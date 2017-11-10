const constants = {
    VERSION: "6.0.0",
    PROTOCOL_VERSION: 254,
    PROTOCOL_VERSION_MIN_SIZE: 2,
    UINT32_SIZE: 8,                             // hex
    UINT64_SIZE: 16,                            // hex
    HASH_SIZE: 16,                              // bin
    GUID_SIZE: 16,                              // bin
    CMD_SIZE: 2,                                // bin
    LOG_ERR: 1,
    LOG_WARN: 2,
    LOG_INFO: 3,
    LOG_TEST: 4,
    LOG_DBG: 5,
    DEFAULT_PORT: 8126,
    DEFAULT_WORKERS: Math.ceil(require('os').cpus().length / 2)
};

constants.ID_SIZE = constants.GUID_SIZE + constants.HASH_SIZE;
constants.VERSION_SIZE = constants.UINT32_SIZE;
constants.SIZE_SIZE = constants.UINT64_SIZE;
constants.DEFAULT_LOG_LEVEL = constants.LOG_INFO;

Object.freeze(constants);
module.exports.Constants = constants;
