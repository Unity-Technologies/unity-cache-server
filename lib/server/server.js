'use strict';
const net = require('net');
const consts = require('../constants');
const helpers = require('../helpers');
const ClientStreamProcessor  = require('./client_stream_processor');
const CommandProcessor = require('./command_processor');
const TransactionMirror = require('./transaction_mirror');

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

        this.allowIpv6 = options.allowIpv6;
        this._errCallback = null;
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
     *
     * @returns {net.Server}
     */
    get server() {
        return this._server;
    }

    /**
     *
     * @returns {Array|*}
     */
    get mirrors() {
        return this._mirrors;
    }

    /**
     *
     * @param {Function} cb
     */
    set errCallback(cb) {
        this._errCallback = cb;
    }

    /**
     * start the cache server
     *
     * @param errCallback error callback (optional)
     */
    start(errCallback) {
        this.errCallback = errCallback;

        this._server = net.createServer(socket => {
            helpers.log(consts.LOG_TEST, `${socket.remoteAddress}:${socket.remotePort} connected.`);

            const cmdProc = new CommandProcessor(this.cache);
            const streamProc = new ClientStreamProcessor({clientAddress: `${socket.remoteAddress}:${socket.remotePort}`});

            const mirrors = this._mirrors;
            if(mirrors.length > 0) {
                cmdProc.on('onTransactionEnd', (trx) => {
                    mirrors.forEach(m => m.queueTransaction(trx));
                });
            }

            socket.on('close', () => {
                    helpers.log(consts.LOG_TEST, `${socket.remoteAddress}:${socket.remotePort} closed connection.`);
                    socket.unpipe(streamProc);
                    streamProc.unpipe(cmdProc);
                    cmdProc.unpipe(socket);
                }).on('error', err => {
                    helpers.log(consts.LOG_ERR, err);
                });

            socket.pipe(streamProc) // Transform the incoming byte stream into commands and file data
                .pipe(cmdProc)      // Execute commands and interface with the cache module
                .pipe(socket);     // Connect back to socket to send files

            socket['commandProcessor'] = cmdProc;
        }).on('error', err => {
            if (err.code === 'EADDRINUSE') {
                helpers.log(consts.LOG_ERR, `Port ${this.port} is already in use...`);
            }

            if (this._errCallback && typeof(this._errCallback === 'function')) { this._errCallback(err); }
        });

        return new Promise(resolve => {
            if(this.allowIpv6) {
                this._server.listen(this.port, () => resolve());
            }
            else {
                this._server.listen(this.port, "0.0.0.0", () => resolve());
            }
            
        });
    };

    stop() {
        return new Promise((resolve, reject) => {
            if(!this._server || !this._server.listening) return resolve();
            this._server.close(err => {
                err ? reject(err) : resolve();
            });
        });
    }
}

module.exports = CacheServer;