const { Server, CacheRAM } = require('../lib');
const TransactionMirror = require('../lib/server/transaction_mirror');
const tmp = require('tmp');
const { generateCommandData, sleep } = require('./test_utils');
const assert = require('assert');
const consts = require('../lib/constants');

const cacheOpts = {
    cachePath: tmp.tmpNameSync({}).toString(),
    pageSize: 10 * 1024,
    minFreeBlockSize: 1024,
    persistenceOptions: {
        autosave: false
    }
};

const writeFileDataToCache = async (cache, fileData) => {
    await cache._addFileToCache(consts.FILE_TYPE.INFO, fileData.guid, fileData.hash, fileData.info);
    await cache._addFileToCache(consts.FILE_TYPE.BIN, fileData.guid, fileData.hash, fileData.bin);
    await cache._addFileToCache(consts.FILE_TYPE.RESOURCE, fileData.guid, fileData.hash, fileData.resource);
};

describe("TransactionMirror", () => {

    before(async () => {
        this.sourceCache = new CacheRAM();
        this.targetCache = new CacheRAM();
        await this.sourceCache.init(cacheOpts);
        await this.targetCache.init(cacheOpts);

        this.targetServer = new Server(this.targetCache, {port: 0});
        await this.targetServer.start(err => assert(!err, `Server reported error! ${err}`));
        const opts = { host: 'localhost', port: this.targetServer.port };
        this.mirror = new TransactionMirror(opts, this.sourceCache);
        this.mirror._queueProcessDelay = 1;
    });

    it("should mirror all queued transactions to the target Cache Server", async () => {
        const fileData = [
                generateCommandData(1024, 1024),
                generateCommandData(1024, 1024)
            ];

        for(const d of fileData) {
            await writeFileDataToCache(this.sourceCache, d);
            const trxMock = { guid: d.guid, hash: d.hash, manifest: [consts.FILE_TYPE.INFO, consts.FILE_TYPE.BIN, consts.FILE_TYPE.RESOURCE] };
            this.mirror.queueTransaction(trxMock);
        }

        await sleep(50);

        fileData.forEach(async d => {
            let info = await this.targetCache.getFileInfo(consts.FILE_TYPE.INFO, d.guid, d.hash);
            assert.strictEqual(info.size, d.info.length);

            info = await this.targetCache.getFileInfo(consts.FILE_TYPE.RESOURCE, d.guid, d.hash);
            assert.strictEqual(info.size, d.resource.length);

            info = await this.targetCache.getFileInfo(consts.FILE_TYPE.BIN, d.guid, d.hash);
            assert.strictEqual(info.size, d.bin.length);
        });
    });

    describe("queueTransaction", () => {
        it("should not queue an empty transaction for mirroring", () => {
            this.mirror.queueTransaction({manifest: []});
            assert.strictEqual(this.mirror._queue.length, 0);
        });
    });

    describe("get address", () => {
        it("should return the address of the mirror host", () => {
            assert.strictEqual(this.mirror.address, "localhost");
        });
    });
});