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
    LOG_DBG: 4,
    DEFAULT_PORT: 8126,
    DEFAULT_HOST: "0.0.0.0",
    DEFAULT_WORKERS: 0,
    DEFAULT_CACHE_MODULE: 'cache_fs',
    DEFAULT_CACHE_PATH: '.unity_cache',
    FILE_TYPE: {
        INFO: 'i',
        BIN: 'a',
        RESOURCE: 'r'
    },
    CLI_CONFIG_KEYS: {
        CACHE_MODULE: "Cache.defaultModule",
        CACHE_PATH: "Cache.cachePath",
        WORKERS: "Cache.options.workers",
        LOG_LEVEL: "Global.logLevel",
        HOST: "Server.host",
        PORT: "Server.port",
        MIRROR: "Mirror.addresses",
        ALLOW_IP_V6: "Server.options.allowIpv6",
        COMMAND_PROCESSOR: "Cache.options.processor",
        PUTWHITELIST: "Cache.options.processor.putWhitelist",
        CLIENT_RECORDER: "Diagnostics.clientRecorder"
    }
};

constants.ID_SIZE = constants.GUID_SIZE + constants.HASH_SIZE;
constants.VERSION_SIZE = constants.UINT32_SIZE;
constants.SIZE_SIZE = constants.UINT64_SIZE;
constants.DEFAULT_LOG_LEVEL = constants.LOG_INFO;
constants.ZERO_HASH = Buffer.alloc(constants.HASH_SIZE, 0);
Object.freeze(constants);
module.exports = constants;
