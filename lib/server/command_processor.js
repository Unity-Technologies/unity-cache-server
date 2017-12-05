const helpers = require('./../helpers');
const consts = require('./../constants').Constants;

const { Duplex } = require('stream');

const kSource = Symbol("source");
const kCache = Symbol("cache");
const kSendFileQueue = Symbol("sendFileQueue");
const kReadStateVersion = Symbol("readStateVersion");
const kReadStateCommand = Symbol("readStateCommand");
const kReadStatePutStream = Symbol("readStatePutStream");

class CommandProcessor extends Duplex {
    constructor(clientStreamProcessor, cache) {
        super();
        this[kSource] = clientStreamProcessor;
        this[kCache] = cache;
        this[kSendFileQueue] = [];
        this._readState = kReadStateVersion;
        this._trx = null;
        this._putStream = null;
        this._putSize = 0;
        this._putSent = 0;
    }

    _write(chunk, encoding, callback) {
        let handler = null;
        const self = this;

        switch(this._readState) {
            case kReadStateVersion:
                handler = this._handleVersion;
                break;
            case kReadStateCommand:
                handler = this._handleCommand;
                break;
            case kReadStatePutStream:
                handler = this._handleWrite;
                break;
            default:
                return callback(null);
        }

        handler.call(this, chunk, function(err) {
            if(err) {
                self._quit(err);
            }

            callback();
        });
    }

    _read_internal() {
        if(this[kSendFileQueue].length === 0) {
            this.push('');
            return;
        }

        let go = true;

        while(go && this[kSendFileQueue].length > 0) {
            let file = this[kSendFileQueue][0];

            if (file.header !== null) {
                let header = file.header;
                file.header = null;
                go = this.push(header, 'ascii');
                helpers.log(consts.LOG_DBG, `Sent header, size ${header.length}`);
            }

            let chunk = null;

            if (file.stream !== null && (chunk = file.stream.read()) !== null) {
                go = this.push(chunk, 'ascii');
            }

            if (chunk === null) {
                helpers.log(consts.LOG_DBG, `Finished send queue item, length is now ${this[kSendFileQueue].length}`);
                this[kSendFileQueue].shift();
            }
        }
   }

    _read() {
        let self = this;
        Promise.resolve().then(() => {
            self._read_internal();
        });
    }

    _quit(err) {
        this[kSource].unpipe(this);
        this[kSource].emit('quit');
        this._readState = null;
        err && helpers.log(consts.LOG_ERR, err);
    }
    
    _handleVersion(data, callback) {
        let version = helpers.readUInt32(data);
        this._readState = kReadStateCommand;
        let err = null;
        if(version !== consts.PROTOCOL_VERSION) {
            version = 0;
            err = new Error("Bad Client protocol version");
        }

        this.push(helpers.encodeInt32(version));
        callback(err);
    }

    _handleWrite(data, callback) {
        const self = this;

        this._putStream.write(data, 'ascii', function() {
            self._putSent += data.length;
            if(self._putSent === self._putSize) {
                self._readState = kReadStateCommand;
                self._putSent = 0;
                self._putSize = 0;
            }

            callback();
        });
    }

    _handleCommand(data, callback) {
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
        else if(data.length > 0) {
            cmd = data.toString('ascii');
        }
        else {
            return callback();
        }

        helpers.log(consts.LOG_DBG, "CP: Parsing command '" + cmd + "'");

        switch(cmd) {
            case 'q':
                this._quit();
                this._readState = null;
                break;
            case 'ga':
            case 'gi':
            case 'gr':
                this._onGet(type, guid, hash, callback);
                break;
            case 'ts':
                this._onTransactionStart(guid, hash, callback);
                break;
            case 'te':
                this._onTransactionEnd(callback);
                break;
            case 'pa':
            case 'pi':
            case 'pr':
                this._onPut(type, size, callback);
                break;
            default:
                callback(new Error("Unrecognized command '" + cmd + "'"));
        }
    }

    _onGet(type, guid, hash, callback) {
        let self = this;
        this[kCache].getFileStream(type, guid, hash, function(err, result) {

            if(err || result === null) {
                let resp = Buffer.from('-' + type, 'ascii');
                self[kSendFileQueue].push({
                    header: Buffer.concat([resp, guid, hash], 34),
                    stream: null
                });
            }
            else {
                let resp = Buffer.from('+' + type + helpers.encodeInt64(result.size), 'ascii');
                self[kSendFileQueue].push({
                    size: result.size,
                    header: Buffer.concat([resp, guid, hash], 50),
                    stream: result.stream
                });

                helpers.log(consts.LOG_DBG, "CP: Adding file to send queue, size " + result.size);
            }

            if(self[kSendFileQueue].length === 1)
                self._read(self._readState.highWaterMark);

            callback(null);
        });
    }

    _onTransactionStart(guid, hash, callback) {
        const self = this;

        if(this._trx !== null) {
            helpers.log(consts.LOG_DBG, "Cancel previous transaction");
            this._trx = null;
        }

        this[kCache].createPutTransaction(guid, hash, function(err, trx) {
            if(err) {
                return callback(err);
            }

            helpers.log(consts.LOG_DBG, "Start transaction for " + guid.toString('hex') + "-" + hash.toString('hex'));
            self._trx = trx;
            callback(null);
        });
    }

    _onTransactionEnd(callback) {
        const self = this;

        if(!this._trx) {
            return callback(new Error("Invalid transaction isolation"));
        }

        this[kCache].endPutTransaction(this._trx, function(err) {
            helpers.log(consts.LOG_DBG, "End transaction for " + self._trx.guid.toString('hex') + "-" + self._trx.hash.toString('hex'));
            self._trx = null;
            callback(err);
        });
    }

    _onPut(type, size, callback) {
        const self = this;

        if(!this._trx) {
            return callback(new Error("Not in a transaction"));
        }

        this._trx.getWriteStream(type, size, function(err, stream) {
            if(err) {
                return callback(err);
            }

            self._putStream = stream;
            self._putSize = size;
            self._readState = kReadStatePutStream;
            callback(null);
        });
    }
}

module.exports = CommandProcessor;