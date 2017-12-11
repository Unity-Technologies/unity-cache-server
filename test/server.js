const assert = require('assert');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const helpers = require('../lib/helpers');
const consts = require('../lib/constants').Constants;
const CacheServer = require('../lib/server.js');
const CacheFS = require("../lib/cache_fs");

const CmdResponseListener = require('./../lib/client/server_response_transform.js');

const CACHE_SIZE = 1024 * 1024;
const MIN_BLOB_SIZE = 64;
const MAX_BLOB_SIZE = 2048;

helpers.SetLogger(()=>{});
var cache = new CacheFS(helpers.generateTempDir(), CACHE_SIZE);
var server = new CacheServer(cache, {port: 0});
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

function generateCommandData(minSize, maxSize) {
    minSize = minSize || MIN_BLOB_SIZE;
    maxSize = maxSize || MAX_BLOB_SIZE;

    function getSize() { return Math.max(minSize, Math.floor(Math.random() * maxSize)); }

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
    if(callback == null) {
        callback = condition;
        condition = true;
    }

    var match;
    helpers.SetLogger(function (lvl, msg) {
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
                var ver = helpers.readUInt32(data);
                assert(ver == consts.PROTOCOL_VERSION, "Expected " + consts.PROTOCOL_VERSION + " Received " + ver);
                done();
            });

            client.write(helpers.encodeInt32(consts.PROTOCOL_VERSION));
        });

        it("should respond with 0 if unsupported", function (done) {
            client.on('data', function (data) {
                var ver = helpers.readUInt32(data);
                assert(ver == 0, "Expected 0, Received " + ver);
                done();
            });

            client.write(helpers.encodeInt32(consts.PROTOCOL_VERSION + 1));
        });

        it("should recognize a 2 byte version sent 1 byte at a time", function (done) {
            this.slow(250);

            client.on('data', function(data) {
                var ver = helpers.readUInt32(data);
                assert(ver == consts.PROTOCOL_VERSION, "Expected " + consts.PROTOCOL_VERSION + " Received " + ver);
                done();
            });

            var ver = "fe";
            client.write(ver[0]);
            sleep(50).then(() => { client.write(ver[1]); });
        });
    });

    describe("Transactions", function () {

        var self = this;

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
            var d = encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash);
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
            client.write(encodeCommand(cmd.putAsset, null, null, self.data.asset));
        });

        it("should close the socket on an invalid transaction command", function(done) {
            expectLog(client, /invalid data receive/i, done);
            client.write('tx', self.data.guid, self.data.hash);
        });
    });

    describe("PUT requests", function () {
        this.slow(1500);

        var self = this;
        this.getCachePath = function(extension) {
            return cache.GetCachePath(
                helpers.readHex(self.data.guid.length, self.data.guid),
                helpers.readHex(self.data.hash.length, self.data.hash),
                extension, false);
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
            expectLog(client, /invalid data receive/i, done);
            client.write(
                encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash) +
                encodeCommand("px", null, null, self.data.asset));
        });

        it("should try to free cache space if the cache size exceeds the max cache size after writing a file", function(done) {
            var match1 = false;
            var match2 = false;

            cache.maxCacheSize = 1024;

            helpers.SetLogger(function(lvl, msg) {
                match1 = match1 || /Begin.*1200/.test(msg);
                match2 = match2 || /Completed.*800/.test(msg);
            });

            client.on('close', function() {
                assert(match1 && match2);
                cache.maxCacheSize = CACHE_SIZE;
                done();
            });

            var data = generateCommandData(400, 400);
            client.write(
                encodeCommand(cmd.transactionStart, data.guid, data.hash) +
                encodeCommand(cmd.putAsset, null, null, data.asset) +
                encodeCommand(cmd.putResource, null, null, data.resource) +
                encodeCommand(cmd.putInfo, null, null, data.resource) +
                encodeCommand(cmd.transactionEnd));

            sleep(50).then(() => { client.end(); })
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

                var buf = Buffer.from(
                    encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash) +
                    encodeCommand(test.cmd, null, null, self.data.asset) +
                    encodeCommand(cmd.transactionEnd), 'ascii');

                var sentBytes = 0;
                function sendBytesAsync() {
                    setTimeout(() => {
                        var packetSize = Math.min(buf.length - sentBytes, Math.ceil(Math.random() * 10));
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
            var asset = Buffer.from(crypto.randomBytes(self.data.asset.length).toString('ascii'), 'ascii');

            client.on('close', function() {
                fs.open(self.getCachePath('bin'), 'r', function(err, fd) {
                    assert(!err, err);
                    var buf = fs.readFileSync(fd);
                    assert(buf.compare(asset) == 0);
                    done();
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

        var self = this;
        self.data = generateCommandData();

        before(function(done) {
            client = net.connect({port: server.port}, function (err) {
                assert(!err);
                client.write(helpers.encodeInt32(consts.PROTOCOL_VERSION));
                client.write(encodeCommand(cmd.transactionStart, self.data.guid, self.data.hash));
                client.write(encodeCommand(cmd.putAsset, null, null, self.data.asset));
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
            expectLog(client, /invalid data receive/i, done);
            client.write(encodeCommand('gx', self.data.guid, self.data.hash));
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

                var buf = Buffer.from(encodeCommand(test.cmd, self.data.guid, self.data.hash), 'ascii');

                var sentBytes = 0;
                function sendBytesAsync() {
                    setTimeout(() => {
                        var packetSize = Math.min(buf.length - sentBytes, Math.ceil(Math.random() * 10));
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

                var badGuid = Buffer.allocUnsafe(consts.GUID_SIZE).fill(0);
                var badHash = Buffer.allocUnsafe(consts.HASH_SIZE).fill(0);
                client.write(encodeCommand(test.cmd, badGuid, badHash));
            });
        });
     });

    describe("Integrity check", function() {

        var self = this;

        before(function() {
            self.data = generateCommandData();
        });

        beforeEach(function (done) {
            client = net.connect({port: server.port}, function (err) {
                assert(!err);
                client.write(helpers.encodeInt32(consts.PROTOCOL_VERSION));
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

        it("should respond with the number of errors detected with any integrity check command", function(done) {
            expectLog(client, /fix \d+ issue/, done);
            client.end(cmd.integrityFix);
        });

        it("should close the socket on an invalid integrity command type", function(done) {
            expectLog(client, /invalid data receive/i, done);
            client.write('icx');
        });

        describe("Validations", function() {
            this.slow(250);

            it("should remove unrecognized files from the cache root dir", function(done) {
                var filePath = cache.cacheDir + "/file.rogue";
                fs.writeFileSync(filePath, "");

                client.on('close', function() {
                    assert(!fs.existsSync(filePath));
                    done();
                });

                client.write(cmd.integrityFix);
                sleep(50).then(() => { client.end(); });
            });

            it("should remove unrecognized files from cache subdirs", function(done) {
                var filePath = cache.cacheDir + "/00/file.rogue";
                fs.writeFileSync(filePath, "");

                client.on('close', function() {
                    assert(!fs.existsSync(filePath));
                    done();
                });

                client.write(cmd.integrityFix);
                sleep(50).then(() => { client.end(); });
            });

            it("should remove unrecognized directories from the cache root dir", function(done) {
                var dirPath = cache.cacheDir + "/dir.rogue";
                fs.mkdirSync(dirPath);

                client.on('close', function() {
                    assert(!fs.existsSync(dirPath));
                    done();
                });

                client.write(cmd.integrityFix);
                sleep(50).then(() => { client.end(); });
            });

            it("should remove unrecognized directories from cache subdirs", function(done) {
                var dirPath = cache.cacheDir + "/00/dir.rogue";
                fs.mkdirSync(dirPath);

                client.on('close', function() {
                    assert(!fs.existsSync(dirPath));
                    done();
                });

                client.write(cmd.integrityFix);
                sleep(50).then(() => { client.end(); });
            });

            it("should ensure that cache files match their parent dir namespace", function(done) {
                var data = generateCommandData();
                var fileName = data.guid.toString('hex') + "-" + data.hash.toString('hex') + ".bin";

                // Put a valid cache file into the wrong sub directory
                fileName = "ff" + fileName.slice(2);
                var filePath = cache.cacheDir + "/00/" + fileName;

                fs.writeFileSync(filePath, "");

                client.on('close', function() {
                    assert(!fs.existsSync(filePath));
                    done();
                });

                client.write(cmd.integrityFix);
                sleep(50).then(() => { client.end(); });
            });

            it("should ensure each .resource file has a corresponding .bin file", function(done) {
                expectLog(client, /fix 1 issue/, done);

                var data = generateCommandData();
                client.write(encodeCommand(cmd.transactionStart, data.guid, data.hash));
                client.write(encodeCommand(cmd.putResource, null, null, data.resource));
                client.write(encodeCommand(cmd.transactionEnd));

                sleep(50).then(() => {
                    client.end(cmd.integrityFix);
                });
            });

            it("should ensure each .info file has a corresponding .bin file", function(done) {
                expectLog(client, /fix 1 issue/, done);

                var data = generateCommandData();
                client.write(encodeCommand(cmd.transactionStart, data.guid, data.hash));
                client.write(encodeCommand(cmd.putInfo, null, null, data.info));
                client.write(encodeCommand(cmd.transactionEnd));

                sleep(50).then(() => {
                    client.end(cmd.integrityFix);
                });
            });

            it("should ensure each .bin file has a corresponding .info file", function(done) {
                expectLog(client, /fix 1 issue/, done);

                var data = generateCommandData();
                client.write(encodeCommand(cmd.transactionStart, data.guid, data.hash));
                client.write(encodeCommand(cmd.putAsset, null, null, data.asset));
                client.write(encodeCommand(cmd.transactionEnd));

                sleep(50).then(() => {
                    client.end(cmd.integrityFix);
                });
            });

            it("should ensure each .resource file has a corresponding .info file", function(done) {
                expectLog(client, /fix 2 issue/, done);

                var data = generateCommandData();
                client.write(encodeCommand(cmd.transactionStart, data.guid, data.hash));
                client.write(encodeCommand(cmd.putAsset, null, null, data.asset));
                client.write(encodeCommand(cmd.putResource, null, null, data.resource));
                client.write(encodeCommand(cmd.transactionEnd));

                sleep(50).then(() => {
                    client.end(cmd.integrityFix);
                });
            });

            var requiredResourceTests = [
                { type: "audio", classId: "1020" }
            ];

            requiredResourceTests.forEach(function(test) {
                it("should ensure " + test.type + " files have a corresponding .resource file", function(done) {
                    expectLog(client, /fix 2 issue/, done);

                    var data = generateCommandData();
                    data.info = Buffer.from("  assetImporterClassID: " + test.classId, 'ascii');
                    client.write(encodeCommand(cmd.transactionStart, data.guid, data.hash));
                    client.write(encodeCommand(cmd.putAsset, null, null, data.asset));
                    client.write(encodeCommand(cmd.putInfo, null, null, data.info));
                    client.write(encodeCommand(cmd.transactionEnd));

                    sleep(50).then(() => {
                        client.end(cmd.integrityFix);
                    });

                });
            });

            var skipFiles = [
                "desktop.ini",
                "temp",
                ".ds_store"
            ]

            skipFiles.forEach(function(test) {
                it("should skip validation for certain system specific files (" + test + ")", function(done) {
                    var filePath = cache.cacheDir + "/" + test;
                    fs.writeFileSync(filePath, "");

                    client.on('close', function() {
                        fs.access(filePath, function(error) {
                            assert(!error);
                            done();
                        })
                    });

                    client.write(cmd.integrityFix);
                    sleep(50).then(() => { client.end(); });
                })
            })
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