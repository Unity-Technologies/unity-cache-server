'use strict';
const EventEmitter = require('events');
const cluster = require('cluster');
const consts = require('../constants');
const helpers = require('../helpers');
const path = require('path');
const fs = require('fs-extra');
const defaultsDeep = require('lodash').defaultsDeep;
const { promisify } = require('util');
const loki = require('lokijs');
const ReliabilityManager = require('./reliability_manager');
const _ = require('lodash');
const { Writable } = require('stream');

const kDbName = 'cache.db';

class CacheBase extends EventEmitter {
    constructor() {
        super();
        this._optionOverrides = {};
        this._db = null;
        this._rm = null;
    }

    static get properties() {
        return {};
    }

    // noinspection JSMethodCanBeStatic
    get _optionsPath() {
        return 'Cache.options';
    }

    get _options() {
        const opts = require('config').get(this._optionsPath);
        return defaultsDeep(this._optionOverrides, opts);
    }

    set _options(val) {
        if(typeof(val) === 'object')
            this._optionOverrides = val;
    }

    get _cachePath() {
        if(!this._options.hasOwnProperty('cachePath'))
            return null;

        const cachePath = this._options.cachePath;
        return path.isAbsolute(cachePath) ? cachePath : path.join(path.dirname(require.main.filename), cachePath);
    }

    /**
     *
     * @returns {LokiPersistenceAdapter}
     */
    get _persistenceAdapterClass() {
        return loki.LokiFsAdapter;
    }

    /**
     *
     * @returns {string}
     * @private
     */
    get _dbPath() {
        return path.join(this._cachePath, kDbName);
    }

    /**
     *
     * @param options
     * @returns {Promise<LokiConstructor>}
     */
    async _initDb(options) {
        const db = new loki(this._dbPath, options);
        const loadDb = promisify(db.loadDatabase).bind(db);
        await loadDb({});

        return db;
    }

    /**
     *
     */
    _saveDb() {
        const save = promisify(this.db.saveDatabase).bind(this.db);
        return save();
    }

    /**
     *
     * @returns {null|Loki}
     */
    get db() {
        return this._db;
    }

    /**
     *
     * @returns {null|ReliabilityManager}
     */
    get reliabilityManager() {
        return this._rm;
    }

    /**
     *
     * @param {Object} options
     * @returns {Promise<any>}
     */
    async init(options) {
        this._options = options;

        if(cluster.isMaster) {
            const p = this._cachePath;
            helpers.log(consts.LOG_INFO, `Cache path is ${p}`);
            await fs.mkdirs(p);

            // Initialize database
            let dbOpts = {};
            const PersistenceAdapterClass = this._persistenceAdapterClass;

            if(PersistenceAdapterClass !== null && this._options.persistence === true && this._options.persistenceOptions) {
                dbOpts = this._options.persistenceOptions;
                dbOpts.adapter = new PersistenceAdapterClass(this);
            }

            this._db = await this._initDb(dbOpts);
        }

        if(this._options.highReliability === true)
            this._rm = new ReliabilityManager(this.db, this._cachePath, this._options.highReliabilityOptions);
    }

    /**
     *
     * @returns {Promise<null>}
     */
    async shutdown() {
        if(!cluster.isMaster) return Promise.resolve();

        const opts = this._options;
        if(opts.hasOwnProperty('persistenceOptions') === false || opts.persistenceOptions.autosave === false) {
            await this._saveDb();
        }

        const close = promisify(this.db.close).bind(this.db);
        return close();
    }

    /**
     *
     * @param {String} type
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @returns {Promise<any>}
     */
    getFileInfo(type, guid, hash) {
        return Promise.reject(new Error("Not implemented"));
    }

    /**
     *
     * @param {String} type
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @returns {Promise<Readable>}
     */
    getFileStream(type, guid, hash) {
        return Promise.reject(new Error("Not implemented"));
    }

    /**
     *
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @returns {Promise<any>}
     */
    createPutTransaction(guid, hash) {
        return Promise.resolve(new PutTransaction(guid, hash));
    }

    /**
     *
     * @param {PutTransaction} transaction
     * @returns {Promise<any>}
     */
    async endPutTransaction(transaction) {
        await transaction.finalize();

        if(this._rm !== null && this._options.highReliability)
            return this._rm.processTransaction(transaction);
    }

    cleanup(dryRun = true) {
        return Promise.reject(new Error("Not implemented"));
    }
}

class PutTransaction extends EventEmitter {

    /**
     *
     * @param {Buffer} guid
     * @param {Buffer} hash
     */
    constructor(guid, hash) {
        super();
        this._guid = guid;
        this._hash = hash;
        this._isValid = true;
        this._clientAddress = "";
    }

    /**
     *
     * @returns {Buffer}
     */
    get guid() { return this._guid; }

    /**
     *
     * @returns {Buffer}
     */
    get hash() { return this._hash; }

    /**
     *
     * @returns {Array}
     */
    get manifest() { return []; }

    /**
     *
     * @returns {Array}
     */
    get files() { return []; }

    /**
     *
     * @param {String} val
     */
    set clientAddress(val) {
        this._clientAddress = val;
    }

    /**
     *
     * @returns {String}
     */
    get clientAddress() {
        return this._clientAddress;
    }

    /**
     *
     * @returns {String}
     */
    get filesHashStr() {
        return _.sortBy(this.files, 'type').reduce((result, file) => {

            // FILE_TYPE.INFO content is ignored in determinism calculation, as it contains a preview image that will
            // often fail to be cross-platform deterministic
            return file.type === consts.FILE_TYPE.INFO
                ? result + file.type
                : result + file.type + file.byteHash.toString('hex');

        }, this._guid.toString('hex') + this._hash.toString('hex'));
    }

    /**
     *
     * @returns {boolean}
     */
    get isValid() { return this._isValid; }

    /**
     *
     * @returns {Promise<any>}
     */
    async finalize() {
        await this.validateHash();
        this.emit('finalize');
    }

    /**
     *
     * @returns {Promise<void>}
     */
    async validateHash() {
        if(this.hash.compare(consts.ZERO_HASH) === 0) {
            helpers.log(consts.LOG_ERR, `Invalidating transaction with zero (0) value hash for GUID ${helpers.GUIDBufferToString(this.guid)}`);
            return this.invalidate();
        }
    }

    /**
     *
     * @param {String} type
     * @param {Number} size
     * @returns {Promise<any>}
     */
    getWriteStream(type, size) {
        return Promise.resolve(new Writable({
            write(chunk, encoding, cb){ setImmediate(cb); }
        }));
    }

    async invalidate() {
        this._isValid = false;
    }

    /**
     *
     * @param targetPath
     * @returns {Promise<any>}
     */
    async writeFilesToPath(targetPath) {
        return Promise.resolve();
    }
}

module.exports = {
    CacheBase: CacheBase,
    PutTransaction: PutTransaction
};
