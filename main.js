const cluster = require('cluster');
const helpers = require('./lib/helpers');
const consts = require('./lib/constants').Constants;
const program = require('commander');
const path = require('path');
const CacheServer = require('./lib/server_v2');
const config = require('config');

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
    .option('-v, --verify', 'Verify the Cache Server integrity, without fixing errors')
    .option('-f, --fix', 'Fix errors found while verifying the Cache Server integrity')
    .option('-m, --monitor-parent-process <n>', 'Monitor a parent process and exit if it dies', myParseInt, 0)
    .parse(process.argv);

helpers.SetLogLevel(program.logLevel);

// Initialize cache
var cache;

try {
    var moduleName = config.get("Cache.module");
    var modulePath = path.resolve(config.get("Cache.path"), moduleName);
    helpers.log(consts.LOG_INFO, "Loading Cache module at " + modulePath);
    const Cache = require(modulePath);
    cache = new Cache();
}
catch(e) {
    console.log(e);
    process.exit(1);
}

if (program.verify || program.fix) {
    console.log("Verifying integrity of Cache Server directory " + program.path);
    var numErrors = cache.VerifyCache(program.fix);
    console.log("Cache Server directory contains " + numErrors + " integrity issue(s)");
    if (program.fix)
        console.log("Cache Server directory integrity fixed.");
    process.exit(0);
}

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

var errHandler = function () {
    helpers.log(consts.LOG_ERR, "Unable to start Cache Server");
    process.exit(1);
};

var server = new CacheServer(cache, program.port);

if(cluster.isMaster) {
    helpers.log(consts.LOG_INFO, "Cache Server version " + consts.VERSION);

    if(program.workers === 0) {
        server.Start(errHandler, function () {
            helpers.log(consts.LOG_INFO, `Cache Server ready on port ${server.port}`);
        });
    }

    for(let i = 0; i < program.workers; i++) {
        var worker = cluster.fork();
        cache.registerClusterWorker(worker);
    }
}
else {
    server.Start(errHandler, function () {
        helpers.log(consts.LOG_INFO, `Cache Server worker ${cluster.worker.id} ready on port ${server.port}`);
    });
}
