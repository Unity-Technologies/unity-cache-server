const assert = require('assert');
const helpers = require('../lib/helpers');
const consts = require('../lib/constants');
const sinon = require('sinon');
const tmp = require('tmp-promise');
const fs = require('fs-extra');
const path = require('path');

describe("Helper functions", () => {
    const guid = Buffer.from([80,127,95,145,103,153,135,123,185,19,13,54,122,207,246,26]);
    const guidStr = "05f7f519769978b79b31d063a7fc6fa1";

    describe("GUIDBufferToString", () => {
        it("should convert a 16 byte buffer to a hex representation that matches Unity's string formatter for GUIDs", () => {
            assert.strictEqual(helpers.GUIDBufferToString(guid), guidStr);
        });

        it("should throw an error if the input is not a buffer or the wrong length", () => {
            assert.throws(helpers.GUIDBufferToString.bind(null, null), Error);
            assert.throws(helpers.GUIDBufferToString.bind(null, Buffer.from([])), Error);
            assert.throws(helpers.GUIDBufferToString.bind(null, Buffer.alloc(17, 0)), Error);
        });
    });

    describe("GUIDStringToBuffer", () => {
        it("should convert a 32 character hex string that represents a Unity GUID to an equivalent byte buffer", () => {
            assert.strictEqual(guid.compare(helpers.GUIDStringToBuffer(guidStr)), 0);

        });

        it("should throw an error if the input value is not a string or is the wrong length", () => {
            assert.throws(helpers.GUIDStringToBuffer.bind(null, null));
            assert.throws(helpers.GUIDStringToBuffer.bind(null, ''));
            assert.throws(helpers.GUIDStringToBuffer.bind(null, guidStr + 'x'));
        });
    });

    describe("isBuffer", () => {
        it("should correctly identify whether or not passed value is a type of Buffer", () => {
            assert(helpers.isBuffer(Buffer.from([])));
            assert(!helpers.isBuffer({}));
            assert(!helpers.isBuffer(null));
        })
    });

    describe("parseAndValidateAddressString", () => {
        it("should resolve a valid address to an IP and return an object with host and port properties", async () => {
            const result = await helpers.parseAndValidateAddressString("localhost", 0);
            assert.equal(result.host, "127.0.0.1");
            assert.strictEqual(result.port, 0);
        });

        it("should return the same IP address passed in if already in ip v4 format", async () => {
            const result = await helpers.parseAndValidateAddressString("1.2.3.4", 1234);
            assert.equal(result.host, "1.2.3.4");
            assert.strictEqual(result.port, 1234);
        });

        it("should throw an error if address in ip v6 format", async () => {
            await helpers.parseAndValidateAddressString("2001::4860::4860::8888", 0)
                .then(() => { throw new Error("Expected error"); }).catch(err => assert(err));

            await helpers.parseAndValidateAddressString("2001:db8:0:0:0:0:2:1", 0)
                .then(() => { throw new Error("Expected error"); }).catch(err => assert(err));
        });

        it("should parse an address:port string", async () => {
            const result = await helpers.parseAndValidateAddressString("localhost:1234", 0);
            assert.equal(result.host, "127.0.0.1");
            assert.strictEqual(result.port, 1234);
        });

        it("should throw an error if the address can't be resolved", () => {
            return helpers.parseAndValidateAddressString("blah", 0)
                .then(() => { throw new Error("Expected error"); }, err => assert(err));
        });
    });

    describe("readDir", () => {
        it("should walk a directory recursively and call the provided callback with file information", async () => {
            const rootDir = await tmp.dir({unsafeCleanup: true});
            await tmp.file({dir: rootDir.path});
            const subDir = await tmp.dir({dir: rootDir.path});
            await tmp.file({dir: subDir.path});
            const expectation = sinon.mock();
            expectation.twice();
            await helpers.readDir(rootDir.path, expectation);
            expectation.verify();
            rootDir.cleanup();

        });

        it("should do nothing and return if no callback is provided", async () => {
            const rootDir = await tmp.dir({unsafeCleanup: true});
            await helpers.readDir(rootDir.path);
            rootDir.cleanup();
        });

        it("should not walk into symlink folders", async () => {
            const rootDir = await tmp.dir({unsafeCleanup: true});
            await tmp.file({dir: rootDir.path});
            const subDir = await tmp.dir({dir: rootDir.path});
            await tmp.file({dir: subDir.path});
            await fs.symlink(subDir.path, path.join(rootDir.path, 'foo'), 'dir');
            const expectation = sinon.mock();
            expectation.twice();
            await helpers.readDir(rootDir.path, expectation);
            expectation.verify();
            rootDir.cleanup();
        });
    });

    describe("Logging functions", () => {
        before(() => {
            this.oldLevel = helpers.getLogLevel();

        });

        after(() => {
            helpers.setLogLevel(this.oldLevel);
        });

        describe("defaultLogger", () => {
            it("should log a console message if the desired log level is >= the minimum level", () => {
                const spy = sinon.spy(console, 'log');
                const str = "Hello World";
                helpers.setLogLevel(consts.LOG_INFO);

                helpers.defaultLogger(consts.LOG_WARN, str);
                assert(spy.calledOnce);
                spy.resetHistory();

                helpers.defaultLogger(consts.LOG_INFO, str);
                assert(spy.calledOnce);
                spy.resetHistory();

                helpers.defaultLogger(consts.LOG_DBG, str);
                assert(spy.notCalled);
                spy.restore();
            });
        });

        describe("defaultClusterLogger", () => {
            it("should log a console message if the desired log level is >= the minimum level", () => {
                const spy = sinon.spy(console, 'log');
                const str = "Hello World";
                helpers.setLogLevel(consts.LOG_INFO);

                helpers.defaultClusterLogger(consts.LOG_WARN, str);
                assert(spy.calledOnce);
                spy.resetHistory();

                helpers.defaultClusterLogger(consts.LOG_INFO, str);
                assert(spy.calledOnce);
                spy.resetHistory();

                helpers.defaultClusterLogger(consts.LOG_DBG, str);
                assert(spy.notCalled);
                spy.restore();
            });
        });

        describe("setLogger", () => {
            it("should do nothing if the passeed in logger is null", () => {
                const prev = helpers.log;
                helpers.setLogger(null);
                assert.strictEqual(prev, helpers.log);
            });

            it("should change the logging function to the passed in function", () => {
                const myLogger = (lvl, msg) => {};
                helpers.setLogger(myLogger);
                assert.strictEqual(myLogger, helpers.log);
            });
        });

        describe("setLogLevel", () => {
            it("should change the logging level to the specified level", () => {
                helpers.setLogLevel(consts.LOG_INFO);
                assert.equal(helpers.getLogLevel(), consts.LOG_INFO);
                helpers.setLogLevel(consts.LOG_DBG);
                assert.equal(helpers.getLogLevel(), consts.LOG_DBG);
            });

            it("should not allow a value out of range", () => {
                helpers.setLogLevel(consts.LOG_DBG);
                assert.equal(helpers.getLogLevel(), consts.LOG_DBG);
                helpers.setLogLevel(consts.LOG_DBG + 1);
                assert.equal(helpers.getLogLevel(), consts.LOG_DBG);

                helpers.setLogLevel(consts.LOG_NONE);
                assert.equal(helpers.getLogLevel(), consts.LOG_NONE);
                helpers.setLogLevel(consts.LOG_NONE - 1);
                assert.equal(helpers.getLogLevel(), consts.LOG_NONE);
            });
        });
    });

    describe("insertSorted", () => {
        it("should insert an element into the correct position in an array", async () => {
            let arr = [1, 2, 4, 5];
            arr = helpers.insertSorted(3, arr, (a, b) => {
                if (a === b) return 0;
                return a < b ? -1 : 1
            });

            assert.equal(arr[2], 3);

        });
        it("should insert an element into the correct position in an empty array", async () => {
            let arr = [];
            arr = helpers.insertSorted(3, arr, (a, b) => {
                if (a === b) return 0;
                return a < b ? -1 : 1
            });

            assert.equal(arr[0], 3);

        });
    });
});