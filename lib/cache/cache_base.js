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
     * @returns {Promise<any>}
     */
    init(options) {
        if(typeof(options) === 'object')
            this._optionOverrides = options;

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
     * @returns {Promise<any>}
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
     * @returns {Promise<any>}
     */
    finalize() {
        return Promise.reject(new Error("Not implemented"));
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
