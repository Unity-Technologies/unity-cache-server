const constants = {
    PROTOCOL_VERSION: 254,
    PROTOCOL_VERSION_MIN_SIZE: 2,
    UINT32_SIZE: 8,                             // hex
    UINT64_SIZE: 16,                            // hex
    HASH_SIZE: 16,                              // bin
    GUID_SIZE: 16,                              // bin
    CMD_SIZE: 2,                                // bin
    LOG_NONE: 0,
    LOG_ERR: 1,
    LOG_WARN: 2,
    LOG_INFO: 3,
    LOG_TEST: 4,
    LOG_DBG: 5,
    DEFAULT_PORT: 8126,
    DEFAULT_WORKERS: 0,
    FILE_TYPE: {
        INFO: 'i',
        BIN: 'a',
        RESOURCE: 'r'
    }
};

constants.ID_SIZE = constants.GUID_SIZE + constants.HASH_SIZE;
constants.VERSION_SIZE = constants.UINT32_SIZE;
constants.SIZE_SIZE = constants.UINT64_SIZE;
constants.DEFAULT_LOG_LEVEL = constants.LOG_INFO;
constants.ZERO_HASH = Buffer.alloc(constants.HASH_SIZE, 0);
Object.freeze(constants);
module.exports = constants;
