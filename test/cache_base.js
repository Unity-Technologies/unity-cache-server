require('./test_init');

const tmp = require('tmp');
const fs = require('fs-extra');
const { CacheBase, PutTransaction } = require('../lib/cache/cache_base');
const assert = require('assert');
const path = require('path');
const randomBuffer = require('./test_utils').randomBuffer;
const consts = require('../lib/constants');
const sinon = require('sinon');
const { Writable } = require('stream');

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

        after(() => fs.remove(opts.cachePath));

        it("should create the cache working directory if it doesn't exist", () => {
            return cache.init(opts)
                .then(() => fs.access(opts.cachePath));
        });

        it("should initialize the _db object", async () => {
            await cache.init(opts);
            assert.notEqual(cache._db, null);
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
        it("should return an instance of a PutTransaction", async () => {
            const t = await cache.createPutTransaction();
            assert.ok(t instanceof PutTransaction);
        });
    });

    describe("endPutTransaction", () => {
        after(() => {
            sinon.restore();
        });

        it("should call finalize on the transaction", async () => {
            const trx = { finalize: () => {} };
            const mock = sinon.mock(trx);
            mock.expects("finalize").once();
            await cache.endPutTransaction(trx);
            mock.verify();
        });

        it("should process transactions with the reliability manager if high reliability mode is on", async () => {
            const trx = {
                finalize: () => {},
                isValid: true
            };

            const myOpts = Object.assign({}, opts);
            myOpts.highReliability = true;
            myOpts.highReliabilityOptions = { reliabilityThreshold: 2 };

            await cache.init(myOpts);
            const stub = sinon.stub(cache._rm, "processTransaction");

            // High reliability enabled: should process
            await cache.endPutTransaction(trx);
            assert(stub.calledOnce);
            stub.resetHistory();

            // High reliability disabled: should not process
            myOpts.highReliability = false;
            await cache.endPutTransaction(trx);
            assert(stub.notCalled);
        });
    });

    describe("cleanup", () => {
        it("should require override implementation in subclasses by returning an error", () => {
            return cache.cleanup()
                .then(() => { throw new Error("Expected error!"); }, () => {});
        });
    });
});

describe("PutTransaction: Base Class", () => {
    let trx;
    const guid = randomBuffer(consts.GUID_SIZE);
    const hash = randomBuffer(consts.HASH_SIZE);

    beforeEach(() => {
        trx = new PutTransaction(guid, hash);
    });

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

    describe("get filesHashStr", () => {
        it("should return a non-zero length string even if there are no files in the transaction", () => {
            assert(trx.filesHashStr.length > 0);
        });

        it("should return a hash string that uniquely identifies the transaction file contents", () => {
            Object.defineProperty(trx, "files", {
                get: () => { return [
                    { type: consts.FILE_TYPE.BIN, byteHash: randomBuffer(consts.HASH_SIZE) },
                    { type: consts.FILE_TYPE.RESOURCE, byteHash: randomBuffer(consts.HASH_SIZE) },
                    { type: consts.FILE_TYPE.INFO, byteHash: randomBuffer(consts.HASH_SIZE) }
                ]}
            });

            const str1 = trx.filesHashStr;
            const str2 = trx.filesHashStr;

            assert(str1 !== str2);
        });

        it("should not include the info (i) file contents in the hash", () => {
            const a = randomBuffer(consts.HASH_SIZE);
            const r = randomBuffer(consts.HASH_SIZE);
            Object.defineProperty(trx, "files", {
                get: () => { return [
                    { type: consts.FILE_TYPE.BIN, byteHash: a },
                    { type: consts.FILE_TYPE.RESOURCE, byteHash: r },
                    { type: consts.FILE_TYPE.INFO, byteHash: randomBuffer(consts.HASH_SIZE) }
                ]}
            });

            const str1 = trx.filesHashStr;
            const str2 = trx.filesHashStr;

            assert(str1 === str2);
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
        it("should return a Writable stream", async() => {
            const s = await trx.getWriteStream(consts.FILE_TYPE.INFO, 0);
            assert.ok(s instanceof Writable);
        });
    });

    describe("writeFilesToPath", () => {
        it("should return a promise", () => {
            const p = trx.writeFilesToPath();
            assert.ok(p instanceof Promise);
        });
    });
});