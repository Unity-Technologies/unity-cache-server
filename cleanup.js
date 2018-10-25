#!/usr/bin/env node
const helpers = require('./lib/helpers');
helpers.initConfigDir(__dirname);

const consts = require('./lib/constants');
const cmd = require('commander');
const moment = require('moment');
const { version } = require('./package.json');
const { UnityCacheServer } = require('./lib/unity_cache_server');

function parseTimeSpan(val) {
    if(!moment.duration(val).isValid())
    {
        helpers.log(consts.LOG_ERR, "Invalid timespan format");
        process.exit(1);
    }

    return val;
}

const optionMap = {
    cacheModule: {
        flags: "-c --cache-module <path>",
        description: "Use cache module at specified path",
        configKey: consts.CLI_CONFIG_KEYS.CACHE_MODULE
    },
    cachePath: {
        flags: "-P, --cache-path <path>",
        description: "Specify the path of the cache directory",
        configKey: consts.CLI_CONFIG_KEYS.CACHE_PATH
    },
    expireTimeSpan: {
        flags: "-e, --expire-time-span <timeSpan>",
        description: "Override the configured maximum cache size. Files will be removed from the cache until the max cache size is satisfied, using a Least Recently Used search. A value of 0 disables this check.",
        validator: parseTimeSpan
    },
    maxCacheSize: {
        flags: "-s, --max-cache-size <bytes>",
        description: "Override the configured maximum cache size. Files will be removed from the cache until the max cache size is satisfied, using a Least Recently Used search. A value of 0 disables this check.",
        validator: parseInt
    },
    delete: {
        flags: "-d, --delete",
        description: "Delete cached files that match the configured criteria. Without this, the default behavior is to dry-run which will print diagnostic information only.",
        defaultValue: false
    },
    daemon: {
        flags: "-D, --daemon <interval>",
        description: "Daemon mode: execute the cleanup script at the given interval in seconds as a foreground process.",
        validator: parseInt
    }
};

cmd.description("Unity Cache Server - Cache Cleanup\n\n  Removes old files from supported cache modules.").version(version).allowUnknownOption(true);
UnityCacheServer.handleCommandLine(cmd, optionMap);

const cacheOpts = {};
if(cmd.hasOwnProperty('expireTimeSpan')) {
    cacheOpts.cleanupOptions.expireTimeSpan = cmd.expireTimeSpan;
}

if(cmd.hasOwnProperty('maxCacheSize')) {
    cacheOpts.cleanupOptions.maxCacheSize = cmd.maxCacheSize;
}

const dryRun = !cmd.delete;
const daemon = cmd.hasOwnProperty('daemon') ? cmd.daemon : 0;

UnityCacheServer.initCache(cacheOpts)
    .then(() => UnityCacheServer.cleanup(dryRun, daemon))
    .catch(() => process.exit(1));
