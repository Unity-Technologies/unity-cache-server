const { Cache, PutTransaction } = require('./cache');
const { Readable, Writable }  = require('stream');
const crypto = require('crypto');
const config = require('config');

const kBuffer = Symbol("buffer");
const kOptions = Symbol("options");

class CacheDebug extends Cache {
    constructor() {
        super();
        this[kBuffer] = Buffer.alloc(
            CacheDebug._options.maxFileSize,
            crypto.randomBytes(CacheDebug._options.maxFileSize).toString('ascii'),
            'ascii');
    }

    static get _options() {
        return config.get("Cache.options.cache_debug");
    }

    getFileStream(type, guid, hash, callback) {
        const size = Math.trunc(Math.random() * this[kOptions].minFileSize + this[kOptions].maxFileSize);
        const slice = this[kBuffer].slice(0, size);

        const stream = new Readable({
            read() {
                this.push(slice);
                this.push(null);
            }
        });

        callback(null, {size: slice.length, stream: stream});
    }

    createPutTransaction(guid, hash, callback) {
        callback(null, new PutTransactionDebug(guid, hash));
    }

    endPutTransaction(transaction, callback) {
        callback();
    }

    registerClusterWorker(worker) {}
}

class PutTransactionDebug extends PutTransaction {
    constructor(guid, hash) {
        super(guid, hash);
    }

    getWriteStream(type, size, callback) {
        const stream = new Writable({
            write(chunk, encoding, callback) {
                callback();
            }
        });

        callback(null, stream);
    }
}

module.exports = CacheDebug;
