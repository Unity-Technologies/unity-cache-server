#!/usr/bin/env node
const helpers = require('./lib/helpers');
helpers.initConfigDir(__dirname);
const config = require('config');

const { Server } = require('./lib');
const cluster = require('cluster');
const consts = require('./lib/constants');
const program = require('commander');
const ip = require('ip');
const VERSION = require('./package.json').version;
const fs = require('fs-extra');
const path = require('path');

function myParseInt(val, def) {
    val = parseInt(val);
    return (!val && val !== 0) ? def : val;
}

function zeroOrMore(val) {
    return Math.max(0, val);
}

function collect(val, memo) {
    memo.push(val);
    return memo;
}

const defaultCacheModule = config.get("Cache.defaultModule");

program.description("Unity Cache Server")
    .version(VERSION)
    .allowUnknownOption(true)
    .option('-p, --port <n>', 'Specify the server port, only apply to new cache server', myParseInt, consts.DEFAULT_PORT)
    .option('-c --cache-module [path]', 'Use cache module at specified path', defaultCacheModule)
    .option('-P, --cache-path [path]', 'Specify the path of the cache directory')
    .option('-l, --log-level <n>', 'Specify the level of log verbosity. Valid values are 0 (silent) through 5 (debug)', myParseInt, consts.DEFAULT_LOG_LEVEL)
    .option('-w, --workers <n>', 'Number of worker threads to spawn', zeroOrMore, consts.DEFAULT_WORKERS)
    .option('-m --mirror [host:port]', 'Mirror transactions to another cache server. Can be repeated for multiple mirrors', collect, [])
    .option('--dump-config', 'Write the active configuration to the console')
    .option('--save-config [path]', 'Write the active configuration to the specified file and exit. Defaults to ./default.yml')
    .option('--NODE_CONFIG_DIR=<path>', 'Specify the directory to search for config files. This is equivalent to setting the NODE_CONFIG_DIR environment variable. Without this option, the built-in configuration is used.');

program.parse(process.argv);

if(program.saveConfig || program.dumpConfig) {
    const configs = config.util.getConfigSources();
    const configData = configs.length > 0 ? configs[configs.length - 1].original : '';

    if(program.dumpConfig) {
        console.log(configData);
    }

    if(program.saveConfig) {
        let configFile = (typeof(program.saveConfig) === 'boolean') ? 'default.yml' : program.saveConfig;
        configFile = path.resolve(configFile);

        if (fs.pathExistsSync(configFile)) {
            helpers.log(consts.LOG_ERR, `${configFile} already exists - will not overwrite.`);
            process.exit(1);
        }

        fs.ensureDirSync(path.dirname(configFile));
        fs.writeFileSync(configFile, configData);
        helpers.log(consts.LOG_INFO, `config saved to ${configFile}`);
    }

    process.exit(0);
}

helpers.setLogLevel(program.logLevel);
helpers.setLogger(program.workers > 0 ? helpers.defaultClusterLogger : helpers.defaultLogger);

const errHandler = function () {
    helpers.log(consts.LOG_ERR, "Unable to start Cache Server");
    process.exit(1);
};

const CacheModule = helpers.resolveCacheModule(program.cacheModule, __dirname);
const Cache = new CacheModule();

if(program.workers > 0 && !CacheModule.properties.clustering) {
    program.workers = 0;
    helpers.log(consts.LOG_INFO, `Clustering disabled, ${program.cacheModule} module does not support it.`);
}

let server = null;

const cacheOpts = {};
if(program.cachePath !== null) {
    cacheOpts.cachePath = program.cachePath;
}

const getMirrors = () => new Promise((resolve, reject) => {
    const defaultPort = consts.DEFAULT_PORT;
    const myIp = ip.address();

    const mirrors = program.mirror.map(async m => {
        const result = await helpers.parseAndValidateAddressString(m, defaultPort);
        if((ip.isEqual(myIp, result.host) || ip.isEqual("127.0.0.1", result.host)) && program.port === port) {
            throw new Error(`Cannot mirror to self!`);
        }

        return result;
    });

    Promise.all(mirrors)
        .then(m => resolve(m))
        .catch(err => reject(err));
});

Cache.init(cacheOpts)
    .then(() => getMirrors())
    .then(mirrors => {
        const opts = {
            port: program.port,
            mirror: mirrors
        };

        server = new Server(Cache, opts);

        if(cluster.isMaster) {
            helpers.log(consts.LOG_INFO, `Cache Server version ${VERSION}; Cache module is ${program.cacheModule}`);

            if(program.workers === 0) {
                server.start(errHandler).then(() => {
                    helpers.log(consts.LOG_INFO, `Cache Server ready on port ${server.port}`);
                });
            }

            for(let i = 0; i < program.workers; i++) {
                const worker = cluster.fork();
                Cache.registerClusterWorker(worker);
            }
        }
        else {
            server.start(errHandler).then(() => {
                helpers.log(consts.LOG_INFO, `Cache Server worker ${cluster.worker.id} ready on port ${server.port}`);
            });
        }
    })
    .catch(err => {
        helpers.log(consts.LOG_ERR, err);
        process.exit(1);
    });

process.on('SIGINT', async () => {
    helpers.log(consts.LOG_INFO, "Shutting down...");
    await Cache.shutdown();
    await server.stop();
    process.exit(0);
});