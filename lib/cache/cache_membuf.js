const cluster = require('cluster');
const { Cache, PutTransaction } = require('./cache');
const { Readable, Writable }  = require('stream');
const crypto = require('crypto');
const helpers = require('../helpers');
const consts = require('../constants').Constants;
const config = require('config');

class CacheMembuf extends Cache {
    constructor() {
        super();

        if(!cluster.isMaster)
            throw new Error("CacheMembuf module does not support clustering!");

        CacheMembuf._init();
    }

    static _init() {
        if(CacheMembuf._pages.length === 0) {
            CacheMembuf._freeBlocks = [];
            CacheMembuf._index = {};
            CacheMembuf._allocPage(CacheMembuf._options.initialPageSize);
        }
    }

    static get _options() {
        return config.get("Cache.options.cache_membuf");
    }

    static _allocPage(size) {
        CacheMembuf._pages.push(Buffer.alloc(size, 0, 'ascii'));
        CacheMembuf._freeBlocks.push({
            pageIndex: CacheMembuf._pages.length - 1,
            pageOffset: 0,
            size: size
        });
        
        return CacheMembuf._freeBlocks.length - 1;
    }

    static _calcIndexKey(type, guid, hash) {
        const h = crypto.createHash('sha256');
        h.update(type);
        h.update(guid);
        h.update(hash);
        return h.digest('hex');
    }

    static _findFreeBlockIndex(size) {
        let best = -1;
        let min = 0;
        let max = CacheMembuf._freeBlocks.length - 1;
        let guess;

        while (min <= max) {
            guess = (min + max) >> 1;

            if (CacheMembuf._freeBlocks[guess].size < size) {
                min = guess + 1;
            } else {
                best = guess;
                max = guess - 1;
            }
        }

        return best;
    }

    static _freeBlock(key) {
        if(!CacheMembuf.hasOwnProperty(key))
            return;

        // Duplicate the index data into the free block list
        CacheMembuf._freeBlocks.push(Object.assign({}, CacheMembuf._index[key]));

        // Remove the block from the index
        delete CacheMembuf._index[key];

        // Re-sort the free block list
        CacheMembuf._freeBlocks.sort(function(a, b) {
            return a.size - b.size;
        });
    }

    static _reserveBlock(key, size) {
        // Free any existing block for this key
        CacheMembuf._freeBlock(key);

        // Find the best free block to use
        const i = CacheMembuf._findFreeBlockIndex(size);
        if(i >= 0) {
            const block = CacheMembuf._freeBlocks[i];
            CacheMembuf._index[key] = Object.assign({}, block);
            CacheMembuf._index[key].size = size;

            // Update this free block if leftover space is greater than the minimum
            if(block.size - size >= CacheMembuf._options.minFreeBlockSize) {
                block.pageOffset += size;
                block.size -= size;

                // Re-sort the free block list
                CacheMembuf._freeBlocks.sort(function(a, b) {
                    return a.size - b.size;
                });
            }
            else {
                // Otherwise remove it
                CacheMembuf._freeBlocks.splice(i, 0);
            }
        }
        else {
            // Otherwise add a new page
            CacheMembuf._index[key] = {
                pageIndex: CacheMembuf._allocPage(CacheMembuf._options.growPageSize),
                pageOffset: 0,
                size: size
            }
        }

        return CacheMembuf._index[key];
    }

    static _addFileToCache(type, guid, hash, buffer) {
        const key = CacheMembuf._calcIndexKey(type, guid, hash);
        const entry = CacheMembuf._reserveBlock(key, buffer.length);

        helpers.log(consts.LOG_DBG, "Saving file: pageIndex = " + entry.pageIndex + " pageOffset = " + entry.pageOffset + " size = " + entry.size);

        buffer.copy(CacheMembuf._pages[entry.pageIndex], entry.pageOffset, 0, buffer.length);
    }

    getFileStream(type, guid, hash, callback) {
        const key = CacheMembuf._calcIndexKey(type, guid, hash);
        if(CacheMembuf._index.hasOwnProperty(key)) {
            const entry = CacheMembuf._index[key];
            const slice = CacheMembuf._pages[entry.pageIndex].slice(entry.pageOffset, entry.pageOffset + entry.size);
            const stream = new Readable({
                read() {
                    this.push(slice);
                    this.push(null);
                }
            });

            callback(null, {size: entry.size, stream: stream});
        }
        else {
            callback(new Error("File not found for (" + type + ") " + guid.toString('hex') + "-" + hash.toString('hex')));
        }
    }

    createPutTransaction(guid, hash, callback) {
        callback(null, new PutTransactionMembuf(guid, hash));
    }

    endPutTransaction(transaction, callback) {
        const files = transaction.getFiles();
        files.forEach(function(file) {
            CacheMembuf._addFileToCache.call(this, file.type, transaction.guid, transaction.hash, file.buffer);
        });

        callback();
    }

    registerClusterWorker(worker) {
        // Not implemented
    }
}

class PutTransactionMembuf extends PutTransaction {
    constructor(guid, hash) {
        super(guid, hash);
        this._files = { a: {}, i: {}, r: {} };
        this._finished = [];
    }

    getFiles() {
        return this._finished;
    }

    getWriteStream(type, size, callback) {
        const self = this;

        if(type !== 'a' && type !== 'i' && type !== 'r') {
            return callback(new Error("Unrecognized type '" + type + "' for transaction."));
        }

        this._files[type].buffer = Buffer.alloc(size, 0, 'ascii');
        this._files[type].pos = 0;

        const stream = new Writable({
            write(chunk, encoding, callback) {
                const file = self._files[type];

                if (file.buffer.length - file.pos >= chunk.length) {
                    chunk.copy(file.buffer, file.pos, 0, chunk.length);
                    file.pos += chunk.length;

                    if (file.pos === size) {
                        self._finished.push({type: type, buffer: file.buffer});
                    }
                }
                else {
                    helpers.log(consts.LOG_ERR, "Attempt to write over stream buffer allocation!");
                }

                callback();
            }
        });

        callback(null, stream);
    }
}

CacheMembuf._index = {};
CacheMembuf._pages = [];
CacheMembuf._freeBlocks = [];

module.exports = CacheMembuf;