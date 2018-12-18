#!/usr/bin/env node
require('./lib/helpers').initConfigDir(__dirname);
const cmd = require('commander');
const consts = require('./lib/constants');
const { version, description } = require('./package.json');
const { UnityCacheServer } = require('./lib/unity_cache_server');

function zeroOrMore(val) {
    return Math.max(0, val);
}

function collect(val, memo) {
    memo = memo || [];
    memo.push(val);
    return memo;
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
    port: {
        flags: "-p, --port <n>",
        description: "Specify the server port",
        validator: parseInt,
        configKey: consts.CLI_CONFIG_KEYS.PORT
    },
    workers: {
        flags: "-w, --workers <n>",
        description: "Number of worker threads to spawn",
        validator: zeroOrMore,
        configKey: consts.CLI_CONFIG_KEYS.WORKERS
    },
    mirror: {
        flags: "-m --mirror <host:port>",
        description: "Mirror transactions to another cache server. Can be repeated for multiple mirrors",
        validator: collect,
        configKey: consts.CLI_CONFIG_KEYS.MIRROR
    },
    putwhitelist: {
        flags: "-W --putwhitelist <host:port>",
        description: "Only allow PUT transactions (uploads) from the specified client address. Can be repeated for multiple clients",
        validator: collect,
        configKey: consts.CLI_CONFIG_KEYS.PUTWHITELIST
    }
};

// Initialize CLI handler
cmd.description(description).version(version).allowUnknownOption(true);
UnityCacheServer.handleCommandLine(cmd, optionMap);
UnityCacheServer.start().then(() => {}, () => process.exit(1));