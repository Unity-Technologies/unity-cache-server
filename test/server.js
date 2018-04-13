const assert = require('assert');
const net = require('net');
const helpers = require('../lib/helpers');
const consts = require('../lib/constants');
const CacheServer = require('../lib/server/server');
const Cache = require('../lib/cache/cache_base').CacheBase;
const sleep = require('./test_utils').sleep;
const cmd = require('./test_utils').cmd;

helpers.setLogger(()=>{});
const cache = new Cache();
const server = new CacheServer(cache, {port: 0});
let client;

describe("Server common", function() {

    beforeEach(function() {
        helpers.setLogger(() => {});
    });

    before(function () {
        return server.start(err => assert(!err, `Cache Server reported error! ${err}`));
    });

    after(function() {
        server.stop();
    });

    describe("Version check", function () {

        beforeEach(function (done) {
            client = net.connect({port: server.port}, done);
        });

        it("should echo the version if supported", function (done) {
            client.on('data', function (data) {
                const ver = helpers.readUInt32(data);
                assert.strictEqual(ver, consts.PROTOCOL_VERSION, "Expected " + consts.PROTOCOL_VERSION + " Received " + ver);
                done();
            });

            client.write(helpers.encodeInt32(consts.PROTOCOL_VERSION));
        });

        it("should respond with 0 if unsupported", function (done) {
            client.on('data', function (data) {
                const ver = helpers.readUInt32(data);
                assert.strictEqual(ver, 0, "Expected 0, Received " + ver);
                done();
            });

            client.write(helpers.encodeInt32(consts.PROTOCOL_VERSION + 1));
        });

        it("should recognize a 2 byte version sent 1 byte at a time", function (done) {
            this.slow(250);

            client.on('data', function(data) {
                const ver = helpers.readUInt32(data);
                assert.strictEqual(ver, consts.PROTOCOL_VERSION, "Expected " + consts.PROTOCOL_VERSION + " Received " + ver);
                done();
            });

            const ver = "fe";
            client.write(ver[0]);
            sleep(50).then(() => { client.write(ver[1]); });
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

        it("should force close the socket when an unrecognized command is received", function(done) {
            client = net.connect({port: server.port}, function (err) {
                assert(!err);

                client.on('close', function() {
                    done();
                });

                client.write(helpers.encodeInt32(consts.PROTOCOL_VERSION));
                client.write('xx');
            });
        })
    })
});