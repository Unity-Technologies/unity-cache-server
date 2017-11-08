'use strict';

class Cache {
    constructor() {}
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
