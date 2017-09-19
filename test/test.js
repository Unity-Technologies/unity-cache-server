const assert = require('assert');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const globals = require('./globals');
const cserver = require('../CacheServer.js');
const CmdResponseListener = require('./cmd_response_listener.js');

const CACHE_SIZE = 1024 * 1024;
const MIN_BLOB_SIZE = 64;
const MAX_BLOB_SIZE = 2048;

var cache_port = 0;
var cache_proto_ver = 0;
var cache_path = require('os').tmpdir() + "/" + cserver.UUID();

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
        guid: Buffer.from(crypto.randomBytes(globals.GUID_SIZE).toString('ascii'), 'ascii'),
        hash: Buffer.from(crypto.randomBytes(globals.HASH_SIZE).toString('ascii'), 'ascii'),
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

describe("CacheServer protocol", function() {

    beforeEach(function() {
        cserver.SetLogger(function(lvl, msg) {});
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
                var ver = globals.bufferToInt32(data);
                assert(ver == cache_proto_ver, "Expected " + cache_proto_ver + " Received " + ver);
                done();
            });

            client.write(globals.encodeInt32(cache_proto_ver));
        });

        it("should respond with 0 if unsupported", function (done) {
            client.on('data', function (data) {
                var ver = globals.bufferToInt32(data);
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

        it("should handle the start transaction (ts) command", function (done) {
            cserver.SetLogger(function (lvl, msg) {
                if (msg.startsWith("Start transaction")) {
                    done();
                }
            });

            client.write(encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash));
        });

        it("should cancel a pending transaction if a new (ts) command is received", function (done) {
            cserver.SetLogger(function (lvl, msg) {
                if (msg.startsWith("Cancel previous transaction")) {
                    done();
                }
            });

            var d = encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash);
            client.write(d);
            client.write(d);
        });

        it("should require a start transaction (ts) cmd before an end transaction (te) cmd", function (done) {
            cserver.SetLogger(function (lvl, msg) {
                if (msg.startsWith("Invalid transaction isolation")) {
                    done();
                }
            });

            client.write(cmd.transactionEnd);
        });

        it("should end a transaction that was started", function (done) {
            cserver.SetLogger(function (lvl, msg) {
                if (msg.startsWith("End transaction for")) {
                    done();
                }
            });

            client.write(encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash));
            client.write(cmd.transactionEnd);
        });
    });

    describe("PUT requests", function () {

        var self = this;
        this.getCachePath = function(extension) {
            return cserver.GetCachePath(
                cserver.readHex(self.data.guid.length, self.data.guid),
                cserver.readHex(self.data.hash.length, self.data.hash),
                extension, false);
        };

        beforeEach(function (done) {
            client = net.connect({port: cache_port}, function (err) {
                assert(!err);
                self.data = generateCommandData();

                // Write version
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
            it("should store " + test.ext + " with a (" + test.cmd + ") cmd", function(done) {
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
                globals.sleep(25).then(() => {
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

                globals.sleep(25).then(() => {
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
            { cmd: cmd.getAsset, blob: self.data.asset },
            { cmd: cmd.getInfo, blob: self.data.info },
            { cmd: cmd.getResource, blob: self.data.resource }
        ];

        tests.forEach(function(test) {
            it("should respond correctly to (" + test.cmd + ") for an existing item", function(done) {
                var listener = new CmdResponseListener(client);
                listener.on('header', function(header) {
                    assert(header.cmd[0] === '+');
                    assert(header.size === test.blob.length, "Expected size " + test.blob.length);
                });

                listener.on('data', function(data, more) {
                    assert(!more);
                    assert(data.compare(test.blob) === 0);
                    done();
                });

                client.write(encodeCommand(test.cmd, self.data.guid, self.data.hash));
            });

            it("should respond correctly to (" + test.cmd + ") for a missing item", function(done) {
                var listener = new CmdResponseListener(client);
                listener.on('header', function(header) {
                    assert(header.cmd[0] === '-');
                    assert(header.size === 0);
                    done();
                });

                var badGuid = Buffer.allocUnsafe(globals.GUID_SIZE).fill(0);
                var badHash = Buffer.allocUnsafe(globals.HASH_SIZE).fill(0);
                client.write(encodeCommand(test.cmd, badGuid, badHash));
            });
        });
     });

    describe("Integrity check", function() {
        it("should not allow an integrity check while in a transaction");
        it("should only verify integrity with the integrity check-verify command (icv)");
        it("should verify and fix errors with the integrity check-fix command (icf)");
        it("should respond with the number of errors detected with any integrity check command");
    });

    describe("Other", function() {
        it("should force close the socket when a quit (q) command is received");
    })
});