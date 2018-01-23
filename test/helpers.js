const assert = require('assert');
const helpers = require('../lib/helpers');

describe("Helper functions", () => {
    const guid = Buffer.from([80,127,95,145,103,153,135,123,185,19,13,54,122,207,246,26]);
    const guidStr = "05f7f519769978b79b31d063a7fc6fa1";

    describe("GUIDBufferToString", () => {
        it("should convert a 16 byte buffer to a hex representation that matches Unity's string formatter for GUIDs", () => {
            assert(helpers.GUIDBufferToString(guid) === guidStr);
        });

        it("should throw an error if the input is not a buffer or the wrong length", () => {
            assert.throws(helpers.GUIDBufferToString.bind(null, null), Error);
            assert.throws(helpers.GUIDBufferToString.bind(null, Buffer.from([])), Error);
            assert.throws(helpers.GUIDBufferToString.bind(null, Buffer.alloc(17, 0)), Error);
        });
    });

    describe("GUIDStringToBuffer", () => {
        it("should convert a 32 character hex string that represents a Unity GUID to an equivalent byte buffer", () => {
            assert(guid.compare(helpers.GUIDStringToBuffer(guidStr)) === 0);

        });

        it("should throw an error if the input value is not a string or is the wrong length", () => {
            assert.throws(helpers.GUIDStringToBuffer.bind(null, null));
            assert.throws(helpers.GUIDStringToBuffer.bind(null, ''));
            assert.throws(helpers.GUIDStringToBuffer.bind(null, guidStr + 'x'));
        });
    });

    describe("isBuffer", () => {
        it("should correctly identify whether or not passed value is a type of Buffer", () => {
            assert(helpers.isBuffer(Buffer.from([])));
            assert(!helpers.isBuffer({}));
            assert(!helpers.isBuffer(null));
        })
    });
});