const { PutTransaction } = require('./cache');
const { Readable, Writable }  = require('stream');
const helpers = require('../helpers');
const consts = require('../constants').Constants;
const config = require('config');
const path = require('path');
const fs = require('fs');
const rimraf = require('rimraf');
const async = require('async');
const defaults = require('lodash/fp/defaults');

class CacheMembuf {

    static get _options() {
        let opts = config.get("Cache.options.cache_membuf");
        return defaults(opts, CacheMembuf._optionOverrides);
    }

    static get _serializePath() {
        if(!CacheMembuf._options.hasOwnProperty('serializePath'))
            return null;

        return path.join(path.dirname(require.main.filename), CacheMembuf._options.serializePath)
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
        return `${guid.toString('hex')}-${hash.toString('hex')}-${type}`;
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
        if(!CacheMembuf._index.hasOwnProperty(key))
            return;

        let block = Object.assign({}, CacheMembuf._index[key]);
        delete block.key;

        // Duplicate the index data into the free block list
        CacheMembuf._freeBlocks.push(block);

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
        let i;
        while((i = CacheMembuf._findFreeBlockIndex(size)) < 0) {
            let growPageSize = CacheMembuf._options.growPageSize;
            let allocSize = Math.max(size, growPageSize);
            if(allocSize > growPageSize) {
                helpers.log(consts.LOG_WARN, "File allocation size of " + size + " exceeds growPageSize of " + growPageSize);
            }

            CacheMembuf._allocPage(allocSize);
        }

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
            CacheMembuf._freeBlocks.splice(i, 1);
        }

        return CacheMembuf._index[key];
    }

    static _addFileToCache(type, guid, hash, buffer) {
        const key = CacheMembuf._calcIndexKey(type, guid, hash);
        const entry = CacheMembuf._reserveBlock(key, buffer.length);

        helpers.log(consts.LOG_DBG, "Saving file: pageIndex = " + entry.pageIndex + " pageOffset = " + entry.pageOffset + " size = " + entry.size);

        buffer.copy(CacheMembuf._pages[entry.pageIndex], entry.pageOffset, 0, buffer.length);
    }

    static _serialize(callback) {

        let p = CacheMembuf._serializePath;
        if(p === null)
            return callback(new Error("Invalid serializedPath"));

        let writeOps = [];
        let i = 0;

        CacheMembuf._pages.forEach(function(page) {
            writeOps.push({
                path: path.join(p, `page.${i++}`),
                data: page
            });
        });

        writeOps.push({
            path: path.join(p, 'index.json'),
            data: JSON.stringify(CacheMembuf._index)
        });

        writeOps.push({
            path: path.join(p, 'freeBlocks.json'),
            data: JSON.stringify(CacheMembuf._freeBlocks)
        });

        function doWriteOp(op, cb) {
            helpers.log(consts.LOG_INFO, `Writing ${op.path}`);
            fs.writeFile(op.path, op.data, cb);
        }

        async.series([
            async.apply(rimraf, p, {}),
            async.apply(fs.mkdir, p, 0o755),
            async.apply(async.eachSeries, writeOps, doWriteOp)
        ], callback);
    }

    static _deserialize(callback) {
        const p = CacheMembuf._serializePath;
        if(p === null || !fs.existsSync(p))
            return callback(new Error("Invalid serializePath"));

        const files = fs.readdirSync(p);

        function loadIndexFile(cb) {
            let indexFile = files.find(file => file.endsWith('index.json'));
            if(!indexFile) {
                return callback(new Error("Cannot find index.json"));
            }

            indexFile = path.join(p, indexFile);
            helpers.log(consts.LOG_DBG, `Loading index file at ${indexFile}`);

            fs.readFile(indexFile, 'utf8', function(err, result) {
                if(err) return callback(err);
                CacheMembuf._index = JSON.parse(result);
                cb();
            });
        }

        function loadFreeBlocksFile(cb) {
            let freeBlocksFile = files.find(file => file.endsWith('freeBlocks.json'));
            if(!freeBlocksFile) {
                return cb(new Error("Cannot find freeBlocks.json"));
            }

            freeBlocksFile = path.join(p, freeBlocksFile);
            helpers.log(consts.LOG_DBG, `Loading freeBlocksFile file at ${freeBlocksFile}`);

            fs.readFile(freeBlocksFile, 'utf8', function(err, result) {
                if(err) return cb(err);
                CacheMembuf._freeBlocks = JSON.parse(result);
                cb();
            });
        }

        let pageFiles = files.filter(file => /page\.\d+$/.test(file)).sort((a, b) => {
            return a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'});
        });

        CacheMembuf._pages = new Array(pageFiles.length);

        function loadPageFile(file, index, cb) {
            file = path.join(p, file);
            helpers.log(consts.LOG_DBG, `Loading page file at ${file}`);

            fs.readFile(file, function(err, result) {
                if(err) return cb(err);
                CacheMembuf._pages[index] = result;
                cb();
            })
        }

        async.series([
            async.apply(loadIndexFile),
            async.apply(loadFreeBlocksFile),
            async.apply(async.eachOf, pageFiles, loadPageFile)
        ], callback);
    }

    static _clearCache() {
        CacheMembuf._pages = [];
        CacheMembuf._freeBlocks = [];
        CacheMembuf._index = {};
        CacheMembuf._allocPage(CacheMembuf._options.initialPageSize);
    }

    static init(options, callback) {
        if(typeof(options) === 'object')
            CacheMembuf._optionOverrides = options;

        if(CacheMembuf._pages.length === 0) {
            CacheMembuf._deserialize(function(err) {
                if(err) {
                    helpers.log(consts.LOG_ERR, err);
                    CacheMembuf._clearCache();
                }

                callback();
            });
        }
    }

    static reset(callback) {
        let p = CacheMembuf._serializePath;
        if(p !== null) {
            rimraf(p, {}, function() {
                CacheMembuf._clearCache();
                callback();
            });
        }
        else {
            CacheMembuf._clearCache();
            callback();
        }
    }

    static save(callback) {
        CacheMembuf._serialize(callback);
    }

    static shutdown(callback) {
        CacheMembuf._serialize(callback);
    }

    static getFileStream(type, guid, hash, callback) {
        const key = CacheMembuf._calcIndexKey(type, guid, hash);
        if(CacheMembuf._index.hasOwnProperty(key)) {
            const entry = CacheMembuf._index[key];
            const file = CacheMembuf._pages[entry.pageIndex].slice(entry.pageOffset, entry.pageOffset + entry.size);
            const stream = new Readable({
                read() {
                    this.push(file);
                    this.push(null);
                },

                highWaterMark: file.length
            });

            callback(null, {size: entry.size, stream: stream});
        }
        else {
            callback(new Error("File not found for (" + type + ") " + guid.toString('hex') + "-" + hash.toString('hex')));
        }
    }

    static createPutTransaction(guid, hash, callback) {
        callback(null, new PutTransactionMembuf(guid, hash));
    }

    static endPutTransaction(transaction, callback) {
        const files = transaction.getFiles();
        files.forEach(function(file) {
            CacheMembuf._addFileToCache(file.type, transaction.guid, transaction.hash, file.buffer);
        });

        callback();
    }

    static registerClusterWorker(worker) {
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
CacheMembuf._optionOverrides = {};

module.exports = CacheMembuf;