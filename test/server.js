require('./test_init');

const assert = require('assert');
const net = require('net');
const os = require('os');
const helpers = require('../lib/helpers');
const consts = require('../lib/constants');
const CacheServer = require('../lib/server/server');
const tmp = require('tmp');
const ClientStreamRecorder = require('../lib/server/client_stream_recorder');
const CacheBase = require('../lib/cache/cache_base').CacheBase;
const { generateCommandData, encodeCommand, clientWrite, sleep, cmd, purgeConfig } = require('./test_utils');
const sinon = require('sinon');

const cache = new CacheBase();
let client;

describe("Server constructor", function() {
    it("should use the default host and port if no host or port is specified in options", () => {
        const s = new CacheServer(cache, { mirror:[] });
        assert.strictEqual(s.port, consts.DEFAULT_PORT);
        assert.strictEqual(s.host, consts.DEFAULT_HOST);
    });
});

describe("Server mirroring", function() {
    const server = new CacheServer(cache, {
        port: 0,
        mirror: [{host: "127.0.0.1", port: 8126}, {host: "1.2.3.4", port: 8126}, {host: "4.3.2.1", port: 8126}]
    });

    before(function () {
        return server.start(err => { return Promise.reject(err); });
    });

    after(function() {
        server.stop();
    });

    beforeEach(function (done) {
        client = net.connect({port: server.port}, done);
    });

    afterEach(() => client.end());

    it("should mirror transactions to the configured list of mirrors", async () => {
        const spies = server.mirrors.map(m => {
            return sinon.spy(m, "queueTransaction");
        });

        const testData = generateCommandData();

        const buf = Buffer.from(helpers.encodeInt32(consts.PROTOCOL_VERSION) +
            encodeCommand(cmd.transactionStart, testData.guid, testData.hash) +
            encodeCommand(cmd.putAsset, null, null, testData.bin) +
            encodeCommand(cmd.transactionEnd), 'ascii');

        await clientWrite(client, buf);

        spies.forEach(s => assert(s.calledOnce));
    });
});

describe("Server startup", function() {
    let server;

    after(() => {
        server.stop();
    });

    it("Should try to bind to the configured host",  function(done) {
        // Validating an exception trying to bind to a bogus adapter is much simpler and more portable than trying
        // to find a unique, valid adapter to bind to.
        const host = "1.2.3.4";
        server = new CacheServer(cache, {host, port: 0});
        server.start(err => {
            assert.strictEqual(err.address, host);
            done();
        });
    });
});

describe("Server common", function() {
    const server = new CacheServer(cache, {port: 0});

    before(function () {
        this._defaultErrCallback = err => assert(!err, `Cache Server reported error! ${err}`);
        return server.start(this._defaultErrCallback);
    });

    after(function() {
        server.stop();
    });

    describe("Version check", function () {

        beforeEach(function (done) {
            client = net.connect({port: server.port}, done);
        });

        afterEach(() => client.end());

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

    describe("Ipv6", function() {
        const ipv6Server = new CacheServer(cache, {port: 0, allowIpv6: true});

        before(function () {
            const interfaces = os.networkInterfaces();
            let ipv6Available = false;
            Object.keys(interfaces).forEach(function (interfaceName){
                interfaces[interfaceName].forEach(function (address){
                    if(address.family === "IPv6"){
                        ipv6Available = true;
                    }
                });
            });

            if(!ipv6Available){
                console.log("Skipping IPv6 tests because IPv6 is not available on this machine");
                this.skip();
            }

            return ipv6Server.start(err => assert(!err, `Cache Server reported error! ${err}`));
        });

        after(function() {
            ipv6Server.stop();
        });

        it("should bind to ipv6 when allowed", function(done) {
            const serverAddress = ipv6Server._server.address();
            assert.strictEqual(serverAddress.family, "IPv6");
            done();
        });

    });

    describe("Ipv4", function() {
        const ipv4Server = new CacheServer(cache, {port: 0, allowIpv6: false});

        before(function () {
            return ipv4Server.start(err => assert(!err, `Cache Server reported error! ${err}`));
        });

        after(function() {
            ipv4Server.stop();
        });

        it("should bind to ipv4 when ipv6 not allowed", function(done) {
            const serverAddress = ipv4Server._server.address();
            assert.strictEqual(serverAddress.family, "IPv4");
            done();
        });
    });

    describe("Error Handling", function() {
        after(() => {
            server.errCallback = this._defaultErrCallback;
            helpers.setLogger(() => {});
        });

        it("should call the configured error handler when an error event is raised", async () => {
            return new Promise(resolve => {
                const err = new Error();
                server.errCallback = e => {
                    assert.strictEqual(e, err);
                    resolve();
                };

                server._server.emit('error', err);
            });
        });

        it("should log an error if the error code is 'EADDRINUSE", async () => {
            return new Promise((resolve, reject) => {
                server.errCallback = e => {};
                helpers.setLogger((lvl, msg) => {
                    /already in use/.test(msg) ? resolve() : reject();
                });

                const err = new Error();
                err.code = 'EADDRINUSE';
                server._server.emit('error', err);
            });
        });

        it("should log an error if the error code is 'ECONNRESET", async () => {
            return new Promise((resolve, reject) => {
                server.errCallback = e => {};
                helpers.setLogger((lvl, msg) => {
                    /unexpectedly closed the connection/.test(msg) ? resolve() : reject();
                });

                const err = new Error();
                err.code = 'ECONNRESET';
                server._server.emit('error', err);
            });
        });
    });

    describe("Client Recorder", () => {
        before(async () => {
            this.tmpDir = tmp.dirSync({unsafeCleanup: true});

            purgeConfig();
            process.env.NODE_CONFIG = JSON.stringify({
                Diagnostics: {
                    clientRecorderOptions: {
                        saveDir: this.tmpDir.name,
                        bufferSize: 1024
                    }
                }
            });

            this.csrServer = new CacheServer(cache, {clientRecorder: true});
            return this.csrServer.start(err => assert(!err, `Cache Server reported error! ${err}`));
        });

        after(() => {
            this.tmpDir.removeCallback();
            return this.csrServer.stop();
        });

        it("should use the ClientStreamRecorder if configured", (done) => {
            assert.ok(this.csrServer.isRecordingClient);

            this.csrServer.server.on('connection', socket => {
                assert.ok(Array.isArray(socket._readableState.pipes));
                assert.ok(socket._readableState.pipes.find(x => x instanceof ClientStreamRecorder));
            });

            client = net.connect({port: this.csrServer.port}, () => {
                client.write(helpers.encodeInt32(consts.PROTOCOL_VERSION));
                client.end(cmd.quit);
            }).on('data', () => {}).on('close', () => done());
        });
    });

    describe("Other", function() {
        it("should force close the socket when a quit (q) command is received", function(done) {
            client = net.connect({port: server.port}, function (err) {
                assert(!err);

                client.on('close', function() {
                    done();
                });

                client.on('data', () => {});

                client.write(helpers.encodeInt32(consts.PROTOCOL_VERSION));
                client.end(cmd.quit);
            });
        });

        it("should force close the socket when an unrecognized command is received", function(done) {
            client = net.connect({port: server.port}, function (err) {
                assert(!err);

                client.on('close', function() {
                    done();
                });

                client.on('data', () => {});

                client.write(helpers.encodeInt32(consts.PROTOCOL_VERSION));
                client.end('xx');
            });
        });
    });
});

