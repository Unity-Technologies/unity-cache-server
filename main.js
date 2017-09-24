var cserver = require('./lib/server');
var globals = require('./lib/globals');
var consts = require('./lib/constants').Constants;

var path = require('path');

/**
 * parse cmd line argument
 * @todo should use existing module, like optimist
 *
 * @return {Object} an object containing the parsed arguments if found
 */
function ParseArguments() {
    var res = {};
    res.legacy = true;
    res.legacyCacheDir = "./cache";
    res.cacheDir = "./cache5.0";
    res.verify = false;
    res.fix = false;
    res.monitorParentProcess = 0;
    res.logFunc = null;
    for (var i = 2; i < process.argv.length; i++) {
        var arg = process.argv[i];

        if (arg.indexOf("--size") == 0) {
            res.size = parseInt(process.argv[++i]);
        }
        else if (arg.indexOf("--path") == 0) {
            res.cacheDir = process.argv[++i];
        }
        else if (arg.indexOf("--port") == 0) {
            res.port = parseInt(process.argv[++i]);
        }
        else if (arg.indexOf("--monitor-parent-process") == 0) {
            res.monitorParentProcess = process.argv[++i];
        }
        else if (arg.indexOf("--verify") == 0) {
            res.verify = true;
            res.fix = false;
        }
        else if (arg.indexOf("--fix") == 0) {
            res.verify = false;
            res.fix = true;
        }
        else if (arg.indexOf("--silent") == 0) {
            res.logFunc = function () {
            };
        }
        else {
            if (arg.indexOf("--help") != 0) {
                console.log("Unknown option: " + arg);
            }
            console.log("Usage: node main.js [--port serverPort] [--path pathToCache] [--legacypath pathToCache] [--size maximumSizeOfCache] [--nolegacy] [--verify|--fix]\n" +
                "--port: specify the server port, only apply to new cache server, default is 8126\n" +
                "--path: specify the path of the cache directory, only apply to new cache server, default is ./cache5.0\n" +
                "--size: specify the maximum allowed size of the LRU cache for both servers. Files that have not been used recently will automatically be discarded when the cache size is exceeded\n" +
                "--verify: verify the Cache Server integrity, no fix.\n" +
                "--fix: fix the Cache Server integrity."
            );
            process.exit(0);
        }
    }

    return res;
}

var res = ParseArguments();
if (res.verify) {
    console.log("Verifying integrity of Cache Server directory " + res.cacheDir);
    var numErrors = cserver.Verify(res.cacheDir, null, false);
    console.log("Cache Server directory contains " + numErrors + " integrity issue(s)");
    process.exit(0);
}

if (res.fix) {
    console.log("Fixing integrity of Cache Server directory " + res.cacheDir);
    cserver.Verify(res.cacheDir, null, true);
    console.log("Cache Server directory integrity fixed.");
    process.exit(0);
}

if (res.monitorParentProcess != 0) {
    function monitor() {
        function is_running(pid) {
            try {
                return process.kill(pid, 0)
            }
            catch (e) {
                return e.code === 'EPERM'
            }
        }

        if (!is_running(res.monitorParentProcess)) {
            globals.log(consts.LOG_INFO, "monitored parent process has died");
            process.exit(1);
        }
        setTimeout(monitor, 1000);
    }

    monitor();
}

cserver.Start(res.size, res.port, res.cacheDir, res.logFunc, function () {
    globals.log(consts.LOG_ERR, "Unable to start Cache Server");
    process.exit(1);
});

setTimeout(function () {
    // Inform integration tests that the cache server is ready
    globals.log(consts.LOG_INFO, "Cache Server version " + cserver.GetVersion());
    globals.log(consts.LOG_INFO, "Cache Server on port " + cserver.GetPort());
    globals.log(consts.LOG_INFO, "Cache Server is ready");
}, 50);
