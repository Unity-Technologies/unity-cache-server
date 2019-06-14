const { Writable } = require('stream');
const fs = require('fs-extra');
const path = require('path');
const uuid = require('uuid');
const consts = require('../constants');
const helpers = require('../helpers');
const { defaultsDeep } = require('lodash');

const kRecordBufferSize = 1024 * 1024 * 10;

class ClientStreamRecorder extends Writable {
    constructor(options) {
        super(options);
        this._optionOverrides = {};
        this._options = options;
        this._sessionId = this._options.sessionId || uuid.v4();
        this._saveDir = this._options.saveDir || '.';
        this._bufferSize = this._options.bufferSize || kRecordBufferSize;
        this._bufferPos = 0;
        this._isRecording = false;
        this._buffer = Buffer.allocUnsafe(this._bufferSize);
        this.on('unpipe', () => this._finish_recording());
    }

    // noinspection JSMethodCanBeStatic
    get _optionsPath() {
        return 'Diagnostics.clientRecorderOptions';
    }

    get _options() {
        const opts = require('config').get(this._optionsPath);
        return defaultsDeep(this._optionOverrides, opts);
    }

    set _options(val) {
        if(typeof(val) === 'object')
            this._optionOverrides = val;
    }

    /**
     *
     * @returns {string}
     */
    get dataPath() {
        return path.join(this._saveDir, this._sessionId);
    }

    /**
     *
     * @param chunk {any}
     * @param encoding {string}
     * @param callback {function}
     * @private
     */
    _write(chunk, encoding, callback) {
        this._record_chunk(chunk).then(callback);
    }

    async _record_chunk(chunk) {
        this._isRecording = true;

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

        this._isRecording = false;
        this.emit('_record_chunk');
    }

    async _flush_buffer() {
        if(this._bufferPos === 0) return;

        await fs.ensureDir(this._saveDir);

        // Normalize the version size so it will be correctly parsed when streamed to a server.
        let zeroPad = 0;
        if(!await fs.pathExists(this.dataPath)) {
            for (let i = consts.PROTOCOL_VERSION_MIN_SIZE; i <= consts.VERSION_SIZE; i++) {
                zeroPad = consts.VERSION_SIZE - i;
                if (helpers.readUInt32(this._buffer.slice(0, i)) === consts.PROTOCOL_VERSION) break;
            }
        }

        const fd = await fs.open(this.dataPath, 'a');
        if(zeroPad > 0) await fs.write(fd, Buffer.alloc(zeroPad, '0', 'ascii'), 0);
        await fs.write(fd, this._buffer, 0, this._bufferPos);
        await fs.close(fd);
        this._bufferPos = 0;
    }

    async _finish_recording() {
        if(this._isRecording) {
            await new Promise(resolve => {
                this.once('_record_chunk', resolve);
            });
        }

        await this._flush_buffer();
        this.emit('finished');
    }
}

module.exports = ClientStreamRecorder;