'use strict';
const cluster = require('cluster');
const helpers = require('./helpers');
const consts = require('./constants').Constants;
const fs = require('fs');

const freeCacheSizeRatio = 0.9;

class CacheFS {
    constructor(path, maxSize) {
        this._cacheDir = path;
        this._maxCacheSize = maxSize;
        this._totalDataSize = -1;
        this._freeingSpaceLock = 0;
        this._InitCache();
    }

    get cacheDir() {
        return this._cacheDir;
    }

    get maxCacheSize() {
        return this._maxCacheSize;
    }

    set maxCacheSize(size) {
        this._maxCacheSize = Math.max(0, parseInt(size));
    }

    get totalDataSize() {
        return this._totalDataSize;
    }

    /**
     * @return {boolean}
     */
    static ShouldIgnoreFile(file) {
        if (file.length <= 2) return true; // Skip "00" to "ff" directories
        if (file.length >= 4 && file.toLowerCase().indexOf("temp") == 0) return true; // Skip Temp directory
        if (file.length >= 9 && file.toLowerCase().indexOf(".ds_store") == 0) return true; // Skip .DS_Store file on MacOSX
        if (file.length >= 11 && file.toLowerCase().indexOf("desktop.ini") == 0) return true; // Skip Desktop.ini file on Windows
        return false;
    }

    static CheckCacheDirectory(dir) {
        fs.readdirSync(dir).forEach(function (file) {
            if (!CacheFS.ShouldIgnoreFile(file)) {
                throw new Error("The file " + dir + "/" + file + " does not seem to be a valid cache file. Please delete it or choose another cache directory.");
            }
        });
    }

    static FixFileIfRequired(path, msg, fix) {
        if (fix) {
            try {
                var stat = fs.statSync(path);
                if (stat.isDirectory())
                    fs.rmdirSync(path);
                else
                    fs.unlinkSync(path);
                helpers.log(consts.LOG_DBG, msg + " File deleted.");
            }
            catch (err) {
                helpers.log(consts.LOG_DBG, err);
            }
        }
        else {
            helpers.log(consts.LOG_DBG, msg + " Please delete it.");
        }
    }
    
    /**
     *
     * @param dir
     * @returns {number}
     */
    static GetDirectorySize(dir) {
        var size = 0;
        fs.readdirSync(dir).forEach(function (file) {
            file = dir + "/" + file;
            var stats = fs.statSync(file);
            if (stats.isFile())
                size += stats.size;
            else
                size += CacheFS.GetDirectorySize(file);
        });

        return size;
    }

    _InitCache() {
        if (!fs.existsSync(this.cacheDir))
            fs.mkdirSync(this.cacheDir, 0o777);
        var hexDigits = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"];
        for (var outer = 0; outer < hexDigits.length; outer++) {
            for (var inner = 0; inner < hexDigits.length; inner++) {
                var cacheSubDir = this.cacheDir + "/" + hexDigits[outer] + hexDigits[inner];
                if (!fs.existsSync(cacheSubDir))
                    fs.mkdirSync(cacheSubDir, 0o777);
            }
        }

        CacheFS.CheckCacheDirectory(this.cacheDir);
        this._totalDataSize = CacheFS.GetDirectorySize(this.cacheDir);

        helpers.log(consts.LOG_DBG, "Cache Server directory " + this.cacheDir);
        helpers.log(consts.LOG_DBG, "Cache Server size " + this.totalDataSize);
        helpers.log(consts.LOG_DBG, "Cache Server max cache size " + this.maxCacheSize);

        if (this.totalDataSize > this.maxCacheSize)
            this._FreeSpace(this.GetFreeCacheSize());
    };

    _WalkDirectory(dir, done) {
        var results = [];
        var self = this;
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
                                self._WalkDirectory(file, function (err, res) {
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
                            helpers.log(consts.LOG_DBG, "Freeing space failed to extract stat from file.");
                        }
                    });
                });
            }
        });
    }

    _FreeSpaceOfFile(removeParam) {
        this._LockFreeSpace();

        var self = this;
        fs.unlink(removeParam.name, function (err) {
            if (err) {
                helpers.log(consts.LOG_DBG, "Freeing cache space file can not be accessed: " + removeParam.name + err);

                // If removing the file fails, then we have to adjust the total data size back
                self._totalDataSize += removeParam.size;
            }
            else {
                helpers.log(consts.LOG_TEST, " Did remove: " + removeParam.name + ". (" + removeParam.size + ")");
            }

            self._UnlockFreeSpace();
        });
    }

    _FreeSpace(freeSize) {
        if (this._freeingSpaceLock != 0) {
            helpers.log(consts.LOG_DBG, "Skip free cache space because it is already in progress: " + this._freeingSpaceLock);
            return;
        }

        this._LockFreeSpace();

        helpers.log(consts.LOG_TEST, "Begin freeing cache space. Current size: " + this.totalDataSize);

        var self = this;
        this._WalkDirectory(this.cacheDir, function (err, files) {
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

            while (self.totalDataSize > freeSize) {
                var remove = files.pop();
                if (!remove)
                    break;

                self._totalDataSize -= remove.size;
                self._FreeSpaceOfFile(remove);
            }

            self._UnlockFreeSpace();
        });
    }

    _LockFreeSpace() {
        this._freeingSpaceLock++;
    }

    _UnlockFreeSpace() {
        this._freeingSpaceLock--;
        if (this._freeingSpaceLock == 0) {
            helpers.log(consts.LOG_TEST, "Completed freeing cache space. Current size: " + this.totalDataSize);
        }
    }

    /**
     *
     * @param dir
     * @param file
     * @param fix
     * @returns {number}
     */
    _ValidateFile(dir, file, fix) {
        if (CacheFS.ShouldIgnoreFile(file)) {
            return 0;
        }

        // Check file name
        var pattern = /^([0-9a-f]{2})([0-9a-f]{30})-([0-9a-f]{32})\.(bin|info|resource)$/i;
        var matches = file.match(pattern);
        if (matches == null) {
            let path = dir ? this.cacheDir + "/" + dir + "/" + file : this.cacheDir + "/" + file;
            let msg = "File " + path + " doesn't match valid pattern.";
            CacheFS.FixFileIfRequired(path, msg, fix);
            return 1;
        }

        // Check if first 2 characters of file corresponds to dir
        if (matches[1].toLowerCase() != dir.toLowerCase()) {
            let path = this.cacheDir + "/" + dir + "/" + file;
            let msg = "File " + path + " should not be in dir " + dir + ".";
            CacheFS.FixFileIfRequired(path, msg, fix);
            return 1;
        }

        // Check if bin file exists for info or resource file
        if (matches[4].toLowerCase() == "info" || matches[4].toLowerCase() == "resource") {
            let checkedPath = this.cacheDir + "/" + dir + "/" + matches[1] + matches[2] + "-" + matches[3] + ".bin";
            if(!fs.existsSync(checkedPath)) {
                let path = this.cacheDir + "/" + dir + "/" + file;
                let msg = "Missing file " + checkedPath + " for " + path + ".";
                CacheFS.FixFileIfRequired(path, msg, fix);
                return 1;
            }
        }

        // Check if info file exists for bin or resource file
        if (matches[4].toLowerCase() == "bin" || matches[4].toLowerCase() == "resource") {
            let checkedPath = this.cacheDir + "/" + dir + "/" + matches[1] + matches[2] + "-" + matches[3] + ".info";
            if(!fs.existsSync(checkedPath)) {
                let path = this.cacheDir + "/" + dir + "/" + file;
                let msg = "Missing file " + checkedPath + " for " + path + ".";
                CacheFS.FixFileIfRequired(path, msg, fix);
                return 1;
            }
        }

        // check if resource file exists for audio
        if (matches[4].toLowerCase() == "info") {
            try {
                var contents = fs.readFileSync(this.cacheDir + "/" + dir + "/" + file, "ascii");
                if (contents.indexOf("assetImporterClassID: 1020") > 0) {
                    var checkedPath = this.cacheDir + "/" + dir + "/" + matches[1] + matches[2] + "-" + matches[3] + ".resource";
                    if(!fs.existsSync(checkedPath)) {
                        var path = this.cacheDir + "/" + dir + "/" + file;
                        var msg = "Missing audio file " + checkedPath + " for " + path + ".";
                        CacheFS.FixFileIfRequired(path, msg, fix);
                        path = this.cacheDir + "/" + dir + "/" + matches[1] + matches[2] + "-" + matches[3] + ".bin";
                        msg = "Missing audio file " + checkedPath + " for " + path + ".";
                        CacheFS.FixFileIfRequired(path, msg, fix);
                        return 2;
                    }
                }
            }
            catch (e) {
            }
        }

        return 0;
    }

    /**
     *
     * @param parent
     * @param dir
     * @param fix
     * @returns {number}
     */
    _VerifyCacheDirectory(parent, dir, fix) {
        let errCount = 0;

        var self = this;
        fs.readdirSync(dir).forEach(function (file) {
            let path = dir + "/" + file;
            let stats = fs.statSync(path);
            if (stats.isDirectory()) {
                if (!CacheFS.ShouldIgnoreFile(file)) {
                    let msg = "The path " + path + " does not seem to be a valid cache path.";
                    CacheFS.FixFileIfRequired(path, msg, fix);
                    errCount++;
                }
                else {
                    if (parent == null)
                        errCount += self._VerifyCacheDirectory(file, path, fix)
                }
            }
            else if (stats.isFile()) {
                errCount += self._ValidateFile(parent, file, fix);
            }
        });

        return errCount;
    }

    _RenameFileSync(from, to, size, oldSize) {
        try {
            helpers.log(consts.LOG_DBG, "Rename " + from + " to " + to);

            fs.renameSync(from, to);

            // When replace succeeds. We reduce the cache size by previous file size and increase by new file size.
            this._AddFileToCache(size - oldSize);
        }
        catch (err) {
            // When the rename fails. We just delete the temp file. The size of the cache has not changed.
            helpers.log(consts.LOG_DBG, "Failed to rename file " + from + " to " + to + " (" + err + ")");
            fs.unlinkSync(from);
        }
    }

    _AddFileToCache(bytes) {
        if (bytes != 0) {
            this._totalDataSize += bytes;
            helpers.log(consts.LOG_DBG, "Total Cache Size " + this.totalDataSize);

            if (this.totalDataSize > this.maxCacheSize)
                this._FreeSpace(this.GetFreeCacheSize());
        }
    }

    _CreateCacheDir(guid) {
        // Only the cluster master should manage the cache file system
        if(!cluster.isMaster) {
            process.send({
                msg: "CacheFS.cmd",
                func: "_CreateCacheDir",
                args: [guid]
            });

            return;
        }

        var dir = this.cacheDir + "/" + guid.substring(0, 2);
        if(!fs.existsSync(dir)) {
            helpers.log(consts.LOG_DBG, "Create directory " + dir);
            fs.mkdirSync(dir, 0o777);
        }
    }

    /**
     * @return {number}
     */
    GetFreeCacheSize() {
        return freeCacheSizeRatio * this.maxCacheSize;
    }

    /**
     * @return {number}
     */
    VerifyCache(fix) {
        var numErrs = this._VerifyCacheDirectory(null, this.cacheDir, false);

        if(fix) {
            if(cluster.isMaster) {
                numErrs = this._VerifyCacheDirectory(null, this.cacheDir, true);
            }
            else {
                // Only the cluster master should manage the cache file system
                process.send({
                    msg: "CacheFS.cmd",
                    func: "VerifyCache",
                    args: [true]
                });
            }
        }

        return numErrs;
    }

    /**
     * @return {string}
     */
    GetCachePath(guid, hash, extension, create) {
        var dir = this.cacheDir + "/" + guid.substring(0, 2);

        if (create)
            this._CreateCacheDir(guid);

        return dir + "/" + guid + "-" + hash + "." + extension;
    }

    ReplaceFile(from, to, size) {
        // Only the cluster master should manage the cache file system
        if(!cluster.isMaster) {
            process.send({
                msg: "CacheFS.cmd",
                func: "ReplaceFile",
                args: [from, to, size]
            });

            return;
        }

        var stats = {};
        try {
            stats = fs.statSync(to);

            // We are replacing a file, we need to subtract this from the totalFileSize
            var oldSize = stats.size;

            try {
                fs.unlinkSync(to);

                // When delete succeeds. We rename the file..
                this._RenameFileSync(from, to, size, oldSize);
            }
            catch (err) {
                // When the delete fails. We just delete the temp file. The size of the cache has not changed.
                helpers.log(consts.LOG_DBG, "Failed to delete file " + to + " (" + err + ")");
                fs.unlinkSync(from);
            }
        }
        catch (err) {
            this._RenameFileSync(from, to, size, 0);
        }
    }

    RegisterClusterWorker(worker) {
        var self = this;
        worker.on('message', function(msg) {
            if(msg.msg && msg.msg === 'CacheFS.cmd') {
                self[msg.func].apply(self, msg.args);
            }
        });
    }
}

module.exports = CacheFS;