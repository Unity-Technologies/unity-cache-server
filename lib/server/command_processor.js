const helpers = require('./../helpers');
const filesize = require('filesize');
const consts = require('./../constants');
const Duplex = require('stream').Duplex;
const { promisify } = require('util');

const kSource = Symbol("source");
const kCache = Symbol("cache");
const kSendFileQueue = Symbol("sendFileQueue");
const kReadStateVersion = Symbol("readStateVersion");
const kReadStateCommand = Symbol("readStateCommand");
const kReadStatePutStream = Symbol("readStatePutStream");
const kReadStateNone = Symbol("readStateNone");

const StatsDClient = require('statsd-client');

class CommandProcessor extends Duplex {

    /**
     *
     * @param {CacheBase} cache
     */
    constructor(cache, statsd) {
        super();
        this[kCache] = cache;
        this[kSendFileQueue] = [];
        this._setWriteHandler(kReadStateVersion);

        this.statsd = statsd || new StatsDClient();
        this.transactionTimer;

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

    /**
     *
     * @param {symbol<kReadStateVersion|kReadStateCommand|kReadStatePutStream>} readState
     * @private
     */
    _setWriteHandler(readState) {
        switch(readState) {
            case kReadStateVersion:
                this._writeHandler = this._handleVersion;
                break;
            case kReadStateCommand:
                this._writeHandler = this._handleCommand;
                break;
            case kReadStatePutStream:
                this._writeHandler = this._handleWrite;
                break;
            default:
                this._writeHandler = () => Promise.resolve();
        }
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
        this._writeHandler.call(this, chunk)
            .then(() => callback(), err => this._quit(err));
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
    async _read_internal() {
        if(this._isReading || this[kSendFileQueue].length === 0)
            return;
        
        let file = this[kSendFileQueue][0];

        this._readReady = this.push(file.header, 'ascii');

        if(!file.exists) {
            this[kSendFileQueue].shift();
            return;
        }

        this._isReading = true;
        this._readStartTime = Date.now();
        let stream;

        try {
            stream = await this[kCache].getFileStream(file.type, file.guid, file.hash);
        }
        catch(err) {
            helpers.log(consts.LOG_ERR, err);
            this._isReading = false;
            return;
        }

        const self = this;

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
   async _quit(err) {
       this[kSource].unpipe(this);
       this[kSource].emit('quit');
       this._setWriteHandler(kReadStateNone);
       if(err) {
           helpers.log(consts.LOG_ERR, err);
       }
    }

    /**
     *
     * @param {Buffer} data
     * @private
     */
    async _handleVersion(data) {
        let version = helpers.readUInt32(data);
        this._setWriteHandler(kReadStateCommand);

        let err = null;
        if(version !== consts.PROTOCOL_VERSION) {
            version = 0;
            err = new Error("Bad Client protocol version");
        }

        this.push(helpers.encodeInt32(version));
        if(err) throw err;
    }

    /**
     *
     * @param {Buffer} data
     * @private
     */
    async _handleWrite(data) {
        await this._putStream.promiseWrite(data, 'ascii');
        this._putSent += data.length;
        if(this._putSent === this._putSize) {
            this._putStream.end();
            this._setWriteHandler(kReadStateCommand);
            this._putSent = 0;
            this._putSize = 0;
        }
    }

    /**
     *
     * @param {Buffer} data
     * @private
     */
    async _handleCommand(data) {
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
        else {
            cmd = data.toString('ascii');
        }

        switch(cmd) {
            case 'q':
                this.statsd.increment('cmd', 1, {cmd: 'quit'});
                await this._quit();
                break;
            case 'ga':
            case 'gi':
            case 'gr':
                this.statsd.increment('cmd', 1, {cmd: 'get', type});
                await this._onGet(type, guid, hash);
                break;
            case 'ts':
                this.statsd.increment('cmd', 1, {cmd: 'trx'});
                await this._onTransactionStart(guid, hash);
                break;
            case 'te':
                this.statsd.increment('cmd', 1, {cmd: 'trx_end'});
                await this._onTransactionEnd();
                break;
            case 'pa':
            case 'pi':
            case 'pr':
                this.statsd.increment('cmd', 1, {cmd: 'put', type});
                await this._onPut(type, size);
                break;
            default:
                throw new Error(`Unrecognized command '${cmd}'`);
        }
    }

    /**
     *
     * @param {String} type
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @returns {Promise<void>}
     * @private
     */
    async _onGet(type, guid, hash) {

        try {
            const info = await this[kCache].getFileInfo(type, guid, hash);
            const resp = Buffer.from(`+${type}${helpers.encodeInt64(info.size)}`, 'ascii');
            this[kSendFileQueue].push({
                exists: true,
                header: Buffer.concat([resp, guid, hash], 50),
                size: info.size,
                type: type,
                guid: guid,
                hash: hash
            });

            this._sendFileQueueCount++;
            helpers.log(consts.LOG_DBG, `Adding file to send queue, size ${info.size}`);

            this.statsd.increment('hit', 1, {type});
            this.statsd.histogram('get-size', info.size, {type})
        }
        catch(err) {
            const resp = Buffer.from(`-${type}`, 'ascii');
            this[kSendFileQueue].push({
                exists: false,
                header: Buffer.concat([resp, guid, hash], 34)
            });

            this.statsd.increment('miss', 1, {type});
        }
        finally {
            if(this[kSendFileQueue].length === 1) {
                this._read();
            }
        }
    }

    /**
     *
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @returns {Promise<void>}
     * @private
     */
    async _onTransactionStart(guid, hash) {
        if(this._trx !== null) {
            helpers.log(consts.LOG_DBG, "Cancel previous transaction");
            this._trx = null;
        }
        this.transactionTimer = new Date();

        this._trx = await this[kCache].createPutTransaction(guid, hash);
        helpers.log(consts.LOG_DBG, `Start transaction for GUID: ${helpers.GUIDBufferToString(guid)} Hash: ${hash.toString('hex')}`);
    }

    /**
     *
     * @returns {Promise<void>}
     * @private
     */
    async _onTransactionEnd() {
        if(!this._trx) {
            throw new Error("Invalid transaction isolation");
        }

        if (this.transactionTimer) {
            this.statsd.timing('trx-latency', this.transactionTimer);
            this.transactionTimer = null;
        }

        await this[kCache].endPutTransaction(this._trx);
        this.emit('onTransactionEnd', this._trx);
        helpers.log(consts.LOG_DBG, `End transaction for GUID: ${helpers.GUIDBufferToString(this._trx.guid)} Hash: ${this._trx.hash.toString('hex')}`);
        this._trx = null;
    }

    /**
     *
     * @param {String} type
     * @param {Number} size
     * @returns {Promise<void>}
     * @private
     */
    async _onPut(type, size) {
        if(!this._trx) {
            throw new Error("Not in a transaction");
        }

        this._putStream = await this._trx.getWriteStream(type, size);
        this._putStream.promiseWrite = promisify(this._putStream.write).bind(this._putStream);
        this._putSize = size;
        this._setWriteHandler(kReadStatePutStream);
    }
}

module.exports = CommandProcessor;