const assert = require('assert');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const helpers = require('../lib/helpers');
const consts = require('../lib/constants').Constants;
const CacheServer = require('../lib/server');
const Cache = require("../lib/cache/cache_membuf");

const CmdResponseListener = require('./../lib/client/server_response_transform.js');

const CACHE_SIZE = 1024 * 1024;
const MIN_BLOB_SIZE = 64;
const MAX_BLOB_SIZE = 2048;

helpers.SetLogger(()=>{});
const cache = new Cache();
const server = new CacheServer(cache, 0);
let client;

const cmd = {
    quit: "q",
    getAsset: "ga",
    getInfo: "gi",
    getResource: "gr",
    putAsset: "pa",
    putInfo: "pi",
    putResource: "pr",
    transactionStart: "ts",
    transactionEnd: "te",
    integrityVerify: "icv",
    integrityFix: "icf"
};

function generateCommandData(minSize, maxSize) {
    minSize = minSize || MIN_BLOB_SIZE;
    maxSize = maxSize || MAX_BLOB_SIZE;

    function getSize() { return Math.max(minSize, Math.floor(Math.random() * maxSize)); }

    return {
        guid: Buffer.from(crypto.randomBytes(consts.GUID_SIZE).toString('ascii'), 'ascii'),
        hash: Buffer.from(crypto.randomBytes(consts.HASH_SIZE).toString('ascii'), 'ascii'),
        bin: Buffer.from(crypto.randomBytes(getSize()).toString('ascii'), 'ascii'),
        info: Buffer.from(crypto.randomBytes(getSize()).toString('ascii'), 'ascii'),
        resource: Buffer.from(crypto.randomBytes(getSize()).toString('ascii'), 'ascii')
    }
}

function encodeCommand(command, guid, hash, blob) {

    if(blob)
        command += helpers.encodeInt64(blob.length);

    if(guid)
        command += guid;

    if(hash)
        command += hash;

    if(blob)
        command += blob;

    return command;
}

function expectLog(client, regex, condition, callback) {
    if(typeof(callback) !== 'function' && typeof(condition) === 'function') {
        callback = condition;
        condition = true;
    }

    let match;
    helpers.SetLogger(function (lvl, msg) {
        match = match || regex.test(msg);
    });

    client.on('close', function() {
        assert(match === condition);
        callback();
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("CacheServer protocol", function() {

    beforeEach(function() {
        helpers.SetLogger(function(lvl, msg) {});
    });

    before(function (done) {
        server.Start(function (err) {
            assert(!err, "Cache Server reported error! " + err);
        }, done);
    });

    describe("Version check", function () {

        beforeEach(function (done) {
            client = net.connect({port: server.port}, done);
        });

        it("should echo the version if supported", function (done) {
            client.on('data', function (data) {
                const ver = helpers.readUInt32(data);
                assert(ver === consts.PROTOCOL_VERSION, "Expected " + consts.PROTOCOL_VERSION + " Received " + ver);
                done();
            });

            client.write(helpers.encodeInt32(consts.PROTOCOL_VERSION));
        });

        it("should respond with 0 if unsupported", function (done) {
            client.on('data', function (data) {
                const ver = helpers.readUInt32(data);
                assert(ver === 0, "Expected 0, Received " + ver);
                done();
            });

            client.write(helpers.encodeInt32(consts.PROTOCOL_VERSION + 1));
        });

        it("should recognize a 2 byte version sent 1 byte at a time", function (done) {
            this.slow(250);

            client.on('data', function(data) {
                const ver = helpers.readUInt32(data);
                assert(ver === consts.PROTOCOL_VERSION, "Expected " + consts.PROTOCOL_VERSION + " Received " + ver);
                done();
            });

            let ver = "fe";
            client.write(ver[0]);
            sleep(50).then(() => { client.write(ver[1]); });
        });
    });

    describe("Transactions", function () {

        const self = this;

        beforeEach(function (done) {
            client = net.connect({port: server.port}, function (err) {
                assert(!err, err);
                self.data = generateCommandData();
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
        this.getCachePath = function(extension, callback) {
            return cache.GetCachePath(
                helpers.readHex(self.data.guid.length, self.data.guid),
                helpers.readHex(self.data.hash.length, self.data.hash),
                extension, false, callback);
        };

        before(function() {
            self.data = generateCommandData();
        });

        beforeEach(function (done) {
            client = net.connect({port: server.port}, function(err) {
                assert(!err);

                // The Unity client always sends the version once on-connect. i.e., the version should not be pre-pended
                // to other request data in the tests below.
                client.write(helpers.encodeInt32(consts.PROTOCOL_VERSION));
                done();
            });

        });

        it("should close the socket on an invalid PUT type", function(done) {
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

        tests.forEach(function(test) {
            it("should store " + test.ext + " data with a (" + test.cmd + ") cmd", function(done) {
                client.on('close', function() {
                    cache.getFileStream(test.cmd[1], self.data.guid, self.data.hash, function(err, result) {
                        assert(!err, err);
                        assert(result.size === self.data[test.ext].length);
                        assert(result.stream !== null);

                        result.stream.on("readable", function() {
                            const chunk = result.stream.read(); // should only be one in this test
                            assert(self.data[test.ext].compare(chunk) === 0);
                            done();
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
                        client.write(buf.slice(sentBytes, sentBytes + packetSize), function() {
                            sentBytes += packetSize;
                            if(sentBytes < buf.length)
                                return sendBytesAsync();
                            else
                                sleep(50).then(() => { client.end(); });
                        });
                    }, 1);
                }

                sendBytesAsync();

            });
        });

        it("should replace an existing file with the same guid and hash", function(done) {
            const asset = Buffer.from(crypto.randomBytes(self.data.bin.length).toString('ascii'), 'ascii');

            client.on('close', function() {
                cache.getFileStream('a', self.data.guid, self.data.hash, function(err, result) {
                    assert(!err, err);
                    assert(result.size === asset.length);
                    assert(result.stream !== null);

                    result.stream.on("readable", function() {
                        const chunk = result.stream.read(); // should only be one in this test
                        assert(asset.compare(chunk) === 0);
                        done();
                    });
                });
            });

            client.write(
                encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash) +
                encodeCommand(cmd.putAsset, null, null, asset) +
                encodeCommand(cmd.transactionEnd));

            sleep(50).then(() => { client.end(); });
        });
    });

    describe("GET requests", function() {
        this.slow(1000);

        const self = this;
        self.data = generateCommandData();

        before(function(done) {
            client = net.connect({port: server.port}, function (err) {
                assert(!err);
                client.write(helpers.encodeInt32(consts.PROTOCOL_VERSION));
                client.write(encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash));
                client.write(encodeCommand(cmd.putAsset, null, null, self.data.bin));
                client.write(encodeCommand(cmd.putInfo, null, null, self.data.info));
                client.write(encodeCommand(cmd.putResource, null, null, self.data.resource));
                client.write(cmd.transactionEnd);

                return sleep(25).then(done);
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

        it("should close the socket on an invalid GET type", function(done) {
            expectLog(client, /Unrecognized command/i, done);
            client.write(encodeCommand('gx', self.data.guid, self.data.hash));
        });

        const tests = [
            {cmd: cmd.getAsset, blob: self.data.bin, type: 'bin'},
            {cmd: cmd.getInfo, blob: self.data.info, type: 'info'},
            {cmd: cmd.getResource, blob: self.data.resource, type: 'resource'}
        ];

        tests.forEach(function(test) {
            it("should retrieve stored " + test.type + " data with the (" + test.cmd + ") command", function(done) {
                let dataBuf;
                let pos = 0;
                client.pipe(new CmdResponseListener())
                    .on('header', function(header) {
                        assert(header.cmd[0] === '+');
                        assert(header.size === test.blob.length, "Expected size " + test.blob.length);
                        dataBuf = Buffer.allocUnsafe(header.size);
                    })
                    .on('data', function(data) {
                        pos += data.copy(dataBuf, pos, 0);
                    })
                    .on('dataEnd', function() {
                        assert(dataBuf.compare(test.blob) === 0);
                        done();
                    });

                const buf = Buffer.from(encodeCommand(test.cmd, self.data.guid, self.data.hash), 'ascii');

                let sentBytes = 0;

                function sendBytesAsync() {
                    setTimeout(() => {
                        const packetSize = Math.min(buf.length - sentBytes, Math.ceil(Math.random() * 10));
                        client.write(buf.slice(sentBytes, sentBytes + packetSize), function() {
                            sentBytes += packetSize;
                            if(sentBytes < buf.length)
                                return sendBytesAsync();
                        });
                    }, 1);
                }

                sendBytesAsync();

            });

            it("should respond with not found (-) for missing " + test.type + " data with the (" + test.cmd + ") command", function(done) {
                client.pipe(new CmdResponseListener())
                    .on('header', function(header) {
                        assert(header.cmd[0] === '-');
                        done();
                    });

                const badGuid = Buffer.allocUnsafe(consts.GUID_SIZE).fill(0);
                const badHash = Buffer.allocUnsafe(consts.HASH_SIZE).fill(0);
                client.write(encodeCommand(test.cmd, badGuid, badHash));
            });
        });
     });

    describe("Other", function() {
        it("should force close the socket when a quit (q) command is received", function(done) {
            client = net.connect({port: server.port}, function (err) {
                assert(!err);

                client.on('close', function() {
                    done();
                });

                client.write(helpers.encodeInt32(consts.PROTOCOL_VERSION));
                client.write(cmd.quit);
            });
        });
    })
});