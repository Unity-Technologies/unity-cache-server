const assert = require('assert');
const net = require('net');
const cserver = require('../CacheServer.js');

const CACHE_SIZE = 1024 * 1024;
const DEBUG_SERVER_OUPUT = false;

var cache_port = 0;
var cache_path = require('os').tmpdir() + "/" + cserver.UUID();

var logger = function(lvl, msg) {
    if(DEBUG_SERVER_OUPUT)
        console.log(msg);
};

function getWriteBuffer(input) {
    return Buffer.from(input.toString(16), 'ascii');
}

function bufferToInt32(input) {
    return parseInt(input.toString('ascii', 0, 8), 16);
}

function bufferToInt64(input) {
    return parseInt(input.toString('ascii', 0, 16), 16);
}

var client;

describe("CacheServer protocol", function() {

    before(function(done) {
        cserver.Start(CACHE_SIZE, 0, cache_path, logger, function(err) {
            assert(!err, "Cache Server reported error!");
        });

        cache_port = cserver.GetPort();
        done();
    });

    beforeEach(function(done) {
        client = net.connect({port: cache_port}, done);
    });

    describe("Version check", function() {
        it("should echo the version if supported", function(done) {
            var pv = cserver.GetProtocolVersion();

            client.on('data', function(data) {
                var ver = bufferToInt32(data);
                assert(ver == pv, "Expected " + pv + " Received " + ver);
                done();
            });

            client.write(getWriteBuffer(pv));
        });

        it("should respond with 0 if unsupported", function(done) {
            client.on('data', function(data) {
                var ver = bufferToInt32(data);
                assert(ver == 0, "Expected 0, Received " + ver);
                done();
            });

            client.write(getWriteBuffer(cserver.GetProtocolVersion() + 1));
        });
    });

    describe("PUT requests", function () {
        it("should handle the start transaction (ts) command", function(done) {
            done();
        });

        it("should cancel a pending transaction if a new (ts) command is received");
        it("should require a start transaction (ts) cmd before an end transaction (te) cmd");
        it("should store an asset with a put asset (pa) cmd");
        it("should store an info with a put info(pi) cmd");
        it("should store a resource with a put resource (pr) cmd");
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
        it("should only verify integrity with the integrity check-verify command (icv)");
        it("should verify and fix errors with the integrity check-fix command (icf)");
        it("should respond with the number of errors detected with any integrity check command");
    });

    describe("Other", function() {
        it("should force close the socket when a quit (q) command is received");
    })
});