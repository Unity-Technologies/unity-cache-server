'use strict';
const net = require('net');
const consts = require('./constants');
const helpers = require('./helpers');
const ClientStreamProcessor  = require('./server/client_stream_processor');
const CommandProcessor = require('./server/command_processor');

class CacheServer {
    /**
     *
     * @param {CacheBase} cache
     * @param {Number} port
     */
    constructor(cache, port) {
        this._cache = cache;
        this._port = port;
        if (!port && port !== 0)
            this._port = consts.DEFAULT_PORT;

        this._server = null;
    }

    /**
     *
     * @returns {*}
     */
    get port() {
        return (this._server && this._server.listening)
            ? this._server.address().port
            : this._port;
    }

    /**
     *
     * @returns {CacheBase|*}
     */
    get cache() {
        return this._cache;
    }

    /**
     * start the cache server
     *
     * @param errCallback error callback (optional)
     * @param callback
     */
    Start(errCallback, callback) {
        const self = this;

        let server = net.createServer(socket => {
            helpers.log(consts.LOG_TEST, `${socket.remoteAddress}:${socket.remotePort} connected.`);

            socket
                .on('close', () => {
                    helpers.log(consts.LOG_TEST, `${socket.remoteAddress}:${socket.remotePort} closed connection.`);
                })
                .on('error', err => {
                    helpers.log(consts.LOG_ERR, err);
                });

            socket
                .pipe(new ClientStreamProcessor())       // Transform the incoming byte stream into commands and file data
                .pipe(new CommandProcessor(self.cache))  // Execute commands and interface with the cache module
                .pipe(socket);                           // Connect back to socket to send files
        });

        server.on('error', err => {
            if (err.code === 'EADDRINUSE') {
                helpers.log(consts.LOG_ERR, `Port ${self.port} is already in use...`);
                if (errCallback && typeof(errCallback === 'function')) { errCallback(err); }
            }
        });

        server.listen(this.port, () => {
            if(callback && typeof(callback) === 'function') { callback(); }
        });

        this._server = server;
    };

    Stop() {
        this._server.close();
    }
}

module.exports = CacheServer;