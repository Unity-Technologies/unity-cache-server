require('./test_init');

const assert = require('assert');
const sinon = require('sinon');
const { CommandProcessor, CacheBase , PutTransaction } = require('../lib');

describe("CommandProcessor", () => {
    describe("PUT Whitelist", () => {
        beforeEach(() => {
            this.cmdProc = new CommandProcessor(new CacheBase());
        });

        it("should implement PUT when whitelisted", async () => {
            this.cmdProc._whitelistEmpty = false;
            this.cmdProc._putWhitelist = ["127.0.0.1"];

            this.cmdProc._trx = new PutTransaction();
            this.cmdProc._trx.clientAddress = "127.0.0.1";
            const spy = sinon.spy(this.cmdProc._trx, "getWriteStream");

            const p = this.cmdProc._onPut("a", 999);
            p.catch(function () {});

            assert(spy.called);
        });

        it("should implement PUT when whitelisted (multiple)", async () => {
            this.cmdProc._whitelistEmpty = false;
            this.cmdProc._putWhitelist = ["127.0.0.6", "127.0.0.3", "127.0.0.1"];

            this.cmdProc._trx = new PutTransaction();
            this.cmdProc._trx.clientAddress = "127.0.0.1";
            const spy = sinon.spy(this.cmdProc._trx, "getWriteStream");

            const p = this.cmdProc._onPut("a", 999);
            p.catch(function () {});

            assert(spy.called);
        });

        it("should implement PUT when whitelist empty", async () => {
            this.cmdProc._whitelistEmpty = true;
            this.cmdProc._putWhitelist = [];

            this.cmdProc._trx = new PutTransaction();
            this.cmdProc._trx.clientAddress = "127.0.0.1";
            const spy = sinon.spy(this.cmdProc._trx, "getWriteStream");

            const p = this.cmdProc._onPut("a", 999);
            p.catch(function () {});

            assert(spy.called);
        });

        it("should allow commands after writing when being whitelisted", async () => {
            this.cmdProc._whitelistEmpty = false;
            this.cmdProc._putWhitelist = ["127.0.0.1"];

            this.cmdProc._trx = new PutTransaction();
            this.cmdProc._trx.clientAddress = "127.0.0.2";

            await this.cmdProc._onPut("a", 6);
            assert.strictEqual(this.cmdProc._writeHandler, this.cmdProc._writeHandlers.putStream);
            this.cmdProc._writeHandler('abcdef');
            assert(this.cmdProc._writeHandlers.command);
        });
    });
});
