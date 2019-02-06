const helpers = require('../lib/helpers');
require('cluster').setMaxListeners(25);

process.on('unhandledRejection', (reason) => {
    console.error(reason);
});

helpers.setLogger(() => {});