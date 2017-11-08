/**
 * Created by spalmer on 10/16/17.
 */
'use strict';
const cluster = require('cluster');
const net = require('net');
const fs = require('fs');
const consts = require('./constants').Constants;
const helpers = require('./helpers');
const ClientStreamProcessor  = require('./server/client_stream_processor');
const CommandProcessor = require('./server/command_processor');

class CacheServer {
    constructor(cache, port) {
        this._cache = cache;
        this._port = parseInt(port);
        if (!port && port !== 0)
            this._port = consts.DEFAULT_PORT;
        this._sever = null;
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

    /**
     * start the cache server
     *
     * @param errCallback error callback (optional)
     * @param callback
     */
    Start(errCallback, callback) {
        const self = this;

        this._server = net.createServer(function (socket) {
            socket
                .on('close', function () {
                    helpers.log(consts.LOG_ERR, "Socket closed");
                })
                .on('error', function (err) {
                    helpers.log(consts.LOG_ERR, "Socket error " + err);
                });

            const clientStreamProcessor = new ClientStreamProcessor();
            const commandProcessor = new CommandProcessor(clientStreamProcessor, self.cache);

            socket.pipe(clientStreamProcessor).pipe(commandProcessor).pipe(socket);
        });

        this._server.on('error', function (e) {
            if (e.code === 'EADDRINUSE') {
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