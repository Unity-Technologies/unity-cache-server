const assert = require('assert');
const net = require('net');
const crypto = require('crypto');
const cserver = require('../CacheServer.js');

const CACHE_SIZE = 1024 * 1024;

var cache_port = 0;
var cache_proto_ver = 0;
var cache_path = require('os').tmpdir() + "/" + cserver.UUID();

var client;

function zeroPad(len, str) {
    for (var i = len - str.length; i > 0; i--) {
        str = '0' + str;
    }

    return str;
}

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

function encodeInt32(input) {
    return zeroPad(8, input.toString(16));
}

function encodeInt64(input) {
    return zeroPad(16, input.toString(16));
}

function bufferToInt32(input) {
    return parseInt(input.toString('ascii', 0, 8), 16);
}

function bufferToInt64(input) {
    return parseInt(input.toString('ascii', 0, 16), 16);
}

describe("CacheServer protocol", function() {

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
                var ver = bufferToInt32(data);
                assert(ver == cache_proto_ver, "Expected " + cache_proto_ver + " Received " + ver);
                done();
            });

            client.write(encodeInt32(cache_proto_ver));
        });

        it("should respond with 0 if unsupported", function (done) {
            client.on('data', function (data) {
                var ver = bufferToInt32(data);
                assert(ver == 0, "Expected 0, Received " + ver);
                done();
            });

            client.write(encodeInt32(cache_proto_ver + 1));
        });
    });

    describe("Transactions", function () {

        beforeEach(function (done) {
            client = net.connect({port: cache_port}, function (err) {
                assert(!err);
                client.write(encodeInt32(cache_proto_ver));
                done();
            });
        });

        it("should handle the start transaction (ts) command", function (done) {
            cserver.SetLogger(function (lvl, msg) {
                if (msg.startsWith("Start transaction")) {
                    done();
                }
            });

            var data = cmd.transactionStart
                + crypto.randomBytes(16).toString('ascii')
                + crypto.randomBytes(16).toString('ascii');

            client.write(data);
        });

        it("should cancel a pending transaction if a new (ts) command is received", function (done) {
            cserver.SetLogger(function (lvl, msg) {
                if (msg.startsWith("Cancel previous transaction")) {
                    done();
                }
            });

            var data = cmd.transactionStart
                + crypto.randomBytes(16).toString('ascii')
                + crypto.randomBytes(16).toString('ascii');

            client.write(data + data);
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

            var data = cmd.transactionStart
                + crypto.randomBytes(16).toString('ascii')
                + crypto.randomBytes(16).toString('ascii');

            client.write(data);
            client.write(cmd.transactionEnd);
        });
    });

    describe("PUT requests", function () {

        before(function (done) {
            client = net.connect({port: cache_port}, function (err) {
                assert(!err);

                // Write version
                client.write(encodeInt32(cache_proto_ver));

                // Start transaction
                var data = cmd.transactionStart
                    + crypto.randomBytes(16).toString('ascii')
                    + crypto.randomBytes(16).toString('ascii');

                client.write(data);

                done();
            });
        });

        it("should store an asset with a put asset (pa) cmd", function(done) {
            cserver.SetLogger(function(lvl, msg) {
                if(msg.startsWith("Put Asset Binary")) {
                    done();
                }
            });

            var data = cmd.putAsset //cmd
                + encodeInt64(1024) // size
                + crypto.randomBytes(1024).toString('ascii'); // blob

            client.write(data);
        });

        it("should store an info with a put info(pi) cmd", function(done) {
            cserver.SetLogger(function(lvl, msg) {
                if(msg.startsWith("Put Asset Info")) {
                    done();
                }
            });

            var data = cmd.putInfo //cmd
                + encodeInt64(1024) // size
                + crypto.randomBytes(1024).toString('ascii'); // blob

            client.write(data);
        });

        it("should store a resource with a put resource (pr) cmd", function(done) {
            cserver.SetLogger(function(lvl, msg) {
                if(msg.startsWith("Put Asset Resource")) {
                    done();
                }
            });

            var data = cmd.putResource //cmd
                + encodeInt64(1024) // size
                + crypto.randomBytes(1024).toString('ascii'); // blob

            client.write(data);
        });

        it("should move temp uploaded files into place when the transaction is ended", function(done) {
            cserver.SetLogger(function(lvl, msg) {
                if(msg.startsWith("Rename ")) {
                    cserver.SetLogger(null);
                    done();
                }
            });

            client.write(cmd.transactionEnd);
        });
    });

    describe("GET requests", function() {
        it("should respond correctly to a get asset (ga) request for an existing item");
        it('should respond correctly to a get asset (ga) request for a missing item');
        it("should respond correctly to a get info (gi) request for an existing item");
        it("should respond correctly to a get info (gi) request for a missing item");
        it("should respond correctly to a get resource (gr) request for an existing item");
        it("should respond correctly to a get resource (gr) request for a missing item");
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