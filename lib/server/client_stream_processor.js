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
        this.errState = null;
        this._registerEventListeners();
        this._init();
    }

    _registerEventListeners() {
        var self = this;

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
            doReadIntegrityType: false,
            didReadIntegrityType: false,
            dataPassThrough: false,
            dataSize: 0,
            headerBufPos: 0,
            dataBytesRead: 0
        };
    }

    static errorCodes() {
        return {
            quitError: { msg: "Client quit" }
        }
    }

    _transform(data, encoding, callback) {
        while(data.length > 0 && this.errState === null) {
            if (this.readState.dataPassThrough)
                data = this._sendData(data);
            else
                data = this._sendCommands(data);

            if(this.errState !== null) {
                this.emit('error', this.errState);
            }
        }

        callback();
    }

    _sendData(data) {
        var len = Math.min(this.readState.dataSize - this.readState.dataBytesRead, data.length);
        this.push(data.slice(0, len));
        this.readState.dataBytesRead += len;

        if(this.readState.dataBytesRead == this.readState.dataSize) {
            this._init();
        }

        return len < data.length ? data.slice(len) : Buffer.from([]);
    }

    _sendCommands(data) {
        var self = this;
        var dataPos = 0;

        function fillBufferWithData(size) {
            if(dataPos >= data.length)
                return false;

            var toCopy = Math.min(size, data.length - dataPos);
            data.copy(self.headerBuf, self.readState.headerBufPos, dataPos, dataPos + toCopy);
            dataPos += toCopy;
            self.readState.headerBufPos += toCopy;

            return toCopy === size;
        }

        function isDone() {
            return dataPos >= data.length || self.errState !== null;
        }

        if(!this.didReadVersion) {
            var verSize = Math.max(consts.VERSION_SIZE, Math.min(consts.PROTOCOL_VERSION_MIN_SIZE, data.length));
            dataPos += verSize;

            this.didReadVersion = true;
            this.push(data.slice(0, verSize));
        }

        while(!isDone()) {
            // Quit?
            if (data[dataPos] === CMD_QUIT) {
                this.push(CMD_QUIT);
                this.errState = this.errorCodes.quitError;
                break;
            }

            // Read command
            if (!this.readState.didReadCmd) {
                if(!fillBufferWithData(consts.CMD_SIZE))
                    break;

                this.readState.didReadCmd = true;

                var cmd = this.headerBuf.slice(0, consts.CMD_SIZE).toString('ascii');

                switch (cmd[0]) {
                    case 'g': // get
                        this.readState.doReadId = true;
                        break;
                    case 'p': // put
                        this.readState.doReadSize = true;
                        break;
                    case 'i': // integrity check
                        this.readState.doReadIntegrityType = true;
                        break;
                    case 't': // transaction
                        if(cmd[1] == 's')
                            this.readState.doReadId = true;

                        break;
                    default:
                        this.errState = new Error("Unrecognized command, aborting!");
                        break;
                }
            }

            // Read size
            if (this.readState.doReadSize && !this.readState.didReadSize) {
                if(!fillBufferWithData(consts.SIZE_SIZE))
                    break;

                this.readState.didReadSize = true;
                this.readState.dataSize = helpers.readUInt64(this.headerBuf.slice(consts.CMD_SIZE, consts.CMD_SIZE + consts.SIZE_SIZE).toString('ascii'));
                this.readState.dataPassThrough = true;
            }

            // Read ID
            if (this.readState.doReadId && !this.readState.didReadId) {
                if(!fillBufferWithData(consts.ID_SIZE))
                    break;

                this.readState.didReadId = true;
           }

            // Read extra
            if (this.readState.doReadIntegrityType && !this.readState.didReadIntegrityType) {
                if(!fillBufferWithData(1))
                    break;

                this.readState.didReadIntegrityType = true;
          }

            this.push(Buffer.from(this.headerBuf.slice(0, this.readState.headerBufPos)));
            
            if(!this.readState.dataPassThrough)
                this._init();
            else
                break;
        }

        return dataPos < data.length ? data.slice(dataPos) : Buffer.from([]);
    }
}

module.exports = ClientStreamProcessor;