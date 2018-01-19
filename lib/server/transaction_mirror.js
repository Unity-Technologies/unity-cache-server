'use strict';
const helpers = require('../helpers');
const consts = require('../constants');
const net = require('net');
const config = require('config');

const OPTIONS_PATH = "Mirror.options";

const PROCESS_DELAY_MS = 2000;
const CONNECT_IDLE_TIMEOUT_MS = 10000;

let cWrite = (client, buf) => {
    return new Promise(resolve => {
        client.write(buf, () => resolve());
    });
};

let cPipe = (client, stream) => {
    return new Promise((resolve, reject) => {
        stream.on('end', () => resolve());
        stream.on('error', err => reject(err));
        stream.pipe(client, {end: false});
    });
};

class TransactionMirror {

    /**
     *
     * @param {Object} connectOptions
     * @param {CacheBase} cache
     */
    constructor(connectOptions, cache) {
        this._connectOptions = connectOptions;
        this._cache = cache;
        this._queue = [];
        this._processing = false;
        this._client = null;
    }

    static get options() {
        return config.get(OPTIONS_PATH);
    }

    get address() {
        return this._connectOptions.host;
    }

    _connect() {
        const self = this;
        return new Promise(resolve => {
            if(self._client !== null && !self._client.destroyed)
                return resolve(self._client);

            let client = net.connect(this._connectOptions);

            const idleTimeout = TransactionMirror.options.connectionIdleTimeout || CONNECT_IDLE_TIMEOUT_MS;
            client.setTimeout(idleTimeout, () => {
                client.end('q');
                self._client = null;
            });

            client.on('connect', () => {
                client.write(helpers.encodeInt32(consts.PROTOCOL_VERSION));
                self._client = client;
                resolve(self._client);
            });

            client.on('error', err => helpers.log(consts.LOG_ERR, err));
        });
    }

    async _processQueue() {
        let self = this;
        let client = await self._connect();

        let send = async (item) => {
            await cWrite(client, Buffer.concat([Buffer.from('ts'), item.guid, item.hash], 34));

            for (let i = 0; i < item.types.length; i++) {
                let type = item.types[i];
                let info = await self._cache.getFileInfo(type, item.guid, item.hash);
                let stream = await self._cache.getFileStream(type, item.guid, item.hash);
                await cWrite(client, `p${type}${helpers.encodeInt64(info.size)}`);
                await cPipe(client, stream);
            }

            await cWrite(client, 'te');
        };

        while (self._queue.length > 0) {
            try {
                await send(self._queue.shift());
            }
            catch (err) {
                helpers.log(consts.LOG_ERR, err);
            }
        }

        self._processing = false;
    }

    /**
     *
     * @param {PutTransaction} trx
     */
    queueTransaction(trx) {
        if(trx.manifest.length === 0) return;

        this._queue.push({
            guid: trx.guid,
            hash: trx.hash,
            types: trx.manifest
        });

        if(!this._processing) {
            this._processing = true;
            let delay = TransactionMirror.options.queueProcessDelay || PROCESS_DELAY_MS;
            setTimeout(this._processQueue.bind(this), delay);
        }
    }
}

module.exports = TransactionMirror;