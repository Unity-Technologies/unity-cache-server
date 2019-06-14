const helpers = require('./../helpers');
const consts = require('./../constants');
const Transform = require('stream').Transform;
const assert = require('assert');

const CMD_QUIT = 'q'.charCodeAt(0);
const MAX_HEADER_SIZE = consts.CMD_SIZE + consts.ID_SIZE;
const kSource = Symbol();

class ClientStreamProcessor extends Transform {
    constructor(options) {
        super();

        this._options = options || {};
        this._headerBuf = Buffer.allocUnsafe(MAX_HEADER_SIZE);
        this._errState = null;
        this._readState = {};

        this._transformHandlers = {
            command: this._sendCommands.bind(this),
            data: this._sendData.bind(this),
            version: this._sendVersion.bind(this)
        };

        this._transformHandler = this._transformHandlers.version;

        this._registerEventListeners();
        this._init();
    }

    /**
     *
     * @returns {string}
     */
    get clientAddress() {
        return this._options.clientAddress || "";
    }

    _registerEventListeners() {
        const self = this;

        this.on('pipe', function(src) {
            self[kSource] = src;
        });
        
        this.on('quit', function() {
            self[kSource].destroy();
        });
    }

    _init() {
        const readState = this._readState;
        readState.version = '';
        readState.doReadSize = false;
        readState.doReadId = false;
        readState.didParseCmd = false;
        readState.dataSize = 0;
        readState.headerBufPos = 0;
        readState.headerSize  = consts.CMD_SIZE;
        readState.dataBytesRead = 0;
    }

    // noinspection JSUnusedGlobalSymbols
    _transform(data, encoding, callback) {
        while(data !== null) {
            data = this._transformHandler(data, this._readState);
            if(this._errState !== null) {
                helpers.log(consts.LOG_ERR, this._errState);
                this.push('q');
                break;
            }
        }

        callback();
    }

    _sendVersion(data, readState) {
        const len = Math.min(consts.VERSION_SIZE - readState.version.length, data.length);
        readState.version += data.slice(0, len).toString('ascii');

        if(readState.version.length < consts.PROTOCOL_VERSION_MIN_SIZE) {
            return null;
        }

        this.push(readState.version);
        this._transformHandler = this._transformHandlers.command;

        return len < data.length ? data.slice(len) : null;
    }

    _sendData(data, readState) {
        const len = Math.min(readState.dataSize - readState.dataBytesRead, data.length);
        this.push(data.slice(0, len));
        readState.dataBytesRead += len;

        if(readState.dataBytesRead === readState.dataSize) {
            this._init();
            this._transformHandler = this._transformHandlers.command;
        }

        return len < data.length ? data.slice(len) : null;
    }

    _sendCommands(data, readState) {
        const self = this;
        const headerBuf = this._headerBuf;
        let dataPos = 0;

        function fillBufferWithData() {
            // Only copy as much as we need for the remaining header size
            const size = readState.headerSize - readState.headerBufPos;

            // Don't copy past the remaining bytes in the data block
            const toCopy = Math.min(size, data.length - dataPos);

            data.copy(headerBuf, readState.headerBufPos, dataPos, dataPos + toCopy);
            dataPos += toCopy;
            readState.headerBufPos += toCopy;
            assert(readState.headerBufPos <= headerBuf.length);

            return readState.headerBufPos === readState.headerSize;
        }

        function isDone() {
            return dataPos >= data.length || self._errState !== null;
        }

        while(!isDone()) {
            // Read command

            if(!fillBufferWithData()) {

                // Quit?
                if (!readState.didParseCmd && data[data.length - 1] === CMD_QUIT) {
                    this.push('q');
                }

                break;
            }

            if(!readState.didParseCmd) {
                readState.didParseCmd = true;

                const cmd = headerBuf.slice(0, consts.CMD_SIZE).toString('ascii');

                switch (cmd[0]) {
                    case 'g': // get
                        readState.doReadId = true;
                        readState.headerSize += consts.ID_SIZE;
                        break;
                    case 'p': // put
                        readState.doReadSize = true;
                        readState.headerSize += consts.SIZE_SIZE;
                        break;
                    case 't': // transaction
                        if (cmd[1] === 's') {
                            readState.doReadId = true;
                            readState.headerSize += consts.ID_SIZE;
                        }

                        break;
                    default:
                        this._errState = new Error("Unrecognized command, aborting!");
                        break;
                }

                this.emit('cmd', cmd);

                if (!fillBufferWithData()) {
                    break;
                }
            }

            // noinspection JSCheckFunctionSignatures
            this.push(Buffer.from(headerBuf.slice(0, readState.headerBufPos)));

            if (readState.doReadSize) {
                readState.dataSize = helpers.readUInt64(headerBuf.slice(consts.CMD_SIZE, consts.CMD_SIZE + consts.SIZE_SIZE));
                this._transformHandler = this._transformHandlers.data;
                break;
            }

            this._init();
        }

        return dataPos < data.length ? data.slice(dataPos) : null;
    }
}

module.exports = ClientStreamProcessor;