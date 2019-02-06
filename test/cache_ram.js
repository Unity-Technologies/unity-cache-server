require('./test_init');

const tmp = require('tmp');
const fs = require('fs-extra');
const Cache = require('../lib/cache/cache_ram');
const randomBuffer = require('./test_utils').randomBuffer;
const generateCommandData = require('./test_utils').generateCommandData;
const sleep = require('./test_utils').sleep;
const path = require('path');
const assert = require('assert');
const consts = require('../lib/constants');

const MIN_FILE_SIZE = 1024 * 5;
const MAX_FILE_SIZE = MIN_FILE_SIZE;

describe("Cache: RAM", function() {
    this.slow(250);

    const dirtyPages = () => cache._pageMeta.chain()
        .find({'dirty' : true}).data()
        .map(page => page.index);

    const opts = {
        cachePath: tmp.tmpNameSync({}).toString(),
        pageSize: MIN_FILE_SIZE * 2,
        maxPageCount: 2,
        minFreeBlockSize: 1024,
        persistence: true,
        persistenceOptions: {
            autosave: false
        },
        highReliability: false
    };

    let cache;
    const fileData = generateCommandData(MIN_FILE_SIZE, MAX_FILE_SIZE);

    const writeFileDataToCache = async (fileData) => {
        await cache._addFileToCache(consts.FILE_TYPE.INFO, fileData.guid, fileData.hash, fileData.info);
        await cache._addFileToCache(consts.FILE_TYPE.BIN, fileData.guid, fileData.hash, fileData.bin);
        await cache._addFileToCache(consts.FILE_TYPE.RESOURCE, fileData.guid, fileData.hash, fileData.resource);
    };

    describe("Public API", () => {
        beforeEach(() => {
            cache = new Cache();
        });

        afterEach(() => fs.remove(opts.cachePath));

        describe("init", () => {
            it("should initialize an empty cache if no database was loaded from disk", async () => {
                await cache.init(opts);
                assert.equal(cache._pageMeta.count(), 1);
                const index = cache._index.findOne({});

                assert.notStrictEqual(index, null);
                assert.equal(index.size, opts.pageSize);
                assert.equal(index.pageOffset, 0);
            });

            it("should populate the _index and _pageMeta when a saved database is loaded from disk", async () => {
                await cache.init(opts);
                await cache._addFileToCache(consts.FILE_TYPE.INFO, fileData.guid, fileData.hash, fileData.info);
                await cache.shutdown();
                await cache.init(opts);

                assert.equal(cache._pageMeta.count(), 1);
                assert.equal(cache._index.count(), 2);
            });

            it("should not save or load any database when opts.persistence is false", async () => {
                const myOpts = Object.assign({}, opts);
                myOpts.persistence = false;

                await cache.init(myOpts);
                await cache._addFileToCache(consts.FILE_TYPE.INFO, fileData.guid, fileData.hash, fileData.info);
                await cache.shutdown();
                await cache.init(myOpts);

                assert.equal(cache._pageMeta.count(), 1);
                assert.equal(cache._index.count(), 1);
            });
        });

        describe("getFileStream", () => {
            it("should update the lastAccessTime of the requested file entry", async () => {
                await cache.init(opts);
                await cache._addFileToCache(consts.FILE_TYPE.INFO, fileData.guid, fileData.hash, fileData.info);
                let info = await cache.getFileInfo(consts.FILE_TYPE.INFO, fileData.guid, fileData.hash);
                const prevTime = info.lastAccessTime;
                await sleep(100);
                await cache.getFileStream(consts.FILE_TYPE.INFO, fileData.guid, fileData.hash);
                info = await cache.getFileInfo(consts.FILE_TYPE.INFO, fileData.guid, fileData.hash);
                assert(info.lastAccessTime > prevTime);
            });
        });

        describe("endPutTransaction", () => {
            it("it should wait for a database save in-progress to complete before ending the transaction", async () => {
                let ok = false;
                cache.on('waitForSerialize', () => {
                    ok = true;
                    cache._serializeInProgress = false;
                });

                cache._serializeInProgress = true;
                await cache.init(opts);
                const trx = await cache.createPutTransaction(fileData.guid, fileData.hash);
                const stream = await trx.getWriteStream(consts.FILE_TYPE.INFO, fileData.info.length);
                stream.end(fileData.info);
                await cache.endPutTransaction(trx);
                assert(ok);
            });

            it("should throw an error when trying to replace a file that is open for reading", async () => {
                const TEST_FILE_SIZE = 1024 * 64 * 2;

                const fData = generateCommandData(TEST_FILE_SIZE, TEST_FILE_SIZE);

                // Add a file to the cache (use the info data)
                await cache.init(opts);
                let trx = await cache.createPutTransaction(fData.guid, fData.hash);
                let wStream = await trx.getWriteStream(consts.FILE_TYPE.INFO, fData.info.length);
                await new Promise(resolve => wStream.end(fData.info, resolve));
                await cache.endPutTransaction(trx);

                // Get a read stream
                const rStream = await cache.getFileStream(consts.FILE_TYPE.INFO, fData.guid, fData.hash);

                // Read a byte
                await new Promise(resolve => rStream.once('readable', () => resolve(rStream.read(1))));

                // Try to replace the file (use the resource data)
                trx = await cache.createPutTransaction(fData.guid, fData.hash);
                wStream = await trx.getWriteStream(consts.FILE_TYPE.INFO, fData.resource.length);
                await new Promise(resolve => wStream.end(fData.resource, resolve));

                return cache.endPutTransaction(trx).then(() => { throw new Error("Expected error"); }, (err) => assert(err))
                    .then(() => rStream.destroy());
            });
        });

        describe("shutdown", () => {
            it("should serialize the database and page files to disk before returning", async () => {
                await cache.init(opts);
                await cache._addFileToCache(consts.FILE_TYPE.INFO, fileData.guid, fileData.hash, fileData.info);

                const pages = dirtyPages();
                assert.equal(pages.length, 1);

                await cache.shutdown();
                await fs.access(cache._dbPath);
                const dir = await fs.readdir(opts.cachePath);
                assert(dir.includes(pages[0]));
            });
        });

        describe("cleanup", () => {
            it("should return a resolved promise", () => {
                return cache.cleanup();
            });
        })
    });

    describe("Internal", () => {

        beforeEach(async () => {
            cache = new Cache();
            await cache.init(opts);

        });

        afterEach(async () => {
            await cache.shutdown();
            cache._clearCache();
            return fs.remove(opts.cachePath);
        });

        describe("_serialize", () => {

            beforeEach(() => writeFileDataToCache(fileData));

            it("should write only dirty page files to disk", async () => {
                const testDir = (dir, dirty) => {
                    assert(dirty.every(entry => dir.includes(entry)));
                    assert(dir.every(entry => dirty.includes(entry)));
                };

                let dirty = dirtyPages();

                // Serialize the cache
                await cache._serialize();
                // Read the cache dir and compare file list to expected dirty pages
                let dir = await fs.readdir(opts.cachePath);
                testDir(dir, dirty);
                // Remove all files from the cache dir
                await fs.emptyDir(opts.cachePath);
                // Replace a single file
                await cache._addFileToCache(consts.FILE_TYPE.INFO, fileData.guid, fileData.hash, randomBuffer(fileData.info.length));
                // Store the dirty page list again
                dirty = dirtyPages();
                // Serialize the cache again
                await cache._serialize();
                // Re-compare cache dir contents to expected dirty pages
                dir = await fs.readdir(opts.cachePath);
                testDir(dir, dirty);
            });
        });

        describe("_deserialize", () => {

            beforeEach(async () => {
                await writeFileDataToCache(fileData);
                await cache._serialize();
            });

            it("should load all page files from the cachePath", async () => {
                const pageMeta = cache._pageMeta.chain().find({}).data();
                const pageData = cache._pages;

                // artificially clear out the page array before de-serializing
                cache._pages = [];
                await cache._deserialize();
                pageMeta.forEach(page => {
                    assert.equal(Buffer.compare(cache._pages[page.index], pageData[page.index]), 0);
                });
            });

            it("should throw an error if the page file size doesn't match the expected size", async () => {
                const dir = await fs.readdir(opts.cachePath);

                assert(dir.length > 0);
                await fs.truncate(path.join(opts.cachePath, dir[0]));

                let didThrow = false;
                try {
                    await cache._deserialize();
                }
                catch(err) {
                    didThrow = true;
                }
                finally {
                    assert(didThrow);
                }
            });
        });

        describe("_allocPage", () => {
            it("should allocate a new page with size equal to the configured page size", () => {
                assert.equal(cache._pageMeta.count(), 1);
                const page = cache._allocPage(0);
                assert.equal(cache._pageMeta.count(), 2);
                assert.equal(cache._pages[page.index].length, opts.pageSize);
            });

            it("should allocate a new page with size equal to the given minSize when greater than the configured page size", () => {
                assert.equal(cache._pageMeta.count(), 1);
                const page = cache._allocPage(opts.pageSize * 2);
                assert.equal(cache._pageMeta.count(), 2);
                assert.equal(cache._pages[page.index].length, opts.pageSize * 2);
            });

            it("should throw an error if page count would exceed maxPageCount", () => {
                for(let x = 0; x < opts.maxPageCount - 1; x++)
                    cache._allocPage(0);

                assert.throws(() => cache._allocPage(0));
            });
        });

        describe("_reserveBlock", () => {
            it("should allocate an existing free block in an existing page when available", () => {
                const key = Cache._calcIndexKey(consts.FILE_TYPE.BIN, randomBuffer(16), randomBuffer(16));
                const block = cache._reserveBlock(key, MIN_FILE_SIZE);
                assert.equal(cache._pageMeta.count(), 1);
                assert.equal(block.size, MIN_FILE_SIZE);
            });

            it("should allocate a new free block to a new page when no free blocks are found in existing pages", () => {
                const key1 = Cache._calcIndexKey(consts.FILE_TYPE.BIN, randomBuffer(16), randomBuffer(16));
                const key2 = Cache._calcIndexKey(consts.FILE_TYPE.BIN, randomBuffer(16), randomBuffer(16));
                cache._reserveBlock(key1, opts.pageSize); // Fill up the first free block
                const block = cache._reserveBlock(key2, MIN_FILE_SIZE); // Should now allocate another
                assert.equal(cache._pageMeta.count(), 2);
                assert.equal(block.size, MIN_FILE_SIZE);
            });

            it("should re-allocate a LRU block when no free blocks are available and maxPageCount has been reached", async () => {
                let firstBlock;
                for(let x = 0; x < opts.maxPageCount; x++) {
                    const key = Cache._calcIndexKey(consts.FILE_TYPE.BIN, randomBuffer(16), randomBuffer(16));
                    const block = cache._reserveBlock(key, opts.pageSize);
                    if(!firstBlock)
                        firstBlock = block;
                    await sleep(50);
                }

                const key = Cache._calcIndexKey(consts.FILE_TYPE.BIN, randomBuffer(16), randomBuffer(16));
                const block = cache._reserveBlock(key, MIN_FILE_SIZE);
                assert.equal(firstBlock.pageIndex, block.pageIndex);
            });

            it("should throw an exception if no free block or no LRU block of a suitable size can be found when maxPageCount has been reached", () => {
                for(let x = 0; x < opts.maxPageCount; x++) {
                    const key = Cache._calcIndexKey(consts.FILE_TYPE.BIN, randomBuffer(16), randomBuffer(16));
                    cache._reserveBlock(key, opts.pageSize);
                }

                assert.throws(() => cache._reserveBlock(key, opts.pageSize * 2));
            });
        });

        describe("_addFileToCache", () => {
            it("should throw an error if the cache cannot grow to accommodate the new file", async () => {
                for(let x = 0; x < opts.maxPageCount; x++) {
                    await cache._addFileToCache(consts.FILE_TYPE.BIN, randomBuffer(16), randomBuffer(16), randomBuffer(opts.pageSize));
                }

                cache._addFileToCache(consts.FILE_TYPE.BIN, randomBuffer(16), randomBuffer(16), randomBuffer(opts.pageSize * 2))
                    .then(() => { throw new Error("Expected exception!") }, () => {});
            });
        });
    });
});