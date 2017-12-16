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

        return path.join(path.dirname(require.main.filename), this._options.cachePath)
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

    registerClusterWorker(worker) {
        // Not implemented
    }
}

class PutTransaction {
    constructor(guid, hash) {
        this._guid = guid;
        this._hash = hash;
    }
    
    get guid() { return this._guid; }
    get hash() { return this._hash; }
}

module.exports = {
    Cache: Cache,
    PutTransaction: PutTransaction
};
