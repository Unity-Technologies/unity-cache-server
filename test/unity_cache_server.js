require('./test_init');
const assert = require('assert');
const helpers = require('../lib/helpers');
const consts = require('../lib/constants');
const tmp = require('tmp-promise');
const yaml = require('js-yaml');
const fs = require('fs-extra');
const path = require('path');
const { purgeConfig, sleep } = require('./test_utils');
const { UnityCacheServer } = require('../lib/unity_cache_server');
const cmd = require('commander');
const net = require('net');
const sinon = require('sinon');

describe("Unity Cache Server bootstrap", () => {
    beforeEach(() => purgeConfig());

    describe("dumpConfig", () => {

        before(() => this._log = helpers.log);
        after(() => helpers.setLogger(this._log));

        it("should log the current config and exit", () => {
            let verified = false;
            helpers.setLogger((lvl, msg) => {
                if(/_test/.test(msg))
                    verified = true;
            });

            process.env.NODE_CONFIG = JSON.stringify({
                _test: 1
            });

            UnityCacheServer.dumpConfig();
            assert.ok(verified);
        });
    });

    describe("saveConfig", () => {

        before(async () => {
            this.tmpDir = await tmp.dir({unsafeCleanup: true});
            this.cwd = process.cwd();
        });

        after(() => {
            process.chdir(this.cwd);
        });

        it("should write the current config to the specified path", async () => {
            const tmpFile = await tmp.tmpName({dir: this.tmpDir.path});
            UnityCacheServer.saveConfig(tmpFile);
            assert.ok(await fs.pathExists(tmpFile));
            const configStr = await fs.readFile(tmpFile);
            const configParsed = yaml.safeLoad(configStr);
            assert.deepEqual(require('config'), configParsed);
        });

        it("should write 'default.yml' to the current directory if no path is specified", async () => {
            process.chdir(this.tmpDir.path);
            UnityCacheServer.saveConfig();
            assert.ok(await fs.pathExists('default.yml'));
        });

        it("should not overwrite a config that exists at the target path", async () => {
            const tmpFile = await tmp.file({dir: this.tmpDir.path});
            assert.ok(await fs.pathExists(tmpFile.path));
            assert.throws(() => UnityCacheServer.saveConfig(tmpFile.path));
        });
    });

    describe("getMirrors", () => {
        it("should return an array of objects with host/port properties for all configured mirrors", async () => {
            process.env.NODE_CONFIG = JSON.stringify({
                Mirror: { addresses: ["1.2.3.4:4321", "8.8.8.8"] }
            });

            const mirrors = await UnityCacheServer.getMirrors();
            assert.equal(2, mirrors.length);
            assert.deepEqual([
                { host: "1.2.3.4", port: 4321 },
                { host: "8.8.8.8", port: 8126 }
            ], mirrors);
        });

        it("should throw an error if 127.0.0.1 is configured as a mirror", async () => {
            process.env.NODE_CONFIG = JSON.stringify({
                Mirror: { addresses: ["127.0.0.1"] }
            });

            UnityCacheServer.getMirrors()
                .then(() => { throw new Error("Expected exception"); }, (err) => assert(err));
        });
    });

    describe("handleCommandLine", () => {
        before(() => {
            sinon.stub(process, "exit").callsFake(() => {});

            this._log = helpers.log;
            this.opts = {
                test: {
                    flags: "-t --test <n>",
                    description: "Test option",
                    validator: parseInt,
                    configKey: "_test"
                }
            };

            const argv = process.argv.concat(['-l', 5, '-t', 99]);
            UnityCacheServer.handleCommandLine(cmd, this.opts, argv);
        });

        afterEach(() => helpers.setLogger(this._log));

        after(() => sinon.restore());

        it("should parse the given CLI option map and configure the given Commander object", () => {
            assert.equal(cmd.options.length, 4); // 3 common options plus one custom from this test suite
            const opt = cmd.options[0];
            assert.equal(opt.flags, this.opts.test.flags);
            assert.equal(opt.description, this.opts.test.description);
        });

        it("should parse CLI arguments (process.argv)", () => {
            assert.equal(cmd.test, 99);
        });

        it("should set config values for applicable CLI options", () => {
            const config = require('config');
            assert.ok(config.has("_test"));
            assert.equal(config.get("_test"), 99);
        });

        it("should set the logging level", () => {
            const config = require('config');
            assert.equal(config.get(consts.CLI_CONFIG_KEYS.LOG_LEVEL), 5);
        });

        it("should invoke the dump-config command", () => {
            let verified = false;
            helpers.setLogger((lvl, msg) => {
                if(/_test/.test(msg))
                    verified = true;
            });

            const argv = process.argv.slice(0, 2).concat(['--dump-config']);
            UnityCacheServer.handleCommandLine(cmd, this.opts, argv);
            assert.ok(verified);
        });

        it("should invoke the save-config command and exit the process", async () => {
            const tmpDir = await tmp.dir({unsafeCleanup: true});
            const tmpName = await tmp.tmpNameSync({dir: tmpDir.path});
            const tmpPath = path.join(tmpDir.path, tmpName);
            const argv = process.argv.concat(['--save-config', tmpPath]);
            UnityCacheServer.handleCommandLine(cmd, this.opts, argv);
            assert(await fs.pathExists(tmpPath));
        });
    });

    describe("initCache", () => {
        before(() => {
            UnityCacheServer.constructor._cache_instance = null;
            this._tmpPath = tmp.tmpNameSync();

            this._cacheOpts = {
                test: true,
                persistenceOptions: {
                    autosave: false
                }
            };

            process.env.NODE_CONFIG = JSON.stringify({
                Cache: {
                    defaultModule: "cache_fs",
                    options: { cache_fs: { cachePath: this._tmpPath } }
                }
            });
        });

        it("should construct an instance of a cache module based on the current config", async () => {
            this._cache = await UnityCacheServer.initCache(this._cacheOpts);
            assert.notEqual(this._cache, null);
            assert.ok(this._cache._options.test);
        });

        it("should set the given cache path if specified on the CLI", async () => {
            assert.equal(this._cache._options.cachePath, this._tmpPath);
        });

        it("should return the same cache module instance on subsequent invocations", async () => {
            assert.strictEqual(await UnityCacheServer.initCache(), this._cache);
        });
    });

    describe("start", () => {
        before(async () => {
            UnityCacheServer.constructor._cache_instance = null;
            const tmpPath = tmp.tmpNameSync();

            process.env.NODE_CONFIG = JSON.stringify({
                Server: {
                        port: 0
                    },
                Cache: {
                    defaultModule: "cache_fs",
                    options: {
                        workers: 1, // test to ensure clustering is disabled automatically
                        cache_fs: {
                            cachePath: tmpPath
                        }
                    }
                },
                Diagnostics: {
                    clientRecorder: true,
                    saveDir: tmpPath
				}
            });

            const opts = {
                test: true,
                persistenceOptions: {
                    autosave: false
                }
            };

            this._cache = await UnityCacheServer.initCache(opts);

            sinon.stub(this._cache.constructor, "properties").get(() => {
                return {
                    clustering: false, // test to ensure clustering is disabled automatically
                    cleanup: true
                }
            });
        });

        afterEach(() => {
            sinon.restore();
        });

        it("should start the cache server", async () => {
            this._server = await UnityCacheServer.start();
            assert(this._server);

            return new Promise((resolve, reject) => {
                const client = net.connect({port: this._server.port}, () => {
                    client.removeAllListeners('error');
                    client.end();
                    resolve();
                });

                client.on('error', (err) => {
                    reject(err);
                })
            });
        });

        it("should construct a client recorder and pass it to the server", async () => {
            assert.ok(this._server.isRecordingClient);
        });

        it("should setup the server error handler", async () => {
            return new Promise(resolve => {
                sinon.stub(process, "exit").callsFake(() => resolve());
                this._server._server.emit('error', new Error());
            });
        });

        it("should setup the CTRL-C handler", () => {
            return new Promise(resolve => {
                sinon.stub(process, "exit").callsFake(() => resolve());

                // Only test SIGTERM, as mocha itself listens to SIGINT
                process.kill(process.pid, 'SIGTERM');
            });
        });
    });

    describe("cleanup", function() {
        this.slow(300);

        before(async () => {
            this._logLevel = helpers.getLogLevel();
            helpers.setLogLevel(0);

            const opts = {
                persistenceOptions: {
                    autosave: false
                }
            };

            this._cache = await UnityCacheServer.initCache(opts);
        });

        afterEach(() => sinon.restore());

        after(() => {
            UnityCacheServer._cache_instance = null;
            helpers.setLogLevel(this._logLevel);
        });

        it("should invoke the cache cleanup process without the dryrun flag", async () => {
            const cleanupSpy = sinon.spy(this._cache, "cleanup");
            const eventSpy1 = sinon.spy();
            const eventSpy2 = sinon.spy();
            const eventSpy3 = sinon.spy();
            const eventSpy4 = sinon.spy();
            this._cache.on('cleanup_delete_item', eventSpy1);
            this._cache.on('cleanup_delete_finish', eventSpy2);
            this._cache.on('cleanup_search_progress', eventSpy3);
            this._cache.on('cleanup_search_finish', eventSpy4);

            await UnityCacheServer.cleanup(false);
            assert(eventSpy1.notCalled);
            assert(eventSpy2.calledOnce);
            assert(eventSpy3.calledOnce);
            assert(eventSpy4.calledOnce);
            assert(cleanupSpy.calledWith(false));
        });

        it("should error and exit if the cache module does not support caching", async () => {
            sinon.stub(this._cache.constructor, "properties").get(() => {
                return { cleanup: false }
            });

            const exitStub = sinon.stub(process, "exit").callsFake((code) => {
                assert.equal(code, 1);
            });

            await UnityCacheServer.cleanup();
            assert(exitStub.calledOnce);
        });

        it("should run repeatedly when started in daemon mode", async () => {
            const cleanupSpy = sinon.spy(this._cache, "cleanup");
            const p = UnityCacheServer.cleanup(true, 50);
            await sleep(150);
            assert(cleanupSpy.callCount > 1);
            sinon.stub(process, "exit").callsFake(() => {});
            process.kill(process.pid, 'SIGTERM');
            return p;
        });

        it("should exit in a timely manner when interrupted in daemon mode", async () => {
            sinon.spy(this._cache, "cleanup");
            const p = UnityCacheServer.cleanup(true, 5000);
            sinon.stub(process, "exit").callsFake(() => {});
            process.kill(process.pid, 'SIGTERM');
            return p;
        });
    });
});
