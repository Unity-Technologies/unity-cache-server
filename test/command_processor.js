const assert = require('assert');
const sinon = require('sinon');
const { CommandProcessor, CacheBase , PutTransaction } = require('../lib');

describe("CommandProcessor", () => {
    describe("PUT Whitelist", () => {
        beforeEach(() => {
            cmdProc = new CommandProcessor(new CacheBase());
        });

        it("should implement PUT when whitelisted", async () => {
            cmdProc._whitelistEmpty = false;
            cmdProc._putWhitelist = ["127.0.0.1"];

            cmdProc._trx = new PutTransaction();
            cmdProc._trx.clientAddress = "127.0.0.1";
            spy = sinon.spy(cmdProc._trx, "getWriteStream");

            p = cmdProc._onPut("a", 999)
            p.catch(function () {});

            assert(spy.called)     
        });

        it("should implement PUT when whitelisted (multiple)", async () => {
            cmdProc._whitelistEmpty = false;
            cmdProc._putWhitelist = ["127.0.0.6", "127.0.0.3", "127.0.0.1"];

            cmdProc._trx = new PutTransaction();
            cmdProc._trx.clientAddress = "127.0.0.1";
            spy = sinon.spy(cmdProc._trx, "getWriteStream");

            p = cmdProc._onPut("a", 999)
            p.catch(function () {});

            assert(spy.called)     
        });

        it("should implement PUT when whitelist empty", async () => {
            cmdProc._whitelistEmpty = true;
            cmdProc._putWhitelist = [];

            cmdProc._trx = new PutTransaction();
            cmdProc._trx.clientAddress = "127.0.0.1";
            spy = sinon.spy(cmdProc._trx, "getWriteStream");

            p = cmdProc._onPut("a", 999)
            p.catch(function () {});

            assert(spy.called)     
        });

        it("should not implement PUT when not whitelisted", async () => {
            cmdProc._whitelistEmpty = false
            cmdProc._putWhitelist = ["127.0.0.1"]

            cmdProc._trx = new PutTransaction();
            cmdProc._trx.clientAddress = "127.0.0.2";

            await cmdProc._onPut("a", 999)
            assert.strictEqual(cmdProc._writeHandler, cmdProc._writeHandlers.none);        
        });

        it("should not implement PUT when not whitelisted (multiple)", async () => {
            cmdProc._whitelistEmpty = false
            cmdProc._putWhitelist = ["127.0.0.6", "127.0.0.3", "127.0.0.1"]

            cmdProc._trx = new PutTransaction();
            cmdProc._trx.clientAddress = "127.0.0.2";

            await cmdProc._onPut("a", 999)
            assert.strictEqual(cmdProc._writeHandler, cmdProc._writeHandlers.none);        
        });
    });
});
