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
        this.didReadVersion = false;
        this.didReadCommand = false;
        this.didReadSize = false;
        this.didReadId = false;
        this.didReadHeader = false;

        this.headerData = {
            version: 0,
            cmd: "",
            size: 0,
            guid: null,
            hash: null
        }
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

        // Read version
        if(!this.didReadVersion && writeHeaderBuffer(globals.VERSION_SIZE)) {
            this.headerData.version = globals.bufferToInt32(this.headerBuf.slice(0, globals.VERSION_SIZE));
            this.didReadVersion = true;
        }

        if(isDone()) { return callback(); }

        // Read command
        if(!this.didReadCommand && writeHeaderBuffer(globals.CMD_SIZE)) {
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
                    return;
            }

            this.didReadCommand = true;
        }

        if(isDone()) { return callback(); }

        // Read size
        if(this.doReadSize && !this.didReadSize && writeHeaderBuffer(globals.SIZE_SIZE)) {
            this.headerData.size = globals.bufferToInt64(this.headerBuf.slice(0, globals.UINT64_SIZE));
            this.didReadSize = true;
        }

        if(isDone()) { return callback(); }

        // Read ID
        if(this.doReadId && !this.didReadId && writeHeaderBuffer(globals.ID_SIZE)) {
            this.headerData.guid = this.headerBuf.slice(0, globals.GUID_SIZE);
            this.headerData.hash = this.headerBuf.slice(globals.GUID_SIZE);
            this.didReadId = true;
        }

        this.didReadHeader = true;
        this.emit('header', this.headerData);

        // Send any remaining bytes in the buffer as blob data
        if(dataPos < data.length) {
            process.nextTick(this._sendData.bind(this, data.slice(dataPos), callback));
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
            process.nextTick(this._emitHeader.bind(this, data.slice(len), callback));
        }

        if(this.blobBytesRead === this.headerData.size) {
            this.init();
            this.emit('dataEnd');
        }
    }
}

module.exports = CacheServerResponseTransform;