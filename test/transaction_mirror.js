const { Server, CacheRAM } = require('../lib');
const TransactionMirror = require('../lib/server/transaction_mirror');
const tmp = require('tmp');
const { generateCommandData, sleep } = require('./test_utils');
const assert = require('assert');

let cacheOpts = {
    cachePath: tmp.tmpNameSync({}).toString(),
    initialPageSize: 10 * 1024,
    growPageSize: 10 * 1024,
    minFreeBlockSize: 1024,
    persistenceOptions: {
        autosave: false
    }
};

describe("TransactionMirror", () => {

    before(async () => {
        this.fileData = generateCommandData(1024, 1024);

        this.sourceCache = new CacheRAM();
        this.targetCache = new CacheRAM();
        await this.sourceCache.init(cacheOpts);
        await this.targetCache.init(cacheOpts);

        this.targetServer = new Server(this.targetCache, {port: 0});

        let self = this;
        return new Promise((resolve, reject) => {
            self.targetServer.Start(err => reject(err), () => {
                let opts = { host: 'localhost', port: self.targetServer.port };
                self.mirror = new TransactionMirror(opts, self.sourceCache);
                self.mirror._queueProcessDelay = 0;
                resolve();
            });
        });
    });

    it("should mirror all queued transactions to the target Cache Server", async () => {
        this.sourceCache._addFileToCache('i', this.fileData.guid, this.fileData.hash, this.fileData.info);
        this.sourceCache._addFileToCache('a', this.fileData.guid, this.fileData.hash, this.fileData.bin);
        this.sourceCache._addFileToCache('r', this.fileData.guid, this.fileData.hash, this.fileData.resource);

        const trxMock = {
            guid: this.fileData.guid,
            hash: this.fileData.hash,
            manifest: ['i', 'a', 'r']
        };

        this.mirror.queueTransaction(trxMock);
        await sleep(50);

        let info = await this.targetCache.getFileInfo('i', this.fileData.guid, this.fileData.hash);
        assert(info && info.size === this.fileData.info.length);

        info = await this.targetCache.getFileInfo('r', this.fileData.guid, this.fileData.hash);
        assert(info && info.size === this.fileData.resource.length);

        info = await this.targetCache.getFileInfo('a', this.fileData.guid, this.fileData.hash);
        assert(info && info.size === this.fileData.bin.length);
    });

    describe("queueTransaction", () => {
        it("should not queue an empty transaction for mirroring", () => {
            this.mirror.queueTransaction({manifest: []});
            assert(this.mirror._queue.length === 0);
        });
    });

    describe("get address", () => {
        it("should return the address of the mirror host", () => {
            assert(this.mirror.address === "localhost");
        });
    });
});