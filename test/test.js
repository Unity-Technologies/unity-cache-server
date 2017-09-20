const assert = require('assert');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const globals = require('../lib/globals');
const consts = require('../lib/constants').Constants;
const cserver = require('../lib/server.js');
const cachefs = require("../lib/cache_fs");

const CmdResponseListener = require('./../lib/client/server_response_transform.js');

const CACHE_SIZE = 1024 * 1024;
const MIN_BLOB_SIZE = 64;
const MAX_BLOB_SIZE = 2048;

var cache_port = 0;
var cache_proto_ver = 0;
var cache_path = require('os').tmpdir() + "/" + crypto.randomBytes(32).toString('hex');

var client;

var cmd = {
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

function generateCommandData() {

    function getSize() { return Math.max(MIN_BLOB_SIZE, Math.floor(Math.random() * MAX_BLOB_SIZE)); }

    return {
        guid: Buffer.from(crypto.randomBytes(consts.GUID_SIZE).toString('ascii'), 'ascii'),
        hash: Buffer.from(crypto.randomBytes(consts.HASH_SIZE).toString('ascii'), 'ascii'),
        asset: Buffer.from(crypto.randomBytes(getSize()).toString('ascii'), 'ascii'),
        info: Buffer.from(crypto.randomBytes(getSize()).toString('ascii'), 'ascii'),
        resource: Buffer.from(crypto.randomBytes(getSize()).toString('ascii'), 'ascii')
    }
}

function encodeCommand(command, guid, hash, blob) {

    if(blob)
        command += globals.encodeInt64(blob.length);

    if(guid)
        command += guid;

    if(hash)
        command += hash;

    if(blob)
        command += blob;

    return command;
}

function expectLog(client, regex, condition, callback) {
    if(callback == null) {
        callback = condition;
        condition = true;
    }

    var match;
    globals.SetLogger(function (lvl, msg) {
        match = match || regex.test(msg);
    });

    client.on('close', function() {
        assert(match == condition);
        callback();
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("CacheServer protocol", function() {

    beforeEach(function() {
        globals.SetLogger(function(lvl, msg) {});
    });

    before(function (done) {
        cserver.Start(CACHE_SIZE, 0, cache_path, function (lvl, msg) {
        }, function (err) {
            assert(!err, "Cache Server reported error!");
        });

        cache_port = cserver.GetPort();
        cache_proto_ver = cserver.GetProtocolVersion();
        done();
    });

    describe("Version check", function () {

        beforeEach(function (done) {
            client = net.connect({port: cache_port}, done);
        });

        it("should echo the version if supported", function (done) {
            client.on('data', function (data) {
                var ver = globals.readUInt32(data);
                assert(ver == cache_proto_ver, "Expected " + cache_proto_ver + " Received " + ver);
                done();
            });

            client.write(globals.encodeInt32(cache_proto_ver));
        });

        it("should respond with 0 if unsupported", function (done) {
            client.on('data', function (data) {
                var ver = globals.readUInt32(data);
                assert(ver == 0, "Expected 0, Received " + ver);
                done();
            });

            client.write(globals.encodeInt32(cache_proto_ver + 1));
        });
    });

    describe("Transactions", function () {

        var self = this;

        beforeEach(function (done) {
            client = net.connect({port: cache_port}, function (err) {
                assert(!err);
                self.data = generateCommandData();
                client.write(globals.encodeInt32(cache_proto_ver));
                done();
            });
        });

        it("should start a transaction with the (ts) command", function (done) {
            expectLog(client, /Start transaction/, done);
            client.end(encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash));
        });

        it("should cancel a pending transaction if a new (ts) command is received", function (done) {
            expectLog(client, /Cancel previous transaction/, done);
            var d = encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash);
            client.write(d);
            client.end(d);
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
            client.write(encodeCommand(cmd.putAsset, null, null, self.data.asset));
        });
    });

    describe("PUT requests", function () {

        var self = this;
        this.getCachePath = function(extension) {
            return cachefs.GetCachePath(
                globals.readHex(self.data.guid.length, self.data.guid),
                globals.readHex(self.data.hash.length, self.data.hash),
                extension, false);
        };

        beforeEach(function (done) {
            client = net.connect({port: cache_port}, function (err) {
                assert(!err);
                self.data = generateCommandData();
                client.write(globals.encodeInt32(cache_proto_ver));

                // Start transaction
                client.write(encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash));
                done();
            });
        });

        var tests = [
            {ext: 'bin', cmd: cmd.putAsset},
            {ext: 'info', cmd: cmd.putInfo},
            {ext: 'resource', cmd: cmd.putResource}
        ];

        tests.forEach(function(test) {
            it("should store " + test.ext + " data with a (" + test.cmd + ") cmd", function(done) {
                client.on('close', function() {
                    fs.open(self.getCachePath(test.ext), 'r', function(err, fd) {
                        assert(!err, err);
                        var buf = fs.readFileSync(fd);
                        assert(buf.compare(self.data.asset) == 0);
                        done();
                    });
                });

                client.write(encodeCommand(test.cmd, null, null, self.data.asset));
                client.write(encodeCommand(cmd.transactionEnd));

                // The server is doing async file operations to move the file into place. be patient.
                sleep(25).then(() => {
                    client.end();
                });
            });
        });
    });

    describe("GET requests", function() {

        var self = this;
        self.data = generateCommandData();


        before(function(done) {
            client = net.connect({port: cache_port}, function (err) {
                assert(!err);
                client.write(globals.encodeInt32(cache_proto_ver));
                client.write(encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash));
                client.write(encodeCommand(cmd.putAsset, null, null, self.data.asset));
                client.write(encodeCommand(cmd.putInfo, null, null, self.data.info));
                client.write(encodeCommand(cmd.putResource, null, null, self.data.resource));
                client.write(cmd.transactionEnd);

                sleep(25).then(() => {
                    done();
                });
            });
        });

        beforeEach(function (done) {
            client = net.connect({port: cache_port}, function (err) {
                assert(!err);

                // Write version
                client.write(globals.encodeInt32(cache_proto_ver));
                done();
            });
        });

        var tests = [
            { cmd: cmd.getAsset, blob: self.data.asset, type: 'bin' },
            { cmd: cmd.getInfo, blob: self.data.info, type: 'info' },
            { cmd: cmd.getResource, blob: self.data.resource, type: 'resource' }
        ];

        tests.forEach(function(test) {
            it("should retrieve stored " + test.type + " data with the (" + test.cmd + ") command", function(done) {
                var dataBuf;
                var pos = 0;
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

                client.write(encodeCommand(test.cmd, self.data.guid, self.data.hash));

            });

            it("should respond with not found (-) for missing " + test.type + " data with the (" + test.cmd + ") command", function(done) {
                client.pipe(new CmdResponseListener())
                    .on('header', function(header) {
                        assert(header.cmd[0] === '-');
                        done();
                    });

                var badGuid = Buffer.allocUnsafe(consts.GUID_SIZE).fill(0);
                var badHash = Buffer.allocUnsafe(consts.HASH_SIZE).fill(0);
                client.write(encodeCommand(test.cmd, badGuid, badHash));
            });
        });
     });

    describe("Integrity check", function() {

        var self = this;

        beforeEach(function (done) {
            client = net.connect({port: cache_port}, function (err) {
                assert(!err);
                self.data = generateCommandData();
                client.write(globals.encodeInt32(cache_proto_ver));
                done();
            });
        });

        it("should not allow an integrity check while in a transaction", function(done) {
            expectLog(client, /In a transaction/, done);
            client.write(encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash));
            client.end(cmd.integrityVerify);
        });

        it("should only verify integrity with the integrity check-verify command (icv)", function(done) {
            expectLog(client, /fix/, false, done);
            client.end(cmd.integrityVerify);
        });

        it("should verify and fix errors with the integrity check-fix command (icf)", function (done) {
            expectLog(client, /File deleted/, done);
            client.end(cmd.integrityFix);
        });

        it("should respond with the number of errors detected with any integrity check command", function(done) {
            expectLog(client, /fix \d+ issue/, done);
            client.end(cmd.integrityFix);
        });
    });

    describe("Other", function() {
        it("should force close the socket when a quit (q) command is received", function(done) {
            client = net.connect({port: cache_port}, function (err) {
                assert(!err);

                client.on('close', function() {
                    done();
                });

                client.write(globals.encodeInt32(cache_proto_ver));
                client.write(cmd.quit);
            });
        });
    })
});