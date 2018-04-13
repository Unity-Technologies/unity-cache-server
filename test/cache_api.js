const assert = require('assert');
const tmp = require('tmp');
const loki = require('lokijs');
const fs = require('fs-extra');
const sleep = require('./test_utils').sleep;
const generateCommandData = require('./test_utils').generateCommandData;
const readStream = require('./test_utils').readStream;
const EventEmitter = require('events');

const test_modules = [
    {
        name: "cache_ram",
        path: "../lib/cache/cache_ram",
        options: {
            cachePath: tmp.tmpNameSync({}),
            pageSize: 1024 * 1024,
            minFreeBlockSize: 1024,
            persistenceOptions: {
                adapter: new loki.LokiMemoryAdapter()
            }
        }
    },
    {
        name: "cache_fs",
        path: "../lib/cache/cache_fs",
        options: {
            cachePath: tmp.tmpNameSync({})
        }
    }
];

describe("Cache API", () => {
    test_modules.forEach(module => {
        describe(module.name, () => {
            let CacheModule, cache;

            before(() => {
                /** @type {CacheBase} **/
                CacheModule = require(module.path);
                cache = new CacheModule();
            });

            after(() => {
                return fs.remove(module.options.cachePath);
            });

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

            describe("registerClusterWorker", () => {
                it("should return with no error", done => {
                    cache.registerClusterWorker(new EventEmitter());
                    done();
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
                let fileData, trx;

                beforeEach(() => {
                    fileData = generateCommandData(1024, 1024);
                    return cache.createPutTransaction(fileData.guid, fileData.hash)
                        .then(result => { trx = result; });
                });

                it("should call finalize on the transaction", () => {
                    let called = false;
                    trx.finalize = () => {
                        called = true;
                        return Promise.resolve();
                    };

                    cache.endPutTransaction(trx).then(() => assert(called));
                });

                it("should add info, asset, and resource files to the cache that were written to the transaction", () => {
                    return trx.getWriteStream('i', fileData.info.length)
                        .then(stream => stream.end(fileData.info))
                        .then(() => cache.endPutTransaction(trx))
                        .then(() => sleep(50))
                        .then(() => cache.getFileInfo('i', fileData.guid, fileData.hash))
                        .then(info => assert.equal(info.size, fileData.info.length));
                });

                it("should return an error if any files were partially written to the transaction", () => {
                    return trx.getWriteStream('i', fileData.info.length)
                        .then(stream => stream.end(fileData.info.slice(0, 1)))
                        .then(() => cache.endPutTransaction(trx))
                        .then(() => { throw new Error("Expected error!"); }, err =>  assert(err));
                });

                it("should not add files to the cache that were partially written to the transaction", () => {
                    return trx.getWriteStream('i', fileData.info.length)
                        .then(stream => stream.end(fileData.info.slice(0, 1)))
                        .then(() => cache.endPutTransaction(trx))
                        .then(() => {}, err => assert(err))
                        .then(() => cache.getFileInfo('i', fileData.guid, fileData.hash))
                        .then(() => { throw new Error("Expected error!"); }, err =>  assert(err));
                });
            });

            describe("getFileStream", function() {

                let fileData;

                beforeEach(() => {
                    fileData = generateCommandData(1024, 1024);
                    let trx;
                    return cache.createPutTransaction(fileData.guid, fileData.hash)
                        .then(result => { trx = result; })
                        .then(() => trx.getWriteStream('i', fileData.info.length))
                        .then(stream => stream.end(fileData.info))
                        .then(() => cache.endPutTransaction(trx))
                        .then(() => sleep(50));
                });

                it("should return a readable stream for a file that exists in the cache", () => {
                    return cache.getFileStream('i', fileData.guid, fileData.hash)
                        .then(stream => assert(stream instanceof require('stream').Readable));
                });

                it("should return an error for a file that does not exist in the cache", () => {
                    return cache.getFileStream('a', fileData.guid, fileData.hash)
                        .then(() => { throw new Error("Expected error!"); }, err =>  assert(err));
                });


                it("should handle files being replaced while read streams to the same file are already open", async () => {
                    const TEST_FILE_SIZE = 1024 * 64 * 2;
                    const FILE_TYPE = 'i';

                    const fData = generateCommandData(TEST_FILE_SIZE, TEST_FILE_SIZE);

                    // Add a file to the cache (use the info data)
                    let trx = await cache.createPutTransaction(fData.guid, fData.hash);
                    let wStream = await trx.getWriteStream('i', fData.info.length);
                    await new Promise(resolve => wStream.end(fData.info, resolve));
                    await cache.endPutTransaction(trx);
                    await sleep(50);

                    // Get a read stream
                    let rStream = await cache.getFileStream(FILE_TYPE, fData.guid, fData.hash);

                    // Read a block
                    let buf = Buffer.allocUnsafe(fData.info.length);
                    let bytes = await new Promise(resolve => rStream.once('readable', () => resolve(rStream.read(1024 * 64))));
                    bytes.copy(buf, 0, 0);

                    // Replace the file (use the resource data)
                    trx = await cache.createPutTransaction(fData.guid, fData.hash);
                    wStream = await trx.getWriteStream(FILE_TYPE, fData.resource.length);
                    await new Promise(resolve => wStream.end(fData.resource, resolve));
                    await cache.endPutTransaction(trx);
                    await sleep(50);

                    // Read the rest of the file - compare it to the info data
                    bytes = await readStream(rStream, fData.info.length - bytes.length);
                    bytes.copy(buf, fData.info.length - bytes.length, 0);
                    assert.equal(buf.compare(fData.info), 0);

                    // Get another new read stream to the same guid
                    rStream = await cache.getFileStream(FILE_TYPE, fData.guid, fData.hash);

                    // Read the file and compare it to the resource data
                    buf = await readStream(rStream, fData.resource.length);
                    assert.equal(buf.compare(fData.resource), 0);
                });
            });
        });
    });
});

describe("PutTransaction API", function() {
    test_modules.forEach(function (module) {
        describe(module.name, function () {
            let cache, fileData, trx;

            before(() => {
                /** @type {CacheBase} **/
                const CacheModule = require(module.path);
                cache = new CacheModule();
                fileData = generateCommandData(1024, 1024);
            });

            after(() => {
                return fs.remove(module.options.cachePath);
            });

            beforeEach(() => {
                return cache.createPutTransaction(fileData.guid, fileData.hash)
                    .then(result => { trx = result; });
            });

            describe("get guid", function() {
                it("should return the file guid for the transaction", () => {
                    assert.strictEqual(trx.guid, fileData.guid);
                });
            });

            describe("get hash", function() {
                it("should return the file hash for the transaction", () => {
                    assert.strictEqual(trx.hash, fileData.hash);
                });
            });

            describe("get manifest", function() {
                it("should return an array of file types that were successfully written to the transaction", () => {
                    return trx.getWriteStream('i', fileData.info.length)
                        .then(stream => stream.end(fileData.info))
                        .then(() => trx.getWriteStream('r', fileData.resource.length))
                        .then(stream => stream.end(fileData.resource))
                        .then(() => trx.getWriteStream('a', fileData.bin.length))
                        .then(stream => stream.end(fileData.bin))
                        .then(() => trx.finalize())
                        .then(() => {
                            const m = trx.manifest;
                            ['i', 'a', 'r'].forEach((t) => assert(m.indexOf(t) >= 0));
                        });
                });
            });

            describe("get files", function() {
                it("should return an empty array before finalize() is called", () => {
                    assert.strictEqual(trx.files.length, 0);
                });

                it("should return a list of objects that represent completed files for the transaction", () => {
                    return trx.getWriteStream('i', fileData.info.length)
                        .then(stream => stream.end(fileData.info))
                        .then(() => trx.finalize())
                        .then(() => assert.equal(trx.files.length, 1));
                });
            });

            describe("finalize", function() {
                it("should return an error if any file was not fully written", () => {
                    return trx.getWriteStream('i', fileData.info.length)
                        .then(stream => stream.end(fileData.info.slice(0, 1)))
                        .then(() => trx.finalize())
                        .then(() => { throw new Error("Expected error!"); }, err =>  assert(err));
                });

                it("should return with no error and no value if the transaction was successfully finalized", () => {
                    return trx.getWriteStream('i', fileData.info.length)
                        .then(stream => stream.end(fileData.info))
                        .then(() => trx.finalize())
                });

                it("should emit a 'finalize' event", (done) => {
                    trx.once('finalize', () => done());
                    trx.finalize();
                });
            });

            describe("getWriteStream", function() {
                it("should return a WritableStream for the given file type", () => {
                    return trx.getWriteStream('i', 1)
                        .then(stream => assert(stream instanceof require('stream').Writable));
                });

                it("should only accept types of 'i', 'a', or 'r", () => {
                    return trx.getWriteStream('i', 1)
                        .then(() => trx.getWriteStream('a', 1))
                        .then(() => trx.getWriteStream('r', 1))
                        .then(() => trx.getWriteStream('x', 1))
                        .then(() => { throw new Error("Expected error!"); }, err => assert(err));
                });

                it("should return an error for size equal to 0", () => {
                    return trx.getWriteStream('i', 0)
                        .then(() => { throw new Error("Expected error!"); }, err => assert(err))
                });

                it("should return an error for size less than 0", () => {
                    return trx.getWriteStream('i', -1)
                        .then(() => { throw new Error("Expected error!"); }, err => assert(err))
                });
            });
        });
    });
});