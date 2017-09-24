const cserver = require('./lib/server');
const globals = require('./lib/globals');
const consts = require('./lib/constants').Constants;
const program = require('commander');
const path = require('path');

const DEFAULT_PATH = __dirname + '/cache5.0';
const DEFAULT_SIZE = 1024 * 1024 * 1024 * 50;
const DEFAULT_PORT = 8126;
const DEFAULT_LOG_LEVEL = consts.LOG_TEST;

function myParseInt(val, def) {
    return parseInt(val) || def;
}

program.description("Unity Cache Server")
    .version(consts.VERSION)
    .option('-s, --size <n>', 'Specify the maximum allowed size of the LRU cache. Files that have not been used recently will automatically be discarded when the cache size is exceeded. Default is 50Gb', myParseInt, DEFAULT_SIZE)
    .option('-p, --port <n>', 'Specify the server port, only apply to new cache server, default is 8126', myParseInt, DEFAULT_PORT)
    .option('-P, --path [path]', 'Specify the path of the cache directory. Default is ./cache5.0', DEFAULT_PATH)
    .option('-l, --log-level <n>', 'Specify the level of log verbosity. Valid values are 0 (silent) through 5 (debug). Default is 4 (test)', myParseInt, DEFAULT_LOG_LEVEL)
    .option('-v, --verify', 'Verify the Cache Server integrity, without fixing errors')
    .option('-f, --fix', 'Fix errors found while verifying the Cache Server integrity')
    .option('-m, --monitor-parent-process <n>', 'Monitor a parent process and exit if it dies', myParseInt, 0)
    .parse(process.argv);

globals.SetLogLevel(program.logLevel);

if (program.verify) {
    console.log("Verifying integrity of Cache Server directory " + program.path);
    var numErrors = cserver.Verify(program.path, null, false);
    console.log("Cache Server directory contains " + numErrors + " integrity issue(s)");
    process.exit(0);
}
else if (program.fix) {
    console.log("Fixing integrity of Cache Server directory " + program.path);
    cserver.Verify(program.path, null, true);
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

cserver.Start(program.size, program.port, program.path, null, function () {
    globals.log(consts.LOG_ERR, "Unable to start Cache Server");
    process.exit(1);
});

setTimeout(function () {
    // Inform integration tests that the cache server is ready
    globals.log(consts.LOG_INFO, "Cache Server version " + cserver.GetVersion());
    globals.log(consts.LOG_INFO, "Cache Server on port " + cserver.GetPort());
    globals.log(consts.LOG_INFO, "Cache Server is ready");
}, 50);
