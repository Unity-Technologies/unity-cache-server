const cluster = require('cluster');
const helpers = require('./lib/helpers');
const consts = require('./lib/constants').Constants;
const program = require('commander');
const path = require('path');
const CacheServer = require('./lib/server');
const config = require('config');
const prompt = require('prompt');

function myParseInt(val, def) {
    val = parseInt(val);
    return (!val && val !== 0) ? def : val;
}

function zeroOrMore(val) {
    return Math.max(0, val);
}

function atLeastOne(val) {
    return Math.max(1, val);
}

program.description("Unity Cache Server")
    .version(consts.VERSION)
    //.option('-s, --size <n>', 'Specify the maximum allowed size of the LRU cache. Files that have not been used recently will automatically be discarded when the cache size is exceeded. Default is 50Gb', myParseInt, consts.DEFAULT_CACHE_SIZE)
    .option('-p, --port <n>', 'Specify the server port, only apply to new cache server, default is 8126', myParseInt, consts.DEFAULT_PORT)
    //.option('-P, --path [path]', 'Specify the path of the cache directory. Default is ./cache5.0', consts.DEFAULT_CACHE_DIR)
    .option('-l, --log-level <n>', 'Specify the level of log verbosity. Valid values are 0 (silent) through 5 (debug). Default is 4 (test)', myParseInt, consts.DEFAULT_LOG_LEVEL)
    .option('-w, --workers <n>', 'Number of worker threads to spawn. Default is 1 for every 2 CPUs reported by the OS', zeroOrMore, consts.DEFAULT_WORKERS)
    .option('-m, --monitor-parent-process <n>', 'Monitor a parent process and exit if it dies', myParseInt, 0)
    .parse(process.argv);

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

const moduleName = config.get("Cache.module");
const modulePath = path.resolve(config.get("Cache.path"), moduleName);
helpers.log(consts.LOG_INFO, "Loading Cache module at " + modulePath);
const Cache = require(modulePath);
let server = null;

Cache.init({}, function() {
    server = new CacheServer(Cache, program.port);

    if(cluster.isMaster) {
        helpers.log(consts.LOG_INFO, "Cache Server version " + consts.VERSION);

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
                    Cache.shutdown(function () {
                        server.Stop();
                        process.exit(0);
                    });
                    break;

                case 's':
                    helpers.log(consts.LOG_INFO, "Saving cache data ...");
                    Cache.save(function(err) {
                        if(err) {
                            helpers.log(consts.LOG_ERR, err);
                            server.Stop();
                            process.exit(1);
                        }

                        helpers.log(consts.LOG_INFO, "Save finished.");
                    });

                    break;
                case 'r':
                    helpers.log(consts.LOG_INFO, "Resetting cache data ...");
                    Cache.reset(function(err) {
                        "use strict";
                        if(err) {
                            helpers.log(consts.LOG_ERR, err);
                            server.Stop();
                            process.exit(1);
                        }

                        helpers.log(consts.LOG_INFO, "Reset finished.");
                    });
            }
        }

        process.nextTick(startPrompt);
    });
}



