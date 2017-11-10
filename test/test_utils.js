const assert = require('assert');
const crypto = require('crypto');
const consts = require('../lib/constants').Constants;
const helpers = require('../lib/helpers');

const MIN_BLOB_SIZE = 64;
const MAX_BLOB_SIZE = 2048;

exports.generateCommandData = function(minSize, maxSize) {
    minSize = minSize || MIN_BLOB_SIZE;
    maxSize = maxSize || MAX_BLOB_SIZE;

    function getSize() { return Math.max(minSize, Math.floor(Math.random() * maxSize)); }

    return {
        guid: Buffer.from(crypto.randomBytes(consts.GUID_SIZE).toString('ascii'), 'ascii'),
        hash: Buffer.from(crypto.randomBytes(consts.HASH_SIZE).toString('ascii'), 'ascii'),
        bin: Buffer.from(crypto.randomBytes(getSize()).toString('ascii'), 'ascii'),
        info: Buffer.from(crypto.randomBytes(getSize()).toString('ascii'), 'ascii'),
        resource: Buffer.from(crypto.randomBytes(getSize()).toString('ascii'), 'ascii')
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