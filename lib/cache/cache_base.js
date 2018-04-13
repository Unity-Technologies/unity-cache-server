'use strict';
const EventEmitter = require('events');
const cluster = require('cluster');
const consts = require('../constants');
const helpers = require('../helpers');
const config = require('config');
const path = require('path');
const fs = require('fs-extra');
const defaultsDeep = require('lodash').defaultsDeep;

class CacheBase extends EventEmitter {
    constructor() {
        super();
        this._optionOverrides = {};
    }

    static get properties() {
        return {};
    }

    // noinspection JSMethodCanBeStatic
    get _optionsPath() {
        return 'Cache.options';
    }

    get _options() {
        const opts = config.get(this._optionsPath);
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
     * @param {Object} options
     * @returns {Promise<any>}
     */
    init(options) {
        this._options = options;

        if(cluster.isMaster) {
            const p = this._cachePath;
            helpers.log(consts.LOG_INFO, `Cache path is ${p}`);
            return fs.mkdirs(p);
        }
        else {
            return Promise.resolve();
        }
    }

    /**
     *
     * @returns {Promise<any>}
     */
    shutdown() {
        return Promise.reject(new Error("Not implemented"));
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
        return Promise.reject(new Error("Not implemented"));
    }

    /**
     *
     * @param {PutTransaction} transaction
     * @returns {Promise<any>}
     */
    endPutTransaction(transaction) {
        return Promise.reject(new Error("Not implemented"));
    }

    // noinspection JSMethodCanBeStatic
    /**
     *
     * @param {EventEmitter} worker
     */
    registerClusterWorker(worker) {
        throw new Error("Not implemented");
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
     * @returns {Promise<any>}
     */
    finalize() {
        return Promise.resolve().then(() => this.emit('finalize'));
    }

    /**
     *
     * @param {String} type
     * @param {Number} size
     * @returns {Promise<any>}
     */
    getWriteStream(type, size) {
        return Promise.reject(new Error("Not implemented"));
    }
}

module.exports = {
    CacheBase: CacheBase,
    PutTransaction: PutTransaction
};
