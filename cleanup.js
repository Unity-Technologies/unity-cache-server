#!/usr/bin/env node
const helpers = require('./lib/helpers');
const consts = require('./lib/constants');
const program = require('commander');
const path = require('path');
const moment = require('moment');
const klaw = require('klaw');
const filesize =require('filesize');
const fs = require('fs-extra');
const ora = require('ora');

const { Transform } = require('stream');

const config = require('config');
const VERSION = require('./package.json').version;

function myParseInt(val, def) {
    val = parseInt(val);
    return (!val && val !== 0) ? def : val;
}

const defaultCacheModule = config.get("Cache.defaultModule");

program.description("Unity Cache Server - Cache Cleanup\n\n  Remove files from cache that have not been accessed within the given <timeSpan>.\n\n  Both ASP.NET style time spans (days.minutes:hours:seconds, e.g. '15.23:59:59') and ISO 8601 time spans (e.g. 'P15DT23H59M59S') are supported.")
    .version(VERSION)
    .arguments('<timeSpan>')
    .option('-c --cache-module [path]', 'Use cache module at specified path', defaultCacheModule)
    .option('-P, --cache-path [path]', 'Specify the path of the cache directory')
    .option('-l, --log-level <n>', 'Specify the level of log verbosity. Valid values are 0 (silent) through 5 (debug)', myParseInt, consts.DEFAULT_LOG_LEVEL)
    .option('-d, --delete', 'Delete cached files that that have not been accessed within the timeSpan provided.')
    .action(timeSpan => doCleanup(timeSpan));

program.parse(process.argv);

if (!process.argv.slice(2).length) {
    program.outputHelp();
}

function doCleanup(timeSpan) {
    helpers.setLogLevel(program.logLevel);

    const CacheModule = require(path.resolve(program.cacheModule));

    if(!CacheModule.properties.cleanup) {
        helpers.log(consts.LOG_ERR, "Configured cache module does not support cleanup script.");
        process.exit(1);
    }

    const cache = new CacheModule();

    let cacheOpts = {};
    if(program.cachePath !== null) {
        cacheOpts.cachePath = program.cachePath;
    }

    cache._options = cacheOpts;
    helpers.log(consts.LOG_INFO, `Cache path is ${cache._cachePath}`);

    const duration = moment.duration(timeSpan);
    if(!duration.isValid()) {
        helpers.log(consts.LOG_ERR, `Invalid timeSpan specified.`);
    }


    const msg = `Gathering cache files that have not been accessed within ${duration.humanize()}`;
    const spinner = ora({color:'white'}).start(`${msg} (found 0)`);

    const minFileAccessTime = moment().subtract(duration).toDate();
    let items = [];
    let totalSize = 0;
    let freedSize = 0;
    let filterTransform = new Transform({
        objectMode: true,
        transform(item, enc, next) {
            if(item.stats.isDirectory()) return next();

            totalSize += item.stats.size;
            if(item.stats.atime < minFileAccessTime) {
                spinner.text = `${msg} (found ${items.length}, ${filesize(freedSize)})`;
                freedSize += item.stats.size;
                this.push(item);
            }

            next();
        }
    });

    klaw(cache._cachePath).pipe(filterTransform)
        .on('data', item => items.push(item.path))
        .on('end', async () => {
            spinner.stop();

            if(program.delete) {
                for(let item of items) {
                    helpers.log(consts.LOG_INFO, `Deleting ${item}`);
                    await fs.unlink(item);
                }
            }

            let pct = totalSize > 0 ? (freedSize/totalSize).toPrecision(2) * 100 : 0;
            helpers.log(consts.LOG_INFO, `Found ${items.length} expired files: ${filesize(freedSize)} of ${filesize(totalSize)} total cache size (${pct}%).`);
            if(!program.delete) {
                helpers.log(consts.LOG_INFO, "Nothing deleted; run with --delete to remove expired files from the cache.");
            }
    })
}