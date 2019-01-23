const cluster = require('cluster');
const uuid = require('uuid');
const { EventEmitter } = require('events');
const consts = require('./constants');
const helpers = require('./helpers');

const kMsgPrefix = "__ClusterMessage__";
const kCallbackTimeout = 5000;

class ClusterMessages extends EventEmitter {
    constructor() {
        super();
        this._callbacks = {};
        this._listeners = {};
        this._initMessageHandlers();
    }

    /**
     *
     * @param {String} msg
     * @param {Number} timeout
     * @private
     */
    _scheduleCallbackDeletion(msg, timeout) {
        setTimeout(() => {
            if(this._callbacks.hasOwnProperty(msg)) {
                helpers.log(consts.LOG_WARN, `Warning: ClusterMessage callback timeout, deleting: ${msg}`);
                delete this._callbacks[message.msgId];
            }
        }, timeout);
    }

    _initMessageHandlers() {
        if(cluster.isMaster) {
            cluster.on('message', (worker, message) => {
                if(!message || !message.hasOwnProperty(kMsgPrefix)) return;

                const msg = message[kMsgPrefix];
                if (!this._listeners.hasOwnProperty(msg)) return;

                Promise.resolve()
                    .then(() => this._listeners[msg](message.data))
                    .then(result => {
                        const payload = {
                            msgId: message.msgId,
                            result: result
                        };

                        payload[kMsgPrefix] = msg;

                        cluster.workers[message.workerId].send(payload);
                    });
            });
        }
        else {
            process.on('message', (message) => {
                if(!message || !message.hasOwnProperty('msgId')) return;

                const cb = this._callbacks[message.msgId];
                if(!cb) return;

                cb.resolve(message.result);
                delete this._callbacks[message.msgId];
            });
        }
    }

    /**
     *
     * @param {String} msg
     * @param {Function<Promise<any>>} listener
     */
    listenFor(msg, listener) {
        this._listeners[msg] = listener;
    }

    /**
     *
     * @param {String} msg
     * @param {Object} data
     * @returns {Promise<*>}
     */
    async send(msg, data, timeout = kCallbackTimeout) {
        if(!cluster.isWorker) return Promise.reject("Function can only be called from a worker node.");

        return new Promise((resolve, reject) => {
            const payload = {
                msgId: uuid.v4(),
                data: data,
                workerId: cluster.worker.id
            };

            payload[kMsgPrefix] = msg;

            this._callbacks[payload.msgId] = {
                resolve: resolve,
                reject: reject
            };

            this._scheduleCallbackDeletion(payload.msgId, timeout);
            process.send(payload);
        });
    }
}

module.exports = ClusterMessages;