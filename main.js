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
        description: "The path to cache module. The Default path is 'cache_fs'.",
        configKey: consts.CLI_CONFIG_KEYS.CACHE_MODULE
    },
    cachePath: {
        flags: "-P, --cache-path <path>",
        description: "The path of the cache directory.",
        configKey: consts.CLI_CONFIG_KEYS.CACHE_PATH
    },
    host: {
        flags: "-h, --host <address>",
        description: "The interface on which the Cache Server listens. The default is to listen on all interfaces.",
        configKey: consts.CLI_CONFIG_KEYS.HOST
    },
    port: {
        flags: "-p, --port <n>",
        description: "The port on which the Cache Server listens. The default value is 8126.",
        validator: parseInt,
        configKey: consts.CLI_CONFIG_KEYS.PORT
    },
    workers: {
        flags: "-w, --workers <n>",
        description: "The number of worker threads to spawn. The default is 0.",
        validator: zeroOrMore,
        configKey: consts.CLI_CONFIG_KEYS.WORKERS
    },
    mirror: {
        flags: "-m --mirror <host:port>",
        description: "Mirror transactions to another cache server. Repeat this option for multiple mirrors.",
        validator: collect,
        configKey: consts.CLI_CONFIG_KEYS.MIRROR
    },
    putwhitelist: {
        flags: "-W --putwhitelist <host:port>",
        description: "Only allow PUT transactions (uploads) from the specified client address. Repeat this option for multiple addresses.",
        validator: collect,
        configKey: consts.CLI_CONFIG_KEYS.PUTWHITELIST
    },
    diagClientRecorder: {
        flags: "--diag-client-recorder",
        description: "Record incoming client network stream to disk.",
        configKey: consts.CLI_CONFIG_KEYS.CLIENT_RECORDER
    }
};

// Initialize CLI handler
cmd.description(description).version(version).allowUnknownOption(true);
UnityCacheServer.handleCommandLine(cmd, optionMap);
UnityCacheServer.start().then(() => {}, () => process.exit(1));