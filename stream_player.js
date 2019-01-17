#!/usr/bin/env node
const helpers = require('./lib/helpers');
helpers.initConfigDir(__dirname);

const consts = require('./lib/constants');
const program = require('commander');
const net = require('net');
const fs = require('fs-extra');
const filesize = require('filesize');
const crypto = require('crypto');
const ServerStreamProcessor = require('./lib/client/server_stream_processor');
const ClientStreamProcessor = require('./lib/server/client_stream_processor');
const ClientStreamDebugger = require('./lib/server/client_stream_debugger');

program.arguments('<filePath> [ServerAddress]')
    .option('-i --iterations <n>', 'Number of times to send the recorded session to the server', 1)
    .option('-c --max-concurrency <n>', 'Number of concurrent connections to make to the server', 1)
    .option('-d --debug-protocol', 'Print protocol stream debugging data to the console', false)
    .option('-q --no-verbose', 'Do not show progress and result statistics')
    .action((filePath, serverAddress) => {
        const options = {
            numIterations: parseInt(program.iterations),
            numConcurrent: parseInt(program.maxConcurrency),
            verbose: program.verbose,
            debugProtocol: program.debugProtocol
        };

        run(filePath, serverAddress, options)
            .then(stats => {
                if(options.verbose) {
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

program.parse(process.argv);

async function run(filePath, serverAddress, options) {
    let nullServer = null;

    if(!serverAddress) {
        nullServer = net.createServer({}, socket => {
            socket.on('data', () => {});
        });

        await new Promise(resolve => {
            nullServer.listen(0, "0.0.0.0", () => resolve());
        });
    }

    if(nullServer !== null) {
        const a = nullServer.address();
        serverAddress = `${a.address}:${a.port}`;
    }

    // Gather files
    const files = [];
    const stat = await fs.stat(filePath);
    if(stat.isDirectory()) {
        await helpers.readDir(filePath, f => files.push(f.path));
    }
    else {
        files.push(filePath);
    }

    // Validate files
    const verBuf = Buffer.alloc(consts.VERSION_SIZE, 'ascii');
    for(let i = 0; i < files.length; i++) {
        const fd = await fs.open(files[i], "r");
        await fs.read(fd, verBuf, 0, consts.VERSION_SIZE, 0);
        if(helpers.readUInt32(verBuf) !== consts.PROTOCOL_VERSION) {
            if(options.verbose) {
                console.log(`Skipping unrecognized file ${files[i]}`);
            }
            files[i] = null;
        }

        await fs.close(fd);
    }

    const jobs = [];
    const results = [];
    let i = 0;
    while(i < options.numIterations) {
        files.forEach(f => {
            if(f === null) return;
            jobs.push((n, t) => {
                if(options.verbose) console.log(`[${n}/${t}] Playing ${f}`);
                return playStream(f, serverAddress, options)
                    .then(stats => results.push(stats))
                    .catch(err => { throw(err); });
            });
        });

        i++;
    }

    const totalJobs = jobs.length;
    let nextJobNum = 0;
    while(jobs.length > 0) {
        nextJobNum += Math.min(jobs.length, options.numConcurrent);
        const next = jobs.splice(0, options.numConcurrent);
        await Promise.all(next.map(t => t(nextJobNum, totalJobs)));
    }

    if(nullServer !== null) nullServer.close();

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

async function playStream(filePath, serverAddress, options) {
    let bytesReceived = 0, receiveStartTime, receiveEndTime, sendStartTime, sendEndTime, dataHash;

    if(!await fs.pathExists(filePath)) throw new Error(`Cannot find ${filePath}`);

    const fileStats = await fs.stat(filePath);
    const address = await helpers.parseAndValidateAddressString(serverAddress, consts.DEFAULT_PORT);
    const client = new net.Socket();
    await new Promise(resolve => client.connect(address.port, address.host, () => resolve()));

    const fileStream = fs.createReadStream(filePath);

    fileStream.on('open', () => {
        sendStartTime = Date.now();
    }).on('close', () => {
        sendEndTime = Date.now();
    });

    let reqCount = 0;

    const ssp = new ServerStreamProcessor();

    ssp.once('header', () => {
        receiveStartTime = Date.now();
    }).on('header', () => {
        reqCount--;
        if(reqCount === 0) client.end('');
    }).on('data', (chunk) => {
        bytesReceived += chunk.length;
    }).on('dataEnd', () => {
        receiveEndTime = Date.now();
    });

    if(options.debugProtocol) {
        ssp.on('header', header => {
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
        }).on('data', (chunk) => {
            dataHash.update(chunk, 'ascii');
        }).on('dataEnd', () => {
            console.log(` <BLOB ${dataHash.digest().toString('hex')}>`);
        });
    }

    const csp = new ClientStreamProcessor({});

    csp.on('cmd', cmd => {
        if(cmd[0] === 'g') reqCount++;
    });

    let stream = fileStream.pipe(csp);

    if(options.debugProtocol) {
        stream = stream.pipe(new ClientStreamDebugger({}))
            .on('debug', data => console.log(`>>> ${data.join(' ')}`));
    }

    stream.pipe(client, {end: false}).pipe(ssp);

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