#!/usr/bin/env node
const helpers = require('./lib/helpers');
helpers.initConfigDir(__dirname);

const consts = require('./lib/constants');
const cmd = require('commander');
const net = require('net');
const fs = require('fs-extra');
const filesize = require('filesize');
const crypto = require('crypto');
const ServerStreamProcessor = require('./lib/client/server_stream_processor');
const ClientStreamProcessor = require('./lib/server/client_stream_processor');
const ClientStreamDebugger = require('./lib/server/client_stream_debugger');

const RECEIVE_DATA_TIMEOUT = 500;

let nullServer = null;

cmd.arguments('<filePath> [ServerAddress]')
    .option('-i --iterations <n>', 'Number of times to send the recorded session to the server', 1)
    .option('-c --max-concurrency <n>', 'Number of concurrent connections to make to the server', 1)
    .option('-d --debug-protocol', 'Print protocol stream debugging data to the console', false)
    .option('-q --no-verbose', 'Do not show progress and result statistics')
    .action((filePath, serverAddress) => {
        serverSetup(serverAddress)
            .then(sa => run(filePath, sa, cmd.iterations, cmd.maxConcurrency))
            .then(stats => {
                if(nullServer !== null) nullServer.close();
                if(cmd.verbose) {
                    if(stats.bytesSent > 0) {
                        const sendTime = stats.sendTime / 1000;
                        const sendBps = stats.bytesSent / sendTime || 0;
                        console.log(`Sent ${filesize(stats.bytesSent)} in ${sendTime} seconds (${filesize(sendBps)}/second)`);
                    }

                    if(stats.bytesReceived > 0) {
                        const receiveTime = stats.receiveTime / 1000;
                        const receiveBps = stats.bytesReceived / receiveTime || 0;
                        console.log(`Received ${filesize(stats.bytesReceived)} in ${receiveTime} seconds (${filesize(receiveBps)}/second)`);
                    }
                }
            })
            .catch(err => {
                console.log(err);
                process.exit(1);
            });
    });

cmd.parse(process.argv);

async function serverSetup(serverAddress) {
    if(serverAddress) return serverAddress;

    nullServer = net.createServer({}, socket => {
        socket.on('data', () => {});
    });

    return new Promise(resolve => {
        nullServer.listen(0, "0.0.0.0", () => {
            const a = nullServer.address();
            resolve(`${a.address}:${a.port}`);
        });
    });
}

async function run(filePath, serverAddress, i, c) {
    const jobs = [];
    const results = [];
    while(jobs.length < i) {
        const jobNum = jobs.length + 1;
        jobs.push(() => {
            if(cmd.verbose && i > 1) console.log(`Playing iteration ${jobNum}/${i}`);
            return playStream(filePath, serverAddress)
                .then(stats => results.push(stats))
                .catch(err => { throw(err); });
        });
    }

    while(jobs.length > 0) {
        const next = jobs.splice(0, c);
        await Promise.all(next.map(t => t()));
    }

    return results.reduce((prev, cur) => {
        cur.bytesSent += prev.bytesSent;
        cur.bytesReceived += prev.bytesReceived;
        cur.sendTime += prev.sendTime;
        cur.receiveTime += prev.receiveTime;
        return cur;
    }, {
        receiveTime: 0,
        bytesReceived: 0,
        sendTime: 0,
        bytesSent: 0
    });
}

async function playStream(filePath, serverAddress) {
    let timer = null;
    let bytesReceived = 0, receiveStartTime, receiveEndTime, sendStartTime, sendEndTime, dataHash;
    const debugProtocol = cmd.debugProtocol;

    if(!await fs.pathExists(filePath)) throw new Error(`Cannot find ${filePath}`);
    const fileStats = await fs.stat(filePath);
    const address = await helpers.parseAndValidateAddressString(serverAddress, consts.DEFAULT_PORT);
    const client = net.createConnection(address.port, address.host, () => {});

    const setTimer = () => {
        timer = setTimeout(() => client.end(''), RECEIVE_DATA_TIMEOUT);
    };

    const fileStream = fs.createReadStream(filePath);

    fileStream.on('open', () => {
        sendStartTime = Date.now();
    }).on('close', () => {
        sendEndTime = Date.now();
    });

    const ssp = new ServerStreamProcessor();

    ssp.once('header', () => {
        receiveStartTime = Date.now();
    }).on('header', header => {
        if(debugProtocol) {
            dataHash = crypto.createHash('sha256');

            const debugData = [header.cmd];
            if(header.size) {
                debugData.push(header.size);
            }

            debugData.push(helpers.GUIDBufferToString(header.guid));
            debugData.push(header.hash.toString('hex'));

            const txt = `<<< ${debugData.join(' ')}`;
            if(header.size) {
                process.stdout.write(txt);
            } else {
                console.log(txt)
            }
        }

        clearTimeout(timer);
    }).on('data', (chunk) => {
        if(debugProtocol) dataHash.update(chunk, 'ascii');
        bytesReceived += chunk.length;
    }).on('dataEnd', () => {
        if(debugProtocol) console.log(` <BLOB ${dataHash.digest().toString('hex')}>`);
        receiveEndTime = Date.now();
        setTimer();
    });

    setTimer();

    const csp = new ClientStreamProcessor({});
    const csd = new ClientStreamDebugger({});

    csd.on('debug', data => {
        if(cmd.debugProtocol) {
            console.log(`>>> ${data.join(' ')}`);
        }
    });

    fileStream.pipe(csp).pipe(csd).pipe(client, {end: false}).pipe(ssp);

    return new Promise(resolve => {
        client.on('close', () => {
            resolve({
                bytesSent: fileStats.size,
                bytesReceived: bytesReceived,
                sendTime: sendEndTime - sendStartTime,
                receiveTime: receiveEndTime - receiveStartTime,
            });
        });
    });
}