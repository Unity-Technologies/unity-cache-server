const helpers = require('./../helpers');
const consts = require('./../constants').Constants;
const { Transform } = require('stream');

const MAX_HEADER_SIZE = consts.ID_SIZE;

class CacheServerResponseTransform extends Transform {
    constructor() {
        super();
        this.headerBuf = Buffer.allocUnsafe(MAX_HEADER_SIZE);
        this._init();
    }

    _init() {
        this.didReadHeader = false;
        this.headerData = {};
        this.headerBufPos = 0;
        this.blobBytesRead = 0;
        this.doReadSize = false;
        this.doReadId = false;
    }

    _transform(data, encoding, callback) {
        if(this.didReadHeader) {
            this._sendData(data, callback);
        }
        else {
            this._emitHeader(data, callback);
        }
    }

    _sendData(data, callback) {
        const len = Math.min(this.headerData.size - this.blobBytesRead, data.length);
        this.blobBytesRead += len;

        if(len >= data.length) {
            this.push(data);
            callback();
        }
        else {
            this.push(data.slice(0, len));
            this._emitHeader(data.slice(len), callback);
        }

        if(this.blobBytesRead === this.headerData.size) {
            this._init();
            this.emit('dataEnd');
        }
    }

    _emitHeader(data, callback) {
        const self = this;
        let dataPos = 0;

        function fillBufferWithData(fillToPos) {
            const maxLen = fillToPos - self.headerBufPos;
            const toCopy = Math.min(data.length, maxLen);
            data.copy(self.headerBuf, self.headerBufPos, dataPos, dataPos + toCopy);
            dataPos += toCopy;
            self.headerBufPos += toCopy;

            if(fillToPos === self.headerBufPos) {
                self.headerBufPos = 0;
                return true;
            }

            return false;
        }

        function isDone() {
            return dataPos >= data.length || self.didReadHeader;
        }

        function didRead(key) {
            return self.headerData.hasOwnProperty(key);
        }

        // Read version
        if(!didRead('version') && fillBufferWithData(consts.VERSION_SIZE)) {
            this.headerData.version = helpers.readUInt32(this.headerBuf.slice(0, consts.VERSION_SIZE));
        }

        if(isDone()) { return callback(); }

        // Read command
        if(!didRead('cmd') && fillBufferWithData(consts.CMD_SIZE)) {
            const cmd = this.headerBuf.slice(0, consts.CMD_SIZE).toString('ascii');
            this.headerData.cmd = cmd;
            switch(cmd[0]) {
                case '+': // file found
                    this.doReadSize = true;
                    this.doReadId = true;
                    break;
                case '-': // file not found
                    this.doReadSize = false;
                    this.doReadId = true;
                    break;
                default:
                    return callback(new Error("Unrecognized command response, aborting!"));
            }
        }

        if(isDone()) { return callback(); }

        // Read size
        if(this.doReadSize && !didRead('size') && fillBufferWithData(consts.SIZE_SIZE)) {
            this.headerData.size = helpers.readUInt64(this.headerBuf.slice(0, consts.UINT64_SIZE));
        }

        if(isDone()) { return callback(); }

        // Read ID
        if(this.doReadId && !didRead('guid') && fillBufferWithData(consts.ID_SIZE)) {
            this.headerData.guid = this.headerBuf.slice(0, consts.GUID_SIZE);
            this.headerData.hash = this.headerBuf.slice(consts.GUID_SIZE);
        }

        this.didReadHeader = true;
        this.emit('header', Object.assign({}, this.headerData));

        // Send any remaining bytes in the buffer as blob data
        if(dataPos < data.length) {
            this._sendData(data.slice(dataPos), callback);
        }
        else {
            callback();
        }
    }
}

module.exports = CacheServerResponseTransform;