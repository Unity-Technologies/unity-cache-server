const consts = require('../constants');
const { Transform } = require('stream');
const helpers = require('../helpers');
const crypto = require('crypto');

class ClientStreamDebugger extends Transform {
    constructor(options) {
        super(options);

        this._writeHandlers = {
            putStream: this._handleWrite.bind(this),
            command: this._handleCommand.bind(this),
            version: this._handleVersion.bind(this)
        };

        this._putHash = null;
        this._putSize = 0;
        this._putSent = 0;
        this._writeHandler = this._writeHandlers.version;
    }

    _transform(chunk, encoding, callback) {
        this._writeHandler(chunk);
        this.push(chunk);
        callback();
    }

    /**
     *
     * @param {Buffer} data
     * @private
     */
    _handleVersion(data) {
        this.emit('debug', [helpers.readUInt32(data)]);
        this._writeHandler = this._writeHandlers.command;
    }

    /**
     *
     * @param {Buffer} data
     * @private
     */
    _handleWrite(data) {
        this._putSent += data.length;
        this._putHash.update(data, 'ascii');
        if(this._putSent === this._putSize) {
            this.emit('debug', [`<BLOB ${this._putHash.digest().toString('hex')}>`]);
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
    _handleCommand(data) {
        const cmd = data.slice(0, Math.min(data.length, 2)).toString('ascii');
        const eventData = [cmd];
        let size, guid, hash = null;

        if(data.length > 1) {
            if (data.length === 2 + consts.ID_SIZE) {
                guid = Buffer.from(data.slice(2, 2 + consts.GUID_SIZE));
                hash = Buffer.from(data.slice(2 + consts.HASH_SIZE));
                eventData.push(helpers.GUIDBufferToString(guid));
                eventData.push(hash.toString('hex'));
            }
            else if (data.length === 2 + consts.SIZE_SIZE) {
                size = helpers.readUInt64(data.slice(2));
                this._putSize = size;
                this._putHash = crypto.createHash('sha256');
                this._writeHandler = this._writeHandlers.putStream;
                eventData.push(size.toString());
            }
        }

        this.emit('debug', eventData);
    }
}

module.exports = ClientStreamDebugger;
