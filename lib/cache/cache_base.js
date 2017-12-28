'use strict';
const EventEmitter = require('events');
const cluster = require('cluster');
const consts = require('../constants');
const helpers = require('../helpers');
const config = require('config');
const path = require('path');
const fs = require('fs-extra');
const _ = require('lodash');

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
        let opts = config.get(this._optionsPath);
        return _.defaultsDeep(this._optionOverrides, opts);
    }

    get _cachePath() {
        if(!this._options.hasOwnProperty('cachePath'))
            return null;

        let cachePath = this._options.cachePath;
        return path.isAbsolute(cachePath) ? cachePath : path.join(path.dirname(require.main.filename), cachePath);
    }

    /**
     *
     * @param {Object} options
     * @param {Function?} callback
     * @returns {Promise<any>}
     */
    init(options, callback) {
        if(typeof(options) === 'object')
            this._optionOverrides = options;

        if(cluster.isMaster) {
            const p = this._cachePath;
            helpers.log(consts.LOG_INFO, `Cache path is ${p}`);
            return helpers.returnPromise(fs.mkdirs(p), callback);
        }
        else {
            return helpers.returnPromise(Promise.resolve(), callback);
        }
    }

    // noinspection JSMethodCanBeStatic
    /**
     *
     * @param {Function?} callback
     */
    shutdown(callback) {
        return Promise.reject(new Error("Not implemented"));
    }

    // noinspection JSMethodCanBeStatic
    /**
     *
     * @param {String} type
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @param {Function?} callback
     * @returns {Promise<any>}
     */
    getFileInfo(type, guid, hash, callback) {
        return Promise.reject(new Error("Not implemented"));
    }

    // noinspection JSMethodCanBeStatic
    /**
     *
     * @param {String} type
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @param {Function?} callback
     * @returns {Promise<any>}
     */
    getFileStream(type, guid, hash, callback) {
        return Promise.reject(new Error("Not implemented"));
    }

    // noinspection JSMethodCanBeStatic
    /**
     *
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @param {Function?} callback
     * @returns {Promise<any>}
     */
    createPutTransaction(guid, hash, callback) {
        return Promise.reject(new Error("Not implemented"));
    }

    // noinspection JSMethodCanBeStatic
    /**
     *
     * @param {PutTransaction} transaction
     * @param {Function?} callback
     * @returns {Promise<any>}
     */
    endPutTransaction(transaction, callback) {
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
}

class PutTransaction {

    /**
     *
     * @param {Buffer} guid
     * @param {Buffer} hash
     */
    constructor(guid, hash) {
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
    get files() { return []; }
    /**
     *
     * @param {Function?} callback
     * @returns {Promise<any>}
     */
    finalize(callback) {
        return Promise.reject(new Error("Not implemented"));
    }

    /**
     *
     * @param {String} type
     * @param {Number} size
     * @param {Function} callback
     * @returns {Promise<any>}
     */
    getWriteStream(type, size, callback) {
        return Promise.reject(new Error("Not implemented"));
    }
}

module.exports = {
    CacheBase: CacheBase,
    PutTransaction: PutTransaction
};
