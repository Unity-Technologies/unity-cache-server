'use strict';
const config = require('config');
const path = require('path');
const fs = require('fs-extra');
const _ = require('lodash');

class Cache {
    static get properties() {
        return {};
    }

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

    init(options, callback) {
        if(typeof(options) === 'object')
            this._optionOverrides = options;

        const p = this._cachePath;

        if(typeof(callback) !== 'function') {
            return fs.mkdirs(p);
        }

        fs.mkdirs(p, callback);
    }

    reset(callback) {
        throw new Error("Not implemented");
    }

    save(callback) {
        throw new Error("Not implemented");
    }

    shutdown(callback) {
        throw new Error("Not implemented");
    }

    hasFile(type, guid, hash, callback) {
        throw new Error("Not implemented");
    }

    getFileStream(type, guid, hash, callback) {
        throw new Error("Not implemented");
    }

    createPutTransaction(guid, hash, callback) {
        throw new Error("Not implemented");
    }

    endPutTransaction(transaction, callback) {
        throw new Error("Not implemented");
    }

    registerClusterWorker(worker) {
        throw new Error("Not implemented");
    }
}

class PutTransaction {
    constructor(guid, hash) {
        this._guid = guid;
        this._hash = hash;
    }
    
    get guid() { return this._guid; }
    get hash() { return this._hash; }

    getWriteStream(type, size, callback) {
        throw new Error("Not implemented");
    }
}

module.exports = {
    Cache: Cache,
    PutTransaction: PutTransaction
};
