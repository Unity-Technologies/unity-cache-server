'use strict';
const { Cache, PutTransaction } = require('./cache');
const helpers = require('../helpers');
const consts = require('../constants').Constants;
const path = require('path');
const fs = require('fs-extra');
const uuid = require('uuid');
const _ = require('lodash');

class CacheFS extends Cache {
    constructor() {
        super();
    }

    static get properties() {
        return {
            clustering: true
        }
    }

    static _calcFilename(type, guid, hash) {
        return `${guid.toString('hex')}-${hash.toString('hex')}.${type}`;
    }

    _calcFilepath(type, guid, hash) {
        return path.join(this._cachePath, CacheFS._calcFilename(type, guid, hash));
    }

    get _optionsPath() {
        return super._optionsPath + ".cache_fs";
    }

    init(options, callback) {
        return super.init(options, callback);
    }

    reset(callback) {
        return super.reset(callback);
    }

    save(callback) {
        callback(); // No op
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

        transaction.getFiles()
            .then((files) => {
                return Promise.all(files.map(moveFile));
            })
            .then(() => {
                callback();
            })
            .catch(err => {
                callback(err);
            });
    }

    registerClusterWorker(worker) {

    }
}

class PutTransactionFS extends PutTransaction {
    constructor(guid, hash, cachePath) {
        super(guid, hash);
        this._cachePath = cachePath;
        this._writeOptions = {
            flags: 'w',
            encoding: 'ascii',
            fd: null,
            mode: 0o666,
            autoClose: true
        };

        this._files = {};
    }

    _closeAllStreams() {
        return new Promise((resolve) => {
            let self = this;
            let files = _.values(this._files);

            if(files.length === 0)
                return resolve();

            let closed = 0;
            let toClose = files.length;

            function processClosedFile(file) {
                closed++;

                if(file.stream.bytesWritten !== file.size) {
                    _.unset(self._files, file.type);
                }

                if(closed === toClose) {
                    resolve();
                }
            }

            files.forEach(file => {
                if(file.stream.closed) return processClosedFile(file);

                file.stream.on('close', () => {
                    processClosedFile(file);
                }).on('error', err => {
                    helpers.log(consts.LOG_ERR, err);
                    _.unset(self._files, file.type);
                });
            });
        });
    }

    getFiles() {
        return new Promise((resolve) => {
            this._closeAllStreams()
                .then(() => {
                    resolve(_.values(this._files));
                });
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

                self._files[type] = {
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