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
        this._sendFileQueueSentCount = 0;
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
        Promise.resolve().then(() => this._read_internal());
    }

    /**
     * @private
     */
    _read_internal() {
        if(this._isReading || this[kSendFileQueue].length === 0)
            return;

        let self = this;
        let file = self[kSendFileQueue][0];

        self._readReady = self.push(file.header, 'ascii');

        if(!file.exists) {
            self[kSendFileQueue].shift();
            return;
        }

        self._isReading = true;
        self._readStartTime = Date.now();
        this[kCache].getFileStream(file.type, file.guid, file.hash)
            .then(stream => {
                function readChunk() {
                    if(!self._readReady) {
                        return setImmediate(readChunk);
                    }

                    let chunk;
                    while(chunk = stream.read()) {
                        self._readReady = self.push(chunk, 'ascii');
                        self._sendFileQueueChunkReads++;
                        self._sendFileQueueReadBytes += chunk.length;

                        if(!self._readReady) {
                            setImmediate(readChunk);
                            break;
                        }
                    }
                }

                stream.on('readable', readChunk);

                stream.on('end', () => {
                    self[kSendFileQueue].shift();
                    self._sendFileQueueSentCount++;
                    self._isReading = false;
                    self._sendFileQueueReadDuration += Date.now() - self._readStartTime;
                    self._read();
                })
            })
            .catch(err => {
                helpers.log(consts.LOG_ERR, err);
                self._isReading = false;
            });
    }

    /**
     * @private
     */
    _printReadStats() {
        if(this._sendFileQueueReadDuration > 0) {
            let totalTime = this._sendFileQueueReadDuration / 1000;
            let throughput = (this._sendFileQueueReadBytes / totalTime).toFixed(2);
            helpers.log(consts.LOG_INFO, `Sent ${this._sendFileQueueSentCount} of ${this._sendFileQueueCount} requested files (${this._sendFileQueueChunkReads} chunks) totaling ${filesize(this._sendFileQueueReadBytes)} in ${totalTime} seconds (${filesize(throughput)}/sec)`);
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
        let p, cmd, size, type, guid, hash = null;
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
        else {
            cmd = data.toString('ascii');
        }

        switch(cmd) {
            case 'q':
                this._quit();
                this._readState = null;
                p = Promise.resolve();
                break;
            case 'ga':
            case 'gi':
            case 'gr':
                p = this._onGet(type, guid, hash);
                break;
            case 'ts':
                p = this._onTransactionStart(guid, hash);
                break;
            case 'te':
                p = this._onTransactionEnd();
                break;
            case 'pa':
            case 'pi':
            case 'pr':
                p = this._onPut(type, size);
                break;
            default:
                p = Promise.reject(new Error(`Unrecognized command '${cmd}`));
        }

        p.then(() => callback(), err => callback(err));
    }

    /**
     *
     * @param {String} type
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @returns {Promise<any>}
     * @private
     */
    _onGet(type, guid, hash) {
        let self = this;
        return this[kCache].getFileInfo(type, guid, hash)
            .then(result => {
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
            })
            .catch(() => {
                let resp = Buffer.from(`-${type}`, 'ascii');
                self[kSendFileQueue].push({
                    exists: false,
                    header: Buffer.concat([resp, guid, hash], 34)
                });
            })
            .then(() => {
                if(self[kSendFileQueue].length === 1) {
                    self._read(self._readState.highWaterMark);
                }
            });
    }

    /**
     *
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @returns {Promise<any>}
     * @private
     */
    _onTransactionStart(guid, hash) {
        const self = this;

        if(this._trx !== null) {
            helpers.log(consts.LOG_DBG, "Cancel previous transaction");
            this._trx = null;
        }

        return this[kCache].createPutTransaction(guid, hash)
            .then(trx => {
                helpers.log(consts.LOG_DBG, `Start transaction for GUID: ${helpers.GUIDBufferToString(guid)} Hash: ${hash.toString('hex')}`);
                self._trx = trx;
            });
    }

    /**
     *
     * @returns {Promise<any>}
     * @private
     */
    _onTransactionEnd() {
        const self = this;

        if(!this._trx) {
            return Promise.reject(new Error("Invalid transaction isolation"));
        }

        return this[kCache].endPutTransaction(this._trx)
            .then(() => {
                helpers.log(consts.LOG_DBG, `End transaction for GUID: ${helpers.GUIDBufferToString(self._trx.guid)} Hash: ${self._trx.hash.toString('hex')}`);
                self._trx = null;
            });
    }

    /**
     *
     * @param {String} type
     * @param {Number} size
     * @returns {Promise<any>}
     * @private
     */
    _onPut(type, size) {
        const self = this;

        if(!this._trx) {
            return Promise.reject(new Error("Not in a transaction"));
        }

        return this._trx.getWriteStream(type, size)
            .then(stream => {
                self._putStream = stream;
                self._putSize = size;
                self._readState = kReadStatePutStream;
            });
    }
}

module.exports = CommandProcessor;