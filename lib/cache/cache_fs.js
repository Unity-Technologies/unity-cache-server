'use strict';
const { CacheBase, PutTransaction } = require('./cache_base');
const helpers = require('../helpers');
const path = require('path');
const fs = require('fs-extra');
const uuid = require('uuid');
const consts = require('../constants');
const moment = require('moment');
const pick = require('lodash').pick;
const crypto = require('crypto');
const fileExtensions = require('lodash').invert(consts.FILE_TYPE);

class CacheFS extends CacheBase {

    get _optionsPath() {
        return super._optionsPath + ".cache_fs";
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
        const ext = fileExtensions[type].toLowerCase();
        return `${helpers.GUIDBufferToString(guid)}-${hash.toString('hex')}.${ext}`;
    }

    static _extractGuidAndHashFromFilepath(filePath) {
        const fileName = path.basename(filePath).toLowerCase();
        const matches = /^([0-9a-f]{32})-([0-9a-f]{32})\./.exec(fileName);
        const result = { guidStr: "", hashStr: ""};
        if(matches && matches.length === 3) {
            result.guidStr = matches[1];
            result.hashStr = matches[2];
        }

        return result;
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

    /**
     *
     * @param {String} type
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @param {String} sourcePath
     * @returns {Promise<String>}
     * @private
     */
    async _writeFileToCache(type, guid, hash, sourcePath) {
        const filePath = this._calcFilepath(type, guid, hash);

        await fs.move(sourcePath, filePath, { overwrite: true });
        return filePath;
    }

    async getFileInfo(type, guid, hash) {
        const filePath = this._calcFilepath(type, guid, hash);
        const stats = await fs.stat(filePath);
        return {filePath: filePath, size: stats.size};
    }

    getFileStream(type, guid, hash) {
        const key = this._calcFilepath(type, guid, hash);
        const stream = fs.createReadStream(key);

        return new Promise((resolve, reject) => {
            stream.on('open', () => {
                resolve(stream);
            }).on('error', err => {
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
        await super.endPutTransaction(transaction);

        const promises = transaction.files.map((file) =>
            self._writeFileToCache(file.type, transaction.guid, transaction.hash, file.file)
                .then(filePath => helpers.log(consts.LOG_DBG, `Added file to cache: ${file.size} ${filePath}`)));

        return Promise.all(promises);
    }

    async cleanup(dryRun = true) {
        const expireDuration = moment.duration(this._options.cleanupOptions.expireTimeSpan);
        const minFileAccessTime = moment().subtract(expireDuration).toDate();
        const maxCacheSize = this._options.cleanupOptions.maxCacheSize;

        if(!expireDuration.isValid() || expireDuration.asMilliseconds() === 0) {
            return Promise.reject(new Error("Invalid expireTimeSpan option"));
        }

        let cacheCount = 0;
        let cacheSize = 0;
        let deleteSize = 0;
        let deletedItemCount = 0;
        let deleteItems = [];
        const verb = dryRun ? 'Gathering' : 'Removing';
        let spinnerMessage = verb + ' expired files';

        const progressData = () => {
            return {
                cacheCount: cacheCount,
                cacheSize: cacheSize,
                deleteCount: deleteItems.length + deletedItemCount,
                deleteSize: deleteSize,
                msg: spinnerMessage,
            };
        };

        const progressEvent = () => this.emit('cleanup_search_progress', progressData());

        progressEvent();
        const progressTimer = setInterval(progressEvent, 250);

        await helpers.readDir(this._cachePath, (item) => {
            if(item.stats.isDirectory()) return;

            cacheSize += item.stats.size;
            cacheCount ++;

            if(item.stats.atime < minFileAccessTime) {
                deleteSize += item.stats.size;
                deletedItemCount++;
                deleteItems.push(item);
            }
        });

        await Promise.all(
            deleteItems.map(d => this.delete_cache_item(dryRun, d))
        );

        deleteItems.length = 0;

        if (maxCacheSize > 0 && cacheSize - deleteSize > maxCacheSize) {
            let needsSorted = false;
            cacheCount = 0;
            spinnerMessage = 'Gathering files to delete to satisfy Max cache size';

            await helpers.readDir(this._cachePath, (item) => {
                if (item.stats.atime < minFileAccessTime) {
                    // already expired items are handled in the previous pass (only relevant for dry-run)
                    return;
                }

                item = {path: item.path, stats: pick(item.stats, ['atime', 'size'])};
                cacheCount++;

                if (cacheSize - deleteSize >= maxCacheSize) {
                    deleteSize += item.stats.size;
                    deleteItems.push(item);
                    needsSorted = true;
                }
                else {
                    if (needsSorted) {
                        deleteItems.sort((a, b) => {
                            if (a.stats.atime === b.stats.atime) return 0;
                            return a.stats.atime > b.stats.atime ? 1 : -1
                        });

                        needsSorted = false;
                    }

                    const i = deleteItems[deleteItems.length - 1]; // i is the MRU out of the current delete list

                    if (item.stats.atime < i.stats.atime) {
                        deleteItems = helpers.insertSorted(item, deleteItems, (a, b) => {
                            if (a.stats.atime === b.stats.atime) return 0;
                            return a.stats.atime < b.stats.atime ? -1 : 1
                        });
                        deleteSize += item.stats.size;

                        if (cacheSize - (deleteSize - i.stats.size) < maxCacheSize) {
                            deleteItems.pop();
                            deleteSize -= i.stats.size;
                        }
                    }
                }
            });
        }

        clearTimeout(progressTimer);
        this.emit('cleanup_search_finish', progressData());

        await Promise.all(
            deleteItems.map(d => this.delete_cache_item(dryRun, d))
        );

        this.emit('cleanup_delete_finish', progressData());
    }

    async delete_cache_item(dryRun = true, item) {
        const guidHash = CacheFS._extractGuidAndHashFromFilepath(item.path);

        // Make sure we're only deleting valid cached files
        if(guidHash.guidStr.length === 0 || guidHash.hashStr.length === 0)
            return;

        if(!dryRun) {
            await fs.unlink(item.path);
            if(this.reliabilityManager !== null) {
                this.reliabilityManager.removeEntry(guidHash.guidStr, guidHash.hashStr);
            }
        }

        this.emit('cleanup_delete_item', item.path);
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
                    size: stream.size,
                    byteHash: stream.stream.byteHash
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

    async invalidate() {
        await super.invalidate();
        await Promise.all(this._files.map(async (f) => await fs.unlink(f.file)));
        this._files = [];
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

        if(!Object.values(consts.FILE_TYPE).includes(type)) {
            throw new Error(`Unrecognized type '${type}' for transaction.`);
        }

        await fs.ensureFile(file);
        const stream = new HashedWriteStream(file, this._writeOptions);
        this._streams[type] = {
            file: file,
            type: type,
            size: size,
            stream: stream
        };

        return new Promise(resolve => stream.on('open', () => resolve(stream)));
    }

    async writeFilesToPath(filePath) {
        await fs.ensureDir(filePath);
        return Promise.all(this._files.map(async f => {
            const dest = `${path.join(filePath, f.byteHash.toString('hex'))}.${f.type}`;
            await fs.copyFile(f.file, dest);
            return dest;
        }));
    }
}

class HashedWriteStream extends fs.WriteStream {
    constructor(path, options) {
        super(path, options);
        this._hash = crypto.createHash('sha256');
    }

    _write(data, encoding, cb) {
        this._hash.update(data, encoding);
        super._write(data, encoding, cb);
    }

    get byteHash() {
        return this._hash.digest();
    }
}

module.exports = CacheFS;