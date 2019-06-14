require('./test_init');

const assert = require('assert');
const crypto = require('crypto');
const loki = require('lokijs');
const tmp = require('tmp');
const sinon = require('sinon');

const helpers = require('../lib/helpers');
const consts = require('../lib/constants');
const CacheServer = require('../lib/server/server');
const ServerStreamProcessor = require('../lib/client/server_stream_processor.js');
const CommandProcessor = require('../lib/server/command_processor');

const {
    generateCommandData,
    encodeCommand,
    expectLog,
    cmd,
    clientWrite,
    readStream,
    getClientPromise
} = require('./test_utils');


const SMALL_MIN_FILE_SIZE = 64;
const SMALL_MAX_FILE_SIZE = 128;
const MIN_FILE_SIZE = 1024;
const MAX_FILE_SIZE = 1024 * 1024;
const SMALL_PACKET_SIZE = 64;
const MED_PACKET_SIZE = 1024;
const LARGE_PACKET_SIZE = 1024 * 16;

let cache, server, client, cmdProc;

const test_modules = [
    {
        tmpDir: tmp.dirSync({unsafeCleanup: true}),
        name: "cache_ram",
        path: "../lib/cache/cache_ram",
        options: {
            pageSize: MAX_FILE_SIZE,
            minFreeBlockSize: 1024,
            highReliability: true,
            highReliabilityOptions: {
                reliabilityThreshold: 0
            },
            persistenceOptions: {
                autosave: false,
                adapter: new loki.LokiMemoryAdapter()
            }
        }
    },
    {
        tmpDir: tmp.dirSync({unsafeCleanup: true}),
        name: "cache_fs",
        path: "../lib/cache/cache_fs",
        options: {
            highReliability: true,
            highReliabilityOptions: {
                reliabilityThreshold: 0
            },
            persistenceOptions: {
                autosave: false
            }
        }
    }
    ];

describe("Protocol", () => {
    test_modules.forEach(module => {
        describe(module.name, function() {

            before(async () => {
                /** @type {CacheBase} **/
                const CacheModule = require(module.path);
                cache = new CacheModule();

                module.options.cachePath = module.tmpDir.name;

                await cache.init(module.options);
                server = new CacheServer(cache, {port: 0});
                await server.start(err => assert(!err, `Cache Server reported error!  ${err}`));

                server.server.on('connection', socket => {
                    // pipes expected to look like this: socket | ClientStreamProcessor | CommandProcessor
                    cmdProc = socket._readableState.pipes._readableState.pipes;
                    assert.ok(cmdProc instanceof CommandProcessor);
                });
            });

            after(async () => {
                await server.stop();
                module.tmpDir.removeCallback();
            });

            describe("Transactions", () => {

                const self = this;

                before(() => {
                    self.data = generateCommandData(MIN_FILE_SIZE, MAX_FILE_SIZE);
                });

                beforeEach(async () => {
                    client = await getClientPromise(server.port);
                    await clientWrite(client, helpers.encodeInt32(consts.PROTOCOL_VERSION));
                });

                it("should start a transaction with the (ts) command", (done) => {
                    expectLog(client, /Start transaction/, done);
                    client.end(encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash));
                });

                it("should cancel a pending transaction if a new (ts) command is received", (done) => {
                    expectLog(client, /Cancel previous transaction/, done);
                    const d = encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash);
                    client.write(d); // first one ...
                    client.end(d); // ... canceled by this one
                });

                it("should require a start transaction (ts) cmd before an end transaction (te) cmd", (done) => {
                    expectLog(client, /Invalid transaction isolation/, done);
                    client.end(cmd.transactionEnd);
                });

                it("should end a transaction that was started with the (te) command", (done) => {
                    expectLog(client, /End transaction for/, done);
                    client.write(encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash));
                    client.end(cmd.transactionEnd);
                });

                it("should require a transaction start (te) command before a put command", (done) => {
                    expectLog(client, /Not in a transaction/, done);
                    client.write(encodeCommand(cmd.putAsset, null, null, 'abc'));
                });

                it("should close the socket on an invalid transaction command", (done) => {
                    expectLog(client, /Unrecognized command/i, done);
                    client.write('tx', self.data.guid, self.data.hash);
                });
            });

            describe("PUT requests", function () {
                this.slow(5000);
                this.timeout(5000);

                const self = this;
                self.data = generateCommandData(MIN_FILE_SIZE, MAX_FILE_SIZE);
                self.smallData = generateCommandData(SMALL_MIN_FILE_SIZE, SMALL_MAX_FILE_SIZE);

                beforeEach(async () => {
                    client = await getClientPromise(server.port);

                    // The Unity client always sends the version once on-connect. i.e., the version should not be pre-pended
                    // to other request data in the tests below.
                    await clientWrite(client, helpers.encodeInt32(consts.PROTOCOL_VERSION));
                });

                afterEach(() => client.end());

                it("should close the socket on an invalid PUT type", (done) => {
                    expectLog(client, /Unrecognized command/i, done);
                    const buf = Buffer.from(
                        encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash) +
                        encodeCommand("px", null, null, 'abc'), 'ascii');

                    client.write(buf);
                });

                const tests = [
                    {packetSize: 1, data: self.smallData},
                    {packetSize: LARGE_PACKET_SIZE, data: self.data}
                ];

                tests.forEach(function (test) {
                    it(`should store all files for a transaction (client write packet size = ${test.packetSize})`, async () => {
                        // Insert 'q' character ('Quit' command) into the GUID, to catch subtle protocol errors when packet size is 1
                        if(test.packetSize === 1) {
                            test.data.guid[0] = test.data.guid[test.data.guid.length - 1] = 'q'.charCodeAt(0);
                        }

                        const buf = Buffer.from(
                            encodeCommand(cmd.transactionStart, test.data.guid, test.data.hash) +
                            encodeCommand(cmd.putAsset, null, null, test.data.bin) +
                            encodeCommand(cmd.putInfo, null, null, test.data.info) +
                            encodeCommand(cmd.putResource, null, null, test.data.resource) +
                            encodeCommand(cmd.transactionEnd), 'ascii');

                        await clientWrite(client, buf, test.packetSize);
                        let stream = await cache.getFileStream(consts.FILE_TYPE.BIN, test.data.guid, test.data.hash);
                        let data = await readStream(stream, test.data.bin.length);
                        assert.strictEqual(test.data.bin.compare(data), 0);

                        stream = await cache.getFileStream(consts.FILE_TYPE.INFO, test.data.guid, test.data.hash);
                        data = await readStream(stream, test.data.info.length);
                        assert.strictEqual(test.data.info.compare(data), 0);

                        stream = await cache.getFileStream(consts.FILE_TYPE.RESOURCE, test.data.guid, test.data.hash);
                        data = await readStream(stream, test.data.resource.length);
                        assert.strictEqual(test.data.resource.compare(data), 0);
                    });
                });

                it("should not allow replacing files for a version that already exists", async () => {
                    const newData = Buffer.from(crypto.randomBytes(self.data.bin.length).toString('ascii'), 'ascii');

                    const buf = Buffer.from(
                        encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash) +
                        encodeCommand(cmd.putAsset, null, null, newData) +
                        encodeCommand(cmd.transactionEnd), 'ascii');

                    await clientWrite(client, buf);
                    const stream = await cache.getFileStream(consts.FILE_TYPE.BIN, self.data.guid, self.data.hash);
                    const data = await readStream(stream, self.data.bin.length);
                    assert.strictEqual(data.compare(self.data.bin), 0);
                });
            });

            describe("GET requests", function () {
                this.slow(1000);

                const self = this;
                self.data = generateCommandData(MIN_FILE_SIZE, MAX_FILE_SIZE);

                before(async () => {
                    const buf = Buffer.from(
                        helpers.encodeInt32(consts.PROTOCOL_VERSION) +
                        encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash) +
                        encodeCommand(cmd.putAsset, null, null, self.data.bin) +
                        encodeCommand(cmd.putInfo, null, null, self.data.info) +
                        encodeCommand(cmd.putResource, null, null, self.data.resource) +
                        encodeCommand(cmd.transactionEnd) +
                        encodeCommand(cmd.quit), 'ascii');

                    client = await getClientPromise(server.port);
                    await clientWrite(client, buf);
                });

                beforeEach(async () => {
                    client = await getClientPromise(server.port);

                    // The Unity client always sends the version once on-connect. i.e., the version should not be pre-pended
                    // to other request data in the tests below.
                    await clientWrite(client, helpers.encodeInt32(consts.PROTOCOL_VERSION));
                });

                afterEach(() => {
                    sinon.restore();
                    client.destroy();
                });

                it("should close the socket on an invalid GET type", (done) => {
                    expectLog(client, /Unrecognized command/i, done);
                    clientWrite(client, encodeCommand('gx', self.data.guid, self.data.hash)).catch(err => done(err));
                });

                it("should close file streams if the client drops before finished reading", async () => {
                    const resp = new ServerStreamProcessor();
                    client.pipe(resp);

                    cmdProc._testReadStreamDestroy = true;

                    const getCmd = Buffer.from(encodeCommand(cmd.getAsset, self.data.guid, self.data.hash), 'ascii');
                    return clientWrite(client, getCmd)
                        .then(() => {
                            return new Promise(resolve => {
                                cmdProc.on('_testReadStreamDestroy', () => {
                                    assert.equal(cmdProc.readStream, null);
                                    resolve();
                                });

                                client.destroy();
                            });
                        });
                });

                it("should gracefully handle an abrupt socket close when sending a file", function(done) {
                    const resp = new ServerStreamProcessor();
                    resp.on('data', () => {});
                    client.pipe(resp);
                    const buf = Buffer.from(encodeCommand(cmd.getAsset, self.data.guid, self.data.hash) +
                        encodeCommand(cmd.quit), 'ascii');
                    client.write(buf, () => done());
                    // There's no assertion here - the failure would manifest as a stuck/hung test process as a result
                    // of a stuck async loop
                });

                it('should retrieve stored versions in the order they were are requested (queued)', function(done) {
                    const resp = new ServerStreamProcessor();
                    client.pipe(resp);

                    const cmds = ['+a', '+i', '-r', '+i', '+a'];

                    resp.on('data', () => {});
                    resp.on('dataEnd', () => {
                        if(cmds.length === 0) {
                            assert.strictEqual(cmdProc.sentFileCount, 4);
                            done();
                        }
                    });

                    resp.on('header', header => {
                        const nextCmd = cmds.shift();
                        assert.strictEqual(header.cmd, nextCmd);
                    });

                    const buf = Buffer.from(
                        encodeCommand(cmd.getAsset, self.data.guid, self.data.hash) +
                        encodeCommand(cmd.getInfo, self.data.guid, self.data.hash) +
                        encodeCommand(cmd.getResource, self.data.guid, Buffer.alloc(consts.HASH_SIZE, 'ascii')) +
                        encodeCommand(cmd.getInfo, self.data.guid, self.data.hash) +
                        encodeCommand(cmd.getAsset, self.data.guid, self.data.hash), 'ascii');


                    // execute all commands in the same frame to simulate filling the send queue in CommandProcessor
                    clientWrite(client, buf, LARGE_PACKET_SIZE).catch(err => done(err));
                });

                it('should retrieve stored versions in the order they were are requested (async series)', function(done) {
                    const resp = new ServerStreamProcessor();
                    client.pipe(resp);

                    const cmds = ['+a', '+i', '-r', '+i', '+a'];

                    resp.on('data', () => {});
                    resp.on('dataEnd', () => {
                        if(cmds.length === 0) {
                            assert.strictEqual(cmdProc.sentFileCount, 4);
                            done();
                        }
                    });

                    resp.on('header', header => {
                        const nextCmd = cmds.shift();
                        assert.strictEqual(header.cmd, nextCmd);
                    });

                    const cmdData = [
                        encodeCommand(cmd.getAsset, self.data.guid, self.data.hash),
                        encodeCommand(cmd.getInfo, self.data.guid, self.data.hash),
                        encodeCommand(cmd.getResource, self.data.guid, Buffer.alloc(consts.HASH_SIZE, 'ascii')),
                        encodeCommand(cmd.getInfo, self.data.guid, self.data.hash),
                        encodeCommand(cmd.getAsset, self.data.guid, self.data.hash)
                    ];

                    // execute each command in series, asynchronously, to better simulate a real world server connection
                    let next = Promise.resolve();
                    cmdData.forEach(b => {
                        next = next.then(() => clientWrite(client, b, LARGE_PACKET_SIZE))
                            .catch(err => done(err));
                    });
                });

                it('should respond with not found (-) for a file that exists but throws an error when accessed', function (done) {
                    const resp = new ServerStreamProcessor();
                    client.pipe(resp);

                    resp.on('header', header => {
                        assert.strictEqual(header.cmd, '-a');
                        done();
                    });

                    sinon.stub(cache, "getFileStream").rejects();

                    const buf = Buffer.from(encodeCommand(cmd.getAsset, self.data.guid, self.data.hash), 'ascii');
                    clientWrite(client, buf);
                });

                const tests = [
                    {cmd: cmd.getAsset, blob: self.data.bin, type: 'bin', packetSize: 1},
                    {cmd: cmd.getAsset, blob: self.data.bin, type: 'bin', packetSize: SMALL_PACKET_SIZE},
                    {cmd: cmd.getInfo, blob: self.data.info, type: 'info', packetSize: MED_PACKET_SIZE},
                    {cmd: cmd.getResource, blob: self.data.resource, type: 'resource', packetSize: LARGE_PACKET_SIZE}
                ];

                tests.forEach(function (test) {

                    it(`should respond with not found (-) for missing ${test.type} files (client write packet size = ${test.packetSize})`, (done) => {
                        client.pipe(new ServerStreamProcessor())
                            .on('header', function (header) {
                                assert.strictEqual(header.cmd, '-' + test.cmd[1]);
                                done();
                            });

                        const badGuid = Buffer.allocUnsafe(consts.GUID_SIZE).fill(0);
                        const badHash = Buffer.allocUnsafe(consts.HASH_SIZE).fill(0);

                        clientWrite(client, encodeCommand(test.cmd, badGuid, badHash), test.packetSize)
                            .catch(err => done(err));
                    });

                    it(`should retrieve stored ${test.type} data with the (${test.cmd}) command (write packet size = ${test.packetSize})`, (done) => {
                        let dataBuf;
                        let pos = 0;

                        const resp = new ServerStreamProcessor();

                        resp.on('header', function (header) {
                                assert.strictEqual(header.cmd, '+' + test.cmd[1]);
                                assert.strictEqual(header.guid.compare(self.data.guid), 0, "GUID does not match");
                                assert.strictEqual(header.hash.compare(self.data.hash), 0, "HASH does not match");
                                assert.strictEqual(header.size, test.blob.length, "Expected size " + test.blob.length);
                                dataBuf = Buffer.allocUnsafe(header.size);
                            })
                            .on('data', function (data) {
                                const prev = pos;
                                pos += data.copy(dataBuf, pos);
                                assert.strictEqual(data.compare(test.blob.slice(prev, pos)), 0, `Blobs don't match at pos ${pos}`);
                            })
                            .on('dataEnd', function () {
                                assert.strictEqual(dataBuf.compare(test.blob), 0);
                                done();
                            });

                        client.pipe(resp);

                        const buf = Buffer.from(encodeCommand(test.cmd, self.data.guid, self.data.hash), 'ascii');
                        clientWrite(client, buf, test.packetSize).catch(err => done(err));
                    });
                });
            });
        });
    });
});
