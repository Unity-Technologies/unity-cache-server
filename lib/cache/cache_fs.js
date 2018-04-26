'use strict';
const { CacheBase, PutTransaction } = require('./cache_base');
const helpers = require('../helpers');
const path = require('path');
const fs = require('fs-extra');
const uuid = require('uuid');
const consts = require('../constants');
const moment = require('moment');
const pick = require('lodash').pick;

class CacheFS extends CacheBase {
    constructor() {
        super();
    }

    static get properties() {
        return {
            clustering: true,
            cleanup: true
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
        const ext = { 'i': 'info', 'a': 'bin', 'r': 'resource' }[type];
        return `${helpers.GUIDBufferToString(guid)}-${hash.toString('hex')}.${ext}`;
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
        const fileName = CacheFS._calcFilename(type, guid, hash);
        return path.join(this._cachePath, fileName.substr(0, 2), fileName);
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

    async _addFileToCache(type, guid, hash, sourcePath) {
        const filePath = this._calcFilepath(type, guid, hash);
        await fs.move(sourcePath, filePath, { overwrite: true });
        return filePath;
    }

    async getFileInfo(type, guid, hash) {
        const stats = await fs.stat(this._calcFilepath(type, guid, hash));
        return {size: stats.size};
    }

    getFileStream(type, guid, hash) {
        const stream = fs.createReadStream(this._calcFilepath(type, guid, hash));

        return new Promise((resolve, reject) => {
            stream.on('open', () => resolve(stream))
                .on('error', err => {
                helpers.log(consts.LOG_ERR, err);
                reject(err);
            });
        });
    }

    async createPutTransaction(guid, hash) {
       return new PutTransactionFS(guid, hash, this._cachePath);
    }

    async endPutTransaction(transaction) {
        const self = this;

        const moveFile = async (file) => {
            self._addFileToCache(file.type, transaction.guid, transaction.hash, file.file)
                .then(filePath => helpers.log(consts.LOG_TEST, `Added file to cache: ${file.size} ${filePath}`),
                        err => helpers.log(consts.LOG_ERR, err));
        };

        await transaction.finalize();
        return Promise.all(transaction.files.map(moveFile));
    }

    registerClusterWorker(worker) {}

    cleanup(dryRun = true) {
        const self = this;

        const expireDuration = moment.duration(this._options.cleanupOptions.expireTimeSpan);
        if(!expireDuration.isValid() || expireDuration.asMilliseconds() === 0) {
            return Promise.reject(new Error("Invalid expireTimeSpan option"));
        }

        const minFileAccessTime = moment().subtract(expireDuration).toDate();
        const maxCacheSize = this._options.cleanupOptions.maxCacheSize;

        const allItems = [];
        const deleteItems = [];
        let cacheSize = 0;
        let deleteSize = 0;

        const progressData = () => {
            return {
                cacheCount: allItems.length,
                cacheSize: cacheSize,
                deleteCount: deleteItems.length,
                deleteSize: deleteSize
            };
        };

        const progressEvent = () => self.emit('cleanup_search_progress', progressData());

        progressEvent();
        const progressTimer = setInterval(progressEvent, 250);

        return helpers.readDir(self._cachePath, (item) => {
            if(item.stats.isDirectory()) return next();
            item = {path: item.path, stats: pick(item.stats, ['atime', 'size'])};
            allItems.push(item);
            cacheSize += item.stats.size;
            if(item.stats.atime < minFileAccessTime) {
                deleteSize += item.stats.size;
                deleteItems.push(item);
            }
        }).then(async () => {
            if(maxCacheSize > 0 && cacheSize - deleteSize > maxCacheSize) {
                allItems.sort((a, b) => { return a.stats.atime > b.stats.atime });
                for(const item of allItems) {
                    deleteSize += item.stats.size;
                    deleteItems.push(item);
                    if(cacheSize - deleteSize <= maxCacheSize) break;
                }
            }

            clearTimeout(progressTimer);
            self.emit('cleanup_search_finish', progressData());

            for(const d of deleteItems) {
                self.emit('cleanup_delete_item', d.path);
                if(!dryRun) {
                    await fs.unlink(d.path);
                }
            }

            self.emit('cleanup_delete_finish', progressData());
        });
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

    async _closeAllStreams() {
        const self = this;
        const files = Object.values(this._streams);
        if(files.length === 0) return;

        function processClosedStream(stream) {
            if(stream.stream.bytesWritten === stream.size) {
                self._files.push({
                    file: stream.file,
                    type: stream.type,
                    size: stream.size
                });
            }
            else {
                throw new Error("Transaction failed; file size mismatch");
            }
        }

        for(const file of files) {
            if(file.stream.closed) {
                processClosedStream(file);
                continue;
            }

            await new Promise((resolve, reject) => {
                file.stream.on('close', () => {
                    try {
                        processClosedStream(file);
                        resolve();
                    }
                    catch(err) {
                        reject(err);
                    }
                });
            });
        }
    }

    get manifest() {
        return this.files.map((file) => file.type);
    }

    get files() {
        return this._files;
    }

    async finalize() {
        await this._closeAllStreams();
        return super.finalize();
    }

    async getWriteStream(type, size) {
        const file = path.join(this._cachePath, uuid());

        if(typeof(size) !== 'number' || size <= 0) {
            throw new Error("Invalid size for write stream");
        }

        if(type !== 'a' && type !== 'i' && type !== 'r') {
            throw new Error(`Unrecognized type '${type}' for transaction.`);
        }

        await fs.ensureFile(file);
        const stream = fs.createWriteStream(file, this._writeOptions);
        this._streams[type] = {
            file: file,
            type: type,
            size: size,
            stream: stream
        };

        return new Promise(resolve => stream.on('open', () => resolve(stream)));
    }
}

module.exports = CacheFS;