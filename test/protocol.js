const assert = require('assert');
const net = require('net');
const crypto = require('crypto');
const helpers = require('../lib/helpers');
const consts = require('../lib/constants');
const CacheServer = require('../lib/server');
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

const MIN_FILE_SIZE = 1024;
const MAX_FILE_SIZE = 1024 * 1024;
const SMALL_PACKET_SIZE = 16;
const LARGE_PACKET_SIZE = 1024 * 16;

let cache, server, client;

let test_modules = [
    {
        tmpDir: tmp.dirSync({unsafeCleanup: true}),
        name: "cache_membuf",
        path: "../lib/cache/cache_membuf",
        options: {
            initialPageSize: MAX_FILE_SIZE * 2,
            growPageSize: MAX_FILE_SIZE,
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

describe("Protocol", function() {
    test_modules.forEach(function(module) {
        describe(module.name, function() {

            beforeEach(function() {
                helpers.SetLogger(function() {});
            });

            before(function (done) {
                /** @type {CacheBase} **/
                let CacheModule = require(module.path);
                cache = new CacheModule();

                module.options.cachePath = module.tmpDir.name;

                cache.init(module.options)
                    .then(() => {
                        server = new CacheServer(cache, 0);
                        server.Start(err => {
                            assert(!err, "Cache Server reported error! " + err);
                        }, done);
                    });
            });

            after(function() {
                server.Stop();
                module.tmpDir.removeCallback();
            });

            describe("Transactions", function () {

                const self = this;

                before(function() {
                    self.data = generateCommandData(MIN_FILE_SIZE, MAX_FILE_SIZE);
                });

                beforeEach(() => {
                    return getClientPromise(server.port)
                        .then(c => {
                            client = c;
                            return clientWrite(c, helpers.encodeInt32(consts.PROTOCOL_VERSION));
                        });
                });

                it("should start a transaction with the (ts) command", function (done) {
                    expectLog(client, /Start transaction/, done);
                    client.end(encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash));
                });

                it("should cancel a pending transaction if a new (ts) command is received", function (done) {
                    expectLog(client, /Cancel previous transaction/, done);
                    const d = encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash);
                    client.write(d); // first one ...
                    client.end(d); // ... canceled by this one
                });

                it("should require a start transaction (ts) cmd before an end transaction (te) cmd", function (done) {
                    expectLog(client, /Invalid transaction isolation/, done);
                    client.end(cmd.transactionEnd);
                });

                it("should end a transaction that was started with the (te) command", function (done) {
                    expectLog(client, /End transaction for/, done);
                    client.write(encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash));
                    client.end(cmd.transactionEnd);
                });

                it("should require a transaction start (te) command before a put command", function(done) {
                    expectLog(client, /Not in a transaction/, done);
                    client.write(encodeCommand(cmd.putAsset, null, null, 'abc'));
                });

                it("should close the socket on an invalid transaction command", function(done) {
                    expectLog(client, /Unrecognized command/i, done);
                    client.write('tx', self.data.guid, self.data.hash);
                });
            });

            describe("PUT requests", function () {
                this.slow(5000);

                const self = this;

                before(function () {
                    self.data = generateCommandData(MIN_FILE_SIZE, MAX_FILE_SIZE);
                });

                beforeEach(() => {
                    return getClientPromise(server.port)
                        .then(c => {
                            client = c;

                            // The Unity client always sends the version once on-connect. i.e., the version should not be pre-pended
                            // to other request data in the tests below.
                            return clientWrite(c, helpers.encodeInt32(consts.PROTOCOL_VERSION));
                        });
                });

                it("should close the socket on an invalid PUT type", function (done) {
                    expectLog(client, /Unrecognized command/i, done);
                    let buf = Buffer.from(
                        encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash) +
                        encodeCommand("px", null, null, 'abc'), 'ascii');

                    client.write(buf);
                });

                const tests = [
                    {ext: 'bin', cmd: cmd.putAsset, packetSize: SMALL_PACKET_SIZE},
                    {ext: 'info', cmd: cmd.putInfo, packetSize: SMALL_PACKET_SIZE},
                    {ext: 'resource', cmd: cmd.putResource, packetSize: SMALL_PACKET_SIZE},
                    {ext: 'bin', cmd: cmd.putAsset, packetSize: LARGE_PACKET_SIZE},
                    {ext: 'info', cmd: cmd.putInfo, packetSize: LARGE_PACKET_SIZE},
                    {ext: 'resource', cmd: cmd.putResource, packetSize: LARGE_PACKET_SIZE}
                ];

                tests.forEach(function (test) {
                    it(`should store ${test.ext} data with a (${test.cmd}) command (client write packet size = ${test.packetSize})`, () => {
                        const buf = Buffer.from(
                            encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash) +
                            encodeCommand(test.cmd, null, null, self.data[test.ext]) +
                            encodeCommand(cmd.transactionEnd), 'ascii');

                        return clientWrite(client, buf, test.packetSize)
                            .then(() => cache.getFileStream(test.cmd[1], self.data.guid, self.data.hash))
                            .then(stream => readStream(stream, self.data[test.ext].length))
                            .then(data => assert(self.data[test.ext].compare(data) === 0));
                    });
                });

                it("should replace an existing file with the same guid and hash ", () => {
                    const asset = Buffer.from(crypto.randomBytes(self.data.bin.length).toString('ascii'), 'ascii');

                    const buf = Buffer.from(
                        encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash) +
                        encodeCommand(cmd.putAsset, null, null, asset) +
                        encodeCommand(cmd.transactionEnd), 'ascii');

                    return clientWrite(client, buf)
                        .then(() => cache.getFileStream('a', self.data.guid, self.data.hash))
                        .then(stream => readStream(stream, asset.length))
                        .then(buffer => assert(asset.compare(buffer) === 0));
                });
            });

            describe("GET requests", function () {
                this.slow(1000);

                const self = this;
                self.data = generateCommandData(MIN_FILE_SIZE, MAX_FILE_SIZE);

                before(() => {
                    const buf = Buffer.from(
                        helpers.encodeInt32(consts.PROTOCOL_VERSION) +
                        encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash) +
                        encodeCommand(cmd.putAsset, null, null, self.data.bin) +
                        encodeCommand(cmd.putInfo, null, null, self.data.info) +
                        encodeCommand(cmd.putResource, null, null, self.data.resource) +
                        encodeCommand(cmd.transactionEnd) +
                        encodeCommand(cmd.quit), 'ascii');

                    return getClientPromise(server.port)
                        .then(c => {
                            client = c;
                            return clientWrite(c, buf);
                        });
                });

                beforeEach(() => {
                    return getClientPromise(server.port)
                        .then(c => {
                            client = c;

                            // The Unity client always sends the version once on-connect. i.e., the version should not be pre-pended
                            // to other request data in the tests below.
                            return clientWrite(c, helpers.encodeInt32(consts.PROTOCOL_VERSION));
                        });
                });

                it("should close the socket on an invalid GET type", function (done) {
                    expectLog(client, /Unrecognized command/i, done);
                    clientWrite(client, encodeCommand('gx', self.data.guid, self.data.hash)).catch(err => done(err));
                });

                const tests = [
                    {cmd: cmd.getAsset, blob: self.data.bin, type: 'bin', packetSize: 1},
                    {cmd: cmd.getInfo, blob: self.data.info, type: 'info', packetSize: 1},
                    {cmd: cmd.getResource, blob: self.data.resource, type: 'resource', packetSize: 1},
                    {cmd: cmd.getAsset, blob: self.data.bin, type: 'bin', packetSize: LARGE_PACKET_SIZE},
                    {cmd: cmd.getInfo, blob: self.data.info, type: 'info', packetSize: LARGE_PACKET_SIZE},
                    {cmd: cmd.getResource, blob: self.data.resource, type: 'resource', packetSize: LARGE_PACKET_SIZE}
                ];

                tests.forEach(function (test) {

                    it(`should respond with not found (-) for missing ${test.type} files (client write packet size = ${test.packetSize})`, function (done) {
                        client.pipe(new CacheServerResponseTransform())
                            .on('header', function (header) {
                                assert(header.cmd === '-' + test.cmd[1]);
                                done();
                            });

                        const badGuid = Buffer.allocUnsafe(consts.GUID_SIZE).fill(0);
                        const badHash = Buffer.allocUnsafe(consts.HASH_SIZE).fill(0);

                        clientWrite(client, encodeCommand(test.cmd, badGuid, badHash), test.packetSize)
                            .catch(err => done(err));
                    });

                    it(`should retrieve stored ${test.type} data with the (${test.cmd}) command (write packet size = ${test.packetSize})`, function (done) {
                        let dataBuf;
                        let pos = 0;

                        let resp = new CacheServerResponseTransform();

                        resp.on('header', function (header) {
                                assert(header.cmd === '+' + test.cmd[1]);
                                assert(header.guid.compare(self.data.guid) === 0, "GUID does not match");
                                assert(header.hash.compare(self.data.hash) === 0, "HASH does not match");
                                assert(header.size === test.blob.length, "Expected size " + test.blob.length);
                                dataBuf = Buffer.allocUnsafe(header.size);
                            })
                            .on('data', function (data) {
                                let prev = pos;
                                pos += data.copy(dataBuf, pos);
                                assert(data.compare(test.blob.slice(prev, pos)) === 0, `Blobs don't match at pos ${pos}`);
                            })
                            .on('dataEnd', function () {
                                assert(dataBuf.compare(test.blob) === 0);
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
