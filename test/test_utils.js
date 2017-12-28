const assert = require('assert');
const crypto = require('crypto');
const consts = require('../lib/constants');
const helpers = require('../lib/helpers');

const MIN_BLOB_SIZE = 64;
const MAX_BLOB_SIZE = 2048;

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
    helpers.SetLogger(function (lvl, msg) {
        match = match || regex.test(msg);
    });

    client.on('close', function() {
        assert(match === condition);
        callback();
    });
};

exports.sleep = function(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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