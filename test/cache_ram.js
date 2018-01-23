const tmp = require('tmp');
const fs = require('fs-extra');
const Cache = require('../lib/cache/cache_ram');
const randomBuffer = require('./test_utils').randomBuffer;
const generateCommandData = require('./test_utils').generateCommandData;
const path = require('path');
const assert = require('assert');

const MIN_FILE_SIZE = 1024 * 5;
const MAX_FILE_SIZE = MIN_FILE_SIZE;

describe("Cache: RAM", () => {

    function dirtyPages() {
        return cache._pageMeta.chain()
            .find({'dirty' : true}).data()
            .map(page => page.index);
    }

    function writeFileDataToCache(fileData) {
        cache._addFileToCache('i', fileData.guid, fileData.hash, fileData.info);
        cache._addFileToCache('a', fileData.guid, fileData.hash, fileData.bin);
        cache._addFileToCache('r', fileData.guid, fileData.hash, fileData.resource);
    }

    let opts = {
        cachePath: tmp.tmpNameSync({}).toString(),
        initialPageSize: MIN_FILE_SIZE * 2,
        growPageSize: MIN_FILE_SIZE * 2,
        minFreeBlockSize: 1024,
        persistenceOptions: {
            autosave: false
        }
    };

    let cache;
    let fileData = generateCommandData(MIN_FILE_SIZE, MAX_FILE_SIZE);

    describe("Public API", () => {

        beforeEach(() => {
            cache = new Cache();
        });

        afterEach(() => {
            return fs.remove(opts.cachePath);
        });

        describe("init", () => {
            it("should initialize the _db object", () => {
                return cache.init(opts).then(() => assert(cache._db !== null));
            });

            it("should initialize an empty cache if no database was loaded from disk", () => {
                return cache.init(opts)
                    .then(() => {
                        assert(cache._pageMeta.count() === 1);
                        let index = cache._index.findOne({});
                        assert(index !== null);
                        assert(index.size === opts.initialPageSize);
                        assert(index.pageOffset === 0);
                    });
            });

            it("should populate the _index and _pageMeta when a saved database is loaded from disk", () => {
                return cache.init(opts)
                    .then(() => { cache._addFileToCache('i', fileData.guid, fileData.hash, fileData.info);} )
                    .then(() => cache.shutdown())
                    .then(() => cache.init(opts))
                    .then(() => {
                        assert(cache._pageMeta.count() === 1);
                        assert(cache._index.count() === 2);
                    });
            });
        });

        describe("endPutTransaction", () => {
            it("it should wait for a database save in-progress to complete before ending the transaction", () => {
                let trx;

                let ok = false;
                cache.on('waitForSerialize', () => {
                    ok = true;
                    cache._serializeInProgress = false;
                });

                cache._serializeInProgress = true;
                return cache.init(opts)
                    .then(() => cache.createPutTransaction(fileData.guid, fileData.hash))
                    .then(result => { trx = result; })
                    .then(() => trx.getWriteStream('i', fileData.info.length))
                    .then(stream => stream.end(fileData.info))
                    .then(() => cache.endPutTransaction(trx))
                    .then(() => assert(ok));
            });
        });

        describe("shutdown", () => {
            it("should serialize the database and page files to disk before returning", () => {
                let pages;
                return cache.init(opts)
                    .then(() => { cache._addFileToCache('i', fileData.guid, fileData.hash, fileData.info); })
                    .then(() => {
                        pages = dirtyPages();
                        assert(pages.length === 1);
                    })
                    .then(() => cache.shutdown())
                    .then(() => fs.access(cache._dbPath))
                    .then(() => fs.readdir(opts.cachePath))
                    .then(dir => assert(dir.includes(pages[0])));
            });
        });
    });

    describe("_serialize", () => {

        beforeEach(() => {
            cache = new Cache();
            return cache.init(opts).then(() => writeFileDataToCache(fileData));
        });

        afterEach(() => {
            cache._clearCache();
            return fs.remove(opts.cachePath);
        });

        it("should write only dirty page files to disk", () => {
            let testDir = (dir, dirty) => {
                assert(dirty.every(entry => dir.includes(entry)));
                assert(dir.every(entry => dirty.includes(entry)));
            };

            let dirty = dirtyPages();
            return Promise.resolve()
                // Serialize the cache
                .then(() => cache._serialize())
                // Read the cache dir and compare file list to expected dirty pages
                .then(() => fs.readdir(opts.cachePath))
                .then(dir => testDir(dir, dirty))
                // Remove all files from the cache dir
                .then(() => fs.emptyDir(opts.cachePath))
                // Replace a single file
                .then(() => cache._addFileToCache('i', fileData.guid, fileData.hash, randomBuffer(fileData.info.length)))
                // Store the dirty page list again
                .then(() => { dirty = dirtyPages(); })
                // Serialize the cache again
                .then(() => cache._serialize())
                // Re-compare cache dir contents to expected dirty pages
                .then(() => fs.readdir(opts.cachePath))
                .then(dir => testDir(dir, dirty));
        });
    });

    describe("_deserialize", () => {

        beforeEach(() => {
            cache = new Cache();
            return cache.init(opts)
                .then(() => writeFileDataToCache(fileData))
                .then(() => cache._serialize());
        });

        afterEach(() => {
            cache._clearCache();
            return fs.remove(opts.cachePath);
        });

        it("should load all page files from the cachePath", () => {
            let pageMeta =  cache._pageMeta.chain().find({}).data();
            let pageData = cache._pages;

            // artificially clear out the page array before de-serializing
            cache._pages = [];

            return cache._deserialize()
                .then(() => {
                    let ok = pageMeta.every(page => {
                        return Buffer.compare(cache._pages[page.index], pageData[page.index]) === 0;
                    });

                    assert(ok);
                });
        });

        it("should throw an error if the page file size doesn't match the expected size", () => {
            return fs.readdir(opts.cachePath)
                .then(dir => {
                    assert(dir.length > 0);
                    return fs.truncate(path.join(opts.cachePath, dir[0]))
                })
                .then(() => cache._deserialize())
                .then(() => { throw new Error("Expected error!"); }, err =>  assert(err));
        });
    });

    describe("_allocPage", () => {

    });

    describe("_findFreeBlock", () => {

    });

    describe("_reserveBlock", () => {

    });

    describe("_waitForSerialize", () => {

    });

    describe("_addFileToCache", () => {

    });

    describe("_clearCache", () => {

    });
});