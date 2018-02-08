const helpers = require('./lib/helpers');
const program = require('commander');
const consts = require('./lib/constants');
const fs = require('fs-extra');
const filesize = require('filesize');
const Client = require('./lib/client/client');

function myParseInt(val, def) {
    val = parseInt(val);
    return (!val && val !== 0) ? def : val;
}

const DEFAULT_SERVER_ADDRESS = 'localhost:8126';

program.description("Unity Cache Server - Project Import")
    .version(require('./package').version)
    .description('Imports Unity project Library data into a local or remote Cache Server.')
    .arguments('<TransactionFilePath> [ServerAddress]')
    .option('-l, --log-level <n>', 'Specify the level of log verbosity. Valid values are 0 (silent) through 5 (debug).', myParseInt, consts.DEFAULT_LOG_LEVEL)
    .option('--no-timestamp-check', 'Do not use timestamp check to protect against importing files from a project that has changed since last exported.', true)
    .option('--skip <n>', 'Skip to transaction # in the import file at startup.', myParseInt, 0)
    .action((projectRoot, serverAddress) => {
        helpers.setLogLevel(program.logLevel);
        serverAddress = serverAddress || DEFAULT_SERVER_ADDRESS;
        importTransactionFile(projectRoot, serverAddress, consts.DEFAULT_PORT)
            .catch(err => {
                console.log(err);
                process.exit(1);
            });
    });

program.parse(process.argv);

async function importTransactionFile(filePath, addressString, defaultPort) {

    let address = await helpers.parseAndValidateAddressString(addressString, defaultPort);

    if(!await fs.pathExists(filePath)) throw new Error(`Cannot find ${filePath}`);
    let data = await fs.readJson(filePath);
    if(!data.hasOwnProperty('transactions')) throw new Error(`Invalid transaction data!`);

    let client = new Client(address.host, address.port, {});
    await client.connect();

    const trxCount = data.transactions.length;
    const trxStart = Math.min(trxCount - 1, Math.max(0, program.skip - 1));
    const startTime = Date.now();
    let sentBytes = 0;
    let sentAssetCount = 0;
    let sentFileCount = 0;

    for(let i = trxStart; i < trxCount; i++) {
        const trx = data.transactions[i];
        const guid = helpers.GUIDStringToBuffer(trx.guid);
        const hash = Buffer.from(trx.hash, 'hex');

        helpers.log(consts.LOG_INFO, `(${i + 1}/${trxCount}) ${trx.assetPath}`);

        try {
            helpers.log(consts.LOG_DBG, `Begin transaction for ${helpers.GUIDBufferToString(guid)}-${hash.toString('hex')}`);
            await client.beginTransaction(guid, hash);
        }
        catch (err) {
            helpers.log(consts.LOG_ERR, err);
            process.exit(1);
        }

        let stats;

        for (let file of trx.files) {

            try {
                stats = await fs.stat(file.path);
            }
            catch(err) {
                helpers.log(consts.LOG_ERR, err);
                continue;
            }

            if (program.timestampCheck && stats.mtimeMs !== file.ts * 1000) {
                helpers.log(consts.LOG_WARN, `${file.path} has been modified, skipping`);
                continue;
            }

            try {
                const stream = fs.createReadStream(file.path);
                helpers.log(consts.LOG_DBG, `Putting file of type: ${file.type} size: ${stats.size}`);
                await client.putFile(file.type, guid, hash, stream, stats.size);
            }
            catch(err) {
                helpers.log(consts.LOG_ERR, err);
                process.exit(1);
            }

            sentBytes += stats.size;
            sentFileCount++;
        }

        try {
            helpers.log(consts.LOG_DBG, `End transaction for ${helpers.GUIDBufferToString(guid)}-${hash.toString('hex')}`);
            await client.endTransaction();
            sentAssetCount++;
        }
        catch (err) {
            helpers.log(consts.LOG_ERR, err);
            process.exit(1);
        }
    }

    let totalTime = (Date.now() - startTime) / 1000;
    let throughput = (sentBytes / totalTime).toFixed(2);
    helpers.log(consts.LOG_INFO, `Sent ${sentFileCount} files for ${sentAssetCount} assets (${filesize(sentBytes)}) in ${totalTime} seconds (${filesize(throughput)}/sec)`);

    return client.quit();
}
