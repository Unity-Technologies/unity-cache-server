'use strict';
const cluster = require('cluster');
const consts = require('../constants');
const helpers = require('../helpers');
const config = require('config');
const path = require('path');
const fs = require('fs-extra');
const _ = require('lodash');

class CacheBase {
    constructor() {}

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
     * @returns {*}
     */
    init(options, callback) {
        if(typeof(options) === 'object')
            this._optionOverrides = options;

        if(cluster.isMaster) {
            const p = this._cachePath;
            helpers.log(consts.LOG_INFO, `Cache path is ${p}`);

            if (typeof(callback) !== 'function') {
                return fs.mkdirs(p);
            }

            fs.mkdirs(p, callback);
        }
        else {
            if (typeof(callback) !== 'function') {
                return new Promise(resolve => { resolve(); });
            }
            else {
                callback(null);
            }
        }
    }

    // noinspection JSMethodCanBeStatic
    /**
     *
     * @param {Function} callback
     */
    shutdown(callback) {
        throw new Error("Not implemented");
    }

    // noinspection JSMethodCanBeStatic
    /**
     *
     * @param {String} type
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @param {Function} callback
     */
    getFileInfo(type, guid, hash, callback) {
        throw new Error("Not implemented");
    }

    // noinspection JSMethodCanBeStatic
    /**
     *
     * @param {String} type
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @param {Function} callback
     */
    getFileStream(type, guid, hash, callback) {
        throw new Error("Not implemented");
    }

    // noinspection JSMethodCanBeStatic
    /**
     *
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @param {Function} callback
     */
    createPutTransaction(guid, hash, callback) {
        throw new Error("Not implemented");
    }

    // noinspection JSMethodCanBeStatic
    /**
     *
     * @param {PutTransaction} transaction
     * @param {Function} callback
     */
    endPutTransaction(transaction, callback) {
        throw new Error("Not implemented");
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
        if(typeof(callback) !== 'function') {
            return new Promise((resolve) => { resolve(); });
        }

        setImmediate(callback);
    }

    /**
     *
     * @param {String} type
     * @param {Number} size
     * @param {Function} callback
     */
    getWriteStream(type, size, callback) {
        throw new Error("Not implemented");
    }
}

module.exports = {
    CacheBase: CacheBase,
    PutTransaction: PutTransaction
};
