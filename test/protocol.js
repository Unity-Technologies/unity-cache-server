const assert = require('assert');
const crypto = require('crypto');
const helpers = require('../lib/helpers');
const consts = require('../lib/constants');
const CacheServer = require('../lib/server/server');
const CacheServerResponseTransform = require('../lib/client/server_stream_processor.js');
const loki = require('lokijs');
const tmp = require('tmp');
const generateCommandData = require('./test_utils').generateCommandData;
const encodeCommand = require('./test_utils').encodeCommand;
const expectLog = require('./test_utils').expectLog;
const cmd = require('./test_utils').cmd;
const clientWrite = require('./test_utils').clientWrite;
const readStream = require('./test_utils').readStream;
const getClientPromise = require('./test_utils').getClientPromise;

const SMALL_MIN_FILE_SIZE = 64;
const SMALL_MAX_FILE_SIZE = 128;
const MIN_FILE_SIZE = 1024;
const MAX_FILE_SIZE = 1024 * 1024;
const SMALL_PACKET_SIZE = 64;
const MED_PACKET_SIZE = 1024;
const LARGE_PACKET_SIZE = 1024 * 16;

let cache, server, client;

const test_modules = [
    {
        tmpDir: tmp.dirSync({unsafeCleanup: true}),
        name: "cache_ram",
        path: "../lib/cache/cache_ram",
        options: {
            pageSize: MAX_FILE_SIZE,
            minFreeBlockSize: 1024,
            persistenceOptions: {
                adapter: new loki.LokiMemoryAdapter()
            }
        }
    },
    {
        tmpDir: tmp.dirSync({unsafeCleanup: true}),
        name: "cache_fs",
        path: "../lib/cache/cache_fs",
        options: {}
    }
    ];

describe("Protocol", () => {
    test_modules.forEach(module => {
        describe(module.name, function() {

            beforeEach(() => {
                helpers.setLogger(() => {});
            });

            before(async () => {
                /** @type {CacheBase} **/
                const CacheModule = require(module.path);
                cache = new CacheModule();

                module.options.cachePath = module.tmpDir.name;

                await cache.init(module.options);
                server = new CacheServer(cache, {port: 0});
                await server.start(err => assert(!err, `Cache Server reported error!  ${err}`));
            });

            after(() => {
                server.stop();
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

                it("should close the socket on an invalid PUT type", (done) => {
                    expectLog(client, /Unrecognized command/i, done);
                    const buf = Buffer.from(
                        encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash) +
                        encodeCommand("px", null, null, 'abc'), 'ascii');

                    client.write(buf);
                });

                const tests = [
                    {ext: 'bin', data: self.smallData, cmd: cmd.putAsset, packetSize: 1},
                    {ext: 'info', data: self.smallData, cmd: cmd.putInfo, packetSize: 1},
                    {ext: 'resource', data: self.smallData, cmd: cmd.putResource, packetSize: 1},
                    {ext: 'bin', data: self.data, cmd: cmd.putAsset, packetSize: SMALL_PACKET_SIZE},
                    {ext: 'info', data: self.data, cmd: cmd.putInfo, packetSize: MED_PACKET_SIZE},
                    {ext: 'resource', data: self.data, cmd: cmd.putResource, packetSize: LARGE_PACKET_SIZE}
                ];

                tests.forEach(function (test) {
                    it(`should store ${test.ext} data with a (${test.cmd}) command (client write packet size = ${test.packetSize})`, () => {
                        // Insert 'q' character ('Quit' command) into the GUID, to catch subtle protocol errors when packet size is 1
                        if(test.packetSize === 1) {
                            test.data.guid[0] = test.data.guid[test.data.guid.length - 1] = 'q'.charCodeAt(0);
                        }

                        const buf = Buffer.from(
                            encodeCommand(cmd.transactionStart, test.data.guid, test.data.hash) +
                            encodeCommand(test.cmd, null, null, test.data[test.ext]) +
                            encodeCommand(cmd.transactionEnd), 'ascii');

                        return clientWrite(client, buf, test.packetSize)
                            .then(() => cache.getFileStream(test.cmd[1], test.data.guid, test.data.hash))
                            .then(stream => readStream(stream, test.data[test.ext].length))
                            .then(data => assert.strictEqual(test.data[test.ext].compare(data), 0));
                    });
                });

                it("should replace an existing file with the same guid and hash", () => {
                    const asset = Buffer.from(crypto.randomBytes(self.data.bin.length).toString('ascii'), 'ascii');

                    const buf = Buffer.from(
                        encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash) +
                        encodeCommand(cmd.putAsset, null, null, asset) +
                        encodeCommand(cmd.transactionEnd), 'ascii');

                    return clientWrite(client, buf)
                        .then(() => cache.getFileStream('a', self.data.guid, self.data.hash))
                        .then(stream => readStream(stream, asset.length))
                        .then(buffer => assert.strictEqual(asset.compare(buffer), 0));
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

                it("should close the socket on an invalid GET type", (done) => {
                    expectLog(client, /Unrecognized command/i, done);
                    clientWrite(client, encodeCommand('gx', self.data.guid, self.data.hash)).catch(err => done(err));
                });

                const tests = [
                    {cmd: cmd.getAsset, blob: self.data.bin, type: 'bin', packetSize: SMALL_PACKET_SIZE},
                    {cmd: cmd.getInfo, blob: self.data.info, type: 'info', packetSize: MED_PACKET_SIZE},
                    {cmd: cmd.getResource, blob: self.data.resource, type: 'resource', packetSize: LARGE_PACKET_SIZE}
                ];

                tests.forEach(function (test) {

                    it(`should respond with not found (-) for missing ${test.type} files (client write packet size = ${test.packetSize})`, (done) => {
                        client.pipe(new CacheServerResponseTransform())
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

                        const resp = new CacheServerResponseTransform();

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
