const helpers = require('./../helpers');
const consts = require('./../constants');
const Transform  = require('stream').Transform;

const MAX_HEADER_SIZE = consts.CMD_SIZE + consts.SIZE_SIZE + consts.ID_SIZE;
const TOKEN_FILE_FOUND = "+";
const TOKEN_FILE_NOT_FOUND = "-";

class ServerStreamProcessor extends Transform {
    constructor() {
        super();
        this._headerBuf = Buffer.allocUnsafe(MAX_HEADER_SIZE);
        this.didReadVersion = false;
        this.version = 0;
        this._errState = null;
        this._init();
    }

    _init() {
        this.readState = {
            headerData: {},
            dataPassThrough : false,
            didReadCmd: false,
            doReadSize : false,
            doReadId: false,
            headerBufPos: 0,
            headerSize: consts.CMD_SIZE,
            dataBytesRead: 0
        };

        this.readState.headerData.version = this.version;
    }

    // noinspection JSUnusedGlobalSymbols
    _transform(data, encoding, callback) {
        while(data !== null && data.length > 0) {
            if (this.readState.dataPassThrough) {
                data = this._sendData(data);
            }
            else {
                data = this._emitHeader(data);
            }

            if(this._errState !== null) {
                helpers.log(consts.LOG_ERR, this._errState);
                break;
            }
        }

        callback();
    }

    _sendData(data) {
        const len = Math.min(this.readState.headerData.size - this.readState.dataBytesRead, data.length);
        this.push(data.slice(0, len));
        this.readState.dataBytesRead += len;

        if(this.readState.dataBytesRead === this.readState.headerData.size) {
            this._init();
            this.emit('dataEnd');
        }

        return len < data.length ? data.slice(len) : null;
    }

    _emitHeader(data) {
        const self = this;
        let dataPos = 0;

        function fillBufferWithData() {
            // Only copy as much as we need for the remaining header size
            const size = self.readState.headerSize - self.readState.headerBufPos;

            // Don't copy past the remaining bytes in the data block
            const toCopy = Math.min(size, data.length - dataPos);

            data.copy(self._headerBuf, self.readState.headerBufPos, dataPos, dataPos + toCopy);
            dataPos += toCopy;
            self.readState.headerBufPos += toCopy;

            return self.readState.headerBufPos === self.readState.headerSize;
        }

        function isDone() {
            return dataPos >= data.length || self._errState !== null;
        }

        // Read version
        if (!this.didReadVersion) {
            this.version = helpers.readUInt32(data.slice(0, consts.VERSION_SIZE));
            dataPos += Math.min(data.length, consts.VERSION_SIZE);
            this.readState.headerData.version = this.version;
            this.didReadVersion = true;
        }

        while(!isDone()) {

            if(!fillBufferWithData())
                break;

            // Read command
            if (!this.readState.didReadCmd) {
                this.readState.didReadCmd = true;

                const cmd = this._headerBuf.slice(0, consts.CMD_SIZE).toString('ascii');

                this.readState.headerData.cmd = cmd;
                this.readState.doReadId = true;
                this.readState.headerSize += consts.ID_SIZE;

                switch (cmd[0]) {
                    case TOKEN_FILE_FOUND:
                        this.readState.doReadSize = true;
                        this.readState.headerSize += consts.SIZE_SIZE;
                        break;
                    case TOKEN_FILE_NOT_FOUND:
                        break;
                    default:
                        this._errState = new Error(`Unrecognized command response, aborting! (${cmd})`);
                }

                if(this._errState || !fillBufferWithData())
                    break;
            }

            let pos = consts.CMD_SIZE;

            if (this.readState.doReadSize) {
                this.readState.headerData.size = helpers.readUInt64(this._headerBuf.slice(pos, pos + consts.UINT64_SIZE));
                pos += consts.UINT64_SIZE;
                this.readState.dataPassThrough = true;
            }

            if(this.readState.doReadId) {
                this.readState.headerData.guid = this._headerBuf.slice(pos, pos + consts.GUID_SIZE);
                pos += consts.GUID_SIZE;
                this.readState.headerData.hash = this._headerBuf.slice(pos, pos + consts.HASH_SIZE);
            }

            this.emit('header', Object.assign({}, this.readState.headerData));

            if(this.readState.dataPassThrough) {
                break;
            }

            this._init();
        }

        return dataPos < data.length ? data.slice(dataPos) : null;
    }
}

module.exports = ServerStreamProcessor;