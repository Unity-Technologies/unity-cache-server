const assert = require('assert');
const crypto = require('crypto');
const consts = require('../lib/constants');
const helpers = require('../lib/helpers');
const net = require('net');
const path =  require('path');

const MIN_BLOB_SIZE = 64;
const MAX_BLOB_SIZE = 2048;
const MIN_PACKET_SIZE = 1024 * 16;
const WRITE_RESOLVE_DELAY = 100;

function randomBuffer(size) {
    return Buffer.from(crypto.randomBytes(size).toString('ascii'), 'ascii')
}

exports.randomBuffer = randomBuffer;


exports.generateCommandData = function(minSize, maxSize) {
    minSize = minSize || MIN_BLOB_SIZE;
    maxSize = maxSize || MAX_BLOB_SIZE;

    function getSize() { return minSize + Math.floor(Math.random() * (maxSize - minSize)); }

    return {
        guid: randomBuffer(consts.GUID_SIZE),
        hash: randomBuffer(consts.HASH_SIZE),
        bin: randomBuffer(getSize()),
        info: randomBuffer(getSize()),
        resource: randomBuffer(getSize())
    }
};

exports.encodeCommand = function(command, guid, hash, blob) {

    if(blob)
        command += helpers.encodeInt64(blob.length);

    if(guid)
        command += guid;

    if(hash)
        command += hash;

    if(blob)
        command += blob;

    return command;
};

exports.expectLog = function(client, regex, condition, callback) {
    if(typeof(callback) !== 'function' && typeof(condition) === 'function') {
        callback = condition;
        condition = true;
    }

    let match;
    helpers.setLogger(function (lvl, msg) {
        match = match || regex.test(msg);
    });

    client.on('close', function() {
        assert.strictEqual(match, condition);
        callback();
    });

    client.on('data', () => {});
};

exports.sleep = function(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
};

exports.clientWrite = function(client, data, minPacketSize, maxPacketSize) {
    return new Promise((resolve, reject) => {
        let sentBytes = 0;
        let closed = false;
        const closeListener = () => closed = true;
        client.once('close', closeListener);

        if(typeof(minPacketSize) !== 'number') {
            minPacketSize = MIN_PACKET_SIZE;
        }

        if(typeof(maxPacketSize) !== 'number' || maxPacketSize < minPacketSize) {
            maxPacketSize = minPacketSize;
        }

        function packetSize() {
            return Math.ceil(minPacketSize + (Math.random() * maxPacketSize - minPacketSize));
        }

        function write() {
            if(closed && sentBytes < data.length) {
                return reject(new Error("Client closed before write finished"));
            }

            const len = Math.min(data.length - sentBytes, packetSize());
            client.write(data.slice(sentBytes, sentBytes + len), () => {
                sentBytes += len;

                if (sentBytes === data.length) {
                    client.removeListener('close', closeListener);
                    setTimeout(resolve, WRITE_RESOLVE_DELAY);
                }
                else {
                    setImmediate(write);
                }
            });
        }

        write();
    });
};

/**
 *
 * @param stream
 * @param size
 * @returns {Promise<Buffer>}
 */
exports.readStream = function(stream, size) {
    return new Promise((resolve, reject) => {
        let pos = 0;
        const buffer = Buffer.alloc(size, 0, 'ascii');
        stream.on('readable', function() {
            let data;
            while((data = this.read()) !== null) {
                if(pos + data.length > size) {
                    reject(new Error("Stream size exceeds buffer size allocation"));
                }

                data.copy(buffer, pos);
                pos += data.length;
            }
        });

        stream.on('end', () => {
            resolve(buffer);
        });
    });
};

exports.getClientPromise = function(port) {
    return new Promise((resolve, reject) => {
        const client = net.createConnection(port);
        client.once('connect', () => {
            resolve(client);
        });

        client.once('error', err => {
            reject(err);
        });
    });
};

exports.purgeConfig = function() {
    function directory() {
        if (process.env.NODE_CONFIG_DIR) {
            return process.env.NODE_CONFIG_DIR;
        }

        return path.join(process.cwd(), 'config');
    }

    for (const fileName in require.cache) {
        if (!fileName.includes(directory())) {
            continue;
        }

        delete require.cache[fileName];
    }

    delete require.cache[require.resolve('config')];
};

exports.cmd = {
    quit: "q",
    getAsset: "ga",
    getInfo: "gi",
    getResource: "gr",
    putAsset: "pa",
    putInfo: "pi",
    putResource: "pr",
    transactionStart: "ts",
    transactionEnd: "te",
    integrityVerify: "icv",
    integrityFix: "icf"
};