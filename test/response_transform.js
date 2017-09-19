const assert = require('assert');
const globals = require('./globals');
const Transform = require('stream').Transform;

const MAX_HEADER_SIZE = globals.ID_SIZE;

class CacheServerResponseTransform extends Transform {
    constructor() {
        super();

        this.headerBuf = Buffer.allocUnsafe(MAX_HEADER_SIZE);
        this.init();
    }

    init() {
        this.headerBufPos = 0;
        this.blobBytesRead = 0;
        this.doReadSize = false;
        this.doReadId = false;
        this.didReadHeader = false;
        this.headerData = {};
    }

    _transform(data, encoding, callback) {
        if(this.didReadHeader) {
            this._sendData(data, callback);
        }
        else {
            this._emitHeader(data, callback);
        }
    }

    _emitHeader(data, callback) {
        var self = this;
        var dataPos = 0;
        function writeHeaderBuffer(fillToPos) {
            var maxLen = fillToPos - self.headerBufPos;
            var toCopy = Math.min(data.length, maxLen);
            data.copy(self.headerBuf, self.headerBufPos, dataPos, dataPos + toCopy);
            dataPos += toCopy;
            self.headerBufPos += toCopy;

            if(fillToPos == self.headerBufPos) {
                self.headerBufPos = 0;
                return true;
            }

            return false;
        }

        function isDone() {
            return dataPos >= data.length || self.didReadHeader;
        }

        function didWrite(key) {
            return self.headerData.hasOwnProperty(key);
        }

        // Read version
        if(!didWrite('version') && writeHeaderBuffer(globals.VERSION_SIZE)) {
            this.headerData.version = globals.bufferToInt32(this.headerBuf.slice(0, globals.VERSION_SIZE));
        }

        if(isDone()) { return callback(); }

        // Read command
        if(!didWrite('cmd') && writeHeaderBuffer(globals.CMD_SIZE)) {
            var cmd = this.headerBuf.slice(0, globals.CMD_SIZE).toString('ascii');
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
                case 'i': // integrity check
                    this.doReadSize = true;
                    this.doReadId = false;
                    break;
                default:
                    return callback(new Error("Unrecognized command response, aborting!"));
            }
        }

        if(isDone()) { return callback(); }

        // Read size
        if(this.doReadSize && !didWrite('size') && writeHeaderBuffer(globals.SIZE_SIZE)) {
            this.headerData.size = globals.bufferToInt64(this.headerBuf.slice(0, globals.UINT64_SIZE));
        }

        if(isDone()) { return callback(); }

        // Read ID
        if(this.doReadId && !didWrite('guid') && writeHeaderBuffer(globals.ID_SIZE)) {
            this.headerData.guid = this.headerBuf.slice(0, globals.GUID_SIZE);
            this.headerData.hash = this.headerBuf.slice(globals.GUID_SIZE);
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

    _sendData(data, callback) {
        var len = Math.min(this.headerData.size - this.blobBytesRead, data.length);
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
            this.init();
            this.emit('dataEnd');
        }
    }
}

module.exports = CacheServerResponseTransform;