const assert = require('assert');
const helpers = require('./../helpers');
const consts = require('./../constants').Constants;

const { Transform } = require('stream');

const CMD_QUIT = 'q'.charCodeAt(0);
const MAX_HEADER_SIZE = consts.CMD_SIZE + consts.ID_SIZE;
const kSource = Symbol("source");

class ClientStreamProcessor extends Transform {
    constructor() {
        super();

        this.headerBuf = Buffer.allocUnsafe(MAX_HEADER_SIZE);
        this.didReadVersion = false;
        this.version = '';
        this.errState = null;
        this._registerEventListeners();
        this._init();
    }

    _registerEventListeners() {
        const self = this;

        this.on('pipe', function(src) {
            self[kSource] = src;
        });
        
        this.on('quit', function() {
            self[kSource].destroy();
        })
    }

    _init() {
        this.readState = {
            didReadCmd: false,
            doReadSize: false,
            didReadSize: false,
            doReadId: false,
            didReadId: false,
            dataPassThrough: false,
            dataSize: 0,
            headerBufPos: 0,
            headerSize : consts.CMD_SIZE,
            dataBytesRead: 0
        };
    }

    static get errorCodes() {
        return {
            quitError: { msg: "Client quit" }
        }
    }

    _transform(data, encoding, callback) {
        while(data !== null && data.length > 0 && this.errState === null) {
            if (this.readState.dataPassThrough)
                data = this._sendData(data);
            else
                data = this._sendCommands(data);

            if(this.errState !== null) {
                helpers.log(consts.LOG_ERR, this.errState.msg);
            }
        }

        callback();
    }

    _sendData(data) {
        const len = Math.min(this.readState.dataSize - this.readState.dataBytesRead, data.length);
        this.push(data.slice(0, len));
        this.readState.dataBytesRead += len;

        if(this.readState.dataBytesRead === this.readState.dataSize) {
            this._init();
        }

        return len < data.length ? data.slice(len) : Buffer.from([]);
    }

    _sendCommands(data) {
        const self = this;
        let dataPos = 0;

        function fillBufferWithData() {
            if(dataPos >= data.length)
                return false;

            // Only copy as much as we need for the remaining header size
            let size = self.readState.headerSize - self.readState.headerBufPos;

            // Don't copy past the remaining bytes in the data block
            const toCopy = Math.min(size, data.length - dataPos);

            data.copy(self.headerBuf, self.readState.headerBufPos, dataPos, dataPos + toCopy);
            dataPos += toCopy;
            self.readState.headerBufPos += toCopy;

            return self.readState.headerBufPos === self.readState.headerSize;
        }

        function isDone() {
            return dataPos >= data.length || self.errState !== null;
        }

        if(!this.didReadVersion) {
            let len = Math.min(consts.VERSION_SIZE - this.version.length, data.length);
            this.version += data.slice(0, len).toString('ascii');
            dataPos += len;

            if(this.version.length < consts.PROTOCOL_VERSION_MIN_SIZE) {
                return null;
            }

            this.push(this.version);
            this.didReadVersion = true;
        }

        while(!isDone()) {
            // Read command
            if (!this.readState.didReadCmd) {
                if(!fillBufferWithData()) {

                    // Quit?
                    if (data[data.length - 1] === CMD_QUIT) {
                        this.push('q');
                        this.errState = ClientStreamProcessor.errorCodes.quitError;
                    }

                    break;
                }

                this.readState.didReadCmd = true;

                const cmd = this.headerBuf.slice(0, consts.CMD_SIZE).toString('ascii');

                switch (cmd[0]) {
                    case 'g': // get
                        this.readState.doReadId = true;
                        this.readState.headerSize += consts.ID_SIZE;
                        break;
                    case 'p': // put
                        this.readState.doReadSize = true;
                        this.readState.headerSize += consts.SIZE_SIZE;
                        break;
                    case 't': // transaction
                        if(cmd[1] === 's') {
                            this.readState.doReadId = true;
                            this.readState.headerSize += consts.ID_SIZE;
                        }

                        break;
                    default:
                        this.errState = new Error("Unrecognized command, aborting!");
                        break;
                }
            }

            // Read size
            if (this.readState.doReadSize && !this.readState.didReadSize) {
                if(!fillBufferWithData())
                    break;

                this.readState.didReadSize = true;
                this.readState.dataSize = helpers.readUInt64(this.headerBuf.slice(consts.CMD_SIZE, consts.CMD_SIZE + consts.SIZE_SIZE).toString('ascii'));
                this.readState.dataPassThrough = true;
            }

            // Read ID
            if (this.readState.doReadId && !this.readState.didReadId) {
                if(!fillBufferWithData())
                    break;

                this.readState.didReadId = true;
           }

            this.push(Buffer.from(this.headerBuf.slice(0, this.readState.headerBufPos)));

            if(!this.readState.dataPassThrough)
                this._init();
            else
                break;
        }

        return dataPos < data.length ? data.slice(dataPos) : null;
    }
}

module.exports = ClientStreamProcessor;