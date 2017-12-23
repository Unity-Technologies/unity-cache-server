'use strict';
const { CacheBase, PutTransaction } = require('./cache');
const helpers = require('../helpers');
const consts = require('../constants');
const path = require('path');
const fs = require('fs-extra');
const uuid = require('uuid');
const _ = require('lodash');

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

    init(options, callback) {
        return super.init(options, callback);
    }

    shutdown(callback) {
        callback(); // No op
    }

    getFileInfo(type, guid, hash, callback) {
        fs.stat(this._calcFilepath(type, guid, hash))
            .then(stats => {
                callback(null, {size: stats.size});
            })
            .catch(err => {
                callback(err);
            })
    }

    getFileStream(type, guid, hash, callback) {
        let stream = fs.createReadStream(this._calcFilepath(type, guid, hash));
        stream.on('open', () => {
                callback(null, stream);
            }).on('error', err => {
                callback(err);
        });
    }

    createPutTransaction(guid, hash, callback) {
        callback(null, new PutTransactionFS(guid, hash, this._cachePath));
    }

    endPutTransaction(transaction, callback) {
        let self = this;

        function moveFile(file) {
            let filePath = self._calcFilepath(file.type, transaction.guid, transaction.hash);
            return fs.move(file.file, filePath, { overwrite: true });
        }

        transaction.finalize()
            .then(() => {
                return Promise.all(transaction.files.map(moveFile));
            })
            .then(() => {
                callback();
            })
            .catch(err => {
                callback(err);
            });
    }

    registerClusterWorker(worker) {
        worker.on('message', () => {});
    }
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
                }).on('error', err => {
                    helpers.log(consts.LOG_ERR, err);
                    _.unset(self._streams, file.type);
                });
            });
        });
    }

    get files() {
        return this._files;
    }

    finalize(callback) {
        if(typeof(callback) !== 'function') {
            return this._closeAllStreams();
        }

        this._closeAllStreams()
            .then(() => {
                callback();
            })
            .catch(err => {
                callback(err);
            });
    }

    getWriteStream(type, size, callback) {
        let self = this;
        let file = path.join(this._cachePath, uuid());

        fs.ensureFile(file)
            .then(() => {
                let stream = fs.createWriteStream(file, this._writeOptions);
                stream.on('open', () => {
                    callback(null, stream);
                });

                self._streams[type] = {
                    file: file,
                    type: type,
                    size: size,
                    stream: stream
                };
            })
            .catch(err => {
                callback(err);
            });
    }
}

module.exports = CacheFS;