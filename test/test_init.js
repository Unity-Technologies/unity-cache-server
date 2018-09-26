const helpers = require('../lib/helpers');

process.on('unhandledRejection', (reason) => {
    console.error(reason);
});

helpers.setLogger(() => {});