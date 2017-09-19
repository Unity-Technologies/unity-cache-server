const assert = require('assert');
const globals = require('./globals');
const EventEmitter = require('events');

const MAX_HEADER_SIZE = globals.ID_SIZE;

class CmdResponseListener extends EventEmitter {
    constructor(socket) {
        super();
        socket.on('data', this.handleResponseData.bind(this));
        socket.on('error', this.handleResponseError.bind(this));
        socket.on('close', this.handleResponseClose.bind(this));
        socket.on('end', this.handleResponseClose.bind(this));

        this.headerBuf = Buffer.allocUnsafe(MAX_HEADER_SIZE);
        this.responseBuffer = [];
        this.isProcessingBuffer = false;
        this.init();
    }

    init() {
        this.headerBufPos = 0;
        this.doReadSize = false;
        this.doReadId = false;
        this.blobBytesRead = 0;

        this.didReadVersion = false;
        this.didReadCommand = false;
        this.didReadSize = false;
        this.didReadId = false;
        this.didReadHeader = false;

        this.headerData = {
            version: 0,
            cmd: "",
            size: 0,
            guid: null,
            hash: null
        }
    }

    handleResponseData(data) {
        if(this.responseBuffer.length == 0 && !this.isProcessingBuffer)
            process.nextTick(this.processResponseBuffer.bind(this));

        this.responseBuffer.push(data);
    }
    
    handleResponseError(error) {
        this.isProcessingBuffer = false;
        this.emit('error', error);
    }
    
    handleResponseClose() {
        this.emit('end');
    }

    processResponseBuffer() {
        if(this.responseBuffer.length == 0)
            return;

        this.isProcessingBuffer = true;

        var self = this;
        var buf = this.responseBuffer.shift();
        var bufPos = 0;

        function fillHeaderBuf(fillToPos) {
            var maxLen = fillToPos - self.headerBufPos;
            var toCopy = Math.min(buf.length, maxLen);
            buf.copy(self.headerBuf, self.headerBufPos, bufPos, bufPos + toCopy);
            bufPos += toCopy;
            self.headerBufPos += toCopy;

            if(fillToPos == self.headerBufPos) {
                self.headerBufPos = 0;
                return true;
            }

            return false;
        }

        function isDone() {
            var isDone = bufPos >= buf.length || self.didReadHeader;
            if(isDone) {
                self.isProcessingBuffer = false;
                process.nextTick(self.processResponseBuffer.bind(self));
            }

            return isDone;
        }

        // Finished with header; handle blob data
        if(this.didReadHeader) {
            var len = Math.min(this.headerData.size - this.blobBytesRead, buf.length);
            this.blobBytesRead += len;
            var more = (this.blobBytesRead < this.headerData.size);

            if(len < buf.length) {
                // put the rest back in the queue to process as a new command
                this.responseBuffer.unshift(Buffer.from(buf.slice(len)));
                this.emit('data', buf.slice(0, len), more);
            }
            else {
                this.emit('data', buf, more);
            }

            if(!more) {
                // Done reading blob data - reset everything
                this.init();
                process.nextTick(this.processResponseBuffer.bind(this));
            }

            this.isProcessingBuffer = false;
            return;
        }

        // Read version
        if(!this.didReadVersion && fillHeaderBuf(globals.VERSION_SIZE)) {
            this.headerData.version = globals.bufferToInt32(this.headerBuf.slice(0, globals.VERSION_SIZE));
            this.didReadVersion = true;
        }

        if(isDone()) { return; }

        // Read command
        if(!this.didReadCommand && fillHeaderBuf(globals.CMD_SIZE)) {
            var cmd = this.headerBuf.slice(0, globals.CMD_SIZE).toString('ascii');
            this.headerData.cmd = cmd;
            switch(cmd[0]) {
                case '+': // file found
                    this.doReadSize = true;
                    this.doReadId = true;
                    break;
                case '-': // file not found
                    this.doReadSize = false;
                    this.doReadId = true;
                    break;
                case 'i': // integrity check
                    this.doReadSize = true;
                    this.doReadId = false;
                    break;
                default:
                    this.handleResponseError("Unrecognized command response, aborting!");
                    return;
            }

            this.didReadCommand = true;
        }

        if(isDone()) { return; }

        // Read size
        if(this.doReadSize && !this.didReadSize && fillHeaderBuf(globals.SIZE_SIZE)) {
            this.headerData.size = globals.bufferToInt64(this.headerBuf.slice(0, globals.UINT64_SIZE));
            this.didReadSize = true;
        }

        if(isDone()) { return; }

        // Read ID
        if(this.doReadId && !this.didReadId && fillHeaderBuf(globals.ID_SIZE)) {
            this.headerData.guid = this.headerBuf.slice(0, globals.GUID_SIZE);
            this.headerData.hash = this.headerBuf.slice(globals.GUID_SIZE);
            this.didReadId = true;
        }

        // Put any remainder back on top of the queue
        if(bufPos < buf.length) {
            this.responseBuffer.unshift(Buffer.from(buf.slice(bufPos)));
        }

        this.didReadHeader = true;
        self.emit('header', self.headerData);

        return isDone();
    }
}

module.exports = CmdResponseListener;