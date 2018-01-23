const cluster = require('cluster');
const helpers = require('./lib/helpers');
const consts = require('./lib/constants');
const program = require('commander');
const path = require('path');
const CacheServer = require('./lib').Server;
const config = require('config');
const prompt = require('prompt');
const dns = require('dns');
const ip = require('ip');
const VERSION = require('./package.json').version;

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
    .option('-p, --port <n>', `Specify the server port, only apply to new cache server, default is ${consts.DEFAULT_PORT}`, myParseInt, consts.DEFAULT_PORT)
    .option('-c --cacheModule [path]', `Use cache module at specified path. Default is '${defaultCacheModule}'`, defaultCacheModule)
    .option('-P, --cachePath [path]', `Specify the path of the cache directory.`)
    .option('-l, --log-level <n>', `Specify the level of log verbosity. Valid values are 0 (silent) through 5 (debug). Default is ${consts.DEFAULT_LOG_LEVEL}`, myParseInt, consts.DEFAULT_LOG_LEVEL)
    .option('-w, --workers <n>', `Number of worker threads to spawn. Default is ${consts.DEFAULT_WORKERS}`, zeroOrMore, consts.DEFAULT_WORKERS)
    .option('-m --mirror [host:port]', `Mirror transactions to another cache server. Can be repeated for multiple mirrors.`, collect, [])
    .option('-m, --monitor-parent-process <n>', 'Monitor a parent process and exit if it dies', myParseInt, 0);

program.parse(process.argv);

helpers.SetLogLevel(program.logLevel);

if (program.monitorParentProcess > 0) {
    function monitor() {
        function is_running(pid) {
            try {
                return process.kill(pid, 0)
            }
            catch (e) {
                return e.code === 'EPERM'
            }
        }

        if (!is_running(program.monitorParentProcess)) {
            helpers.log(consts.LOG_INFO, "monitored parent process has died");
            process.exit(1);
        }
        setTimeout(monitor, 1000);
    }

    monitor();
}

const errHandler = function () {
    helpers.log(consts.LOG_ERR, "Unable to start Cache Server");
    process.exit(1);
};

const CacheModule = require(path.resolve(program.cacheModule));
const Cache = new CacheModule();

if(program.workers > 0 && !CacheModule.properties.clustering) {
    program.workers = 0;
    helpers.log(consts.LOG_INFO, `Clustering disabled, ${program.cacheModule} module does not support it.`);
}

let server = null;

let cacheOpts = {};
if(program.cachePath !== null) {
    cacheOpts.cachePath = program.cachePath;
}

let getMirrors = () => new Promise((resolve, reject) => {
    let mirrors = program.mirror.map(m => {
        let [host, port] = m.split(':');
        port = parseInt(port);

        if(!port) port = config.get("Defaults.serverPort");
        const myIp = ip.address();

        return new Promise((resolve, reject) => {
            dns.lookup(host, {family: 4, hints: dns.ADDRCONFIG}, (err, address) => {
                if(err) return reject(err);

                if((ip.isEqual(myIp, address) || ip.isEqual("127.0.0.1", address)) && program.port === port) {
                    return reject(new Error(`Cannot mirror to self!`));
                }

                helpers.log(consts.LOG_INFO, `Cache Server mirroring to ${address}:${port}`);
                resolve({ host: address, port: port });
            });
        })
    });

    Promise.all(mirrors)
        .then(m => resolve(m))
        .catch(err => reject(err));
});

Cache.init(cacheOpts)
    .then(() => getMirrors())
    .then(mirrors => {
        let opts = {
            port: program.port,
            mirror: mirrors
        };

        server = new CacheServer(Cache, opts);

        if(cluster.isMaster) {
            helpers.log(consts.LOG_INFO, `Cache Server version ${VERSION}; Cache module ${program.cacheModule}`);

            if(program.workers === 0) {
                server.Start(errHandler, function () {
                    helpers.log(consts.LOG_INFO, `Cache Server ready on port ${server.port}`);
                    startPrompt();
                });
            }

            for(let i = 0; i < program.workers; i++) {
                const worker = cluster.fork();
                Cache.registerClusterWorker(worker);
            }
        }
        else {
            server.Start(errHandler, function () {
                helpers.log(consts.LOG_INFO, `Cache Server worker ${cluster.worker.id} ready on port ${server.port}`);
            });
        }
    })
    .catch(err => {
        helpers.log(consts.LOG_ERR, err);
        process.exit(1);
    });

function startPrompt() {
    prompt.message = "";
    prompt.delimiter = "> ";
    prompt.start();

    prompt.get(['command'], function(err, result) {
        if(err) {
            if(err.message === 'canceled') {
                result = { command: 'q' };
            }
            else {
                helpers.log(consts.LOG_ERR, err);
                server.Stop();
                process.exit(1);
            }
        }

        if(result) {
            switch(result.command) {
                case 'q':
                    helpers.log(consts.LOG_INFO, "Shutting down ...");
                    Cache.shutdown().then(() => {
                        server.Stop();
                        process.exit(0);
                    });
                    break;
            }
        }

        process.nextTick(startPrompt);
    });
}



