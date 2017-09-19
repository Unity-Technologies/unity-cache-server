const UINT32_SIZE = 8;                    // hex encoded
const UINT64_SIZE = 16;                   // hex
const HASH_SIZE = 16;                     // bin
const GUID_SIZE = 16;                     // bin
const ID_SIZE = GUID_SIZE + HASH_SIZE;    // bin
const CMD_SIZE = 2;                       // bin

function zeroPad(len, str) {
    for (var i = len - str.length; i > 0; i--) {
        str = '0' + str;
    }

    return str;
}

module.exports = {
    UINT32_SIZE: UINT32_SIZE,
    UINT64_SIZE: UINT64_SIZE,
    HASH_SIZE: HASH_SIZE,
    GUID_SIZE: GUID_SIZE,
    ID_SIZE: ID_SIZE,
    CMD_SIZE: CMD_SIZE,
    VERSION_SIZE: UINT32_SIZE,
    SIZE_SIZE: UINT64_SIZE
};

module.exports.encodeInt32 = function(input) {
    return zeroPad(UINT32_SIZE, input.toString(16));
};

module.exports.encodeInt64 = function(input) {
    return zeroPad(UINT64_SIZE, input.toString(16));
};

module.exports.bufferToInt32 = function(input) {
    return parseInt(input.toString('ascii', 0, UINT32_SIZE), 16);
};

module.exports.bufferToInt64 = function(input) {
    return parseInt(input.toString('ascii', 0, UINT64_SIZE), 16);
};

module.exports.sleep = function(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
};