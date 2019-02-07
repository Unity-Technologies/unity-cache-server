require('./test_init');

const tmp = require('tmp');
const fs = require('fs-extra');
const Cache = require('../lib/cache/cache_fs');
const generateCommandData = require('./test_utils').generateCommandData;
const sleep = require('./test_utils').sleep;
const assert = require('assert');
const moment = require('moment');
const helpers = require('../lib/helpers');
const consts = require('../lib/constants');

const MIN_FILE_SIZE = 1024 * 5;
const MAX_FILE_SIZE = MIN_FILE_SIZE;

const cacheOpts = {
    cachePath: tmp.tmpNameSync({}).toString(),
    highReliability: true,
    highReliabilityOptions: {
        reliabilityThreshold: 0
    }
};

let cache;

const addFileToCache = async (atime) => {
    const data = generateCommandData(MIN_FILE_SIZE, MAX_FILE_SIZE);
    const tmpPath = tmp.tmpNameSync();
    await fs.writeFile(tmpPath, data.bin);
    const trx = await cache.createPutTransaction(data.guid, data.hash);
    await trx.getWriteStream(consts.FILE_TYPE.BIN, data.bin.length).then(s => s.end(data.bin));
    await cache.endPutTransaction(trx);
    await sleep(100);
    await fs.unlink(tmpPath);
    const info = await cache.getFileInfo(consts.FILE_TYPE.BIN, data.guid, data.hash);
    await fs.utimes(info.filePath, atime, atime);

    return {
        path: info.filePath,
        guidStr: helpers.GUIDBufferToString(data.guid),
        hashStr: data.hash.toString('hex')
    };
};

describe("Cache: FS", () => {
    describe("Public API", () => {
        beforeEach(() => {
            cache = new Cache();
        });

        afterEach(async () => {
            await cache.shutdown();
            return fs.remove(cacheOpts.cachePath)
        });

        describe("cleanup", function() {
            this.slow(500);

            it("should remove files that have not been accessed within a given timespan (ASP.NET style)", async () => {
                const opts = Object.assign({}, cacheOpts);
                opts.cleanupOptions = {
                    expireTimeSpan: "P1D",
                    maxCacheSize: 0
                };

                await cache.init(opts);
                const file1 = await addFileToCache(moment().subtract(2, 'days').toDate());
                const file2 = await addFileToCache(moment().subtract(2, 'days').toDate());
                const file3 = await addFileToCache(moment().add(1, 'days').toDate());

                assert(fs.pathExistsSync(file1.path));
                assert(fs.pathExistsSync(file2.path));
                assert(fs.pathExistsSync(file3.path));

                await cache.cleanup(false);

                assert(!fs.pathExistsSync(file1.path));
                assert(!fs.pathExistsSync(file2.path));
                assert(fs.pathExistsSync(file3.path));
            });

            it("should remove files that have not been accessed within a given timespan (ISO 8601 style)", async () => {
                const opts = Object.assign({}, cacheOpts);
                opts.cleanupOptions = {
                    expireTimeSpan: "1.00:00:00",
                    maxCacheSize: 0
                };

                await cache.init(opts);
                const file1 = await addFileToCache(moment().subtract(2, 'days').toDate());
                const file2 = await addFileToCache(moment().subtract(2, 'days').toDate());
                const file3 = await addFileToCache(moment().add(1, 'days').toDate());

                assert(fs.pathExistsSync(file1.path));
                assert(fs.pathExistsSync(file2.path));
                assert(fs.pathExistsSync(file3.path));

                await cache.cleanup(false);

                assert(!fs.pathExistsSync(file1.path));
                assert(!fs.pathExistsSync(file2.path));
                assert(fs.pathExistsSync(file3.path));
            });

            it("should reject a promise with an invalid timespan", () => {
                const opts = Object.assign({}, cacheOpts);
                opts.cleanupOptions = {
                    expireTimeSpan: "ABCDEF",
                    maxCacheSize: 0
                };

                return cache.init(opts)
                    .then(() => cache.cleanup())
                    .then(() => { throw new Error("Promise resolved, but expected rejection!"); }, err => assert(err));
            });

            it("should remove files in least-recently-used order until the overall cache size is lower than a given threshold", async () => {
                const opts = Object.assign({}, cacheOpts);
                opts.cleanupOptions = {
                    expireTimeSpan: "P30D",
                    maxCacheSize: MIN_FILE_SIZE * 2 + 1
                };

                await cache.init(opts);
                const file1 = await addFileToCache(moment().toDate());
                const file2 = await addFileToCache(moment().subtract(1, 'days').toDate());
                const file3 = await addFileToCache(moment().subtract(5, 'days').toDate());
                const file4 = await addFileToCache(moment().subtract(31, 'days').toDate());

                assert(await fs.pathExists(file1.path));
                assert(await fs.pathExists(file2.path));
                assert(await fs.pathExists(file3.path));
                assert(await fs.pathExists(file4.path));

                // Execute dry-run path first for complete coverage
                await cache.cleanup(true);

                assert(await fs.pathExists(file1.path));
                assert(await fs.pathExists(file2.path));
                assert(await fs.pathExists(file3.path));
                assert(await fs.pathExists(file4.path));

                await cache.cleanup(false);

                assert(await fs.pathExists(file1.path));
                assert(await fs.pathExists(file2.path));
                assert(!await fs.pathExists(file3.path));
                assert(!await fs.pathExists(file4.path));

                opts.cleanupOptions.maxCacheSize = MIN_FILE_SIZE + 1;
                cache._options = opts;

                await cache.cleanup(false);
                assert(await fs.pathExists(file1.path));
                assert(!await fs.pathExists(file2.path));
            });

            it("should emit events while processing files", async () => {
                const opts = Object.assign({}, cacheOpts);
                opts.cleanupOptions = {
                    expireTimeSpan: "P30D",
                    maxCacheSize: 1
                };

                await cache.init(opts);
                await addFileToCache(moment().toDate());

                let cleanup_search_progress = false;
                let cleanup_search_finish = false;
                let cleanup_delete_item = false;
                let cleanup_delete_finish = false;

                cache.on('cleanup_search_progress', () => cleanup_search_progress = true)
                    .on('cleanup_search_finish', () => cleanup_search_finish = true)
                    .on('cleanup_delete_item', () => cleanup_delete_item = true)
                    .on('cleanup_delete_finish', () => cleanup_delete_finish = true);

                return cache.cleanup(false).then(() => {
                    assert(cleanup_search_progress);
                    assert(cleanup_search_finish);
                    assert(cleanup_delete_item);
                    assert(cleanup_delete_finish);
                });
            });

            it("should not delete any files if the dryRun option is true", async () => {
                const opts = Object.assign({}, cacheOpts);
                opts.cleanupOptions = {
                    expireTimeSpan: "P30D",
                    maxCacheSize: 1
                };

                await cache.init(opts);
                const file = await addFileToCache(moment().toDate());
                await cache.cleanup(true);
                assert(await fs.pathExists(file.path));
            });

            it("should remove versions from the reliability manager, when in high reliability mode", async () => {
                const opts = Object.assign({}, cacheOpts);
                opts.cleanupOptions = {
                    expireTimeSpan: "P30D",
                    maxCacheSize: 1
                };

                await cache.init(opts);
                const file = await addFileToCache(moment().toDate());
                let rmEntry = cache.reliabilityManager.getEntry(file.guidStr, file.hashStr);
                assert(rmEntry);

                await cache.cleanup(false);
                rmEntry = cache.reliabilityManager.getEntry(file.guidStr, file.hashStr);
                assert(!rmEntry);
            });
        });

    });

    describe("PutTransaction API", () => {

        beforeEach(() => {
            cache = new Cache();
        });

        afterEach(() => fs.remove(cacheOpts.cachePath));

        describe("invalidate", () => {
            it("should cleanup temporary files", async () => {
                const fileData = generateCommandData(MIN_FILE_SIZE, MAX_FILE_SIZE);
                const trx = await cache.createPutTransaction(fileData.guid, fileData.hash);
                await trx.getWriteStream(consts.FILE_TYPE.INFO, fileData.info.length).then(s => s.end(fileData.info));
                await trx.finalize();
                assert.equal(trx.files.length, 1);
                const filePath = trx.files[0].file;
                assert(fs.pathExistsSync(filePath));
                await trx.invalidate();
                assert(!fs.pathExistsSync(filePath));
            });
        });
    });
});