const _ = require('lodash');
const { version } = require('../package.json');
const ip = require('ip');
const consts = require('./constants');
const helpers = require('./helpers');
const yaml = require('js-yaml');
const path = require('path');
const fs = require('fs-extra');

class UnityCacheServer {
    static dumpConfig() {
        const configData = yaml.safeDump(require('config'));
        helpers.log(0, configData);
    }

    static saveConfig(configFile = 'default.yml') {
        configFile = path.resolve(configFile);
        if (fs.pathExistsSync(configFile)) {
            const err = new Error(`${configFile} already exists - will not overwrite.`);
            helpers.log(consts.LOG_ERR, err.message);
            throw err;
        }

        const configData = yaml.safeDump(require('config'));
        fs.ensureDirSync(path.dirname(configFile));
        fs.writeFileSync(configFile, configData);
        helpers.log(consts.LOG_INFO, `config saved to ${configFile}`);
    }

    static async getMirrors() {
        const config = require('config');
        const mirror = config.get(consts.CLI_CONFIG_KEYS.MIRROR);
        const myPort = config.get(consts.CLI_CONFIG_KEYS.PORT);
        const myIp = ip.address();

        const mirrors = mirror.map(async m => {
            const result = await helpers.parseAndValidateAddressString(m, consts.DEFAULT_PORT);
            if((ip.isEqual(myIp, result.host) || ip.isEqual("127.0.0.1", result.host)) && myPort === result.port) {
                throw new Error("Cannot mirror to self!");
            }

            return result;
        });

        return Promise.all(mirrors);
    }

    // To allow test harness to override
    static _exit(code = 0) {
        process.exit(code);
    }

    static handleCommandLine(cmd, optionMap, argv = process.argv) {
        // configure common CLI options
        _.defaultsDeep(optionMap, {
            logLevel: {
                flags: "-l, --log-level <n>",
                description: "Specify the level of log verbosity. Valid values are 0 (silent) through 5 (debug)",
                validator: parseInt,
                configKey: consts.CLI_CONFIG_KEYS.LOG_LEVEL
            },
            dumpConfig: {
                flags: "--dump-config",
                description: "Write the active configuration to the console"
            },
            saveConfig: {
                flags: "--save-config [path]",
                description: "Write the active configuration to the specified file and exit",
                defaultValue: "default.yml"
            },
            nodeConfigDir: {
                flags: "--NODE_CONFIG_DIR=<path>",
                description: "Specify the directory to search for config files. This is equivalent to setting the NODE_CONFIG_DIR environment variable. Without this option, the built-in configuration is used."
            }
        });

        // Add CLI options
        for(const o of _.values(optionMap)) {
            const validator = o.hasOwnProperty('validator') ? o.validator : null;
            const defaultValue = o.hasOwnProperty('defaultValue') ? o.defaultValue : null;
            cmd.option(o.flags, o.description, validator, defaultValue);
        }

        cmd.parse(argv);

        // Set CLI config overrides
        const overrides = JSON.parse(process.env.NODE_CONFIG || '{}');
        for(const optionKey of Object.keys(optionMap)) {
            if(!cmd.hasOwnProperty(optionKey) || cmd[optionKey] == null) continue;
            const optionVal = cmd[optionKey];
            const configKey = optionMap[optionKey].configKey;
            _.set(overrides, configKey, optionVal);
        }

        process.env.NODE_CONFIG = JSON.stringify(overrides);

        // Load config
        const config = require('config');

        // Init logging
        const logLevel = config.has(consts.CLI_CONFIG_KEYS.LOG_LEVEL)
            ? config.get(consts.CLI_CONFIG_KEYS.LOG_LEVEL)
            : consts.DEFAULT_LOG_LEVEL;

        helpers.setLogLevel(logLevel);

        // Handle CLI specific options
        if(cmd.dumpConfig || cmd.saveConfig) {
            if (cmd.dumpConfig) {
                UnityCacheServer.dumpConfig();
            }

            if (cmd.saveConfig) {
                typeof(cmd.saveConfig) === 'string' ? UnityCacheServer.saveConfig(cmd.saveConfig) : UnityCacheServer.saveConfig();
            }

            UnityCacheServer._exit();
        }
    }

    /**
     *
     * @returns {Promise<CacheBase>}
     */
    static async initCache(opts = {}) {
        if(this.constructor._cache_instance != null) {
            return this.constructor._cache_instance;
        }

        const config = require('config');

        // Find and load the desired cache module
        const cacheModuleName = config.get(consts.CLI_CONFIG_KEYS.CACHE_MODULE);
        const CacheModule = helpers.resolveCacheModule(cacheModuleName, path.resolve(__dirname, 'cache'));

        const myOpts = Object.assign({}, opts);
        myOpts.cachePath = config.has(consts.CLI_CONFIG_KEYS.CACHE_PATH)
            ? config.get(consts.CLI_CONFIG_KEYS.CACHE_PATH)
            : config.get(`Cache.options.${cacheModuleName}.cachePath`);

        this.constructor._cache_instance = new CacheModule();
        this.constructor._cache_module_name = cacheModuleName;
        await this.constructor._cache_instance.init(myOpts);
        return this.constructor._cache_instance;
    }

    /**
     *
     * @returns {Promise<Server>}
     */
    static async start() {
        const config = require('config');
        const consts = require('./constants');
        const cluster = require('cluster');
        const Server = require('./server/server');

        const getConfigVal = (key, defVal) => {
            return config.has(key) ? config.get(key) : defVal;
        };

        const cache = await UnityCacheServer.initCache();

        // Define # of worker threads
        let workers = getConfigVal(consts.CLI_CONFIG_KEYS.WORKERS, 0);
        if(workers > 0 && !cache.constructor.properties.clustering) {
            workers = 0;
            helpers.log(consts.LOG_INFO, `Clustering disabled, current cache module ${this.constructor._cache_module_name} does not support it.`);
        }

        helpers.setLogger(workers > 0 ? helpers.defaultClusterLogger : helpers.defaultLogger);

        const serverOpts = {
            port: getConfigVal(consts.CLI_CONFIG_KEYS.PORT, consts.DEFAULT_PORT),
            mirror: await this.getMirrors(),
            allowIpv6: getConfigVal(consts.CLI_CONFIG_KEYS.ALLOW_IP_V6, false)
        };

        // create Server
        const server = new Server(cache, serverOpts);

        // Setup SIGINT handler
        ['SIGINT', 'SIGTERM'].forEach(sig => {
            process.on(sig, async () => {
                helpers.log(consts.LOG_INFO, "Shutting down...");
                await cache.shutdown();
                await server.stop();
                UnityCacheServer._exit();
            });
        });

        // Startup server
        const errHandler = (err) => {
            helpers.log(consts.LOG_ERR, err.message);
            UnityCacheServer._exit(1);
        };

        if(cluster.isMaster) {
            helpers.log(consts.LOG_INFO, `Cache Server version ${version}; Cache module is ${this.constructor._cache_module_name}`);

            for(let i = 0; i < workers; i++) {
                cluster.fork();
            }
        }

        if(cluster.isWorker || workers === 0) {
            await server.start(errHandler);
            helpers.log(consts.LOG_INFO, `Cache Server ready on port ${server.port}`);
        }

        return server;
    }

    /**
     *
     * @param {Boolean} dryRun
     * @param {Number} daemon
     * @returns {Promise<void>}
     */
    static async cleanup(dryRun = true, daemon = 0) {
        const filesize =require('filesize');
        const ora = require('ora');
        const cache = await UnityCacheServer.initCache();

        if(!cache.constructor.properties.cleanup) {
            helpers.log(consts.LOG_ERR, "Configured cache module does not support cleanup script.");
            UnityCacheServer._exit(1);
        }

        cache.on('cleanup_delete_item', item => helpers.log(consts.LOG_DBG, item));

        cache.on('cleanup_delete_finish', data => {
            const pct = data.cacheSize > 0 ? (data.deleteSize/data.cacheSize).toPrecision(2) * 100 : 0;
            helpers.log(consts.LOG_INFO, `Found ${data.deleteCount} expired files of ${data.cacheCount}. ${filesize(data.deleteSize)} of ${filesize(data.cacheSize)} (${pct}%).`);
            if(dryRun) {
                helpers.log(consts.LOG_INFO, "Nothing deleted; run with --delete to remove expired files from the cache.");
            }
        });

        let spinner = null;

        const logLevel = helpers.getLogLevel();
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
                    UnityCacheServer._exit(1);
                });
        }

        if(daemon && daemon > 0) {
            setInterval(doCleanup, daemon * 1000);
        }
        else {
            doCleanup();
        }
    }
}

exports.UnityCacheServer = UnityCacheServer;