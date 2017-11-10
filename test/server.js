const assert = require('assert');
const net = require('net');
const helpers = require('../lib/helpers');
const consts = require('../lib/constants').Constants;
const CacheServer = require('../lib/server');
const Cache = require("../lib/cache/cache_debug");

const generateCommandData = require('./test_utils').generateCommandData;
const encodeCommand = require('./test_utils').encodeCommand;
const sleep = require('./test_utils').sleep;
const expectLog = require('./test_utils').expectLog;
const cmd = require('./test_utils').cmd;

helpers.SetLogger(()=>{});
const cache = new Cache();
const server = new CacheServer(cache, 0);
let client;

describe("Server common", function() {

    beforeEach(function() {
        helpers.SetLogger(function(lvl, msg) {});
    });

    before(function (done) {
        server.Start(function (err) {
            assert(!err, "Cache Server reported error! " + err);
        }, done);
    });

    after(function() {
        server.Stop();
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