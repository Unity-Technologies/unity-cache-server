require('./test_init');

const assert = require('assert');
const uuid = require('uuid');
const tmp = require('tmp');
const fs = require('fs-extra');
const {promisify} = require('util');
const {Readable} = require('stream');
const consts = require('../lib/constants');
const {encodeCommand, cmd, randomBuffer} = require('./test_utils');
const ClientStreamRecorder = require('../lib/server/client_stream_recorder');


describe('ClientStreamRecorder', () => {

    before(() => {
        this.tmpDir = tmp.dirSync({unsafeCleanup: true});
    });

    after(() => {
        this.tmpDir.removeCallback();
    });

    it('should set default for missing options', () => {
        const csr = new ClientStreamRecorder({});
        assert(csr._sessionId);
        assert(csr._saveDir);
        assert(csr._bufferSize);
    });

    it('should use options passed into constructor', () => {
        const opts = {
            sessionId: uuid.v4(),
            saveDir: this.tmpDir.name,
            bufferSize: Math.floor(Math.random() * 100000)
        };

        const csr = new ClientStreamRecorder(opts);
        assert.strictEqual(csr._sessionId, opts.sessionId);
        assert.strictEqual(csr._saveDir, opts.saveDir);
        assert.strictEqual(csr._bufferSize, opts.bufferSize);
    });

    it('should not write diagnostic file if client did not send any data', async () => {
        const opts = {
            saveDir: this.tmpDir.name,
            bufferSize: 1024
        };

        const csr = new ClientStreamRecorder(opts);
        const csrWrite = promisify(csr.write).bind(csr);
        const dataPath = csr.dataPath;

        await csrWrite(Buffer.alloc(0));
        assert(!await fs.pathExists(dataPath));
        csr.emit('unpipe'); // triggers a buffer flush
        await csrWrite(Buffer.alloc(1025));
        csr.emit('unpipe');
        assert(await fs.pathExists(dataPath));
    });


    it('should not write to disk until the internal buffer is full', async () => {
        const opts = {
            saveDir: this.tmpDir.name,
            bufferSize: 1024
        };

        const csr = new ClientStreamRecorder(opts);
        const csrWrite = promisify(csr.write).bind(csr);
        const dataPath = csr.dataPath;

        await csrWrite(Buffer.alloc(1023));
        assert(!await fs.pathExists(dataPath));
        await csrWrite(Buffer.alloc(2));
        assert(await fs.pathExists(dataPath));
    });

    it('should write the command buffer to disk with a normalized protocol version', async () => {
        const opts = {
            saveDir: this.tmpDir.name,
            bufferSize: 64
        };

        const csr = new ClientStreamRecorder(opts);

        const guid = randomBuffer(consts.GUID_SIZE);
        const hash = randomBuffer(consts.HASH_SIZE);

        let buffer = Buffer.from('fe' +
            encodeCommand(cmd.getAsset, guid, hash) +
            encodeCommand(cmd.getInfo, guid, hash) +
            encodeCommand(cmd.getResource, guid, hash), 'ascii');

        const reader = new Readable({
            read() {
                this.push(buffer);
                this.push(null);
            }
        });

        reader.pipe(csr);

        await new Promise(resolve => {
            reader.on('end', () => {
                reader.unpipe();
                resolve();
            });
        });

        await new Promise(resolve => {
            csr.on('finished', () => resolve());
        });

        assert(await fs.pathExists(csr.dataPath));
        const fileData = await fs.readFile(csr.dataPath);

        // zero pad the input buffer to match expected file data
        buffer = Buffer.concat([Buffer.from('000000'), buffer]);
        assert.strictEqual(Buffer.compare(fileData, buffer), 0);
    });
});