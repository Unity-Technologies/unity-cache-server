const helpers = require('../lib/helpers');
const consts = require('../lib/constants');

require('cluster').setMaxListeners(25);

process.on('unhandledRejection', (reason) => {
    console.error(reason);
});

helpers.setLogger(() => {});
helpers.setLogLevel(consts.LOG_DBG);