const cluster = require('cluster');
const consts = require("./constants");

let logLevel = consts.LOG_TEST;

reverseByte = (b) => ((b & 0x0F) << 4) | ((b >> 4) & 0x0F);

/**
 * Reverses the hex digits for each byte in a GUID before converting to a string, the same way Unity serializes GUIDs to strings.
 * For example Buffer[10ab7cac5ef26c6e7ec6060be64419fc] => "01bac7cae52fc6e6e76c60b06e4491cf"
 * @param {Buffer} guidBuffer
 * @returns {String}
 */
exports.GUIDBufferToString = function(guidBuffer) {
    if(!guidBuffer || guidBuffer.length !== 16) throw new Error("Invalid GUID input");
    return guidBuffer.reduce((result, curVal) => result + reverseByte(curVal).toString(16).padStart(2, '0'), '');
};

/**
 *
 * @param {String} guidString
 * @returns {Buffer}
 * @constructor
 */
exports.GUIDStringToBuffer = function(guidString) {
    if(typeof(guidString) !== 'string' || guidString.length !== 32) throw new Error("Invalid GUID String input");
    let buf = Buffer.from(guidString, 'hex');
    buf.forEach((val, i) => buf[i] = reverseByte(buf[i]));
    return buf;
};

/**
 * @returns {string}
 */
function zeroPad(len, str) {
    for (let i = len - str.length; i > 0; i--) {
        str = '0' + str;
    }

    return str;
}

/**
 * @param {Number} input
 * @return {string}
 */
exports.encodeInt32 = function(input) {
    return zeroPad(consts.UINT32_SIZE, input.toString(16));
};

/**
 * @param {Number} input
 * @return {string}
 */
exports.encodeInt64 = function(input) {
    return zeroPad(consts.UINT64_SIZE, input.toString(16));
};

/**
 *
 * @param {Buffer} input
 * @returns {number}
 */
exports.readUInt32 = function(input) {
    return parseInt(input.toString('ascii', 0, consts.UINT32_SIZE), 16);
};

/**
 * @param {Buffer} input
 * @return {number}
 */
exports.readUInt64 = function(input) {
    return parseInt(input.toString('ascii', 0, consts.UINT64_SIZE), 16);
};

function DefaultLogger(lvl, msg) {
    if (logLevel < lvl)
        return;

    const prefix = cluster.isMaster ? "[Cluster:M] " : `[Cluster:${cluster.worker.id}] `;
    console.log(`${prefix}${msg}`);
}

exports.log = DefaultLogger;

exports.SetLogger = function(logger) {
    exports.log = logger || DefaultLogger;
};

exports.SetLogLevel = function(lvl) {
   logLevel = Math.min(consts.LOG_DBG, Math.max(0, lvl));
};