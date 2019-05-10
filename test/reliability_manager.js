require('./test_init');

const loki = require('lokijs');
const tmp = require('tmp-promise');
const randomBuffer = require('./test_utils').randomBuffer;
const consts = require('../lib/constants');
const helpers = require('../lib/helpers');
const assert = require('assert');
const sinon = require('sinon');
const crypto = require('crypto');
const { ReliabilityManager, PutTransaction } = require('../lib');

class UnstablePutTransaction extends PutTransaction {
    get filesHashStr() {
        return crypto.randomBytes(64).toString('hex');
    }

    writeFilesToPath(path) {}
}

class StablePutTransaction extends PutTransaction {
    get filesHashStr() {
        return "abc123";
    }
}

describe("ReliabilityManager", () => {
    let rm, db;
    before(() => {
        const tmpDir = tmp.tmpNameSync();
        db = new loki('test.db');
        rm = new ReliabilityManager(db, tmpDir, {reliabilityThreshold: 2, saveUnreliableVersionArtifacts: true});
    });

    after(() => {
        db.close();
    });

    describe("processTransaction", () => {
        it("should not process invalid transactions", async () => {
            const guid = randomBuffer(consts.GUID_SIZE);
            const hash = randomBuffer(consts.HASH_SIZE);
            const trx = new PutTransaction(guid, hash);
            await trx.invalidate();
            assert(!trx.isValid);
            await rm.processTransaction(trx);
            const entry = rm.getEntry(helpers.GUIDBufferToString(guid), hash.toString('hex'));
            assert(!entry);
        });

        describe("Unknown version", () => {
            let trx, trxSpy;
            before(async () => {
                const guid = randomBuffer(consts.GUID_SIZE);
                const hash = randomBuffer(consts.HASH_SIZE);
                trx = new PutTransaction(guid, hash);
                trxSpy = sinon.spy(trx, "writeFilesToPath");
                assert(trx.isValid);
                await rm.processTransaction(trx);
            });

            it("should create a new version entry with the correct reliability state", async () => {
                const entry = rm.getEntry(helpers.GUIDBufferToString(trx.guid), trx.hash.toString('hex'));
                assert(entry);
                assert.strictEqual(entry.factor, 1);
                assert.strictEqual(entry.state, ReliabilityManager.reliabilityStates.Pending);
            });

            it("should invalidate the transaction", async () => {
                assert(!trx.isValid);
            });

            it("should not tell the transaction write unreliable files", () => {
                assert(!trxSpy.called);
            });
        });

        describe("Known version, reliabilityFactor meets reliabilityThreshold", () => {
            let trx, trxSpy;
            before(async () => {
                const guid = randomBuffer(consts.GUID_SIZE);
                const hash = randomBuffer(consts.HASH_SIZE);
                await rm.processTransaction(new StablePutTransaction(guid, hash)); // once
                trx = new StablePutTransaction(guid, hash);
                trxSpy = sinon.spy(trx, "writeFilesToPath");
                assert(trx.isValid);
                await rm.processTransaction(trx); // twice (last time)
            });

            it("should increment the reliability factor & set the correct reliability state", () => {
                const entry = rm.getEntry(helpers.GUIDBufferToString(trx.guid), trx.hash.toString('hex'));
                assert(entry);
                assert.strictEqual(entry.factor, 2);
                assert.strictEqual(entry.state, ReliabilityManager.reliabilityStates.ReliableNew);
            });

            it("should not invalidate the transaction", () => {
                assert(trx.isValid);
            });

            it("should not tell the cache to write unreliable files", () => {
                assert(!trxSpy.called);
            });
        });

        describe("Known version, reliabilityFactor exceeds reliabilityThreshold", () => {
            let trx;
            before(async () => {
                const guid = randomBuffer(consts.GUID_SIZE);
                const hash = randomBuffer(consts.HASH_SIZE);
                await rm.processTransaction(new StablePutTransaction(guid, hash)); // once
                await rm.processTransaction(new StablePutTransaction(guid, hash)); // twice
                trx = new StablePutTransaction(guid, hash);
                assert(trx.isValid);
                await rm.processTransaction(trx); // three times (last time)
            });

            it("should not change the reliabilityFactor, regardless of versionHash consistency", () => {
                const entry = rm.getEntry(helpers.GUIDBufferToString(trx.guid), trx.hash.toString('hex'));
                assert(entry);
                assert.strictEqual(entry.factor, 2);
                assert.strictEqual(entry.state, ReliabilityManager.reliabilityStates.Reliable);
            });

            it("should invalidate the transaction to prevent changes to the version", () => {
                assert(!trx.isValid);
            });
        });

        describe("Known version, inconsistent versionHash", () => {
            let trx, spy;
            before(async () => {
                const guid = randomBuffer(consts.GUID_SIZE);
                const hash = randomBuffer(consts.HASH_SIZE);
                await rm.processTransaction(new UnstablePutTransaction(guid, hash)); // once

                trx = await new UnstablePutTransaction(guid, hash);
                spy = sinon.spy(trx, "writeFilesToPath");
                assert(trx.isValid);
                await rm.processTransaction(trx); // twice (last time)
            });

            it("should set the correct reliability state", () => {
                const entry = rm.getEntry(helpers.GUIDBufferToString(trx.guid), trx.hash.toString('hex'));
                assert(entry);
                assert.strictEqual(entry.state, ReliabilityManager.reliabilityStates.Unreliable);
            });

            it("should invalidate the transaction", () => {
                assert(!trx.isValid);
            });

            it("should tell the transaction to write unreliable files if saveUnreliableVersionArtifacts is true", async () => {
                assert(spy.called);

                // Test with saveUnreliableVersionArtifacts = false
                const myRm = new ReliabilityManager(db, tmp.tmpNameSync(), {reliabilityThreshold: 2, saveUnreliableVersionArtifacts: false});
                spy.resetHistory();
                await myRm.processTransaction(trx);
                assert(!spy.called);
            });
        });

        describe("multiClient", () => {
            it("should not increment the reliability factor twice in a row for the same client", async () => {
                const myRm = new ReliabilityManager(db, tmp.tmpNameSync(), { reliabilityThreshold: 2, multiClient: true });
                const guid = randomBuffer(consts.GUID_SIZE);
                const hash = randomBuffer(consts.HASH_SIZE);

                let trx = new StablePutTransaction(guid, hash);
                trx.clientAddress = "A:1234";
                await myRm.processTransaction(trx);

                const entry = rm.getEntry(helpers.GUIDBufferToString(trx.guid), trx.hash.toString('hex'));
                assert.strictEqual(entry.state, ReliabilityManager.reliabilityStates.Pending);

                trx = new StablePutTransaction(guid, hash);
                trx.clientAddress = "A:1234";
                await myRm.processTransaction(trx);
                assert.strictEqual(entry.state, ReliabilityManager.reliabilityStates.Pending);

                trx = new StablePutTransaction(guid, hash);
                trx.clientAddress = "B:1234";
                await myRm.processTransaction(trx);
                assert.strictEqual(entry.state, ReliabilityManager.reliabilityStates.ReliableNew);
            });

            it("should increment the reliability factor for the same IP on different ports", async () => {
                const myRm = new ReliabilityManager(db, tmp.tmpNameSync(), { reliabilityThreshold: 2, multiClient: true });
                const guid = randomBuffer(consts.GUID_SIZE);
                const hash = randomBuffer(consts.HASH_SIZE);

                let trx = new StablePutTransaction(guid, hash);
                trx.clientAddress = "A:1234";
                await myRm.processTransaction(trx);

                const entry = rm.getEntry(helpers.GUIDBufferToString(trx.guid), trx.hash.toString('hex'));
                assert.strictEqual(entry.state, ReliabilityManager.reliabilityStates.Pending);

                trx = new StablePutTransaction(guid, hash);
                trx.clientAddress = "A:4321";
                await myRm.processTransaction(trx);
                assert.strictEqual(entry.state, ReliabilityManager.reliabilityStates.ReliableNew);
            });
        });
    });

    describe("getEntry", () => {
        it("should retrieve an entry for a given asset GUID & Hash", async () => {
            const guidStr = randomBuffer(consts.GUID_SIZE);
            const hashStr = randomBuffer(consts.HASH_SIZE);
            await rm.processTransaction(new StablePutTransaction(guidStr, hashStr));
            const entry = rm.getEntry(helpers.GUIDBufferToString(guidStr), hashStr.toString('hex'));
            assert(entry);
            assert(entry.versionHash.length > 0);
            assert(entry.factor > 0);
        });

        it("should not create a new entry for an unknown GUID & Hash when create == false", () => {
            const guidStr = helpers.GUIDBufferToString(randomBuffer(consts.GUID_SIZE));
            const hashStr = randomBuffer(consts.HASH_SIZE).toString('hex');
            const entry = rm.getEntry(guidStr, hashStr, false);
            assert(!entry);
        });

        it("should create a new entry with a factor of 0 for an unknown GUID & Hash when create == true", () => {
            const guidStr = helpers.GUIDBufferToString(randomBuffer(consts.GUID_SIZE));
            const hashStr = randomBuffer(consts.HASH_SIZE).toString('hex');
            const entry = rm.getEntry(guidStr, hashStr, true);
            assert(entry);
            assert.strictEqual(entry.factor, 0);
            assert(!entry.versionHash);
        });
    });


    describe("removeEntry", () => {
        it("should remove the entry for a given GUID & Hash", () => {
            const guidStr = helpers.GUIDBufferToString(randomBuffer(consts.GUID_SIZE));
            const hashStr = randomBuffer(consts.HASH_SIZE).toString('hex');
            let entry = rm.getEntry(guidStr, hashStr, true);
            assert(entry);
            rm.removeEntry(guidStr, hashStr);
            entry = rm.getEntry(guidStr, hashStr);
            assert(!entry);
        });
    });
});