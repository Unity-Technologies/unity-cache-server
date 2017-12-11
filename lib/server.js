'use strict';
const cluster = require('cluster');
const net = require('net');
const fs = require('fs');
const consts = require('./constants').Constants;
const helpers = require('./helpers');

const StatsDClient = require('statsd-client');

const CMD_QUIT = 'q'.charCodeAt(0);

const CMD_GET = 'g'.charCodeAt(0);
const CMD_PUT = 'p'.charCodeAt(0);
const CMD_GETOK = '+'.charCodeAt(0);
const CMD_GETNOK = '-'.charCodeAt(0);

const TYPE_ASSET = 'a'.charCodeAt(0);
const TYPE_INFO = 'i'.charCodeAt(0);
const TYPE_RESOURCE = 'r'.charCodeAt(0);

const CMD_TRX = 't'.charCodeAt(0);
const TRX_START = 's'.charCodeAt(0);
const TRX_END = 'e'.charCodeAt(0);

const CMD_INTEGRITY = 'i'.charCodeAt(0);
const CMD_CHECK = 'c'.charCodeAt(0);
const OPT_VERIFY = 'v'.charCodeAt(0);
const OPT_FIX = 'f'.charCodeAt(0);


class CacheServer {
    constructor(cache, port) {
        this._cache = cache;
        this._port = parseInt(port);
        if (!port && port !== 0)
            this._port = consts.DEFAULT_PORT;
        this._sever = null;

        this.statsd = new StatsDClient({
            prefix: 'cache-server'
        });
    }

    get port() {
        return this._server && this._server.listening
            ? this._server.address().port
            : this._port;
    }

    get cache() {
        return this._cache;
    }

    get server() {
        return this._server;
    }

    static uuid() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,
            function (c) {
                var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            });
    }

    _HandleData(socket, data) {
        var self = this;
        var start = new Date();
        var trxStart = 0;

        // There is pending data, add it to the data buffer
        if (socket.pendingData != null) {
            let buf = new Buffer(data.length + socket.pendingData.length);
            socket.pendingData.copy(buf, 0, 0);
            data.copy(buf, socket.pendingData.length, 0);
            data = buf;
            socket.pendingData = null;
        }

        while (true) {
            // Get the version as the first thing
            var idx = 0;
            if (!socket.protocolVersion) {
                if (data.length < consts.PROTOCOL_VERSION_MIN_SIZE)
                {
                    // We need more data
                    socket.pendingData = data;
                    return false;
                }

                socket.protocolVersion = helpers.readUInt32(data);
                self.statsd.increment('protocol-version', 1, { protocol_version: socket.protocolVersion });
                let buf = Buffer.allocUnsafe(consts.UINT32_SIZE);
                if (socket.protocolVersion == consts.PROTOCOL_VERSION) {
                    helpers.log(consts.LOG_INFO, "Client protocol version " + socket.protocolVersion);
                    buf.write(helpers.encodeInt32(socket.protocolVersion));
                    if (socket.isActive)
                        socket.write(buf);
                    data = data.slice(consts.UINT32_SIZE);
                }
                else {
                    helpers.log(consts.LOG_ERR, "Bad Client protocol version");
                    buf.write(helpers.encodeInt32(0));
                    if (socket.isActive)
                        socket.write(buf);
                    socket.end();
                    socket.forceQuit = true;
                    return false;
                }
            }

            // Write a a file to a temp location and move it in place when it has completed
            if (socket.activePutFile != null) {
                let size = data.length;
                if (size > socket.bytesToBeWritten) {
                    size = socket.bytesToBeWritten;
                }
                socket.activePutFile.write(data.slice(0, size), "binary");
                socket.bytesToBeWritten -= size;

                // If we have written all data for this file. We can close the file.
                if (socket.bytesToBeWritten <= 0) {
                    socket.activePutFile.end(function () {
                        socket.targets.push({
                            from: socket.tempPath,
                            to: socket.activePutTarget,
                            size: socket.totalFileSize
                        });
                        socket.tempPath = null;
                        socket.activePutTarget = null;
                        socket.totalFileSize = 0;
                        if (socket.isActive) {
                            socket.resume();

                            // It's possible to have already processed a 'te' (transaction end) event before this callback is called.
                            // Call _HandleData again to ensure the 'te' event is re-processed now that we finished
                            // saving this file
                            if (socket.inTransaction)
                                self._HandleData(socket, Buffer.from([]));
                        }
                    });
                    socket.activePutFile = null;

                    data = data.slice(size);
                    continue;
                }

                // We need more data to write the file completely
                // Return and wait for the next call to _HandleData to receive more data.
                return true;
            }

            if (data.length == 0) {
                // No more data
                return false;
            }

            if (data[idx] == CMD_QUIT) {
                self.statsd.increment('cmd', 1, {cmd_Quit: 'quit'});
                self.statsd.timing('request-latency', start)
                socket.end();
                socket.forceQuit = true;
                return false;
            }

            if (data[idx] == CMD_GET) {
                self.statsd.increment('cmd', 1, {cmd: 'get'});
                if (data.length < consts.CMD_SIZE + consts.ID_SIZE) {
                    socket.pendingData = data;
                    return true;
                }
                idx += 1;


                let reqType = data[idx];

                idx += 1;
                var guid = helpers.readHex(consts.GUID_SIZE, data.slice(idx));
                var hash = helpers.readHex(consts.HASH_SIZE, data.slice(idx + consts.GUID_SIZE));

                var resbuf = Buffer.allocUnsafe(consts.CMD_SIZE + consts.UINT64_SIZE + consts.ID_SIZE);
                data.copy(resbuf, consts.CMD_SIZE + consts.UINT64_SIZE, idx, idx + consts.ID_SIZE); // copy guid + hash

                if (reqType == TYPE_ASSET) {
                    helpers.log(consts.LOG_TEST, "Get Asset Binary " + guid + "/" + hash);
                    socket.getFileQueue.unshift({
                        buffer: resbuf,
                        type: TYPE_ASSET,
                        cacheStream: this.cache.GetCachePath(guid, hash, 'bin', false)
                    });
                }
                else if (reqType == TYPE_INFO) {
                    helpers.log(consts.LOG_TEST, "Get Asset Info " + guid + "/" + hash);
                    socket.getFileQueue.unshift({
                        buffer: resbuf,
                        type: TYPE_INFO,
                        cacheStream: this.cache.GetCachePath(guid, hash, 'info', false)
                    });
                }
                else if (reqType == TYPE_RESOURCE) {
                    helpers.log(consts.LOG_TEST, "Get Asset Resource " + guid + "/" + hash);
                    socket.getFileQueue.unshift({
                        buffer: resbuf,
                        type: TYPE_RESOURCE,
                        cacheStream: this.cache.GetCachePath(guid, hash, 'resource', false)
                    });
                }
                else {
                    helpers.log(consts.LOG_ERR, "Invalid data receive");
                    socket.destroy();
                    return false;
                }

                if (!socket.activeGetFile) {
                    self._SendNextGetFile(socket);
                }

                data = data.slice(idx + consts.ID_SIZE);
                continue;
            }

            // handle a transaction
            else if (data[idx] == CMD_TRX) {
                self.statsd.increment('cmd', 1, {cmd: 'trx'});
                trxStart = new Date();
                if (data.length < consts.CMD_SIZE) {
                    socket.pendingData = data;
                    return true;
                }
                idx += 1;

                if (data[idx] == TRX_START) {
                    if (data.length < consts.CMD_SIZE + consts.ID_SIZE) {
                        socket.pendingData = data;
                        return true;
                    }

                    // Error: The previous transaction was not completed
                    if (socket.inTransaction) {
                        helpers.log(consts.LOG_DBG, "Cancel previous transaction");
                        for (var i = 0; i < socket.targets.length; i++) {
                            fs.unlinkSync(socket.targets[i].from);
                        }
                    }

                    idx += 1;

                    socket.targets = [];
                    socket.inTransaction = true;
                    socket.currentGuid = helpers.readHex(consts.GUID_SIZE, data.slice(idx));
                    socket.currentHash = helpers.readHex(consts.HASH_SIZE, data.slice(idx + consts.GUID_SIZE));

                    helpers.log(consts.LOG_DBG, "Start transaction for " + socket.currentGuid + "-" + socket.currentHash);

                    data = data.slice(idx + consts.ID_SIZE);
                    continue;
                }
                else if (data[idx] == TRX_END) {
                    self.statsd.increment('cmd', 1, {cmd: 'trx_end'});
                    if (trxStart) { self.statsd.timing('trx-latency', trxStart) }

                    if (!socket.inTransaction) {
                        helpers.log(consts.LOG_ERR, "Invalid transaction isolation");
                        socket.destroy();
                        return false;
                    }

                    // We have not completed writing the previous file
                    if (socket.activePutTarget != null) {
                        // Keep the data in pending for the next _HandleData call
                        if (socket.isActive)
                            socket.pause();
                        socket.pendingData = data;
                        return true;
                    }

                    idx += 1;

                    helpers.log(consts.LOG_DBG, "End transaction for " + socket.currentGuid + "-" + socket.currentHash);
                    for (let i = 0; i < socket.targets.length; i++) {
                        this.cache.ReplaceFile(socket.targets[i].from, socket.targets[i].to, socket.targets[i].size);
                    }

                    socket.targets = [];
                    socket.inTransaction = false;
                    socket.currentGuid = null;
                    socket.currentHash = null;

                    data = data.slice(idx);

                    continue;
                }
                else {
                    helpers.log(consts.LOG_ERR, "Invalid data receive");
                    socket.destroy();
                    return false;
                }
            }
            // Put a file from the client to the cache server
            else if (data[idx] == CMD_PUT) {
                if (!socket.inTransaction) {
                    helpers.log(consts.LOG_ERR, "Not in a transaction");
                    socket.destroy();
                    return false;
                }

                // We have not completed writing the previous file
                if (socket.activePutTarget != null) {
                    // Keep the data in pending for the next _HandleData call
                    if (socket.isActive)
                        socket.pause();
                    socket.pendingData = data;
                    return true;
                }

                /// * We don't have enough data to start the put request. (wait for more data)
                if (data.length < consts.CMD_SIZE + consts.UINT64_SIZE) {
                    socket.pendingData = data;
                    return true;
                }

                idx += 1;

                var reqType = data[idx];
                self.statsd.increment('cmd', 1, {cmd: 'put', type: reqType});

                idx += 1;
                var size = helpers.readUInt64(data.slice(idx));
                self.statsd.histogram('put-size', size, { type: reqType });

                if (reqType == TYPE_ASSET) {
                    helpers.log(consts.LOG_TEST, "Put Asset Binary " + socket.currentGuid + "-" + socket.currentHash + " (size " + size + ")");
                    socket.activePutTarget = this.cache.GetCachePath(socket.currentGuid, socket.currentHash, 'bin', true);
                }
                else if (reqType == TYPE_INFO) {
                    helpers.log(consts.LOG_TEST, "Put Asset Info " + socket.currentGuid + "-" + socket.currentHash + " (size " + size + ")");
                    socket.activePutTarget = this.cache.GetCachePath(socket.currentGuid, socket.currentHash, 'info', true);
                }
                else if (reqType == TYPE_RESOURCE) {
                    helpers.log(consts.LOG_TEST, "Put Asset Resource " + socket.currentGuid + "-" + socket.currentHash + " (size " + size + ")");
                    socket.activePutTarget = this.cache.GetCachePath(socket.currentGuid, socket.currentHash, 'resource', true);
                }
                else {
                    helpers.log(consts.LOG_ERR, "Invalid data receive");
                    socket.destroy();
                    return false;
                }

                socket.tempPath = this.cache.cacheDir + "/Temp" + CacheServer.uuid();
                socket.activePutFile = fs.createWriteStream(socket.tempPath);

                socket.activePutFile.on('error', function (err) {
                    helpers.log(consts.LOG_ERR, "Error writing to file " + err + ". Possibly the disk is full? Please adjust --cacheSize with a more accurate maximum cache size");
                    socket.destroy();
                    return false;
                });

                socket.bytesToBeWritten = size;
                socket.totalFileSize = size;

                data = data.slice(idx + consts.UINT64_SIZE);
                continue;
            }

            // handle check integrity
            else if (data[idx] == CMD_INTEGRITY) {
                self.statsd.increment('cmd', 1, {cmd: 'integrity'});
                if (data.length < consts.CMD_SIZE + 1) {
                    socket.pendingData = data;
                    return true;
                }
                idx += 1;

                if (socket.inTransaction) {
                    helpers.log(consts.LOG_ERR, "In a transaction");
                    socket.destroy();
                    return false;
                }

                if (data[idx] == CMD_CHECK && (data[idx + 1] == OPT_VERIFY || data[idx + 1] == OPT_FIX)) {
                    var fixIt = (data[idx + 1] == OPT_FIX);

                    helpers.log(consts.LOG_DBG, "Cache Server integrity check (" + (fixIt ? "fix it" : "verify only") + ")");
                    let verificationNumErrors = this.cache.VerifyCache(fixIt);
                    if (fixIt)
                        helpers.log(consts.LOG_DBG, "Cache Server integrity fix " + verificationNumErrors + " issue(s)");
                    else
                        helpers.log(consts.LOG_DBG, "Cache Server integrity found " + verificationNumErrors + " error(s)");

                    var buf = Buffer.allocUnsafe(consts.CMD_SIZE + consts.UINT64_SIZE);
                    buf[0] = CMD_INTEGRITY;
                    buf[1] = CMD_CHECK;

                    buf.slice(consts.CMD_SIZE).write(helpers.encodeInt64(verificationNumErrors));
                    if (socket.isActive)
                        socket.write(buf);

                    idx += 2;
                }
                else {
                    helpers.log(consts.LOG_ERR, "Invalid data receive");
                    socket.destroy();
                    return false;
                }
            }

            // We need more data to write the file completely
            return true;
        }
    }

    _SendNextGetFile(socket) {
        var self = this;

        if (socket.getFileQueue.length == 0) {
            socket.activeGetFile = null;
            return;
        }

        if (socket.isActive)
            socket.resume();

        var next = socket.getFileQueue.pop();
        var resbuf = next.buffer;
        var type = next.type;
        var file = fs.createReadStream(next.cacheStream);
        // make sure no data is read and lost before we have called file.pipe ().
        file.pause();
        socket.activeGetFile = file;
        var errfunc = function () {
            var buf = Buffer.allocUnsafe(consts.CMD_SIZE + consts.ID_SIZE);
            buf[0] = CMD_GETNOK;
            buf[1] = type;
            self.statsd.increment('miss', 1, {type});
            resbuf.copy(buf, consts.CMD_SIZE, consts.CMD_SIZE + consts.UINT64_SIZE, consts.CMD_SIZE + consts.UINT64_SIZE + consts.ID_SIZE);
            try {
                socket.write(buf);
            }
            catch (err) {
                helpers.log(consts.LOG_ERR, "Error sending file data to socket " + err);
            }
            finally {
                if (socket.isActive) {
                    self._SendNextGetFile(socket);
                }
                else {
                    helpers.log(consts.LOG_ERR, "Socket closed, close active file");
                    file.close();
                }
            }
        };

        file.on('close', function () {
            socket.activeGetFile = null;
            if (socket.isActive) {
                self._SendNextGetFile(socket);
            }

            try {
                // Touch the file, so that it becomes the newest accessed file for LRU cleanup - utimes expects a Unix timestamp in seconds, Date.now() returns millis
                let dateNow = Date.now() / 1000;
                helpers.log(consts.LOG_DBG, "Updating mtime of " + next.cacheStream + " to: " + dateNow);
                fs.utimesSync(next.cacheStream, dateNow, dateNow);
            }
            catch (err) {
                helpers.log(consts.LOG_ERR, "Failed to update mtime of " + next.cacheStream + ": " + err);
            }
        });

        file.on('open', function (fd) {
            fs.fstat(fd, function (err, stats) {
                if (err)
                    errfunc(err);
                else {
                    resbuf[0] = CMD_GETOK;
                    resbuf[1] = type;
                    self.statsd.increment('hit', 1, {type});
                    self.statsd.histogram('get-size', stats.size, { type });

                    helpers.log(consts.LOG_TEST, "Found: " + next.cacheStream + " size:" + stats.size);
                    resbuf.slice(consts.CMD_SIZE).write(helpers.encodeInt64(stats.size));

                    // The ID is already written
                    try {
                        socket.write(resbuf);
                        file.resume();
                        file.pipe(socket, {end: false});
                    }
                    catch (err) {
                        helpers.log(consts.LOG_ERR, "Error sending file data to socket " + err + ", close active file");
                        file.close();
                    }
                }
            });
        });

        file.on('error', errfunc);
    }

    /**
     * start the cache server
     *
     * @param errCallback error callback (optional)
     */
    Start(errCallback, callback) {
        var self = this;

        this._server = net.createServer(function (socket) {
            socket.getFileQueue = [];
            socket.protocolVersion = null;
            socket.activePutFile = null;
            socket.activeGetFile = null;
            socket.activePutTarget = null;
            socket.pendingData = null;
            socket.bytesToBeWritten = 0;
            socket.totalFileSize = 0;
            socket.isActive = true;
            socket.targets = [];
            socket.inTransaction = false;
            socket.currentGuid = null;
            socket.currentHash = null;
            socket.forceQuit = false;

            socket.on('data', function (data) {
                socket.isActive = true;
                self._HandleData(socket, data);
            });

            socket.on('close', function (had_errors) {
                helpers.log(consts.LOG_ERR, "Socket closed");
                socket.isActive = false;
                var checkFunc = function () {
                    var data = new Buffer(0);
                    if (self._HandleData(socket, data)) {
                        setTimeout(checkFunc, 1);
                    }
                };

                if (!had_errors && !socket.forceQuit)
                    checkFunc();
            });

            socket.on('error', function (err) {
                helpers.log(consts.LOG_ERR, "Socket error " + err);
            });
        });

        this._server.on('error', function (e) {
            if (e.code == 'EADDRINUSE') {
                helpers.log(consts.LOG_ERR, 'Port ' + self.port + ' is already in use...');
                if (errCallback && typeof(errCallback === 'function')) { errCallback(e); }
            }
        });

        this._server.listen(this._port, function() {
            if(callback && typeof(callback) === 'function') { callback(); }
        });
    };
}

module.exports = CacheServer;