const cserver = require('./lib/server');
const globals = require('./lib/globals');
const consts = require('./lib/constants').Constants;
const cachefs = require('./lib/cache_fs');
const program = require('commander');
const path = require('path');
const cluster = require('cluster');

function myParseInt(val, def) {
    val = parseInt(val);
    return (!val && val !== 0) ? def : val;
}

program.description("Unity Cache Server")
    .version(consts.VERSION)
    .option('-s, --size <n>', 'Specify the maximum allowed size of the LRU cache. Files that have not been used recently will automatically be discarded when the cache size is exceeded. Default is 50Gb', myParseInt, consts.DEFAULT_CACHE_SIZE)
    .option('-p, --port <n>', 'Specify the server port, only apply to new cache server, default is 8126', myParseInt, consts.DEFAULT_PORT)
    .option('-P, --path [path]', 'Specify the path of the cache directory. Default is ./cache5.0', consts.DEFAULT_CACHE_DIR)
    .option('-l, --log-level <n>', 'Specify the level of log verbosity. Valid values are 0 (silent) through 5 (debug). Default is 4 (test)', myParseInt, consts.DEFAULT_LOG_LEVEL)
    .option('-c, --cluster', 'Launch the Cache Server with multiple worker threads. Default is one per the number of OS reported CPUs.')
    .option('-w, --workers', 'Number of worker threads to spawn in the cluster. Default is one per CPU reported by the OS', consts.DEFAULT_WORKERS)
    .option('-v, --verify', 'Verify the Cache Server integrity, without fixing errors')
    .option('-f, --fix', 'Fix errors found while verifying the Cache Server integrity')
    .option('-m, --monitor-parent-process <n>', 'Monitor a parent process and exit if it dies', myParseInt, 0)
    .parse(process.argv);

globals.SetLogLevel(program.logLevel);

if (program.verify || program.fix) {
    console.log("Verifying integrity of Cache Server directory " + program.path);
    cachefs.SetCacheDir(program.path);
    var numErrors = cachefs.VerifyCache(program.fix);
    console.log("Cache Server directory contains " + numErrors + " integrity issue(s)");
    if(program.fix)
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
            globals.log(consts.LOG_INFO, "monitored parent process has died");
            process.exit(1);
        }
        setTimeout(monitor, 1000);
    }

    monitor();
}

var server = cserver.Start(program.size, program.port, program.path, null, function () {
    globals.log(consts.LOG_ERR, "Unable to start Cache Server");
    process.exit(1);
});

setTimeout(function () {
    // Inform integration tests that the cache server is ready
    globals.log(consts.LOG_INFO, "Cache Server version " + consts.VERSION);
    globals.log(consts.LOG_INFO, "Cache Server on port " + server.address().port);
    globals.log(consts.LOG_INFO, "Cache Server is ready");
}, 50);
