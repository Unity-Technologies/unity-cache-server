require('./test_init');

const assert = require('assert');
const net = require('net');
const Client = require('../lib/client/client');
const WritableStream = require('stream').Writable;
const consts = require('../lib/constants');
const generateCommandData = require('./test_utils').generateCommandData;

describe("Client", () => {
    this.getClient = () => {
        return new Client("127.0.0.1", 9999);
    };

    this.getConnectedClient = async (onConnect) => {
        return new Promise((resolve) => {
            const s = net.createServer(socket => onConnect(socket));
            s.listen(0, "0.0.0.0", () => {
                const a = s.address();
                resolve({server: s, client: new Client(a.address, a.port)});
            });
        });
    };

    describe("close", () => {
        it("should resolve without error if called before connect()", async () => {
            await this.getClient().quit();
        });
    });

    describe("connect", () => {
        it("should return the client object if called one or more times", async () => {
            const data = await this.getConnectedClient(() => {});
            assert.strictEqual(await data.client.connect(), data.client);
            assert.strictEqual(await data.client.connect(), data.client);
            data.server.close();
        });
    });

    describe("putFile", () => {
        it("should throw an error if an unrecognized type is specified", async () => {
            const b = Buffer.alloc(16);
            await this.getClient().putFile('x', b, b, b, 16)
                .then(() => { throw new Error("Expected error"); }, err => assert(err));
        });

        it("should throw an error if an invalid guid is specified", async () => {
            const b = Buffer.alloc(16);

            // wrong size buffer
            await this.getClient().putFile('a', Buffer.alloc(12), b, b, 16)
                .then(() => { throw new Error("Expected error"); }, err => assert(err));

            // wrong type
            await this.getClient().putFile('a', "not a buffer", b, b, 16)
                .then(() => { throw new Error("Expected error"); }, err => assert(err));
        });

        it("should throw an error if an invalid hash is specified", async () => {
            const b = Buffer.alloc(16);

            // wrong size buffer
            await this.getClient().putFile(Client.fileTypes.BIN, b, Buffer.alloc(12), b, 16)
                .then(() => { throw new Error("Expected error"); }, err => assert(err));

            // wrong type
            await this.getClient().putFile(Client.fileTypes.BIN, b, "not a buffer", b, 16)
                .then(() => { throw new Error("Expected error"); }, err => assert(err));
        });

        it("should throw an error if client is not connected", async () => {
            const b = Buffer.alloc(16);
            await this.getClient().putFile(Client.fileTypes.BIN, b, b, b, 16)
                .then(() => { throw new Error("Expected error"); }, err => assert(err));
        });

        it("should send the given buffer to the server", (done) => {
            const data = generateCommandData(256, 256);
            let client, server;

            this.getConnectedClient(socket => {
                socket.pipe(new WritableStream({
                    write(chunk, encoding, callback) {
                        const len = consts.VERSION_SIZE + consts.CMD_SIZE + consts.SIZE_SIZE;
                        const slice = chunk.slice(len, len + data.bin.length);
                        assert.strictEqual(data.bin.compare(slice), 0);
                        callback();
                    },
                    final(cb) {
                        cb();
                        done();
                    }
                }));
            })
                .then(data => { client = data.client; server = data.server; return client.connect(); })
                .then(() => client.putFile(Client.fileTypes.BIN, data.guid, data.hash, data.bin, data.bin.length))
                .then(() => client.quit())
                .then(() => server.close());
        });
    });
});