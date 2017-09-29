const cluster = require('cluster');
const consts = require("./constants").Constants;
const crypto = require('crypto');
const os = require('os');

var logLevel = consts.LOG_TEST;

/**
 * @returns {string}
 */
function zeroPad(len, str) {
    for (var i = len - str.length; i > 0; i--) {
        str = '0' + str;
    }

    return str;
}

/**
 * @return {string}
 */
exports.encodeInt32 = function(input) {
    return zeroPad(consts.UINT32_SIZE, input.toString(16));
};

/**
 * @return {string}
 */
exports.encodeInt64 = function(input) {
    return zeroPad(consts.UINT64_SIZE, input.toString(16));
};

/**
 * @return {number}
 */
exports.readUInt32 = function(input) {
    return parseInt(input.toString('ascii', 0, consts.UINT32_SIZE), 16);
};

/**
 * @return {number}
 */
exports.readUInt64 = function(input) {
    return parseInt(input.toString('ascii', 0, consts.UINT64_SIZE), 16);
};

/**
 * @returns {string}
 */
exports.readHex = function(len, data) {
    var res = '';
    var tmp;
    for (var i = 0; i < len; i++) {
        tmp = data[i];
        tmp = ( (tmp & 0x0F) << 4) | ( (tmp >> 4) & 0x0F );
        res += tmp < 0x10 ? '0' + tmp.toString(16) : tmp.toString(16);
    }
    return res;
};

exports.generateTempDir = function() {
    return os.tmpdir() + "/" + crypto.randomBytes(32).toString('hex');
};

function DefaultLogger(lvl, msg) {
    if (logLevel < lvl)
        return;

    var prefix = cluster.isMaster ? "[Cluster:M] " : `[Cluster:${cluster.worker.id}] `;
    console.log(prefix + msg);
}

exports.log = DefaultLogger;

exports.SetLogger = function(logger) {
    exports.log = logger || DefaultLogger;
};

exports.SetLogLevel = function(lvl) {
   logLevel = Math.min(consts.LOG_DBG, Math.max(0, lvl));
};