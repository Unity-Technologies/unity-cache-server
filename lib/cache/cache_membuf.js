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
        var h = crypto.createHash('sha256');
        h.update(type);
        h.update(guid);
        h.update(hash);
        return h.digest('hex');
    }

    static _findFreeBlockIndex(size) {
        var best = -1;
        var min = 0;
        var max = CacheMembuf._freeBlocks.length - 1;
        var guess;

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
        var i = CacheMembuf._findFreeBlockIndex(size);
        if(i >= 0) {
            var block = CacheMembuf._freeBlocks[i];
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
        var key = CacheMembuf._calcIndexKey(type, guid, hash);
        var fileSize = buffer.length;
        var entry = CacheMembuf._reserveBlock(key, fileSize);
        helpers.log(consts.LOG_DBG, "Saving file: pageIndex = " + entry.pageIndex + " pageOffset = " + entry.pageOffset + " size = " + entry.size);

        buffer.copy(CacheMembuf._pages[entry.pageIndex], 0, entry.pageOffset, fileSize);
    }

    getFileStream(type, guid, hash, callback) {
        var key = CacheMembuf._calcIndexKey(type, guid, hash);
        if(CacheMembuf._index.hasOwnProperty(key)) {
            var entry = CacheMembuf._index[key];
            var slice = CacheMembuf._pages[entry.pageIndex].slice(entry.pageOffset, entry.pageOffset + entry.size);
            var stream = new Readable({
                read() {
                    this.push(slice);
                    this.push(null);
                }
            });
            
            callback(null, {size: entry.size, stream: stream});
        }
        else {
            callback(null, null);
        }
    }

    createPutTransaction(guid, hash, callback) {
        callback(null, new PutTransactionMembuf(guid, hash));
    }

    endPutTransaction(transaction, callback) {
        var files = transaction.getFiles();
        files.forEach(function(file) {
            CacheMembuf._addFileToCache.call(this, file.type, transaction.guid, transaction.hash, file.buffer);
        });

        callback();
    }


    integrityCheck(doFix, callback) {
        return super.integrityCheck(doFix, callback);
    }

    registerClusterWorker(worker) {
        return super.registerClusterWorker(worker);
    }
}

class PutTransactionMembuf extends PutTransaction {
    constructor(guid, hash) {
        super();
        this._buffers = {
            a: null,
            i: null,
            r: null
        };

        this._finished = [];

        this._guid = guid;
        this._hash = hash;
    }

    getFiles() {
        return this._finished;
    }

    get guid() {
        return this._guid;
    }

    get hash() {
        return this._hash;
    }

    getWriteStream(type, size, callback) {
        var self = this;
        
        if(type !== 'a' && type !== 'i' && type !== 'r') {
            return callback(new Error("Unrecognized type '" + type + "' for transaction."));
        }

        this._buffers[type] = Buffer.alloc(size, 0, 'ascii');
        this._bufferPos = 0;
        
        var buffer = this._buffers[type];

        var stream = new Writable({
            write(chunk, encoding, callback) {
                if(buffer.length - self._bufferPos >= chunk.length) {
                    chunk.copy(buffer, self._bufferPos, 0, chunk.length);
                    self._bufferPos += chunk.length;

                    if(self._bufferPos === size) {
                        self._finished.push({type: type, buffer: self._buffers[type]});
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