const tmp = require('tmp');
const fs = require('fs-extra');
const Cache = require('../lib/cache/cache_fs');
const generateCommandData = require('./test_utils').generateCommandData;
const assert = require('assert');
const moment = require('moment');

const MIN_FILE_SIZE = 1024 * 5;
const MAX_FILE_SIZE = MIN_FILE_SIZE;

const cacheOpts = {
    cachePath: tmp.tmpNameSync({}).toString()
};

let cache;

const addFileToCache = async (atime) => {
    const data = generateCommandData(MIN_FILE_SIZE, MAX_FILE_SIZE);
    const tmpPath = tmp.tmpNameSync({dir: cacheOpts.cachePath});
    await fs.writeFile(tmpPath, data.bin);
    const cacheFile = await cache._addFileToCache('a', data.guid, data.hash, tmpPath);
    await fs.utimes(cacheFile, atime, atime);

    const stats = await fs.stat(cacheFile);
    assert(moment(stats.atime).isSame(atime, 'second'), `${stats.atime} != ${atime}`);
    return cacheFile;
};

describe("Cache: FS", () => {
    describe("Public API", () => {
        beforeEach(() => {
            cache = new Cache();
        });

        afterEach(() => fs.remove(cacheOpts.cachePath));

        describe("cleanup", () => {
            it("should remove files that have not been accessed within a given timespan (ASP.NET style)", async () => {
                const opts = Object.assign({}, cacheOpts);
                opts.cleanupOptions = {
                    expireTimeSpan: "P1D",
                    maxCacheSize: 0
                };

                await cache.init(opts);
                const file1 = await addFileToCache(moment().subtract(2, 'days').toDate());
                const file2 = await addFileToCache(moment().subtract(2, 'days').toDate());
                const file3 = await addFileToCache(moment().toDate());

                await cache.cleanup(false);

                assert(!await fs.pathExists(file1));
                assert(!await fs.pathExists(file2));
                assert(await fs.pathExists(file3));
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
                const file3 = await addFileToCache(moment().toDate());

                assert(await fs.pathExists(file1));
                assert(await fs.pathExists(file2));
                assert(await fs.pathExists(file3));

                await cache.cleanup(false);

                assert(!await fs.pathExists(file1));
                assert(!await fs.pathExists(file2));
                assert(await fs.pathExists(file3));
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

                assert(await fs.pathExists(file1));
                assert(await fs.pathExists(file2));
                assert(await fs.pathExists(file3));

                await cache.cleanup(false);

                assert(await fs.pathExists(file1));
                assert(await fs.pathExists(file2));
                assert(!await fs.pathExists(file3));

                opts.cleanupOptions.maxCacheSize = MIN_FILE_SIZE + 1;
                cache._options = opts;

                await cache.cleanup(false);
                assert(await fs.pathExists(file1));
                assert(!await fs.pathExists(file2));
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
                cache.cleanup(true);
                assert(await fs.pathExists(file));
            });
        });
    });
});