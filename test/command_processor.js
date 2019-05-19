require('./test_init');

const assert = require('assert');
const sinon = require('sinon');
const randomBuffer = require('./test_utils').randomBuffer;
const consts = require('../lib/constants');
const { CommandProcessor, CacheBase } = require('../lib');

describe("CommandProcessor", () => {
    describe("PUT Whitelist", () => {

        beforeEach(() => {
            this.cmdProc = new CommandProcessor(new CacheBase());
        });

        afterEach(() => {
            sinon.restore();
        });

        it("should implement PUT when whitelisted", async () => {
            this.cmdProc._whitelistEmpty = false;
            this.cmdProc._putWhitelist = ["127.0.0.1"];

            sinon.stub(this.cmdProc, "clientAddress").get(() => "127.0.0.1:1234");
            await this.cmdProc._onTransactionStart(randomBuffer(consts.GUID_SIZE), randomBuffer(consts.HASH_SIZE));

            const spy = sinon.spy(this.cmdProc._trx, "getWriteStream");

            const p = this.cmdProc._onPut("a", 999);
            p.catch(() => assert.fail());

            assert(spy.called);
        });

        it("should implement PUT when whitelisted (multiple)", async () => {
            this.cmdProc._whitelistEmpty = false;
            this.cmdProc._putWhitelist = ["127.0.0.6", "127.0.0.3", "127.0.0.1"];

            sinon.stub(this.cmdProc, "clientAddress").get(() => "127.0.0.1:1234");
            await this.cmdProc._onTransactionStart(randomBuffer(consts.GUID_SIZE), randomBuffer(consts.HASH_SIZE));

            const spy = sinon.spy(this.cmdProc._trx, "getWriteStream");

            const p = this.cmdProc._onPut("a", 999);
            p.catch(() => assert.fail());

            assert(spy.called);
        });

        it("should implement PUT when whitelist empty", async () => {
            this.cmdProc._whitelistEmpty = true;
            this.cmdProc._putWhitelist = [];

            sinon.stub(this.cmdProc, "clientAddress").get(() => "127.0.0.1:1234");
            await this.cmdProc._onTransactionStart(randomBuffer(consts.GUID_SIZE), randomBuffer(consts.HASH_SIZE));

            const spy = sinon.spy(this.cmdProc._trx, "getWriteStream");

            const p = this.cmdProc._onPut("a", 999);
            p.catch(() => assert.fail());

            assert(spy.called);
        });

        it("should not ask the cache for a writeStream when not whitelisted", async () => {
            this.cmdProc._whitelistEmpty = false;
            this.cmdProc._putWhitelist = ["127.0.0.1"];

            sinon.stub(this.cmdProc, "clientAddress").get(() => "127.0.0.2:1234");
            await this.cmdProc._onTransactionStart(randomBuffer(consts.GUID_SIZE), randomBuffer(consts.HASH_SIZE));

            const spy = sinon.spy(this.cmdProc._trx, "getWriteStream");

            const p = this.cmdProc._onPut("a", 999);
            p.catch(() => assert.fail());

            assert(spy.notCalled);
        });

        it("should allow commands after writing when not whitelisted", async () => {
            this.cmdProc._whitelistEmpty = false;
            this.cmdProc._putWhitelist = ["127.0.0.1"];

            sinon.stub(this.cmdProc, "clientAddress").get(() => "127.0.0.2:1234");
            await this.cmdProc._onTransactionStart(randomBuffer(consts.GUID_SIZE), randomBuffer(consts.HASH_SIZE));

            await this.cmdProc._onPut("a", 6);
            assert.strictEqual(this.cmdProc._writeHandler, this.cmdProc._writeHandlers.putStream);
            this.cmdProc._writeHandler('abcdef');
            assert(this.cmdProc._writeHandlers.command);
        });

        it("should NOT invalidate a transaction when whitelisted", async () => {
            this.cmdProc._whitelistEmpty = false;
            this.cmdProc._putWhitelist = ["127.0.0.1"];

            sinon.stub(this.cmdProc, "clientAddress").get(() => "127.0.0.1:1234");
            await this.cmdProc._onTransactionStart(randomBuffer(consts.GUID_SIZE), randomBuffer(consts.HASH_SIZE));

            assert.ok(this.cmdProc._trx.isValid, "Expected transaction to be valid");
        });

        it("should invalidate a transaction when not whitelisted", async () => {
            this.cmdProc._whitelistEmpty = false;
            this.cmdProc._putWhitelist = ["127.0.0.1"];

            sinon.stub(this.cmdProc, "clientAddress").get(() => "127.0.0.2:1234");
            await this.cmdProc._onTransactionStart(randomBuffer(consts.GUID_SIZE), randomBuffer(consts.HASH_SIZE));

            assert.ok(!this.cmdProc._trx.isValid, "Expected transaction to be invalid");
        });
    });
});
