const helpers = require('./../helpers');
const filesize = require('filesize');
const consts = require('./../constants');
const Duplex = require('stream').Duplex;

const kSource = Symbol("source");
const kCache = Symbol("cache");
const kSendFileQueue = Symbol("sendFileQueue");
const kReadStateVersion = Symbol("readStateVersion");
const kReadStateCommand = Symbol("readStateCommand");
const kReadStatePutStream = Symbol("readStatePutStream");

class CommandProcessor extends Duplex {

    /**
     *
     * @param {CacheBase} cache
     */
    constructor(cache) {
        super();
        this[kCache] = cache;
        this[kSendFileQueue] = [];
        this._readState = kReadStateVersion;

        /**
         *
         * @type {PutTransaction}
         * @private
         */
        this._trx = null;

        this._putStream = null;
        this._putSize = 0;
        this._putSent = 0;
        this._sendFileQueueChunkReads = 0;
        this._sendFileQueueReadDuration = 0;
        this._sendFileQueueReadBytes = 0;
        this._sendFileQueueCount = 0;
        this._isReading = false;
        this._readReady = true;
        this._registerEventListeners();
    }

    _registerEventListeners() {
        const self = this;
        this.once('finish', this._printReadStats);
        this.on('pipe', src => {
            self[kSource] = src;
        });
    }

    // noinspection JSUnusedGlobalSymbols
    /**
     *
     * @param {Buffer} chunk
     * @param {String} encoding
     * @param {Function} callback
     * @private
     */
    _write(chunk, encoding, callback) {
        let handler = null;
        const self = this;

        switch(this._readState) {
            case kReadStateVersion:
                handler = this._handleVersion;
                break;
            case kReadStateCommand:
                handler = this._handleCommand;
                break;
            case kReadStatePutStream:
                handler = this._handleWrite;
                break;
            default:
                return callback(null);
        }

        handler.call(this, chunk, function(err) {
            if(err) {
                self._quit(err);
            }

            callback();
        });
    }

    /**
     * @private
     */
    _read() {
        this._readReady = true;
        let self = this;
        Promise.resolve().then(() => {
            self._read_internal();
        });
    }

    /**
     * @private
     */
    _read_internal() {
        if(this._isReading || this[kSendFileQueue].length === 0)
            return;

        let self = this;
        let file = self[kSendFileQueue][0];

        if (file.header !== null) {
            let header = file.header;
            file.header = null;
            self._readReady = self.push(header, 'ascii');
        }

        if(!file.exists) {
            self[kSendFileQueue].shift();
            return;
        }

        self._isReading = true;
        self._readStartTime = Date.now();
        this[kCache].getFileStream(file.type, file.guid, file.hash, function(err, stream) {
            if(err) {
                helpers.log(consts.LOG_ERR, err);
                self._isReading = false;
                return;
            }

            function readChunk() {
                if(!self._readReady) {
                    return setImmediate(readChunk);
                }

                let chunk = stream.read();
                if(chunk !== null) {
                    self._readReady = self.push(chunk, 'ascii');
                    self._sendFileQueueChunkReads++;
                    self._sendFileQueueReadBytes += chunk.length;
                }
                else {
                    self[kSendFileQueue].shift();
                    self._isReading = false;
                    self._sendFileQueueReadDuration += Date.now() - self._readStartTime;
                    self._read();
                }
            }

            stream.on('readable', readChunk);
        });
    }

    /**
     * @private
     */
    _printReadStats() {
        if(this._sendFileQueueReadDuration > 0) {
            let totalTime = this._sendFileQueueReadDuration / 1000;
            let throughput = (this._sendFileQueueReadBytes / totalTime).toFixed(2);
            helpers.log(consts.LOG_INFO, `Sent ${this._sendFileQueueCount} files (${this._sendFileQueueChunkReads} chunks) totaling ${filesize(this._sendFileQueueReadBytes)} in ${totalTime} seconds (${filesize(throughput)}/sec)`);
        }
    }

    /**
     *
     * @param {Error?} err
     * @private
     */
   _quit(err) {
        this[kSource].unpipe(this);
        this[kSource].emit('quit');
        this._readState = null;
        err && helpers.log(consts.LOG_ERR, err);
    }

    /**
     *
     * @param {Buffer} data
     * @param {Function} callback
     * @private
     */
    _handleVersion(data, callback) {
        let version = helpers.readUInt32(data);
        this._readState = kReadStateCommand;
        let err = null;
        if(version !== consts.PROTOCOL_VERSION) {
            version = 0;
            err = new Error("Bad Client protocol version");
        }

        this.push(helpers.encodeInt32(version));
        callback(err);
    }

    /**
     *
     * @param {Buffer} data
     * @param {Function} callback
     * @private
     */
    _handleWrite(data, callback) {
        const self = this;

        this._putStream.write(data, 'ascii', function() {
            self._putSent += data.length;
            if(self._putSent === self._putSize) {
                self._putStream.end(callback);
                self._readState = kReadStateCommand;
                self._putSent = 0;
                self._putSize = 0;
            }
            else {
                callback();
            }
        });
    }

    /**
     *
     * @param {Buffer} data
     * @param {Function} callback
     * @private
     */
    _handleCommand(data, callback) {
        let cmd, size, type, guid, hash = null;
        if(data.length > 1) {
            cmd = data.slice(0, 2).toString('ascii');
            type = cmd[1];

            if (data.length === 2 + consts.ID_SIZE) {
                guid = Buffer.from(data.slice(2, 2 + consts.GUID_SIZE));
                hash = Buffer.from(data.slice(2 + consts.HASH_SIZE));
            }
            else if (data.length === 2 + consts.SIZE_SIZE) {
                size = helpers.readUInt64(data.slice(2));
            }
        }
        else if(data.length > 0) {
            cmd = data.toString('ascii');
        }
        else {
            return callback();
        }

        switch(cmd) {
            case 'q':
                this._quit();
                this._readState = null;
                break;
            case 'ga':
            case 'gi':
            case 'gr':
                this._onGet(type, guid, hash, callback);
                break;
            case 'ts':
                this._onTransactionStart(guid, hash, callback);
                break;
            case 'te':
                this._onTransactionEnd(callback);
                break;
            case 'pa':
            case 'pi':
            case 'pr':
                this._onPut(type, size, callback);
                break;
            default:
                callback(new Error(`Unrecognized command '${cmd}`));
        }
    }

    /**
     *
     * @param {String} type
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @param {Function} callback
     * @private
     */
    _onGet(type, guid, hash, callback) {
        let self = this;
        this[kCache].getFileInfo(type, guid, hash, function(err, result) {

            if(err || result === null) {
                let resp = Buffer.from(`-${type}`, 'ascii');
                self[kSendFileQueue].push({
                    exists: false,
                    header: Buffer.concat([resp, guid, hash], 34)
                });
            }
            else {
                let resp = Buffer.from(`+${type}${helpers.encodeInt64(result.size)}`, 'ascii');
                self[kSendFileQueue].push({
                    exists: true,
                    header: Buffer.concat([resp, guid, hash], 50),
                    size: result.size,
                    type: type,
                    guid: guid,
                    hash: hash
                });

                self._sendFileQueueCount++;
                helpers.log(consts.LOG_DBG, `Adding file to send queue, size ${result.size}`);
            }

            if(self[kSendFileQueue].length === 1) {
                self._read(self._readState.highWaterMark);
            }

            callback(null);
        });
    }

    /**
     *
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @param {Function} callback
     * @private
     */
    _onTransactionStart(guid, hash, callback) {
        const self = this;

        if(this._trx !== null) {
            helpers.log(consts.LOG_DBG, "Cancel previous transaction");
            this._trx = null;
        }

        this[kCache].createPutTransaction(guid, hash, function(err, trx) {
            if(err) {
                return callback(err);
            }

            helpers.log(consts.LOG_DBG, `Start transaction for ${guid.toString('hex')}-${hash.toString('hex')}`);
            self._trx = trx;
            callback(null);
        });
    }

    /**
     *
     * @param {Function} callback
     * @private
     */
    _onTransactionEnd(callback) {
        const self = this;

        if(!this._trx) {
            return callback(new Error("Invalid transaction isolation"));
        }

        this[kCache].endPutTransaction(this._trx, function(err) {
            helpers.log(consts.LOG_DBG, `End transaction for ${self._trx.guid.toString('hex')}-${self._trx.hash.toString('hex')}`);
            self._trx = null;
            callback(err);
        });
    }

    /**
     *
     * @param {String} type
     * @param {Number} size
     * @param {Function} callback
     * @private
     */
    _onPut(type, size, callback) {
        const self = this;

        if(!this._trx) {
            return callback(new Error("Not in a transaction"));
        }

        this._trx.getWriteStream(type, size, function(err, stream) {
            if(err) {
                return callback(err);
            }

            self._putStream = stream;
            self._putSize = size;
            self._readState = kReadStatePutStream;
            callback(null);
        });
    }
}

module.exports = CommandProcessor;