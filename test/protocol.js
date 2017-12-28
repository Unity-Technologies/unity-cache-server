const assert = require('assert');
const net = require('net');
const crypto = require('crypto');
const helpers = require('../lib/helpers');
const consts = require('../lib/constants');
const CacheServer = require('../lib/server');
const CacheServerResponseTransform = require('./../lib/client/server_response_transform.js');
const loki = require('lokijs');
const tmp = require('tmp');
const generateCommandData = require('./test_utils').generateCommandData;
const encodeCommand = require('./test_utils').encodeCommand;
const sleep = require('./test_utils').sleep;
const expectLog = require('./test_utils').expectLog;
const cmd = require('./test_utils').cmd;

let cache, server, client;

let test_modules = [
    {
        tmpDir: tmp.dirSync({unsafeCleanup: true}),
        name: "cache_membuf",
        path: "../lib/cache/cache_membuf",
        options: {
            initialPageSize: 10000,
            growPageSize: 10000,
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

                cache.init(module.options, function() {
                    server = new CacheServer(cache, 0);

                    server.Start(function (err) {
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
                    self.data = generateCommandData();
                });

                beforeEach(function (done) {
                    client = net.connect({port: server.port}, function (err) {
                        assert(!err, err);
                        client.write(helpers.encodeInt32(consts.PROTOCOL_VERSION));
                        done(err);
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
                    client.write(encodeCommand(cmd.putAsset, null, null, self.data.bin));
                });

                it("should close the socket on an invalid transaction command", function(done) {
                    expectLog(client, /Unrecognized command/i, done);
                    client.write('tx', self.data.guid, self.data.hash);
                });
            });

            describe("PUT requests", function () {
                this.slow(1500);

                const self = this;

                before(function () {
                    self.data = generateCommandData();
                });

                beforeEach(function (done) {
                    client = net.connect({port: server.port}, function (err) {
                        assert(!err);

                        // The Unity client always sends the version once on-connect. i.e., the version should not be pre-pended
                        // to other request data in the tests below.
                        client.write(helpers.encodeInt32(consts.PROTOCOL_VERSION));
                        done();
                    });
                });

                it("should close the socket on an invalid PUT type", function (done) {
                    expectLog(client, /Unrecognized command/i, done);
                    client.write(
                        encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash) +
                        encodeCommand("px", null, null, self.data.bin));
                });

                const tests = [
                    {ext: 'bin', cmd: cmd.putAsset},
                    {ext: 'info', cmd: cmd.putInfo},
                    {ext: 'resource', cmd: cmd.putResource}
                ];

                tests.forEach(function (test) {
                    it("should store " + test.ext + " data with a (" + test.cmd + ") cmd", function (done) {
                        client.on('close', function () {
                            cache.getFileInfo(test.cmd[1], self.data.guid, self.data.hash, function(err, info) {
                                assert(!err, err);
                                assert(info.size === self.data[test.ext].length);
                                cache.getFileStream(test.cmd[1], self.data.guid, self.data.hash, function (err, stream) {
                                    assert(!err, err);
                                    assert(stream !== null);

                                    stream.on("readable", function () {
                                        const chunk = stream.read(); // should only be one in this test
                                        assert(self.data[test.ext].compare(chunk) === 0);
                                        done();
                                    });
                                });
                            });


                        });

                        const buf = Buffer.from(
                            encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash) +
                            encodeCommand(test.cmd, null, null, self.data[test.ext]) +
                            encodeCommand(cmd.transactionEnd), 'ascii');

                        let sentBytes = 0;

                        function sendBytesAsync() {
                            setTimeout(() => {
                                const packetSize = Math.min(buf.length - sentBytes, Math.ceil(Math.random() * 10));
                                client.write(buf.slice(sentBytes, sentBytes + packetSize), function () {
                                    sentBytes += packetSize;
                                    if (sentBytes < buf.length)
                                        return sendBytesAsync();
                                    else
                                        sleep(50).then(() => {
                                            client.end();
                                        });
                                });
                            }, 1);
                        }

                        sendBytesAsync();

                    });
                });

                it("should replace an existing file with the same guid and hash", function (done) {
                    const asset = Buffer.from(crypto.randomBytes(self.data.bin.length).toString('ascii'), 'ascii');

                    client.on('close', function () {
                        cache.getFileInfo('a', self.data.guid, self.data.hash, function(err, info) {
                            assert(!err, err);
                            assert(info.size === asset.length);

                            cache.getFileStream('a', self.data.guid, self.data.hash, function (err, stream) {
                                assert(!err, err);
                                assert(stream !== null);

                                stream.on("readable", function () {
                                    const chunk = stream.read(); // should only be one in this test
                                    assert(asset.compare(chunk) === 0);
                                    done();
                                });
                            });
                        });
                    });

                    client.write(
                        encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash) +
                        encodeCommand(cmd.putAsset, null, null, asset) +
                        encodeCommand(cmd.transactionEnd));

                    sleep(50).then(() => {
                        client.end();
                    });
                });
            });

            describe("GET requests", function () {
                this.slow(1000);

                const self = this;
                self.data = generateCommandData();

                before(function (done) {
                    client = net.connect({port: server.port}, function (err) {
                        assert(!err);
                        client.write(helpers.encodeInt32(consts.PROTOCOL_VERSION));
                        client.write(encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash));
                        client.write(encodeCommand(cmd.putAsset, null, null, self.data.bin));
                        client.write(encodeCommand(cmd.putInfo, null, null, self.data.info));
                        client.write(encodeCommand(cmd.putResource, null, null, self.data.resource));
                        client.write(cmd.transactionEnd);
                        client.end(cmd.quit);
                        client.on('close', done);
                    });
                });

                beforeEach(function (done) {
                    client = net.connect({port: server.port}, function (err) {
                        assert(!err);

                        // The Unity client always sends the version once on-connect. i.e., the version should not be pre-pended
                        // to other request data in the tests below.
                        client.write(helpers.encodeInt32(consts.PROTOCOL_VERSION));
                        done();
                    });
                });

                it("should close the socket on an invalid GET type", function (done) {
                    expectLog(client, /Unrecognized command/i, done);
                    client.write(encodeCommand('gx', self.data.guid, self.data.hash));
                });

                const tests = [
                    {cmd: cmd.getAsset, blob: self.data.bin, type: 'bin'},
                    {cmd: cmd.getInfo, blob: self.data.info, type: 'info'},
                    {cmd: cmd.getResource, blob: self.data.resource, type: 'resource'}
                ];

                it("should respond with not found (-) for missing files", function (done) {
                    let count = 0;

                    client.pipe(new CacheServerResponseTransform())
                        .on('header', function (header) {
                            assert(header.cmd === '-' + tests[count].cmd[1]);
                            count++;
                            if(count === 3) done();
                        });

                    const badGuid = Buffer.allocUnsafe(consts.GUID_SIZE).fill(0);
                    const badHash = Buffer.allocUnsafe(consts.HASH_SIZE).fill(0);

                    tests.forEach(function(test) {
                        client.write(encodeCommand(test.cmd, badGuid, badHash));
                    });
                });


                tests.forEach(function (test) {
                    it("should retrieve stored " + test.type + " data with the (" + test.cmd + ") command", function (done) {
                        let dataBuf;
                        let pos = 0;

                        let resp = new CacheServerResponseTransform();

                        resp
                            .on('header', function (header) {
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

                        let sentBytes = 0;

                        function sendBytesAsync() {
                            setTimeout(() => {
                                const packetSize = Math.min(buf.length - sentBytes, Math.ceil(Math.random() * 10));
                                client.write(buf.slice(sentBytes, sentBytes + packetSize), function () {
                                    sentBytes += packetSize;
                                    if (sentBytes < buf.length)
                                        return sendBytesAsync();
                                });
                            }, 1);
                        }

                        sendBytesAsync();

                    });
                });
            });
        });
    });
});
