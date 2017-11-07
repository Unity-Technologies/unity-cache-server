'use strict';

class Cache {
    constructor() {}
    
    getFileStream(type, guid, hash, callback) {
        throw new Error("Not implemented!");
    }

    createPutTransaction(guid, hash, callback) {
        throw new Error("Not implemented!");
    }

    endPutTransaction(transaction, callback) {
        throw new Error("Not implemented!");
    }

    integrityCheck(doFix, callback) {
        throw new Error("Not implemented!");
    }
    
    registerClusterWorker(worker) {
        throw new Error("Not implemented!");
    }
}

class PutTransaction {
    constructor() {}

    getWriteStream(type, size, callback) {
        throw new Error("Not implemented!");
    }
}

module.exports = {
    Cache: Cache,
    PutTransaction: PutTransaction
};
