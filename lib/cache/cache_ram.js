'use strict';
const { CacheBase, PutTransaction } = require('./cache_base');
const { Readable, Writable }  = require('stream');
const { promisify } = require('util');
const helpers = require('../helpers');
const consts = require('../constants');
const path = require('path');
const fs = require('fs-extra');
const loki = require('lokijs');
const uuid = require('uuid/v4');

const kDbName = 'cache.db';
const kIndex = 'index';
const kPageMeta = 'pages';

class CacheRAM extends CacheBase {
    constructor() {
        super();
        this._db = null;
        this._pages = {};
        this._serializeInProgress = false;
        this._guidRefs = {};
    }

    static get properties() {
        return {
            clustering: false,
            cleanup: false
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
        return super._optionsPath + ".cache_ram";
    }

    get _dbPath() {
        return path.join(this._cachePath, kDbName);
    }

    _allocPage(minSize) {
        const maxPageCount = this._options.maxPageCount;
        if(this._pageMeta.count() === maxPageCount) {
            throw new Error(`reached maxPageCount (${maxPageCount}), cannot allocate new memory page`);
        }

        const pageSize = this._options.pageSize;
        const size = Math.max(minSize, pageSize);
        if(size > pageSize) {
            helpers.log(consts.LOG_WARN, `File allocation size of ${size} exceeds pageSize of ${pageSize}`);
        }

        const pageIndex = uuid();
        this._pages[pageIndex] = Buffer.alloc(size, 0, 'ascii');

        this._index.insert({
            pageIndex: pageIndex,
            pageOffset: 0,
            size: size,
            lastAccessTime: Date.now()
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

        // find LRU block to recycle
        if(result.length === 0 && this._pageMeta.count() === this._options.maxPageCount) {
            result = this._index.chain()
                .find({ 'size' : { '$gte' : size }})
                .simplesort('lastAccessTime')
                .limit(1)
                .data();
        }

        return result.length > 0 ? result[0] : null;
    }

    _reserveBlock(key, size) {
        // Free any existing block for this key
        const doc = this._index.by('fileId', key);
        if(doc) {
            doc.fileId = undefined;
            this._index.update(doc);
        }

        // Find the best free block to use
        let freeBlock;
        while((freeBlock = this._findFreeBlock(size)) === null) {
            this._allocPage(size);
        }

        if(freeBlock.fileId) {
            helpers.log(consts.LOG_DBG, `Allocated existing block of size ${freeBlock.size} for ${key}, last accessed ${freeBlock.lastAccessTime}`);
        }
        else {
            helpers.log(consts.LOG_DBG, `Allocated free block of size ${freeBlock.size} for key ${key}`);
        }

        // Clone the free block, then set it's file id and size
        const block = Object.assign({}, freeBlock);
        delete block['$loki'];
        delete block['meta'];
        block['fileId'] = key;
        block['size'] = size;
        block['lastAccessTime'] = Date.now();
        this._index.insert(block);

        // Update this free block if leftover space is greater than the minimum
        if(freeBlock.size - size >= this._options.minFreeBlockSize) {
            freeBlock.fileId = undefined;
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
    async _addFileToCache(type, guid, hash, buffer) {
        const key = CacheRAM._calcIndexKey(type, guid, hash);

        if(this._guidRefs.hasOwnProperty(key) && this._guidRefs[key] > 0) {
            await new Promise(resolve => this.once(`guidRefRelease-${key}`, resolve));
        }

        const entry = this._reserveBlock(key, buffer.length);

        helpers.log(consts.LOG_TEST, `Saving file key: ${key} pageIndex: ${entry.pageIndex} pageOffset: ${entry.pageOffset} size: ${entry.size}`);

        buffer.copy(this._pages[entry.pageIndex], entry.pageOffset, 0, buffer.length);

        const pageMeta = this._pageMeta.by('index', entry.pageIndex);
        pageMeta.dirty = true;
        this._pageMeta.update(pageMeta);
    }

    /**
     *
     * @returns {Promise<[any]>}
     * @private
     */
    async _serialize() {
        const pages = this._pageMeta.chain().find({'dirty' : true}).data();

        const promises = pages.map(async page => {
            const pagePath = path.join(this._cachePath, page.index);
            helpers.log(consts.LOG_INFO, `Writing ${pagePath}`);

            await fs.writeFile(pagePath, this._pages[page.index]);

            const doc = this._pageMeta.by('index', page.index);
            doc.dirty = false;
            this._pageMeta.update(doc);
        });

        return Promise.all(promises);
    }

    /**
     *
     * @returns {Promise<[any]>}
     * @private
     */
    async _deserialize() {
        const cachePath = this._cachePath;
        const pages = this._pageMeta.chain().find({}).data();

        const promises = pages.map(async page => {
            const file = path.join(cachePath, page.index);
            helpers.log(consts.LOG_DBG, `Loading page file at ${file}`);

            const stats = await fs.stat(file);
            if(stats.size !== page.size) throw new Error(`Unrecognized/invalid page file '${file}'`);
            this._pages[page.index] = await fs.readFile(file);
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
        this._allocPage(this._options.pageSize);
    }

    /**
     *
     * @param options
     * @returns {Promise<any>}
     * @private
     */
    async _initDb(options) {
        const db = new loki(this._dbPath, options);
        const loadDb = promisify(db.loadDatabase).bind(db);
        this._db = db;

        await loadDb({});

        this._index = db.getCollection(kIndex);
        this._pageMeta = db.getCollection(kPageMeta);

        if(this._options.persistence === true && this._index !== null && this._pageMeta !== null) {
            return this._deserialize();
        }

        this._pageMeta = db.addCollection(kPageMeta, {
            unique: ["index"],
            indices: ["dirty"]
        });

        this._index = db.addCollection(kIndex, {
            unique: ["fileId"],
            indices: ["size"]
        });

        this._clearCache();
    }

    /**
     *
     * @private
     */
    async _saveDb() {
        const save = promisify(this._db.saveDatabase).bind(this._db);
        return save();
    }

    async init(options) {
        await super.init(options);

        let dbOpts = {};
        if(this._options.persistence === true && this._options.persistenceOptions) {
            dbOpts = this._options.persistenceOptions;
            dbOpts.adapter = new PersistenceAdapter(this);
        }

        return this._initDb(dbOpts);
    }

    async shutdown() {
        await this._saveDb();
        const close = promisify(this._db.close).bind(this._db);
        return close();
    }

    async getFileInfo(type, guid, hash) {
        const key = CacheRAM._calcIndexKey(type, guid, hash);
        const entry = this._index.by('fileId', key);
        if(entry == null) throw new Error(`File not found for ${key}`);
        return { size: entry.size, lastAccessTime: entry.lastAccessTime };
    }

    async getFileStream(type, guid, hash) {
        const key = CacheRAM._calcIndexKey(type, guid, hash);
        const entry = this._index.by('fileId', key);
        if(entry == null) throw new Error(`File not found for ${key}`);

        // Update lastAccessTime of entry
        entry.lastAccessTime = Date.now();
        this._index.update(entry);

        const file = this._pages[entry.pageIndex].slice(entry.pageOffset, entry.pageOffset + entry.size);

        const stream = new Readable({
            read() {
                if(this.didPush)
                    return this.push(null);
                this.push(file);
                this.didPush = true;
            },

            highWaterMark: file.length
        });

        if(this._guidRefs.hasOwnProperty(key)) {
            this._guidRefs[key]++;
        }
        else {
            this._guidRefs[key] = 1;
        }

        stream.on('end', () => {
            this._guidRefs[key]--;
            if(this._guidRefs[key] === 0) {
                this.emit(`guidRefRelease-${key}`);
            }
        });

        return stream;
    }

    async createPutTransaction(guid, hash) {
        return new PutTransactionRAM(guid, hash);
    }

    async endPutTransaction(transaction) {
        await this._waitForSerialize();
        await transaction.finalize();

        for(const file of transaction.files) {
            this._addFileToCache(file.type, transaction.guid, transaction.hash, file.buffer)
                .catch(err => helpers.log(consts.LOG_ERR, err));
        }
    }

    registerClusterWorker(worker) {}

    cleanup(dryRun = true) {
        // Not supported
        return Promise.resolve();
    }
}

class PutTransactionRAM extends PutTransaction {
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

    async finalize() {
        this._finished = Object.values(this._streams);
        const ok = this._finished.every(file => {
            return file.pos === file.buffer.length;
        });

        if(!ok) throw new Error("Transaction failed; file size mismatch");
        return super.finalize();
    }

    async getWriteStream(type, size) {
        if(typeof(size) !== 'number' || size <= 0) {
            throw new Error("Invalid size for write stream");
        }

        if(type !== 'a' && type !== 'i' && type !== 'r') {
            throw new Error(`Unrecognized type '${type}' for transaction.`);
        }

        this._streams[type] = {
            type: type,
            buffer: Buffer.alloc(size, 0, 'ascii'),
            pos: 0
        };

        const self = this;
        return new Writable({
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
    }
}

module.exports = CacheRAM;

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