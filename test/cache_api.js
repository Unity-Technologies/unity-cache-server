const assert = require('assert');
const helpers = require('../lib/helpers');
const consts = require('../lib/constants');
const tmp = require('tmp');
const loki = require('lokijs');

let test_modules = [
    {
        tmpDir: tmp.dirSync({unsafeCleanup: true}),
        name: "cache_membuf",
        path: "../lib/cache/cache_membuf",
        options: {
            initialPageSize: 10000,
            growPageSize: 10000,
            minFreeBlockSize: 1024,
            persistenceOptions: {
                adapter: new loki.LokiMemoryAdapter()
            }
        }
    },
    {
        tmpDir: tmp.dirSync({unsafeCleanup: true}),
        name: "cache_membuf",
        path: "../lib/cache/cache_fs",
        options: {}
    }
];

describe("Cache API", function() {
    test_modules.forEach(function (module) {
        describe(module.name, function () {
            describe("init", function() {
                it("should create the cache working directory if it doesn't exist");
            });

            describe("getFileInfo", function() {
                it("should report the file size for a file that exists in the cache");
                it("should return an error for a file that does not exist in the cache");
            });

            describe("getFileStream", function() {
                it("should return a readable stream for a file that exists in the cache");
                it("should return an error for a file that does not exist in the cache");
            });

            describe("createPutTransaction", function() {
                it("should return a PutTransaction object for the given file hash & guid");
            });

            describe("endPutTransaction", function() {
                it("should call finalize on the transaction");
                it("should add info, asset, and resource files to the cache that were written to the transaction");
                it("should return an error if any files were partially written to the transaction");
            });
        });
    });
});

describe("PutTransaction API", function() {
    test_modules.forEach(function (module) {
        describe(module.name, function () {
            describe("guid", function() {
                it("should return the file guid for the transaction");
            });

            describe("hash", function() {
                it("should return the file hash for the transaction");
            });

            describe("finalize", function() {
                it("should return an error if any file was not fully written");
                it("should return with no error and no value if the transaction was successfully finalized");
                it("should return a promise if no callback is supplied");
            });

            describe("getWriteStream", function() {
                it("should return a WritableStream for the given file type");
                it("should only accept types of 'i', 'a', or 'r");
                it("should only accept size > 0");
            });
        });
    });
});