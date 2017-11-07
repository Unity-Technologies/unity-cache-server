const { Cache, PutTransaction } = require('./cache');
const { Readable, Writable }  = require('stream');
const crypto = require('crypto');
const kBuffer = Symbol("buffer");
const kOptions = Symbol("options");

class CacheDebug extends Cache {
    constructor(options) {
        super(options);

        this[kOptions] = options;
        this[kBuffer] = Buffer.alloc(
            options.maxFileSize,
            crypto.randomBytes(options.maxFileSize).toString('ascii'),
            'ascii');
    }

    getFileStream(type, guid, hash, callback) {
        var size = Math.trunc(Math.random() * this[kOptions].minFileSize + this[kOptions].maxFileSize);
        var slice = this[kBuffer].slice(0, size);

        var stream = new Readable({
            read() {
                this.push(slice);
                this.push(null);
            }
        });

        callback(null, {size: slice.length, stream: stream});
    }

    createPutTransaction(guid, hash, callback) {
        callback(null, new PutTransactionDebug());
    }

    endPutTransaction(transaction, callback) {
        callback();
    }

    integrityCheck(doFix, callback) {
        callback(null, 0);
    }

    registerClusterWorker(worker) {}
}

class PutTransactionDebug extends PutTransaction {
    constructor() {
        super();
    }

    getWriteStream(type, size, callback) {
        var stream = new Writable({
            write(chunk, encoding, callback) { callback(); }
        });

        callback(null, stream);
    }
}

module.exports = CacheDebug;
