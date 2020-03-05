const _ = require('lodash');
const { version } = require('../package.json');
const ip = require('ip');
const consts = require('./constants');
const helpers = require('./helpers');
const yaml = require('js-yaml');
const path = require('path');
const fs = require('fs-extra');
const StreamRecorder = require('./server/client_stream_recorder');

class UnityCacheServer {
    static getConfigVal(key, defVal) {
        const config = require('config');
        return config.has(key) ? config.get(key) : defVal;
    };

    static dumpConfig() {
        const configData = yaml.safeDump(require('config'));
        helpers.log(0, configData);
    }

    static saveConfig(configFile) {
        configFile = typeof configFile  === 'string'
            ? path.resolve(configFile)
            : 'default.yml';

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
        const mirror = this.getConfigVal(consts.CLI_CONFIG_KEYS.MIRROR, []);
        const myPort = this.getConfigVal(consts.CLI_CONFIG_KEYS.PORT, consts.DEFAULT_PORT);
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

    static handleCommandLine(cmd, optionMap, argv = process.argv) {
        // configure common CLI options
        _.defaultsDeep(optionMap, {
            logLevel: {
                flags: "-l, --log-level <n>",
                description: "The level of log verbosity. Valid values are 0 (silent) through 5 (debug). The default is 3 (info).",
                validator: parseInt,
                configKey: consts.CLI_CONFIG_KEYS.LOG_LEVEL
            },
            dumpConfig: {
                flags: "--dump-config",
                description: "Write the active configuration to the console."
            },
            saveConfig: {
                flags: "--save-config [path]",
                description: "Write the active configuration to the specified file and exit. Defaults to `./default.yml`."
            }
        });

        // Add CLI options
        _.values(optionMap).forEach(o => cmd.option(o.flags, o.description, o.validator, o.defaultValue));

        // Parse shell args
        cmd.parse(argv);

        // Set CLI config overrides
        const overrides = JSON.parse(process.env.NODE_CONFIG || '{}');
        for(const optionKey of Object.keys(optionMap)) {
            if(!cmd.hasOwnProperty(optionKey) || cmd[optionKey] == null) continue;
            const optionVal = cmd[optionKey];
            const configKey = optionMap[optionKey].configKey;
            if(configKey) _.set(overrides, configKey, optionVal);
        }

        process.env.NODE_CONFIG = JSON.stringify(overrides);

        // Init logging
        const logLevel = this.getConfigVal(consts.CLI_CONFIG_KEYS.LOG_LEVEL, consts.DEFAULT_LOG_LEVEL);

        helpers.setLogLevel(logLevel);

        // Handle CLI specific options
        if(cmd.dumpConfig || cmd.saveConfig) {
            if (cmd.dumpConfig) {
                UnityCacheServer.dumpConfig();
            }

            if (cmd.saveConfig) {
                UnityCacheServer.saveConfig(cmd.saveConfig);
            }

            process.exit();
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

        // Find and load the desired cache module
        const cacheModuleName = this.getConfigVal(consts.CLI_CONFIG_KEYS.CACHE_MODULE, consts.DEFAULT_CACHE_MODULE);
        const CacheModule = helpers.resolveCacheModule(cacheModuleName, path.resolve(__dirname, 'cache'));

        const myOpts = Object.assign({}, opts);
        myOpts.cachePath = this.getConfigVal(consts.CLI_CONFIG_KEYS.CACHE_PATH,
            this.getConfigVal(`Cache.options.${cacheModuleName}.cachePath`, consts.DEFAULT_CACHE_PATH));

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
        const consts = require('./constants');
        const cluster = require('cluster');
        const Server = require('./server/server');

        const cache = await UnityCacheServer.initCache();

        // Define # of worker threads
        let workers = this.getConfigVal(consts.CLI_CONFIG_KEYS.WORKERS, 0);
        if(workers > 0 && !cache.constructor.properties.clustering) {
            workers = 0;
            helpers.log(consts.LOG_INFO, `Clustering disabled, current cache module ${this.constructor._cache_module_name} does not support it.`);
        }

        helpers.setLogger(workers > 0 ? helpers.defaultClusterLogger : helpers.defaultLogger);

        const serverOpts = {
            host: this.getConfigVal(consts.CLI_CONFIG_KEYS.HOST, consts.DEFAULT_HOST),
            port: this.getConfigVal(consts.CLI_CONFIG_KEYS.PORT, consts.DEFAULT_PORT),
            mirror: await this.getMirrors(),
            allowIpv6: this.getConfigVal(consts.CLI_CONFIG_KEYS.ALLOW_IP_V6, false),
            clientRecorder: this.getConfigVal(consts.CLI_CONFIG_KEYS.CLIENT_RECORDER, false)
        };

        // create Server
        const server = new Server(cache, serverOpts);

        // Setup SIGINT handler
        ['SIGINT', 'SIGTERM'].forEach(sig => {
            process.once(sig, async () => {
                helpers.log(consts.LOG_INFO, "Shutting down...");
                await cache.shutdown();
                await server.stop();
                process.exit();
            });
        });

        // Startup server
        const errHandler = (err) => {
            helpers.log(consts.LOG_ERR, err.message);
            process.exit(1);
        };

        if(cluster.isMaster) {
            helpers.log(consts.LOG_INFO, `Cache Server version ${version}; Cache module is ${this.constructor._cache_module_name}`);

            for(let i = 0; i < workers; i++) {
                cluster.fork();
            }

            cluster.on('exit', (deadWorker, code, signal) => {
                if (signal) {
                    console.log(`[Cluster: ${deadWorker.id}] !Process killed by signal: ${signal}`);
                } else if (code !== 0) {
                    console.log(`[Cluster: ${deadWorker.id}] !Process exited with error code: ${code}`);
                }

                cluster.fork();
            });
        }

        if(cluster.isWorker || workers === 0) {
            await server.start(errHandler);
            helpers.log(consts.LOG_INFO, `Cache Server ready on ${server.host}:${server.port}`);
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
            process.exit(1);
        }

        const logLevel = helpers.getLogLevel();
        let spinner;

        if(logLevel === consts.LOG_INFO) {
            spinner = ora({color: 'white'})
        }
        else {
            spinner = new FakeSpinner();
        }

        cache.on('cleanup_delete_item', item => {
            helpers.log(consts.LOG_DBG, item);
        });

        cache.on('cleanup_delete_finish', data => {
            const pct = data.cacheSize > 0 ? (data.deleteSize/data.cacheSize).toPrecision(2) * 100 : 0;
            helpers.log(consts.LOG_INFO, `Found ${data.deleteCount} expired files of ${data.cacheCount}. ${filesize(data.deleteSize)} of ${filesize(data.cacheSize)} (${pct}%).`);
        });

        cache.on('cleanup_search_progress', data => {
            spinner.text = `${data.msg} (${data.deleteCount} of ${data.cacheCount} files, ${filesize(data.deleteSize)})`;
        });

        cache.on('cleanup_search_finish', () => {
            spinner.stop();
        });

        async function doCleanup() {
            spinner.start('Gathering cache files for expiration');
            await cache.cleanup(dryRun);

            if(dryRun) {
                helpers.log(consts.LOG_INFO, "Nothing deleted; run with --delete to remove expired files from the cache.");
            }
        }

        if(!daemon) return doCleanup();

        async function doCleanupInterval() {
            const interval = Math.min(250, daemon);
            let finished = false;

            ['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => finished = true));

            while(!finished) {
                await doCleanup();
                for(let i = 0; i < daemon; i += interval) {
                    await new Promise(resolve => setTimeout(resolve, interval));
                    if(finished) break;
                }
            }
        }

        return doCleanupInterval();
    }
}

class FakeSpinner {
    set text(msg) {
        helpers.log(consts.LOG_DBG, msg);
    }

    start(msg) { this.text = msg; };
    stop(){};
}

exports.UnityCacheServer = UnityCacheServer;
