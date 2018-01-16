'use strict';
const { CacheBase, PutTransaction } = require('./cache_base');
const { Readable, Writable }  = require('stream');
const { promisify } = require('util');
const helpers = require('../helpers');
const consts = require('../constants');
const path = require('path');
const fs = require('fs-extra');
const _ = require('lodash');
const loki = require('lokijs');
const uuid = require('uuid/v4');

const kDbName = 'cache_membuf.db';
const kIndex = 'index';
const kPageMeta = 'pages';

class CacheMembuf extends CacheBase {
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

    /**
     *
     * @param {String} type
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @returns {string}
     * @private
     */
    static _calcIndexKey(type, guid, hash) {
        return `${helpers.GUIDBufferToString(guid)}-${hash.toString('hex')}-${type}`;
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
                helpers.log(consts.LOG_WARN, `File allocation size of ${size} exceeds growPageSize of ${growPageSize}`);
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

    /**
     *
     * @returns {Promise<any>}
     * @private
     */
    _waitForSerialize() {
        const self = this;
        
        return new Promise((resolve) => {
            (function waitForSave() {
                if(self._serializeInProgress === false) return resolve();
                self.emit('waitForSerialize');
                setTimeout(waitForSave, 100);
            })();
        });
    }

    /**
     *
     * @param {String} type
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @param {Buffer} buffer
     * @private
     */
    _addFileToCache(type, guid, hash, buffer) {
        const key = CacheMembuf._calcIndexKey(type, guid, hash);
        const entry = this._reserveBlock(key, buffer.length);

        helpers.log(consts.LOG_TEST, `Saving file key: ${key} pageIndex: ${entry.pageIndex} pageOffset: ${entry.pageOffset} size: ${entry.size}`);

        buffer.copy(this._pages[entry.pageIndex], entry.pageOffset, 0, buffer.length);

        let pageMeta = this._pageMeta.by('index', entry.pageIndex);
        pageMeta.dirty = true;
        this._pageMeta.update(pageMeta);
    }

    /**
     *
     * @returns {Promise<[any]>}
     * @private
     */
    _serialize() {
        const self = this;

        let pages = self._pageMeta.chain().find({'dirty' : true}).data();

        let promises = pages.map(page => {
            let pagePath = path.join(self._cachePath, page.index);
            helpers.log(consts.LOG_INFO, `Writing ${pagePath}`);
            return fs.writeFile(pagePath, self._pages[page.index])
                .then(() => {
                    let doc = self._pageMeta.by('index', page.index);
                    doc.dirty = false;
                    self._pageMeta.update(doc);
                });
        });

        return Promise.all(promises);
    }

    /**
     *
     * @returns {Promise<[any]>}
     * @private
     */
    _deserialize() {
        const self = this;
        
        const cachePath = self._cachePath;
        let pages = self._pageMeta.chain().find({}).data();

        let promises = pages.map(page => {
            let file = path.join(cachePath, page.index);
            helpers.log(consts.LOG_DBG, `Loading page file at ${file}`);

            return fs.stat(file)
                .then(stats => {
                    if(stats.size === page.size) {
                        return fs.readFile(file);
                    }

                    throw new Error(`Unrecognized/invalid page file '${file}'`);
                })
                .then(result => {
                    self._pages[page.index] = result;
                });
        });

        return Promise.all(promises);
    }

    /**
     *
     * @private
     */
    _clearCache() {
        this._index.clear();
        this._pageMeta.clear();
        this._pages = {};
        this._allocPage(this._options.initialPageSize);
    }

    /**
     *
     * @param options
     * @returns {Promise<any>}
     * @private
     */
    _initDb(options) {
        const self = this;
        
        let db = new loki(self._dbPath, options);
        let loadDb = promisify(db.loadDatabase).bind(db);
        this._db = db;

        return loadDb({})
            .then(() => {
                self._index = db.getCollection(kIndex);
                self._pageMeta = db.getCollection(kPageMeta);

                if(self._index !== null && self._pageMeta !== null) {
                    return self._deserialize();
                }

                self._pageMeta = db.addCollection(kPageMeta, {
                    unique: ["index"],
                    indices: ["dirty"]
                });

                self._index = db.addCollection(kIndex, {
                    unique: ["fileId"],
                    indices: ["size"]
                });

                self._clearCache();
            });
    }

    /**
     *
     * @private
     */
    _saveDb() {
        let save = promisify(this._db.saveDatabase).bind(this._db);
        return save();
    }

    init(options) {
        const self = this;

        return super.init(options)
            .then(() => {
                let dbOpts = self._options.persistenceOptions || {};
                if(!dbOpts.hasOwnProperty('adapter') || dbOpts.adapter === null) {
                    dbOpts.adapter = new PersistenceAdapter(self);
                }

                return self._initDb(dbOpts);
            });
    }

    shutdown() {
        let close = promisify(this._db.close).bind(this._db);
        return this._saveDb().then(() => close());
    }

    getFileInfo(type, guid, hash) {
        const key = CacheMembuf._calcIndexKey(type, guid, hash);
        const entry = this._index.by('fileId', key);

        return (entry != null)
            ? Promise.resolve({ size: entry.size })
            : Promise.reject(new Error(`File not found for ${key}`));
    }

    getFileStream(type, guid, hash) {
        const self = this;
        const key = CacheMembuf._calcIndexKey(type, guid, hash);
        const entry = this._index.by('fileId', key);

        return new Promise((resolve, reject) => {
            // noinspection EqualityComparisonWithCoercionJS (checking for null or undefined)
            if(entry != null) {
                const file = self._pages[entry.pageIndex].slice(entry.pageOffset, entry.pageOffset + entry.size);
                const stream = new Readable({
                    read() {
                        if(this.didPush)
                            return this.push(null);
                        this.push(file);
                        this.didPush = true;
                    },

                    highWaterMark: file.length
                });

                resolve(stream);
            }
            else {
                reject(new Error(`File not found for ${key}`));
            }
        });
    }

    createPutTransaction(guid, hash) {
        return Promise.resolve(new PutTransactionMembuf(guid, hash));
    }

    endPutTransaction(transaction) {
        const self = this;

        return this._waitForSerialize()
            .then(() => transaction.finalize())
            .then(() => {
                transaction.files.forEach(file => {
                    self._addFileToCache(file.type, transaction.guid, transaction.hash, file.buffer);
                });
            });
    }

    registerClusterWorker(worker) {}
}

class PutTransactionMembuf extends PutTransaction {
    constructor(guid, hash) {
        super(guid, hash);
        this._streams = {};
        this._finished = [];
    }

    get manifest() {
        return this.files.map((file) => file.type);
    }

    get files() {
        return this._finished;
    }

    finalize() {
        let self = this;
        return new Promise((resolve, reject) => {
            self._finished = _.values(self._streams);
            let ok = self._finished.every(file => {
                return file.pos === file.buffer.length;
            });

            ok ? resolve() : reject(new Error("Transaction failed; file size mismatch"));
        }).then(() => super.finalize());
    }

    getWriteStream(type, size) {
        const self = this;

        return new Promise((resolve, reject) => {
            if(typeof(size) !== 'number' || size <= 0) {
                return reject(new Error("Invalid size for write stream"));
            }

            if(type !== 'a' && type !== 'i' && type !== 'r') {
                return reject(new Error(`Unrecognized type '${type}' for transaction.`));
            }

            self._streams[type] = {
                type: type,
                buffer: Buffer.alloc(size, 0, 'ascii'),
                pos: 0
            };

            const stream = new Writable({
                write(chunk, encoding, cb) {
                    const file = self._streams[type];

                    if (file.buffer.length - file.pos >= chunk.length) {
                        chunk.copy(file.buffer, file.pos, 0, chunk.length);
                        file.pos += chunk.length;
                    }
                    else {
                        helpers.log(consts.LOG_ERR, "Attempt to write over stream buffer allocation!");
                    }

                    cb();
                }
            });

            resolve(stream);
        });
    }
}

module.exports = CacheMembuf;

class PersistenceAdapter extends loki.LokiFsAdapter {
    constructor(cache) {
        super();
        this._cache = cache;
    }

    // noinspection JSUnusedGlobalSymbols
    saveDatabase(dbName, dbString, callback) {
        const self = this;
        
        self._cache._serializeInProgress = true;
        super.saveDatabase(dbName, dbString, function() {
            self._cache._serialize()
                .then(() => {
                    self._cache._serializeInProgress = false;
                    callback();
                });
        });
    }
}