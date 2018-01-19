'use strict';
const net = require('net');
const consts = require('../constants');
const helpers = require('../helpers');
const ClientStreamProcessor  = require('./client_stream_processor');
const CommandProcessor = require('./command_processor');
const TransactionMirror = require('./transaction_mirror');
const ip = require('ip');

class CacheServer {
    /**
     *
     * @param {CacheBase} cache
     * @param {Object} options
     */
    constructor(cache, options) {
        this._cache = cache;

        this._port = options.port;
        if (!options.port && options.port !== 0)
            this._port = consts.DEFAULT_PORT;

        this._server = null;
        this._mirrors = [];

        if(options.mirror) {
            options.mirror = [].concat(options.mirror);
            this._mirrors = options.mirror.map(m => new TransactionMirror(m, cache));
        }
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

            const cmdProc = new CommandProcessor(self.cache);

            // Prune mirror list to exclude the incoming socket address, to prevent looping transactions
            const mirrors = self._mirrors.filter(m => !ip.isEqual(socket.address(), m.address()));

            if(mirrors.length > 0) {
                cmdProc.on('onTransactionEnd', (trx) => {
                    mirrors.forEach(m => m.queueTransaction(trx));
                });
            }

            socket.on('close', () => {
                    helpers.log(consts.LOG_TEST, `${socket.remoteAddress}:${socket.remotePort} closed connection.`);
                }).on('error', err => {
                    helpers.log(consts.LOG_ERR, err);
                });

            socket.pipe(new ClientStreamProcessor()) // Transform the incoming byte stream into commands and file data
                .pipe(cmdProc)                       // Execute commands and interface with the cache module
                .pipe(socket);                       // Connect back to socket to send files
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