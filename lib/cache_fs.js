'use strict';
const globals = require('./globals');
const consts = require('./constants').Constants;

const fs = require('fs');
const pathlib = require('path');

var cacheDir = "cache5.0";
var verificationFailed = false;
var verificationNumErrors = 0;

var gTotalDataSize = -1;
var maxCacheSize = 1024 * 1024 * 1024 * 50; // 50Go
var freeCacheSizeRatio = 0.9;
var freeCacheSizeRatioWriteFailure = 0.8;

var gFreeingSpaceLock = 0;

function WalkDirectory(dir, done) {
    var results = [];
    fs.readdir(dir, function (err, list) {
        if (err)
            return done(err);

        var pending = list.length;
        if (pending == 0) {
            done(null, results);
        }
        else {
            list.forEach(function (file) {
                file = dir + '/' + file;
                fs.stat(file, function (err, stat) {
                    if (!err && stat) {
                        if (stat.isDirectory()) {
                            WalkDirectory(file, function (err, res) {
                                results = results.concat(res);
                                if (!--pending)
                                    done(null, results);
                            });
                        }
                        else {
                            results.push({name: file, date: stat.mtime, size: stat.size});
                            if (!--pending) {
                                done(null, results);
                            }
                        }
                    }
                    else {
                        globals.log(consts.LOG_DBG, "Freeing space failed to extract stat from file.");
                    }
                });
            });
        }
    });
}

function FreeSpaceOfFile(removeParam) {
    LockFreeSpace();

    fs.unlink(removeParam.name, function (err) {
        if (err) {
            globals.log(consts.LOG_DBG, "Freeing cache space file can not be accessed: " + removeParam.name + err);

            // If removing the file fails, then we have to adjust the total data size back
            gTotalDataSize += removeParam.size;
        }
        else {
            globals.log(consts.LOG_TEST, " Did remove: " + removeParam.name + ". (" + removeParam.size + ")");
        }

        UnlockFreeSpace();
    });
}

function FreeSpace(freeSize) {
    if (gFreeingSpaceLock != 0) {
        globals.log(consts.LOG_DBG, "Skip free cache space because it is already in progress: " + gFreeingSpaceLock);
        return;
    }

    LockFreeSpace();

    globals.log(consts.LOG_TEST, "Begin freeing cache space. Current size: " + gTotalDataSize);

    WalkDirectory(cacheDir, function (err, files) {
        if (err)
            throw err;

        files.sort(function (a, b) {
            if (a.date == b.date)
                return 0;
            else if (a.date < b.date)
                return 1;
            else
                return -1;
        });

        while (gTotalDataSize > freeSize) {
            var remove = files.pop();
            if (!remove)
                break;

            gTotalDataSize -= remove.size;
            FreeSpaceOfFile(remove);
        }

        UnlockFreeSpace();
    });
}

function LockFreeSpace() {
    gFreeingSpaceLock++;
}

function UnlockFreeSpace() {
    gFreeingSpaceLock--;
    if (gFreeingSpaceLock == 0) {
        globals.log(consts.LOG_TEST, "Completed freeing cache space. Current size: " + gTotalDataSize);
    }
}

/**
 * @return {number}
 */
function GetDirectorySize(dir) {
    var size = 0;
    fs.readdirSync(dir).forEach(function (file) {
        file = dir + "/" + file;
        var stats = fs.statSync(file);
        if (stats.isFile())
            size += stats.size;
        else
            size += GetDirectorySize(file);
    });
    return size;
}

/**
 * @return {boolean}
 */
function ShouldIgnoreFile(file) {
    if (file.length <= 2) return true; // Skip "00" to "ff" directories
    if (file.length >= 4 && file.toLowerCase().indexOf("temp") == 0) return true; // Skip Temp directory
    if (file.length >= 9 && file.toLowerCase().indexOf(".ds_store") == 0) return true; // Skip .DS_Store file on MacOSX
    if (file.length >= 11 && file.toLowerCase().indexOf("desktop.ini") == 0) return true; // Skip Desktop.ini file on Windows
    return false;
}

// To make sure we are not working on a directory which is not cache data, and we delete all the files in it
// during LRU.
function CheckCacheDirectory(dir) {
    fs.readdirSync(dir).forEach(function (file) {
        if (!ShouldIgnoreFile(file)) {
            throw new Error("The file " + dir + "/" + file + " does not seem to be a valid cache file. Please delete it or choose another cache directory.");
        }
    });
}

function FixFileIfRequired(path, msg, fix) {
    if (fix) {
        try {
            fs.unlinkSync(path);
            globals.log(consts.LOG_DBG, msg + " File deleted.");
        }
        catch (err) {
            globals.log(consts.LOG_DBG, err);
        }
    }
    else {
        globals.log(consts.LOG_DBG, msg + " Please delete it.");
    }
}

function ValidateFile(dir, file, fix) {
    if (ShouldIgnoreFile(file)) {
        return;
    }

    // Check file name
    var pattern = /^([0-9a-f]{2})([0-9a-f]{30})-([0-9a-f]{32})\.(bin|info|resource)$/i;
    var matches = file.match(pattern);
    if (matches == null) {
        let path = cacheDir + "/" + dir + "/" + file;
        let msg = "File " + path + " doesn't match valid pattern.";
        FixFileIfRequired(path, msg, fix);
        verificationFailed = true;
        verificationNumErrors++;
        return;
    }

    // Check if first 2 characters of file corresponds to dir
    if (matches[1].toLowerCase() != dir.toLowerCase()) {
        let path = cacheDir + "/" + dir + "/" + file;
        let msg = "File " + path + " should not be in dir " + dir + ".";
        FixFileIfRequired(path, msg, fix);
        verificationFailed = true;
        verificationNumErrors++;
        return;
    }

    // Check if bin file exists for info or resource file
    if (matches[4].toLowerCase() == "info" || matches[4].toLowerCase() == "resource") {
        let checkedPath = cacheDir + "/" + dir + "/" + matches[1] + matches[2] + "-" + matches[3] + ".bin";
        try {
            fs.statSync(checkedPath);
        }
        catch (e) {
            let path = cacheDir + "/" + dir + "/" + file;
            let msg = "Missing file " + checkedPath + " for " + path + ".";
            FixFileIfRequired(path, msg, fix);
            verificationFailed = true;
            verificationNumErrors++;
        }
    }

    // Check if info file exists for bin or resource file
    if (matches[4].toLowerCase() == "bin" || matches[4].toLowerCase() == "resource") {
        let checkedPath = cacheDir + "/" + dir + "/" + matches[1] + matches[2] + "-" + matches[3] + ".info";
        try {
            fs.statSync(checkedPath);
        }
        catch (e) {
            let path = cacheDir + "/" + dir + "/" + file;
            let msg = "Missing file " + checkedPath + " for " + path + ".";
            FixFileIfRequired(path, msg, fix);
            verificationFailed = true;
            verificationNumErrors++;
        }
    }

    // check if resource file exists for audio
    if (matches[4].toLowerCase() == "info") {
        try {
            var contents = fs.readFileSync(cacheDir + "/" + dir + "/" + file, "ascii");
            if (contents.indexOf("assetImporterClassID: 1020") > 0) {
                var checkedPath = cacheDir + "/" + dir + "/" + matches[1] + matches[2] + "-" + matches[3] + ".resource";
                try {
                    fs.statSync(checkedPath);
                }
                catch (e) {
                    var path = cacheDir + "/" + dir + "/" + file;
                    var msg = "Missing audio file " + checkedPath + " for " + path + ".";
                    FixFileIfRequired(path, msg, fix);
                    path = cacheDir + "/" + dir + "/" + matches[1] + matches[2] + "-" + matches[3] + ".bin";
                    msg = "Missing audio file " + checkedPath + " for " + path + ".";
                    FixFileIfRequired(path, msg, fix);

                    verificationFailed = true;
                    verificationNumErrors++;
                }
            }
        }
        catch (e) {


        }
    }
}

function VerifyCacheDirectory(parent, dir, fix) {
    fs.readdirSync(dir).forEach(function (file) {
        var path = dir + "/" + file;
        var stats = fs.statSync(path);
        if (stats.isDirectory()) {
            if (!ShouldIgnoreFile(file)) {
                var msg = "The path " + path + " does not seem to be a valid cache path.";
                FixFileIfRequired(path, msg, fix);
                verificationFailed = true;
                verificationNumErrors++;
            }
            else {
                if (parent == null)
                    VerifyCacheDirectory(file, path, fix)
            }
        }
        else if (stats.isFile()) {
            ValidateFile(parent, file, fix);
        }
    });
}

function RenameFile(from, to, size, oldSize) {
    fs.rename(from, to, function (err) {
        // When the rename fails. We just delete the temp file. The size of the cache has not changed.
        if (err) {
            globals.log(consts.LOG_DBG, "Failed to rename file " + from + " to " + to + " (" + err + ")");
            fs.unlinkSync(from);
        }
        // When replace succeeds. We reduce the cache size by previous file size and increase by new file size.
        else {
            AddFileToCache(size - oldSize);
        }
    });
}

/**
 * @return {number}
 */
function GetFreeCacheSize() {
    return freeCacheSizeRatio * maxCacheSize;
}


exports.InitCache = function() {
    if (!fs.existsSync(cacheDir))
        fs.mkdirSync(cacheDir, 0o777);
    var hexDigits = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"];
    for (var outer = 0; outer < hexDigits.length; outer++) {
        for (var inner = 0; inner < hexDigits.length; inner++) {
            var cacheSubDir = cacheDir + "/" + hexDigits[outer] + hexDigits[inner];
            if (!fs.existsSync(cacheSubDir))
                fs.mkdirSync(cacheSubDir, 0o777);
        }
    }

    CheckCacheDirectory(cacheDir);
    gTotalDataSize = GetDirectorySize(cacheDir);

    globals.log(consts.LOG_DBG, "Cache Server directory " + GetCacheDir());
    globals.log(consts.LOG_DBG, "Cache Server size " + gTotalDataSize);
    globals.log(consts.LOG_DBG, "Cache Server max cache size " + maxCacheSize);

    if (gTotalDataSize > maxCacheSize)
        FreeSpace(GetFreeCacheSize());
};

/**
 * @return {number}
 */
exports.VerifyCache = function(fix) {
    verificationNumErrors = 0;
    if (!fs.existsSync(cacheDir))
        fs.mkdirSync(cacheDir, 0o777);

    VerifyCacheDirectory(null, cacheDir, fix);
    return verificationNumErrors;
};

function AddFileToCache(bytes) {
    if (bytes != 0) {
        gTotalDataSize += bytes;
        globals.log(consts.LOG_DBG, "Total Cache Size " + gTotalDataSize);

        if (gTotalDataSize > maxCacheSize)
            FreeSpace(GetFreeCacheSize());
    }
}

exports.AddFileToCache = AddFileToCache;

/**
 * @return {string}
 */
exports.GetCachePath = function(guid, hash, extension, create) {
    var dir = cacheDir + "/" + guid.substring(0, 2);
    if (create) {
        globals.log(consts.LOG_DBG, "Create directory " + dir);
        fs.existsSync(dir) || fs.mkdirSync(dir, 0o777);
    }

    return dir + "/" + guid + "-" + hash + "." + extension;
};

exports.ReplaceFile = function(from, to, size) {
    fs.stat(to, function (statsErr, stats) {
        // We are replacing a file, we need to subtract this from the totalFileSize
        var oldSize = 0;
        if (!statsErr && stats) {
            oldSize = stats.size;
            fs.unlink(to, function (err) {
                // When the delete fails. We just delete the temp file. The size of the cache has not changed.
                if (err) {
                    globals.log(consts.LOG_DBG, "Failed to delete file " + to + " (" + err + ")");
                    fs.unlinkSync(from);
                }
                // When delete succeeds. We rename the file..
                else {
                    RenameFile(from, to, size, oldSize);
                }
            });
        }
        else {
            RenameFile(from, to, size, 0);
        }
    });
};

exports.FreeSpaceAfterWriteFailure = function() {
    return FreeSpace(gTotalDataSize * freeCacheSizeRatioWriteFailure);
};

exports.SetCacheDir = function(dir) {
    if(dir)
        cacheDir = dir;
};

/**
 * @return {string}
 */
function GetCacheDir() {
    return pathlib.resolve(cacheDir);
}

exports.GetCacheDir = GetCacheDir;

exports.SetMaxCacheSize = function(size) {
    if(size)
        maxCacheSize = size;
};

/**
 * @return {number}
 */
exports.GetMaxCacheSize = function() {
    return maxCacheSize;
};