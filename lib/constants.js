const constants = {
    VERSION: "5.3",
    PROTOCOL_VERSION: 254,

    UINT32_SIZE: 8,                             // hex
    UINT64_SIZE: 16,                            // hex
    HASH_SIZE: 16,                              // bin
    GUID_SIZE: 16,                              // bin
    CMD_SIZE: 2,                                // bin
    LOG_ERR: 1,
    LOG_WARN: 2,
    LOG_INFO: 3,
    LOG_TEST: 4,
    LOG_DBG: 5
};

constants.ID_SIZE = constants.GUID_SIZE + constants.HASH_SIZE;
constants.VERSION_SIZE = constants.UINT32_SIZE;
constants.SIZE_SIZE = constants.UINT64_SIZE;
constants.LOG_LEVEL = constants.LOG_TEST;           //Required for integration tests which scan for log messages

Object.freeze(constants);
module.exports.Constants = constants;