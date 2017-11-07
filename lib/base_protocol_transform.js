const assert = require('assert');
const helpers = require('./helpers');
const consts = require('./constants').Constants;
const Transform = require('stream').Transform;

const MAX_HEADER_SIZE = consts.ID_SIZE;

class BaseProtocolTransform extends Transform {
    constructor() {
        super();

        this.headerBuf = Buffer.allocUnsafe(MAX_HEADER_SIZE);
        this._init();
    }

    _init() {
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

    _emitHeader(data, callback) {}

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
            this._init();
            this.emit('dataEnd');
        }
    }
}

module.exports.Transform = BaseProtocolTransform;