require('./test_init');

const assert = require('assert');
const tmp = require('tmp-promise');
const loki = require('lokijs');
const fs = require('fs-extra');
const sleep = require('./test_utils').sleep;
const generateCommandData = require('./test_utils').generateCommandData;
const sinon = require('sinon');
const crypto = require('crypto');
const consts = require('../lib/constants');

const test_modules = [
    {
        name: "cache_ram",
        path: "../lib/cache/cache_ram",
        options: {
            cachePath: tmp.tmpNameSync({}),
            pageSize: 1024 * 1024,
            minFreeBlockSize: 1024,
            persistenceOptions: {
                autosave: false,
                adapter: new loki.LokiMemoryAdapter()
            },
            highReliability: false
        }
    },
    {
        name: "cache_fs",
        path: "../lib/cache/cache_fs",
        options: {
            cachePath: tmp.tmpNameSync({}),
            highReliability: false,
            persistenceOptions: {
                autosave: false
            }
        }
    }
];

describe("Cache API", function() {
    this.slow(300);

    test_modules.forEach(module => {
        describe(module.name, () => {
            let CacheModule, cache;

            before(() => {
                /** @type {CacheBase} **/
                CacheModule = require(module.path);
                cache = new CacheModule();
            });

            after(() => fs.remove(module.options.cachePath));

            describe("static get properties", () => {
                it("should return an object with common property values", () => {
                    const props = CacheModule.properties;
                    assert(props.hasOwnProperty('clustering') && typeof(props['clustering']) === 'boolean');
                });
            });

            describe("init", () => {
                it("should create the cache working directory if it doesn't exist", () => {
                    return cache.init(module.options)
                        .then(() => fs.access(module.options.cachePath));
                });
            });

            describe("shutdown", () => {
                it("should return with no error", () => {
                    return cache.shutdown();
                });
            });

            describe("createPutTransaction", () => {
                let fileData;

                before(() => {
                    fileData = generateCommandData(1024, 1024);
                });

                it("should return a PutTransaction object for the given file hash & guid", () => {
                    return cache.createPutTransaction(fileData.guid, fileData.hash)
                        .then(trx => {
                                assert.strictEqual(trx.guid.compare(fileData.guid), 0);
                                assert.strictEqual(trx.hash.compare(fileData.hash), 0);
                        });
                });
            });

            describe("endPutTransaction & getFileInfo", () => {
                it("should call finalize() on the given transaction", async () => {
                    const transaction = {
                        finalize: () => {},
                        guid: Buffer.alloc(consts.GUID_SIZE, 0),
                        hash: Buffer.alloc(consts.HASH_SIZE, 0),
                        files: []
                    };

                    const mock = sinon.mock(transaction);
                    mock.expects("finalize").once();

                    await cache.endPutTransaction(transaction);
                    mock.verify();
                });

                it("should add info, asset, and resource files to the cache that were written to the transaction", async () => {
                    const fileData = generateCommandData(1024, 1024);
                    const trx = await cache.createPutTransaction(fileData.guid, fileData.hash);
                    await trx.getWriteStream(consts.FILE_TYPE.INFO, fileData.info.length).then(s => s.end(fileData.info));
                    await trx.getWriteStream(consts.FILE_TYPE.BIN, fileData.info.length).then(s => s.end(fileData.bin));
                    await trx.getWriteStream(consts.FILE_TYPE.RESOURCE, fileData.info.length).then(s => s.end(fileData.resource));
                    await cache.endPutTransaction(trx);
                    await sleep(50);

                    await cache.getFileInfo(consts.FILE_TYPE.INFO, fileData.guid, fileData.hash)
                        .then(info => assert.equal(info.size, fileData.info.length));

                    await cache.getFileInfo(consts.FILE_TYPE.BIN, fileData.guid, fileData.hash)
                        .then(info => assert.equal(info.size, fileData.bin.length));

                    await cache.getFileInfo(consts.FILE_TYPE.RESOURCE, fileData.guid, fileData.hash)
                        .then(info => assert.equal(info.size, fileData.resource.length));

                });

                it("should return an error if any files were partially written to the transaction", async () => {
                    const fileData = generateCommandData(1024, 1024);
                    const trx = await cache.createPutTransaction(fileData.guid, fileData.hash);
                    const stream = await trx.getWriteStream(consts.FILE_TYPE.INFO, fileData.info.length);
                    await stream.end(fileData.info.slice(0, 1));
                    return cache.endPutTransaction(trx)
                        .then(() => { throw new Error("Expected error!"); }, err =>  assert(err));
                });

                it("should not add files to the cache that were partially written to the transaction", async () => {
                    const fileData = generateCommandData(1024, 1024);
                    const trx = await cache.createPutTransaction(fileData.guid, fileData.hash);
                    const stream = await trx.getWriteStream(consts.FILE_TYPE.INFO, fileData.info.length);
                    await stream.end(fileData.info.slice(0, 1));
                    await cache.endPutTransaction(trx)
                        .then(() => {}, err => assert(err));

                    return cache.getFileInfo(consts.FILE_TYPE.INFO, fileData.guid, fileData.hash)
                        .then(() => { throw new Error("Expected error!"); }, err =>  assert(err));
                });

                describe("High Reliability Mode", () => {
                    before(async () => {
                        const opts = cache._options;
                        opts.highReliability = true;
                        opts.highReliabilityOptions = {
                            reliabilityThreshold: 2
                        };

                        await cache.init(opts);
                    });

                    after(async () => {
                        const opts = cache._options;
                        opts.highReliability = false;
                        await cache.init(opts);
                    });

                    it("should not add a version to the cache until the reliabilityFactor meets the reliabilityThreshold", async () => {
                        const fileData = generateCommandData(1024, 1024);
                        let t = await cache.createPutTransaction(fileData.guid, fileData.hash);
                        await t.getWriteStream(consts.FILE_TYPE.INFO, fileData.info.length).then(s => s.end(fileData.info));
                        await t.getWriteStream(consts.FILE_TYPE.BIN, fileData.bin.length).then(s => s.end(fileData.bin));
                        await cache.endPutTransaction(t);
                        await sleep(50);
                        await cache.getFileInfo(consts.FILE_TYPE.INFO, fileData.guid, fileData.hash)
                            .then(() => { throw new Error("Expected error!"); }, err => assert(err));
                        await cache.getFileInfo(consts.FILE_TYPE.BIN, fileData.guid, fileData.hash)
                            .then(() => { throw new Error("Expected error!"); }, err => assert(err));

                        t = await cache.createPutTransaction(fileData.guid, fileData.hash);
                        await t.getWriteStream(consts.FILE_TYPE.INFO, fileData.info.length).then(s => s.end(fileData.info));
                        await t.getWriteStream(consts.FILE_TYPE.BIN, fileData.bin.length).then(s => s.end(fileData.bin));
                        await cache.endPutTransaction(t);
                        await sleep(50);
                        await cache.getFileInfo(consts.FILE_TYPE.INFO, fileData.guid, fileData.hash)
                            .then(i => assert.equal(i.size, fileData.info.length));
                        await cache.getFileInfo(consts.FILE_TYPE.BIN, fileData.guid, fileData.hash)
                            .then(i => assert.equal(i.size, fileData.bin.length));
                    });

                    it("should not add a version to the cache if all transactions for a version do not contain the same number of files", async () => {
                        const fileData = generateCommandData(1024, 1024);
                        let t = await cache.createPutTransaction(fileData.guid, fileData.hash);
                        await t.getWriteStream(consts.FILE_TYPE.INFO, fileData.info.length).then(s => s.end(fileData.info));
                        await t.getWriteStream(consts.FILE_TYPE.BIN, fileData.bin.length).then(s => s.end(fileData.bin));
                        await cache.endPutTransaction(t);
                        await sleep(50);
                        await cache.getFileInfo(consts.FILE_TYPE.INFO, fileData.guid, fileData.hash)
                            .then(() => { throw new Error("Expected error!"); }, err => assert(err));

                        await cache.getFileInfo(consts.FILE_TYPE.BIN, fileData.guid, fileData.hash)
                            .then(() => { throw new Error("Expected error!"); }, err => assert(err));

                        // This time we just add the info file, so the version should be deemed unreliable
                        t = await cache.createPutTransaction(fileData.guid, fileData.hash);
                        await t.getWriteStream(consts.FILE_TYPE.INFO, fileData.info.length).then(s => s.end(fileData.info));
                        await cache.endPutTransaction(t);
                        await sleep(50);

                        await cache.getFileInfo(consts.FILE_TYPE.INFO, fileData.guid, fileData.hash)
                            .then(() => { throw new Error("Expected error!"); }, err => assert(err));
                        await cache.getFileInfo(consts.FILE_TYPE.BIN, fileData.guid, fileData.hash)
                            .then(() => { throw new Error("Expected error!"); }, err => assert(err));
                    });


                    it("should not allow new files to be written to an existing version", async () => {
                        // Commit a version
                        const fileData = generateCommandData(1024, 1024);
                        for(let i = 0; i < cache._options.highReliabilityOptions.reliabilityThreshold + 1; i++) {
                            const trx = await cache.createPutTransaction(fileData.guid, fileData.hash);
                            await trx.getWriteStream(consts.FILE_TYPE.INFO, fileData.info.length).then(s => s.end(fileData.info));
                            await trx.getWriteStream(consts.FILE_TYPE.BIN, fileData.info.length).then(s => s.end(fileData.bin));
                            await trx.getWriteStream(consts.FILE_TYPE.RESOURCE, fileData.info.length).then(s => s.end(fileData.resource));
                            await cache.endPutTransaction(trx);
                            await sleep(50);
                        }

                        // Try to change it with new data
                        const newData = Buffer.from(crypto.randomBytes(fileData.info.length * 2).toString('ascii'), 'ascii');

                        const trx = await cache.createPutTransaction(fileData.guid, fileData.hash);
                        const stream = await trx.getWriteStream(consts.FILE_TYPE.INFO, newData.length);
                        await stream.end(newData);
                        await cache.endPutTransaction(trx);
                        await sleep(50);
                        const info = await cache.getFileInfo(consts.FILE_TYPE.INFO, fileData.guid, fileData.hash);
                        assert.equal(info.size, fileData.info.length);
                    });

                    it("should not allow a previously unstable version to become stable", async () => {
                        const fileData = generateCommandData(1024, 1024);
                        let trx = await cache.createPutTransaction(fileData.guid, fileData.hash);
                        await trx.getWriteStream(consts.FILE_TYPE.BIN, fileData.info.length).then(s => s.end(fileData.info));
                        await cache.endPutTransaction(trx);
                        await sleep(50);

                        // Next version will use the wrong data, making it unreliable
                        trx = await cache.createPutTransaction(fileData.guid, fileData.hash);
                        await trx.getWriteStream(consts.FILE_TYPE.BIN, fileData.resource.length).then(s => s.end(fileData.resource));
                        await cache.endPutTransaction(trx);
                        await sleep(50);

                        // Verify it doesn't exist
                        await cache.getFileInfo(consts.FILE_TYPE.BIN, fileData.guid, fileData.hash)
                            .then(() => { throw new Error("Expected error!"); }, err => assert(err));

                        // Try to add the correct data more than the reliability threshold .. should still not be found
                        for(let i = 0; i < cache._options.highReliabilityOptions.reliabilityThreshold + 1; i++) {
                            trx = await cache.createPutTransaction(fileData.guid, fileData.hash);
                            await trx.getWriteStream(consts.FILE_TYPE.BIN, fileData.info.length).then(s => s.end(fileData.info));
                            await cache.endPutTransaction(trx);
                            await sleep(50);

                            await cache.getFileInfo(consts.FILE_TYPE.BIN, fileData.guid, fileData.hash)
                                .then(() => { throw new Error("Expected error!"); }, err => assert(err));
                        }
                    });
                });
            });

            describe("getFileStream", function() {

                let fileData;

                beforeEach(async () => {
                    fileData = generateCommandData(1024, 1024);
                    const trx = await cache.createPutTransaction(fileData.guid, fileData.hash);
                    await trx.getWriteStream(consts.FILE_TYPE.INFO, fileData.info.length).then(s => s.end(fileData.info));
                    await cache.endPutTransaction(trx);
                    await sleep(50);
                });

                it("should return a readable stream for a file that exists in the cache", () => {
                    return cache.getFileStream(consts.FILE_TYPE.INFO, fileData.guid, fileData.hash)
                        .then(stream => assert(stream instanceof require('stream').Readable));
                });

                it("should return an error for a file that does not exist in the cache", () => {
                    return cache.getFileStream(consts.FILE_TYPE.BIN, fileData.guid, fileData.hash)
                        .then(() => { throw new Error("Expected error!"); }, err =>  assert(err));
                });
            });
        });
    });
});

describe("PutTransaction API", () => {
    test_modules.forEach((module) => {
        describe(module.name, () => {
            let cache, fileData, trx;

            before(() => {
                /** @type {CacheBase} **/
                const CacheModule = require(module.path);
                cache = new CacheModule();
                fileData = generateCommandData(1024, 1024);
            });

            after(() => fs.remove(module.options.cachePath));

            beforeEach( async () => {
                trx = await cache.createPutTransaction(fileData.guid, fileData.hash);
            });

            describe("get guid", () => {
                it("should return the file guid for the transaction", () => {
                    assert.strictEqual(trx.guid, fileData.guid);
                });
            });

            describe("get hash", () => {
                it("should return the file hash for the transaction", () => {
                    assert.strictEqual(trx.hash, fileData.hash);
                });
            });

            describe("get manifest", () => {
                it("should return an array of file types that were successfully written to the transaction", async () => {
                    await trx.getWriteStream(consts.FILE_TYPE.INFO, fileData.info.length).then(s => s.end(fileData.info));
                    await trx.getWriteStream(consts.FILE_TYPE.RESOURCE, fileData.resource.length).then(s => s.end(fileData.resource));
                    await trx.getWriteStream(consts.FILE_TYPE.BIN, fileData.bin.length).then(s => s.end(fileData.bin));
                    await trx.finalize();
                    const m = trx.manifest;
                    [consts.FILE_TYPE.INFO, consts.FILE_TYPE.BIN, consts.FILE_TYPE.RESOURCE].forEach((t) => assert(m.indexOf(t) >= 0));
                });
            });

            describe("get files", () => {
                it("should return an empty array before finalize() is called", () => {
                    assert.strictEqual(trx.files.length, 0);
                });

                it("should return a list of objects that represent completed files for the transaction", async () => {
                    await trx.getWriteStream(consts.FILE_TYPE.INFO, fileData.info.length).then(s => s.end(fileData.info));
                    await trx.finalize();
                    assert.equal(trx.files.length, 1);
                });
            });

            describe("finalize", function() {
                it("should return an error if any file was not fully written", async () => {
                    await trx.getWriteStream(consts.FILE_TYPE.INFO, fileData.info.length).then(s => s.end(fileData.info.slice(0, 1)));
                    await trx.finalize().then(() => { throw new Error("Expected error!"); }, err => assert(err));
                });

                it("should return with no error and no value if the transaction was successfully finalized", async () => {
                    await trx.getWriteStream(consts.FILE_TYPE.INFO, fileData.info.length).then(s => s.end(fileData.info));
                    await trx.finalize();
                });

                it("should emit a 'finalize' event", (done) => {
                    trx.once('finalize', () => done());
                    trx.finalize();
                });

                it("should call validateHash", async () => {
                    const spy = sinon.spy(trx, "validateHash");
                    await trx.finalize();
                    assert(spy.called);
                });
            });

            describe("validateHash", function () {
                it("should invalidate the transaction if the hash is empty (0 values)", async () => {
                    const myTrx = await cache.createPutTransaction(fileData.guid, Buffer.alloc(consts.HASH_SIZE, 0));
                    await myTrx.validateHash();
                    assert(!myTrx.isValid);
                });
            });

            describe("getWriteStream", function() {
                it("should return a WritableStream for the given file type", () => {
                    return trx.getWriteStream(consts.FILE_TYPE.INFO, 1)
                        .then(stream => assert(stream instanceof require('stream').Writable));
                });

                it("should only accept types of consts.FILE_TYPE.INFO, consts.FILE_TYPE.BIN, or 'r", async () => {
                    await trx.getWriteStream(consts.FILE_TYPE.INFO, 1);
                    await trx.getWriteStream(consts.FILE_TYPE.BIN, 1);
                    await trx.getWriteStream(consts.FILE_TYPE.RESOURCE, 1);
                    await trx.getWriteStream('x', 1)
                        .then(() => { throw new Error("Expected error!"); }, err => assert(err));
                });

                it("should return an error for size equal to 0", () => {
                    return trx.getWriteStream(consts.FILE_TYPE.INFO, 0)
                        .then(() => { throw new Error("Expected error!"); }, err => assert(err))
                });

                it("should return an error for size less than 0", () => {
                    return trx.getWriteStream(consts.FILE_TYPE.INFO, -1)
                        .then(() => { throw new Error("Expected error!"); }, err => assert(err))
                });
            });

            describe("invalidate", () => {
                it("should cause isValid to return false", async () => {
                    assert.ok(trx.isValid);
                    await trx.invalidate();
                    assert.ok(!trx.isValid);
                });

                it("should cause files to return an empty array", async () => {
                    await trx.getWriteStream(consts.FILE_TYPE.INFO, fileData.info.length).then(s => s.end(fileData.info));
                    await trx.finalize();
                    assert.equal(trx.files.length, 1);
                    await trx.invalidate();
                    assert.equal(trx.files.length, 0);
                });
            });

            describe("writeFilesToPath", () => {
                it("should copy or write file data to the specified path", async () => {
                    await trx.getWriteStream(consts.FILE_TYPE.INFO, fileData.info.length).then(s => s.end(fileData.info));
                    await trx.finalize();
                    const o = await tmp.dir({ unsafeCleanup: true });
                    const files = await trx.writeFilesToPath(o.path);
                    assert.ok(files);
                    assert.equal(files.length, 1);
                    await fs.access(files[0]);
                    o.cleanup();
                });
            });
        });
    });
});