'use strict'
const { Cache, PutTransaction } = require('./cache');
const { Readable, Writable }  = require('stream');
const helpers = require('../helpers');
const consts = require('../constants').Constants;
const path = require('path');
const fs = require('fs-extra');
const async = require('async');
const _ = require('lodash');
const loki = require('lokijs');
const uuid = require('uuid/v4');

const kDbName = 'cache_membuf.db';
const kIndex = 'index';
const kPageMeta = 'pages';

class CacheMembuf extends Cache {
    constructor() {
        super();
        this._db = null;
        this._pages = {};
        this._serializeInProgress = false;
    }

    static get properties() {
        return {
            clustering: false
        }
    }

    static _calcIndexKey(type, guid, hash) {
        return `${guid.toString('hex')}-${hash.toString('hex')}-${type}`;
    }

    get _optionsPath() {
        return super._optionsPath + ".cache_membuf";
    }

    get _dbPath() {
        return path.join(this._cachePath, kDbName);
    }

    _allocPage(size) {
        let pageIndex = uuid();
        this._pages[pageIndex] = Buffer.alloc(size, 0, 'ascii');

        this._index.insert({
            pageIndex: pageIndex,
            pageOffset: 0,
            size: size,
            timestamp: Date.now()
        });

        return this._pageMeta.insert({
            index: pageIndex,
            size: size,
            dirty: true
        });
    }

    _findFreeBlock(size) {
        let result = this._index.chain()
            .find({ 'fileId' : undefined, 'size' : { '$gte' : size }})
            .simplesort('size')
            .limit(1)
            .data();

        return result.length > 0 ? result[0] : null;
    }

    _reserveBlock(key, size) {
        // Free any existing block for this key
        this._index.findAndUpdate({'fileId' : key}, doc => doc['fileId'] = undefined);

        // Find the best free block to use
        let freeBlock;
        while((freeBlock = this._findFreeBlock(size)) === null) {
            let growPageSize = this._options.growPageSize;
            let allocSize = Math.max(size, growPageSize);
            if(allocSize > growPageSize) {
                helpers.log(consts.LOG_WARN, "File allocation size of " + size + " exceeds growPageSize of " + growPageSize);
            }

            this._allocPage(allocSize);
        }

        // Clone the free block, then set it's file id and size
        let block = _.omit(freeBlock, ['$loki', 'meta']);
        block['fileId'] = key;
        block['size'] = size;
        block['timestamp'] = Date.now();
        this._index.insert(block);

        // Update this free block if leftover space is greater than the minimum
        if(freeBlock.size - size >= this._options.minFreeBlockSize) {
            freeBlock.pageOffset += size;
            freeBlock.size -= size;
            this._index.update(freeBlock);
        }
        else {
            this._index.remove(freeBlock);
        }

        return block;
    }

    _waitForSerialize() {
        const self = this;
        
        return new Promise((resolve) => {
            (function waitForSave() {
                if(self._serializeInProgress === false) return resolve();
                helpers.log(consts.LOG_TEST, "_waitForSerialize...");
                setTimeout(waitForSave, 100);
            })();
        });
    }

    _addFileToCache(type, guid, hash, buffer) {
        const key = CacheMembuf._calcIndexKey(type, guid, hash);
        const entry = this._reserveBlock(key, buffer.length);

        helpers.log(consts.LOG_TEST, `Saving file key: ${key} pageIndex: ${entry.pageIndex} pageOffset: ${entry.pageOffset} size: ${entry.size}`);

        buffer.copy(this._pages[entry.pageIndex], entry.pageOffset, 0, buffer.length);

        let pageMeta = this._pageMeta.by('index', entry.pageIndex);
        pageMeta.dirty = true;
        this._pageMeta.update(pageMeta);
    }

    _serialize(callback) {
        const self = this;

        let p = self._cachePath;
        if(p === null)
            return callback(new Error("Invalid cachePath"));

        let pages = self._pageMeta.chain().find({'dirty' : true}).data();
        let writeOps = pages.map(function(page) {
            return {
                index: page.index,
                path: path.join(p, page.index),
                data: self._pages[page.index]
            }
        });

        function doWriteOp(op, cb) {
            helpers.log(consts.LOG_INFO, `Writing ${op.path}`);
            fs.writeFile(op.path, op.data)
                .then(() => {
                    let doc = self._pageMeta.by('index', op.index);
                    doc.dirty = false;
                    self._pageMeta.update(doc);
                    cb();
                })
                .catch(err => {
                    cb(err);
                });
        }

        async.eachSeries(writeOps, doWriteOp, callback);
    }

    _deserialize(callback) {
        const self = this;
        
        const p = self._cachePath;
        let pages = self._pageMeta.chain().find({}).data();

        function loadPageFile(page, cb) {
            let file = path.join(p, page.index);
            helpers.log(consts.LOG_DBG, `Loading page file at ${file}`);
            fs.stat(file)
                .then(stats => {
                    if(stats.size !== page.size)
                        return cb(new Error(`Unrecognized/invalid page file '${file}'`));

                    return fs.readFile(file);
                })
                .then(result => {
                    self._pages[page.index] = result;
                    cb();
                })
                .catch(err => {
                   cb(err);
                });
        }

        async.each(pages, loadPageFile, callback);
    }

    _clearCache() {
        this._index.clear();
        this._pageMeta.clear();
        this._pages = {};
        this._allocPage(this._options.initialPageSize);
    }

    _initDb(options, callback) {
        const self = this;
        
        let db = new loki(self._dbPath, options);
        this._db = db;

        db.loadDatabase({}, function() {
            self._index = db.getCollection(kIndex);
            self._pageMeta = db.getCollection(kPageMeta);

            if(self._pageMeta === null) {
                self._pageMeta = db.addCollection(kPageMeta, {
                    unique: ["index"],
                    indices: ["dirty"]
                });
            }

            if(self._index === null) {
                self._index = db.addCollection(kIndex, {
                    unique: ["fileId"],
                    indices: ["size"]
                });

                self._clearCache();
                callback();
            }
            else {
                self._deserialize(callback);
            }
        });
    }

    init(options, callback) {
        const self = this;
        
        super.init(options)
            .then(() => {
                let dbOpts = self._options.persistenceOptions || {};
                if(!dbOpts.hasOwnProperty('adapter')) {
                    dbOpts.adapter = new PersistenceAdapter(self);
                }

                self._initDb(dbOpts, callback);
            })
            .catch(err => {
                callback(err);
            });
    }

    reset(callback) {
        this._clearCache();
        callback();
    }

    save(callback) {
        this._db.saveDatabase(callback);
    }

    shutdown(callback) {
        this._db.close(callback);
    }

    getFileStream(type, guid, hash, callback) {
        const self = this;
        
        const entry = this._index.by('fileId', CacheMembuf._calcIndexKey(type, guid, hash));

        // noinspection EqualityComparisonWithCoercionJS (checking for null or undefined)
        if(entry != null) {
            const file = self._pages[entry.pageIndex].slice(entry.pageOffset, entry.pageOffset + entry.size);
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

    createPutTransaction(guid, hash, callback) {
        callback(null, new PutTransactionMembuf(guid, hash));
    }

    endPutTransaction(transaction, callback) {
        const self = this;
        
        this._waitForSerialize().then(() => {
            const files = transaction.getFiles();
            files.forEach(function (file) {
                self._addFileToCache(file.type, transaction.guid, transaction.hash, file.buffer);
            });

            callback();
        });
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

module.exports = CacheMembuf;

class PersistenceAdapter extends loki.LokiFsAdapter {
    constructor(cache) {
        super();
        this._cache = cache;
    }

    saveDatabase(dbname, dbstring, callback) {
        const self = this;
        
        self._cache._serializeInProgress = true;
        super.saveDatabase(dbname, dbstring, function() {
            self._cache._serialize(function() {
                self._cache._serializeInProgress = false;
                callback();
            });
        });
    }
}