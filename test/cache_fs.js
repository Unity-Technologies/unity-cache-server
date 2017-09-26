'use strict';
const assert = require('assert');
const fs = require('fs');
const globals = require('../lib/globals');
const CacheFS = require('../lib/cache_fs');

describe("CacheFS", function() {
    describe("Init", function() {
        it("should throw an error if the given cache folder is not recognized as a valid cache", function() {
            var p = globals.generateTempDir();
            fs.mkdirSync(p);
            var f = p + "/veryImportantDoc.doc";
            fs.writeFileSync(f);

            var err = null;
            try {
                new CacheFS(p, 0);
            }
            catch(e) {
                err = e;
            }
            finally {
                assert(err);
            }
        });
    });
});