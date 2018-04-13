const tmp = require('tmp');
const fs = require('fs-extra');
const { CacheBase, PutTransaction } = require('../lib/cache/cache_base');
const assert = require('assert');
const path = require('path');
const randomBuffer = require('./test_utils').randomBuffer;
const consts = require('../lib/constants');

describe("Cache: Base Class", () => {
    let cache;

    const opts = {
        cachePath: tmp.tmpNameSync({}),
    };

    beforeEach(() => {
        cache = new CacheBase();
    });

    describe("static get properties", () => {
        it("should return an empty object", () => {
            const p = CacheBase.properties;
            assert.strictEqual(typeof(p), 'object');
            assert.strictEqual(Object.keys(p).length, 0);
        });
    });

    describe("get _optionsPath", () => {
        it("should return 'Cache.options'", () => {
            assert.strictEqual(cache._optionsPath, 'Cache.options');
        });
    });

    describe("get _options", () => {
        it("should return an object with options for all built-in cache modules", () => {
            const cacheOptions = cache._options;
            assert.strictEqual(typeof(cacheOptions), 'object');
            assert(cacheOptions.hasOwnProperty('cache_fs'));
            assert(cacheOptions.hasOwnProperty('cache_ram'));
        });

        it("should apply option overrides", () => {
            cache._optionOverrides = {
                $testVal: { nested: { option: true } }
            };

            const cacheOptions = cache._options;
            assert(cacheOptions.hasOwnProperty('$testVal'));
            assert.strictEqual(cacheOptions.$testVal.nested.option, true);
        });
    });

    describe("get _cachePath", () => {
        it("should return null if there is no cachePath option set", () => {
            assert.equal(cache._cachePath, null);
        });

        it("should return the exact value of cachePath if cachePath is an absolute path", () => {
            cache._optionOverrides = opts;
            assert.strictEqual(cache._cachePath, opts.cachePath);
        });

        it("should return a subdirectory path relative to the app root if cachePath is not an absolute path", () => {
            cache._optionOverrides = {
                cachePath: "abc123"
            };

            assert.strictEqual(cache._cachePath, path.join(path.dirname(require.main.filename), "abc123"));
        });

        it("should handle a trailing slash in the cache path", () => {
            const noTrailingSlash = "/dir/without/trailing/slash";
            const withTrailingSlash = "/dir/without/trailing/slash/";

            cache._optionOverrides = {
                cachePath: noTrailingSlash
            };

            assert.strictEqual(cache._cachePath, noTrailingSlash);

            cache._optionOverrides.cachePath = withTrailingSlash;
            assert.strictEqual(cache._cachePath, withTrailingSlash);
        });
    });

    describe("init", () => {

        after(() => {
            return fs.remove(opts.cachePath);
        });

        it("should create the cache working directory if it doesn't exist", () => {
            return cache.init(opts)
                .then(() => fs.access(opts.cachePath));
        });
    });

    describe("shutdown", () => {
        it("should require override implementation in subclasses by returning an error", () => {
            return cache.shutdown()
                .then(() => { throw new Error("Expected error!"); }, () => {});
        });
    });

    describe("getFileInfo", () => {
        it("should require override implementation in subclasses by returning an error", () => {
            return cache.getFileInfo()
                .then(() => { throw new Error("Expected error!"); }, () => {});
        });
    });

    describe("getFileStream", () => {
        it("should require override implementation in subclasses by returning an error", () => {
            return cache.getFileStream()
                .then(() => { throw new Error("Expected error!"); }, () => {});
        });
    });

    describe("createPutTransaction", () => {
        it("should require override implementation in subclasses by returning an error", () => {
            return cache.createPutTransaction()
                .then(() => { throw new Error("Expected error!"); }, () => {});
        });
    });

    describe("endPutTransaction", () => {
        it("should require override implementation in subclasses by returning an error", () => {
            return cache.endPutTransaction()
                .then(() => { throw new Error("Expected error!"); }, () => {});
        });
    });

    describe("registerClusterWorker", () => {
        it("should require override implementation in subclasses by returning an error", () => {
            let error;
            try {
                cache.registerClusterWorker();
            }
            catch(err) {
                error = err;
            }
            finally {
                assert(error);
            }
        });
    });

    describe("cleanup", () => {
        it("should require override implementation in subclasses by returning an error", () => {
            return cache.endPutTransaction()
                .then(() => { throw new Error("Expected error!"); }, () => {});
        });
    });
});

describe("PutTransaction: Base Class", () => {
    const guid = randomBuffer(consts.GUID_SIZE);
    const hash = randomBuffer(consts.HASH_SIZE);
    const trx = new PutTransaction(guid, hash);

    describe("get guid", () => {
        it("should return the guid passed to the constructor", () => {
            assert.equal(guid.compare(trx.guid), 0);
        });
    });

    describe("get hash", () => {
        it("should return the hash passed to the constructor", () => {
            assert.equal(hash.compare(trx.hash), 0);
        });
    });

    describe("get manifest", () => {
        it("should return an empty array", () => {
            assert.equal(trx.manifest.length, 0);
        });
    });

    describe("get files", () => {
        it("should return an empty array", () => {
            assert.equal(trx.files.length, 0);
        });
    });

    describe("finalize", () => {
        it("should return a promise and emit a 'finalize' event", (done) => {
            trx.once('finalize', () => done());
            const p = trx.finalize();
            assert.equal(typeof(p.then), 'function');
        });
    });

    describe("getWriteStream", () => {
        it("should require override implementation in subclasses by returning an error", () => {
            return trx.getWriteStream('i', 0)
                .then(() => { throw new Error("Expected error!"); }, () => {});
        });
    });
});