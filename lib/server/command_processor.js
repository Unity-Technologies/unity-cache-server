const helpers = require('./../helpers');
const filesize = require('filesize');
const consts = require('./../constants');
const { Duplex, Writable } = require('stream');
const { promisify } = require('util');

const kSource = Symbol("source");
const kCache = Symbol("cache");
const kSendFileQueue = Symbol("sendFileQueue");
const kReadStream = Symbol("readStream");

class CommandProcessor extends Duplex {

    /**
     *
     * @param {CacheBase} cache
     */
    constructor(cache) {
        super();
        this[kCache] = cache;
        this[kSendFileQueue] = [];
        this[kReadStream] = null;

        this._writeHandlers = {
            putStream: this._handleWrite.bind(this),
            command: this._handleCommand.bind(this),
            version: this._handleVersion.bind(this),
            none: () => Promise.resolve()
        };

        this._writeHandler = this._writeHandlers.version;

        /**
         *
         * @type {PutTransaction}
         * @private
         */
        this._trx = null;

        const config = require('config');
        this._options = [];
        if(config.has(consts.CLI_CONFIG_KEYS.COMMAND_PROCESSOR)) {
            this._options = config.get(consts.CLI_CONFIG_KEYS.COMMAND_PROCESSOR);
        }

        this._putWhitelist = [];
        if(config.has(consts.CLI_CONFIG_KEYS.PUTWHITELIST)) {
            this._putWhitelist = this._options.putWhitelist;
            this._whitelistEmpty = (!Array.isArray(this._putWhitelist) || !this._putWhitelist.length);
        }

        if(!this._whitelistEmpty) {
            helpers.log(consts.LOG_INFO, `PUT whitelist: ${this._putWhitelist}`);
        }

        this._putStream = null;
        this._putSize = 0;
        this._putSent = 0;
        this._sendFileQueueChunkReads = 0;
        this._sendFileQueueReadDuration = 0;
        this._sendFileQueueReadBytes = 0;
        this._sendFileQueueSize = 0;
        this._sendFileQueueIndex = 0;
        this._sentFileCount = 0;
        this._isReading = false;
        this._testReadStreamDestroy = false;
        this._clientAddress = "(unknown)";
        this._registerEventListeners();
    }

    /**
     *
     * @returns {ReadStream}
     */
    get readStream() {
        return this[kReadStream];
    }

    /**
     *
     * @returns {*|String}
     */
    get clientAddress() {
        return this._clientAddress;
    }

    /**
     *
     * @returns {number}
     */
    get sentFileCount() {
        return this._sentFileCount;
    }

    /**
     *
     * @returns {number}
     */
    get sendFileQueueSize() {
        return this._sendFileQueueSize;
    }

    get _sendFileQueueLength() {
        const q = this[kSendFileQueue];
        return q ? q.length - this._sendFileQueueIndex : 0;
    }

    _registerEventListeners() {
        this.on('pipe', src => {
            this[kSource] = src;
            this._clientAddress = src.clientAddress;
        });

        this.on('unpipe', () => {
            this._printReadStats();
            this[kSource] = null;
            this[kSendFileQueue] = null;
            this._writeHandler = this._writeHandlers.none;

            if(this[kReadStream]) {
                this[kReadStream].destroy();
                this[kReadStream] = null;
                if(this._testReadStreamDestroy) this.emit('_testReadStreamDestroy');
            }
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
        this._writeHandler(chunk)
            .then(() => callback(), err => this._quit(err));
    }

    /**
     * @private
     */
    _readChunk() {
        if(this[kReadStream] === null || this[kSource] === null) return;

        let chunk;
        const rs = this[kReadStream];
        while((chunk = rs.read()) !== null) {
            this._sendFileQueueChunkReads++;
            this._sendFileQueueReadBytes += chunk.length;
            if(!this.push(chunk, 'ascii')) break;
        }
    }

    /**
     * @private
     */
    _endRead() {
        // Conditionally skipping setting this to null under test to reliably simulate a client dropping connection
        // during a file read. This ensures the `destroy()` logic during the unpipe event handler is called on the open stream.
        if(!this._testReadStreamDestroy) this[kReadStream] = null;
        this._isReading = false;
        this._sendFileQueueReadDuration += Date.now() - this._readStartTime;
        setImmediate(this._read.bind(this));
    }

    /**
     *
     * @param file
     * @returns {Buffer}
     * @private
     */
    _responseHeader(file) {
        const resp = file.exists
            ? Buffer.from(`+${file.type}${helpers.encodeInt64(file.size)}`, 'ascii')
            : Buffer.from(`-${file.type}`, 'ascii');

        return Buffer.concat([resp, file.guid, file.hash], resp.length + file.guid.length + file.hash.length);
    }

    /**
     * @private
     */
    _read() {
        // Continue file read in progress
        if(this._isReading) {
            return;
        }

        // No more files to send
        if(this._sendFileQueueLength === 0) {
            return;
        }

        // De-queue the next file
        const i = this._sendFileQueueIndex++;
        const file = this[kSendFileQueue][i];
        delete this[kSendFileQueue][i];

        // Respond with file-not-found header and early out, wait for next _read
        if(!file.exists) {
            this.push(this._responseHeader(file), 'ascii');
            return;
        }

        // Set the _isReading flag outside of the async operation, in case _read is called
        // again before the operation is complete.
        this._isReading = true;

        this[kCache].getFileStream(file.type, file.guid, file.hash)
            .then(stream => {
                this._sentFileCount++;
                this[kReadStream] = stream;
                this._readStartTime = Date.now();
                this.push(this._responseHeader(file), 'ascii');
                this[kReadStream].on('readable', this._readChunk.bind(this));
                this[kReadStream].once('end', this._endRead.bind(this));
            }).catch(err => {
                helpers.log(consts.LOG_ERR, `Error reading file for GUID: ${helpers.GUIDBufferToString(file.guid)} Hash: ${file.hash.toString('hex')}`);
                helpers.log(consts.LOG_ERR, err.message);
                this._isReading = false;
                file.exists = false; // generate a file-not-found response header
                this.push(this._responseHeader(file), 'ascii');
            });
    }

    /**
     * @private
     */
    _isWhitelisted(ip) {
        if(this._whitelistEmpty) return true;
        const [address] = ip.split(':');
        return this._putWhitelist.includes(address);
    }

    /**
     * @private
     */
    _printReadStats() {
        if(this._sendFileQueueReadDuration > 0) {
            const totalTime = this._sendFileQueueReadDuration / 1000;
            const throughput = (this._sendFileQueueReadBytes / totalTime).toFixed(2);
            helpers.log(consts.LOG_INFO, `Sent ${this.sentFileCount} of ${this.sendFileQueueSize} requested files (${this._sendFileQueueChunkReads} chunks) totaling ${filesize(this._sendFileQueueReadBytes)} in ${totalTime} seconds (${filesize(throughput)}/sec) to ${this.clientAddress}`);
        }
    }

    /**
     *
     * @param {Error?} err
     * @private
     */
   async _quit(err) {
       if(this[kSource] !== null) this[kSource].emit('quit');
       this._writeHandler = this._writeHandlers.none;
       if(err) {
           helpers.log(consts.LOG_ERR, err.message);
       }
    }

    /**
     *
     * @param {Buffer} data
     * @private
     */
    async _handleVersion(data) {
        let version = helpers.readUInt32(data);
        this._writeHandler = this._writeHandlers.command;

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
            this._writeHandler = this._writeHandlers.command;
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
                await this._quit();
                break;
            case 'ga':
            case 'gi':
            case 'gr':
                await this._onGet(type, guid, hash);
                break;
            case 'ts':
                await this._onTransactionStart(guid, hash);
                break;
            case 'te':
                await this._onTransactionEnd();
                break;
            case 'pa':
            case 'pi':
            case 'pr':
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
        const item = {
            exists: false,
            type,
            guid,
            hash
        };

        try {
            const info = await this[kCache].getFileInfo(type, guid, hash);
            item.exists = true;
            item.size = info.size;
            this._sendFileQueueSize++;
            helpers.log(consts.LOG_DBG, `Adding file to send queue, size ${info.size}`);
        }
        catch(err) {
            // Ignore error
        }
        finally {
            this[kSendFileQueue].push(item);
            if(this._sendFileQueueLength === 1) {
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

        this._trx = await this[kCache].createPutTransaction(guid, hash);
        this._trx.clientAddress = this.clientAddress;

        helpers.log(consts.LOG_DBG, `Start transaction for GUID: ${helpers.GUIDBufferToString(guid)} Hash: ${hash.toString('hex')}`);

        if(!this._isWhitelisted(this._trx.clientAddress)) {
            await this._trx.invalidate();
            helpers.log(consts.LOG_DBG, `Transaction invalidated from non-whitelisted IP: ${this._trx.clientAddress}`);
        }
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

        if (this._trx.isValid) {
            this._putStream = await this._trx.getWriteStream(type, size);
        } else {
            this._putStream = new Writable({
                write(chunk, encoding, cb) {
                    setImmediate(cb);
                }
            });
        }

        this._putStream.promiseWrite = promisify(this._putStream.write).bind(this._putStream);
        this._putSize = size;
        this._writeHandler = this._writeHandlers.putStream;
    }
}

module.exports = CommandProcessor;
