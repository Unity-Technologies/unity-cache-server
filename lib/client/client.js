'use strict';
const net = require('net');
const consts = require('../constants');
const helpers = require('../helpers');

const cmd = {
    quit: "q",
    transactionStart: "ts",
    transactionEnd: "te"
};

class CacheClient {
    constructor(address, port, options) {
        options = options || {};
        this._address = address;
        this._port = port;
        this._client = null;
        this._options = {
            idleTimeout: options.idleTimeout || 0
        }
    }

    /**
     *
     * @param {Object|String} data
     * @returns {Promise<any>}
     * @private
     */
    _clientWrite(data) {
        const self = this;
        return new Promise((resolve, reject) => {
            if(!self._client) reject(new Error("Not connected, call connect() first"));
            self._client.write(data, () => resolve());
        });
    }

    /**
     *
     * @param {Object} stream
     * @private
     */
    _clientPipe(stream) {
        const self = this;
        return new Promise((resolve, reject) => {
            if(!self._client) reject(new Error("Not connected, call connect() first"));
            stream.on('end', () => resolve());
            stream.on('error', err => reject(err));
            stream.pipe(self._client, {end: false});
        });
    }

    static get fileTypes() {
        return consts.FILE_TYPE;
    }

    /**
     *
     * @returns {Promise<CacheClient>}
     */
    connect() {
        const self = this;
        return new Promise((resolve, reject) => {
            if(self._client !== null && !self._client.destroyed)
                return resolve(self);

            const client = net.connect({host: self._address, port: self._port});

            if(self._options.idleTimeout > 0) {
                client.setTimeout(self._options.idleTimeout, () => self.quit());
            }

            client.on('connect', () => {
                client.write(helpers.encodeInt32(consts.PROTOCOL_VERSION));
                self._client = client;
                resolve(self);
            });

            client.on('close', () => self._client = null);
            client.on('error', err => reject(err));
        });
    }

    /**
     *
     * @returns {Promise<null>}
     */
    quit() {
        if(!this._client) return Promise.resolve();

        return new Promise(resolve => {
            this._client.once('close', () => resolve());
            this._client.end(cmd.quit);
        });
    }

    /**
     *
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @returns {Promise<any>}
     */
    beginTransaction(guid, hash) {
        return this._clientWrite(Buffer.concat([Buffer.from(cmd.transactionStart), guid, hash], 34));
    }

    /**
     *
     * @returns {Promise<any>}
     */
    endTransaction() {
        return this._clientWrite(Buffer.from(cmd.transactionEnd));
    }

    /**
     *
     * @param {String} type
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @param {Buffer|Readable} data
     * @param {Number} size
     * @returns {Promise<void>}
     */
    async putFile(type, guid, hash, data, size) {
        const types = Object.values(CacheClient.fileTypes);

        if(types.indexOf(type) < 0)
            throw new Error("Unrecognized file type");

        if(!helpers.isBuffer(guid) || guid.length !== 16)
            throw new Error("guid is not a buffer or the wrong length (16)");

        if(!helpers.isBuffer(hash) || hash.length !== 16)
            throw new Error("hash is not a buffer or the wrong length (16)");

        await this._clientWrite(`p${type}${helpers.encodeInt64(size)}`);

        if(helpers.isBuffer(data)) {
            await this._clientWrite(data);
        }
        else {
            await this._clientPipe(data);
        }
    }
}

module.exports = CacheClient;