'use strict';
const { CacheBase, PutTransaction } = require('./cache_base');
const helpers = require('../helpers');
const path = require('path');
const fs = require('fs-extra');
const uuid = require('uuid');
const _ = require('lodash');
const consts = require('../constants');

class CacheFS extends CacheBase {
    constructor() {
        super();
    }

    static get properties() {
        return {
            clustering: true
        }
    }

    /**
     *
     * @param {String} type
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @returns {string}
     * @private
     */
    static _calcFilename(type, guid, hash) {
        return `${guid.toString('hex')}-${hash.toString('hex')}.${type}`;
    }

    /**
     *
     * @param {String} type
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @returns {String}
     * @private
     */
    _calcFilepath(type, guid, hash) {
        return path.join(this._cachePath, CacheFS._calcFilename(type, guid, hash));
    }

    get _optionsPath() {
        return super._optionsPath + ".cache_fs";
    }

    init(options) {
        return super.init(options);
    }

    shutdown() {
        return Promise.resolve();
    }

    getFileInfo(type, guid, hash) {
        return new Promise((resolve, reject) => {
            fs.stat(this._calcFilepath(type, guid, hash))
                .then(stats => {
                    resolve({size: stats.size});
                })
                .catch(err => {
                    reject(err);
                });
        });
    }

    getFileStream(type, guid, hash) {
        let stream = fs.createReadStream(this._calcFilepath(type, guid, hash));

        return new Promise((resolve, reject) => {
            stream.on('open', () => {
                resolve(stream);
            }).on('error', err => {
                helpers.log(consts.LOG_ERR, err);
                reject(stream);
            });
        });
    }

    createPutTransaction(guid, hash) {
       return Promise.resolve(new PutTransactionFS(guid, hash, this._cachePath));
    }

    endPutTransaction(transaction) {
        let self = this;

        function moveFile(file) {
            let filePath = self._calcFilepath(file.type, transaction.guid, transaction.hash);
            return fs.move(file.file, filePath, { overwrite: true });
        }

        return transaction.finalize().then(() => {
                return Promise.all(transaction.files.map(moveFile));
            });
    }

    registerClusterWorker(worker) {}
}

class PutTransactionFS extends PutTransaction {
    /**
     *
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @param {String} cachePath
     */
    constructor(guid, hash, cachePath) {
        super(guid, hash);
        /**
         * @type {String}
         * @private
         */
        this._cachePath = cachePath;

        this._writeOptions = {
            flags: 'w',
            encoding: 'ascii',
            fd: null,
            mode: 0o666,
            autoClose: true
        };

        this._streams = {};
        this._files = [];
    }

    _closeAllStreams() {
        return new Promise((resolve, reject) => {
            let self = this;
            let files = _.values(this._streams);

            if(files.length === 0)
                return resolve();

            let closed = 0;
            let toClose = files.length;
            let success = true;

            function processClosedStream(stream) {
                closed++;

                if(stream.stream.bytesWritten === stream.size) {
                    self._files.push({
                        file: stream.file,
                        type: stream.type
                    });
                }
                else {
                    success = false;
                }

                if(closed === toClose) {
                    success ? resolve() : reject(new Error("Transaction failed; file size mismatch"));
                }
            }

            files.forEach(file => {
                if(file.stream.closed) return processClosedStream(file);
                file.stream.on('close', () => {
                    processClosedStream(file);
                });
            });
        });
    }

    get files() {
        return this._files;
    }

    finalize() {
        return this._closeAllStreams();
    }

    getWriteStream(type, size) {
        let self = this;
        let file = path.join(this._cachePath, uuid());

        return new Promise((resolve, reject) => {
            if(typeof(size) !== 'number' || size <= 0) {
                return reject(new Error("Invalid size for write stream"));
            }

            if(type !== 'a' && type !== 'i' && type !== 'r') {
                return reject(new Error(`Unrecognized type '${type}' for transaction.`));
            }

            fs.ensureFile(file)
                .then(() => {
                    let stream = fs.createWriteStream(file, this._writeOptions);
                    stream.on('open', () => {
                        resolve(stream);
                    });

                    self._streams[type] = {
                        file: file,
                        type: type,
                        size: size,
                        stream: stream
                    };
                })
                .catch(err => {
                    reject(err);
                });
        });
    }
}

module.exports = CacheFS;