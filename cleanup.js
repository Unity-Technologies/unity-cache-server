#!/usr/bin/env node
const helpers = require('./lib/helpers');
helpers.initConfigDir(__dirname);
const config = require('config');

const consts = require('./lib/constants');
const program = require('commander');
const moment = require('moment');
const filesize =require('filesize');
const ora = require('ora');
const VERSION = require('./package.json').version;

function myParseInt(val, def) {
    val = parseInt(val);
    return (!val && val !== 0) ? def : val;
}

function parseTimeSpan(val) {
    if(!moment.duration(val).isValid())
    {
        helpers.log(consts.LOG_ERR, "Invalid timespan format");
        process.exit(1);
    }

    return val;
}

const defaultCacheModule = config.get("Cache.defaultModule");

program.description("Unity Cache Server - Cache Cleanup\n\n  Removes old files from supported cache modules.")
    .version(VERSION)
    .allowUnknownOption(true)
    .option('-c --cache-module [path]', 'Use cache module at specified path', defaultCacheModule)
    .option('-P, --cache-path [path]', 'Specify the path of the cache directory')
    .option('-l, --log-level <n>', 'Specify the level of log verbosity. Valid values are 0 (silent) through 5 (debug)', myParseInt, consts.DEFAULT_LOG_LEVEL)
    .option('-e, --expire-time-span <timeSpan>', 'Override the configured file expiration timespan. Both ASP.NET style time spans (days.minutes:hours:seconds, e.g. \'15.23:59:59\') and ISO 8601 time spans (e.g. \'P15DT23H59M59S\') are supported.', parseTimeSpan)
    .option('-s, --max-cache-size <bytes>', 'Override the configured maximum cache size. Files will be removed from the cache until the max cache size is satisfied, using a Least Recently Used search. A value of 0 disables this check.', myParseInt)
    .option('-d, --delete', 'Delete cached files that match the configured criteria. Without this, the default behavior is to dry-run which will print diagnostic information only.')
    .option('-D, --daemon <interval>', 'Daemon mode: execute the cleanup script at the given interval in seconds as a foreground process.', myParseInt)
    .option('--NODE_CONFIG_DIR=<path>', 'Specify the directory to search for config files. This is equivalent to setting the NODE_CONFIG_DIR environment variable. Without this option, the built-in configuration is used.');

program.parse(process.argv);

helpers.setLogLevel(program.logLevel);

const CacheModule = helpers.resolveCacheModule(program.cacheModule, __dirname);

if(!CacheModule.properties.cleanup) {
    helpers.log(consts.LOG_ERR, "Configured cache module does not support cleanup script.");
    process.exit(1);
}

const cache = new CacheModule();

const cacheOpts = { cleanupOptions: {} };

if(program.cachePath !== null) {
    cacheOpts.cachePath = program.cachePath;
}

if(program.hasOwnProperty('expireTimeSpan')) {
    cacheOpts.cleanupOptions.expireTimeSpan = program.expireTimeSpan;
}

if(program.hasOwnProperty('maxCacheSize')) {
    cacheOpts.cleanupOptions.maxCacheSize = program.maxCacheSize;
}

const dryRun = !program.delete;
const logLevel = helpers.getLogLevel();

cache._options = cacheOpts;
helpers.log(consts.LOG_INFO, `Cache path is ${cache._cachePath}`);

cache.on('cleanup_delete_item', item => helpers.log(consts.LOG_DBG, item));

cache.on('cleanup_delete_finish', data => {
    const pct = data.cacheSize > 0 ? (data.deleteSize/data.cacheSize).toPrecision(2) * 100 : 0;
    helpers.log(consts.LOG_INFO, `Found ${data.deleteCount} expired files of ${data.cacheCount}. ${filesize(data.deleteSize)} of ${filesize(data.cacheSize)} (${pct}%).`);
    if(dryRun) {
        helpers.log(consts.LOG_INFO, "Nothing deleted; run with --delete to remove expired files from the cache.");
    }
});

let spinner = null;

if(logLevel < consts.LOG_DBG && logLevel >= consts.LOG_INFO) {
    spinner = ora({color: 'white'});

    cache.on('cleanup_search_progress', data => {
        spinner.text = `${data.msg} (${data.deleteCount} of ${data.cacheCount} files, ${filesize(data.deleteSize)})`;
    });

    cache.on('cleanup_search_finish', () => {
        spinner.stop();
    });

} else if(logLevel === consts.LOG_DBG) {
    cache.on('cleanup_search_progress', data => {
        const txt = `${data.msg} (${data.deleteCount} of ${data.cacheCount} files, ${filesize(data.deleteSize)})`;
        helpers.log(consts.LOG_DBG, txt);
    });
}

const msg = 'Gathering cache files for expiration';
function doCleanup() {
    if (spinner) spinner.start(msg);
    cache.cleanup(dryRun)
        .catch(err => {
            if (spinner) spinner.stop();
            helpers.log(consts.LOG_ERR, err);
            process.exit(1);
        });
}

if(program.hasOwnProperty('daemon') && program.daemon > 0) {
    setInterval(doCleanup, program.daemon * 1000);
}
else {
    doCleanup();
}