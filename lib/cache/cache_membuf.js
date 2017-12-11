const { PutTransaction } = require('./cache');
const { Readable, Writable }  = require('stream');
const helpers = require('../helpers');
const consts = require('../constants').Constants;
const config = require('config');
const path = require('path');
const fs = require('fs');
const async = require('async');
const _ = require('lodash');
const loki = require('lokijs');
const uuid = require('uuid/v4');

const kOptionsPath = 'Cache.options.cache_membuf';
const kDbName = 'cache_membuf.db';
const kIndex = 'index';
const kPageMeta = 'pages';

class CacheMembuf {

    static get _options() {
        let opts = config.get(kOptionsPath);
        return _.defaultsDeep(opts, CacheMembuf._optionOverrides);
    }

    static get _serializePath() {
        if(!CacheMembuf._options.hasOwnProperty('serializePath'))
            return null;

        return path.join(path.dirname(require.main.filename), CacheMembuf._options.serializePath)
    }

    static get _dbPath() {
        return path.join(CacheMembuf._serializePath, kDbName);
    }

    static _allocPage(size) {
        let pageIndex = uuid();
        CacheMembuf._pages[pageIndex] = Buffer.alloc(size, 0, 'ascii');

        CacheMembuf._index.insert({
            pageIndex: pageIndex,
            pageOffset: 0,
            size: size
        });

        return CacheMembuf._pageMeta.insert({
            index: pageIndex,
            size: size,
            dirty: true
        });
    }

    static _calcIndexKey(type, guid, hash) {
        return `${guid.toString('hex')}-${hash.toString('hex')}-${type}`;
    }

    static _findFreeBlock(size) {
        let result = CacheMembuf._index.chain()
            .find({ 'fileId' : undefined, 'size' : { '$gte' : size }})
            .simplesort('size')
            .limit(1)
            .data();

        return result.length > 0 ? result[0] : null;
    }

    static _reserveBlock(key, size) {
        // Free any existing block for this key
        CacheMembuf._index.findAndUpdate({'fileId' : key}, doc => doc['fileId'] = undefined);

        // Find the best free block to use
        let freeBlock;
        while((freeBlock = CacheMembuf._findFreeBlock(size)) === null) {
            let growPageSize = CacheMembuf._options.growPageSize;
            let allocSize = Math.max(size, growPageSize);
            if(allocSize > growPageSize) {
                helpers.log(consts.LOG_WARN, "File allocation size of " + size + " exceeds growPageSize of " + growPageSize);
            }

            CacheMembuf._allocPage(allocSize);
        }

        // Clone the free block, then set it's file id and size
        let block = _.omit(freeBlock, ['$loki', 'meta']);
        block['fileId'] = key;
        block['size'] = size;
        CacheMembuf._index.insert(block);

        // Update this free block if leftover space is greater than the minimum
        if(freeBlock.size - size >= CacheMembuf._options.minFreeBlockSize) {
            freeBlock.pageOffset += size;
            freeBlock.size -= size;
            CacheMembuf._index.update(freeBlock);
        }
        else {
            CacheMembuf._index.remove(freeBlock);
        }

        return block;
    }

    static _addFileToCache(type, guid, hash, buffer) {
        const key = CacheMembuf._calcIndexKey(type, guid, hash);
        const entry = CacheMembuf._reserveBlock(key, buffer.length);

        helpers.log(consts.LOG_TEST, `Saving file type: ${type} guid: ${guid.toString('hex')} hash: ${hash.toString('hex')} pageIndex: ${entry.pageIndex} pageOffset: ${entry.pageOffset} size: ${entry.size}`);

        buffer.copy(CacheMembuf._pages[entry.pageIndex], entry.pageOffset, 0, buffer.length);

        let pageMeta = CacheMembuf._pageMeta.by('index', entry.pageIndex);
        pageMeta.dirty = true;
        CacheMembuf._pageMeta.update(pageMeta);
    }

    static _serialize(callback) {

        let p = CacheMembuf._serializePath;
        if(p === null)
            return callback(new Error("Invalid serializedPath"));

        let pages = CacheMembuf._pageMeta.chain().find({'dirty' : true}).data();
        let writeOps = pages.map(function(page) {
            return {
                index: page.index,
                path: path.join(p, page.index),
                data: CacheMembuf._pages[page.index]
            }
        });

        function doWriteOp(op, cb) {
            helpers.log(consts.LOG_INFO, `Writing ${op.path}`);
            fs.writeFile(op.path, op.data, function(err) {
                if(err) return cb(err);
                let doc = CacheMembuf._pageMeta.by('index', op.index);
                doc.dirty = false;
                CacheMembuf._pageMeta.update(doc);
                cb();
            });
        }

        async.eachSeries(writeOps, doWriteOp, callback);
    }

    static _deserialize(callback) {
        const p = CacheMembuf._serializePath;
        if(p === null || !fs.existsSync(p))
            return callback(new Error("Invalid serializePath"));

        let pages = CacheMembuf._pageMeta.chain().find({}).data();

        function loadPageFile(page, cb) {
            let file = path.join(p, page.index);
            helpers.log(consts.LOG_DBG, `Loading page file at ${file}`);
            fs.stat(file, function(err, stats) {
                if(err)
                    return cb(err);

                if(stats.size !== page.size)
                    return cb(new Error(`Unrecognized/invalid page file '${file}'`));

                fs.readFile(file, function(err, result) {
                    if(err) return cb(err);
                    CacheMembuf._pages[page.index] = result;
                    cb();
                });
            });
        }

        async.each(pages, loadPageFile, callback);
    }

    static _clearCache() {
        CacheMembuf._index.clear();
        CacheMembuf._pageMeta.clear();
        CacheMembuf._pages = {};
        CacheMembuf._allocPage(CacheMembuf._options.initialPageSize);
    }

    static _initDb(options, callback) {
        let db = new loki(CacheMembuf._dbPath, options);
        CacheMembuf._db = db;

        db.loadDatabase({}, function() {
            CacheMembuf._index = db.getCollection(kIndex);
            CacheMembuf._pageMeta = db.getCollection(kPageMeta);

            if(CacheMembuf._pageMeta === null) {
                CacheMembuf._pageMeta = db.addCollection(kPageMeta, {
                    unique: ["index"]
                });
            }

            if(CacheMembuf._index === null) {
                CacheMembuf._index = db.addCollection(kIndex, {
                    unique: ["fileId"],
                    indices: ["size"]
                });

                CacheMembuf._clearCache();
                callback();
            }
            else {
                CacheMembuf._deserialize(callback);
            }
        });
    }

    static init(options, callback) {
        if(typeof(options) === 'object')
            CacheMembuf._optionOverrides = options;

        let dbOpts = CacheMembuf._options.get('persistenceOptions') || {};
        if(!dbOpts.hasOwnProperty('adapter')) {
            dbOpts.adapter = new PersistenceAdapter();
        }

        CacheMembuf._initDb(dbOpts, callback);
    }

    static reset(callback) {
        CacheMembuf._clearCache();
        callback();
    }

    static save(callback) {
        CacheMembuf._db.saveDatabase(callback);
    }

    static shutdown(callback) {
        CacheMembuf._db.close(callback);
    }

    static getFileStream(type, guid, hash, callback) {
        const entry = CacheMembuf._index.by('fileId', CacheMembuf._calcIndexKey(type, guid, hash));

        // noinspection EqualityComparisonWithCoercionJS (checking for null or undefined)
        if(entry != null) {
            const file = CacheMembuf._pages[entry.pageIndex].slice(entry.pageOffset, entry.pageOffset + entry.size);
            const stream = new Readable({
                read() {
                    this.push(file);
                    this.push(null);
                },

                highWaterMark: file.length
            });

            callback(null, {size: entry.size, stream: stream});
        }
        else {
            callback(new Error("File not found for (" + type + ") " + guid.toString('hex') + "-" + hash.toString('hex')));
        }
    }

    static createPutTransaction(guid, hash, callback) {
        callback(null, new PutTransactionMembuf(guid, hash));
    }

    static endPutTransaction(transaction, callback) {
        const files = transaction.getFiles();
        files.forEach(function(file) {
            CacheMembuf._addFileToCache(file.type, transaction.guid, transaction.hash, file.buffer);
        });

        callback();
    }

    static registerClusterWorker(worker) {
        // Not implemented
    }
}

class PutTransactionMembuf extends PutTransaction {
    constructor(guid, hash) {
        super(guid, hash);
        this._files = { a: {}, i: {}, r: {} };
        this._finished = [];
    }

    getFiles() {
        return this._finished;
    }

    getWriteStream(type, size, callback) {
        const self = this;

        if(type !== 'a' && type !== 'i' && type !== 'r') {
            return callback(new Error("Unrecognized type '" + type + "' for transaction."));
        }

        this._files[type].buffer = Buffer.alloc(size, 0, 'ascii');
        this._files[type].pos = 0;

        const stream = new Writable({
            write(chunk, encoding, callback) {
                const file = self._files[type];

                if (file.buffer.length - file.pos >= chunk.length) {
                    chunk.copy(file.buffer, file.pos, 0, chunk.length);
                    file.pos += chunk.length;

                    if (file.pos === size) {
                        self._finished.push({type: type, buffer: file.buffer});
                    }
                }
                else {
                    helpers.log(consts.LOG_ERR, "Attempt to write over stream buffer allocation!");
                }

                callback();
            }
        });

        callback(null, stream);
    }
}

CacheMembuf._db = null;
CacheMembuf._pages = {};
CacheMembuf._optionOverrides = {};

module.exports = CacheMembuf;

class PersistenceAdapter extends loki.LokiFsAdapter {
    constructor() {
        super();
    }

    saveDatabase(dbname, dbstring, callback) {
        super.saveDatabase(dbname, dbstring, function() {
            CacheMembuf._serialize(callback);
        });
    }
}