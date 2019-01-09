const cluster = require('cluster');
const uuid = require('uuid');
const { EventEmitter } = require('events');

const kMsgPrefix = "__ClusterMessage__";

class ClusterMessages extends EventEmitter {
    constructor() {
        super();
        this._callbacks = {};
        this._listeners = {};
        this._initMessageHandlers();
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
    async send(msg, data) {
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

            process.send(payload);
        });
    }
}

module.exports = new ClusterMessages();