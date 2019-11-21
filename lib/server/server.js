'use strict';
const net = require('net');
const consts = require('../constants');
const helpers = require('../helpers');
const ClientStreamProcessor  = require('./client_stream_processor');
const ClientStreamRecorder = require('./client_stream_recorder');
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
        this._errCallback = null;

        this._port = options.port;
        if (!options.port && options.port !== 0)
            this._port = consts.DEFAULT_PORT;

        this._host = options.host || consts.DEFAULT_HOST;

        this._server = null;
        this._mirrors = [];

        if(options.mirror) {
            options.mirror = [].concat(options.mirror);
            this._mirrors = options.mirror.map(m => new TransactionMirror(m, cache));
        }

        this._clientRecorder = !!options.clientRecorder;

        if(this._clientRecorder) {
            helpers.log(consts.LOG_WARN, "Warning: client recording enabled - performance may be impacted!");
        }

        this._allowIpv6 = options.allowIpv6;
    }

    /**
     *
     * @returns {boolean}
     */
    get isRecordingClient() {
        return this._clientRecorder;
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
     * @returns {*|string}
     */
    get host() {
        return this._host;
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
            const remoteAddress = socket.remoteAddress;
            const remotePort = socket.remotePort;

            helpers.log(consts.LOG_INFO, `${remoteAddress}:${remotePort} connected.`);

            const cmdProc = new CommandProcessor(this.cache);
            const streamProc = new ClientStreamProcessor({clientAddress: `${remoteAddress}:${remotePort}`});

            const mirrors = this._mirrors;
            if(mirrors.length > 0) {
                cmdProc.on('onTransactionEnd', (trx) => {
                    mirrors.forEach(m => m.queueTransaction(trx));
                });
            }

            const unpipeStreams = () => {
                socket.unpipe();
                streamProc.unpipe();
                cmdProc.unpipe();
            };

            cmdProc.on('finish', () => {
                helpers.log(consts.LOG_DBG, `${remoteAddress}:${remotePort} CommandProcessor finished.`);
                process.nextTick(unpipeStreams);
            });

            socket.on('close', () => {
                helpers.log(consts.LOG_INFO, `${remoteAddress}:${remotePort} Closed connection.`);
            }).on('error', err => {
                helpers.log(consts.LOG_ERR, `${remoteAddress}:${remotePort} Connection ERROR: ${err.message}`);
                unpipeStreams();
            });

            if(this.isRecordingClient) {
                const sessionId = `${remoteAddress}_${remotePort}_${Date.now()}`;
                socket.pipe(new ClientStreamRecorder({sessionId})); // Record the incoming byte stream to disk
            }

            socket.pipe(streamProc)     // Transform the incoming byte stream into commands and file data
                .pipe(cmdProc)          // Execute commands and interface with the cache module
                .pipe(socket);          // Connect back to socket to send files
        }).on('error', err => {
            if (err.code === 'EADDRINUSE') {
                helpers.log(consts.LOG_ERR, `Port ${this.port} is already in use...`);
            }

            if (err.code === 'ECONNRESET') {
                helpers.log(consts.LOG_ERR, 'The client unexpectedly closed the connection.');
                helpers.log(consts.LOG_DBG, err.stack);
            }

            if (this._errCallback && typeof(this._errCallback === 'function')) { this._errCallback(err); }
        });

        return new Promise( (resolve, reject) => {
            if(this._allowIpv6 && this.host === consts.DEFAULT_HOST) {
                // bind to all interfaces with IPV4 and IPV6 only when the default host value is specified AND
                // the allowIPv6 flag is true. Omitting the host parameter in listen() enables IPV6.
                this._server.listen(this.port, (err) => err ? reject(err) : resolve());
            }
            else {
                this._server.listen(this.port, this.host, (err) => err ? reject(err) : resolve());
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
