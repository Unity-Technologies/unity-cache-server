const { Writable } = require('stream');
const fs = require('fs-extra');
const path = require('path');
const uuid = require('uuid');
const consts = require('../constants');
const helpers = require('../helpers');

const kRecordBufferSize = 1024 * 1024 * 10;

class ClientStreamRecorder extends Writable {
    constructor(options) {
        super(options);
        this._sessionId = options.sessionId || uuid.v4();
        this._saveDir = path.join(options.saveDir || '', this._sessionId);
        this._bufferSize = options.bufferSize || kRecordBufferSize;
        this._bufferPos = 0;
        this._bufferId = 0;
        this._buffer = Buffer.allocUnsafe(this._bufferSize);

        this.on('unpipe', () => {
            process.nextTick(this._flush_buffer.bind(this));
        });
    }

    _write(chunk, encoding, callback) {
        this._record_chunk(chunk).then(() => {
            callback();
        });
    }

    async _record_chunk(chunk) {
        let slice = chunk;
        if(this._bufferPos + slice.length > this._bufferSize) {
            slice = chunk.slice(0, this._bufferSize - this._bufferPos);
        }

        slice.copy(this._buffer, this._bufferPos, 0, slice.length);
        this._bufferPos += slice.length;
        if(this._bufferPos === this._bufferSize) {
            await this._flush_buffer();
        }

        if(slice.length < chunk.length) {
            await this._record_chunk(chunk.slice(slice.length));
        }
    }

    async _flush_buffer() {
        await fs.ensureDir(this._saveDir);
        const filePath = path.join(this._saveDir, `session.${this._bufferId}.data`);

        // Normalize the version size so it will be correctly parsed when streamed to a server.
        let zeroPad = 0;
        if(!await fs.pathExists(filePath)) {
            for (let i = consts.PROTOCOL_VERSION_MIN_SIZE; i <= consts.VERSION_SIZE; i++) {
                zeroPad = consts.VERSION_SIZE - i;
                if (helpers.readUInt32(this._buffer.slice(0, i)) === consts.PROTOCOL_VERSION) break;
            }
        }

        const fd = await fs.open(filePath, 'a');
        if(zeroPad > 0) await fs.write(fd, Buffer.alloc(zeroPad, '0', 'ascii'), 0);
        await fs.write(fd, this._buffer, 0, this._bufferPos);
        await fs.close(fd);
        this._bufferPos = 0;
        this._bufferId++;
    }
}

module.exports = ClientStreamRecorder;