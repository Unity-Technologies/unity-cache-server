const cluster = require('cluster');
const path = require('path');
const helpers = require('../helpers');
const consts = require('../constants');
const crypto = require('crypto');
const _ = require('lodash');

const kDbVersionReliability = 'version_reliability_manager_versions';
const kUnreliableRootDir = '.unreliable';
const defaultOptions = {
    reliabilityThreshold: 0,
    multiClient: false
};

class ReliabilityManager {
    constructor(db, cachePath, options) {
        this._id = ++ReliabilityManager._idCounter;
        this._kMsgUpdateReliabilityFactor = `_updateReliabilityFactorForVersion.${this._id}`;
        this._db = db;
        this._cachePath = cachePath;
        this._options = options || {};
        _.defaults(this._options, defaultOptions);

        if(this._db) {
            this._db_versionReliability = db.getCollection(kDbVersionReliability);
            if (this._db_versionReliability == null) {
                this._db_versionReliability = db.addCollection(kDbVersionReliability, {
                    unique: ["versionId"],
                    indices: ["guid", "hash"]
                });
            }
        }

        if(cluster.isMaster) {
            cluster.on('message', (worker, msg) => {
                if(msg._msg === this._kMsgUpdateReliabilityFactor) {
                    return this._updateReliabilityFactorForVersion(msg);
                }
            });
        }
    }

    /**
     *
     * @param {Object} params
     * @returns {Promise<Object>}
     * @private
     */
    async _updateReliabilityFactorForVersion(params) {
        if(cluster.isWorker) {
            params._msg = this._kMsgUpdateReliabilityFactor;
            return process.send(params);
        }

        const entry = this.getEntry(params.guidStr, params.hashStr, true);
        if(!entry.versionHash) {
            entry.versionHash = params.versionHashStr;
        }

        if(entry.state !== ReliabilityManager.reliabilityStates.Pending) {
            if(entry.state === ReliabilityManager.reliabilityStates.ReliableNew) {
                entry.state = ReliabilityManager.reliabilityStates.Reliable;
                this._db_versionReliability.update(entry);
            }

            return entry;
        }

        if(this._options.multiClient && params.clientId === entry.clientId) {
            helpers.log(consts.LOG_DBG, `Ignoring duplicate transaction for GUID: ${params.guidStr} Hash: ${params.hashStr} from previous client (multiClient = true)`);
            return entry;
        }

        entry.clientId = params.clientId;

        if(entry.versionHash === params.versionHashStr) {
            entry.factor += 1;
            helpers.log(consts.LOG_DBG, `GUID: ${params.guidStr} Hash: ${params.hashStr} ReliabilityFactor: ${entry.factor}`);
        }
        else {
            entry.state = ReliabilityManager.reliabilityStates.Unreliable;
            helpers.log(consts.LOG_ERR, `Unreliable version detected! GUID: ${params.guidStr} Hash: ${params.hashStr}`);
        }

        if(entry.factor >= this._options.reliabilityThreshold)
            entry.state = ReliabilityManager.reliabilityStates.ReliableNew;

        this._db_versionReliability.update(entry);

        entry.wasUpdated = true;
        return entry;
    }

    /**
     *
     * @param {PutTransaction} trx
     * @returns {Promise<void>}
     */
    async processTransaction(trx) {
        if(!trx.isValid) return;

        const params = {
            guidStr: helpers.GUIDBufferToString(trx.guid),
            hashStr: trx.hash.toString('hex'),
            versionHashStr: trx.filesHashStr,
            clientId: crypto.createHash('md5').update(trx.clientAddress).digest().toString('hex'),
            files: trx.files.map(f => {
                return {
                    type: f.type,
                    path: f.file,
                    byteHashStr: f.byteHash.toString('hex')
                }
            })
        };

        const info = await this._updateReliabilityFactorForVersion(params);

        if(info.state === ReliabilityManager.reliabilityStates.Unreliable && this._options.saveUnreliableVersionArtifacts) {
            const unreliableFilePath = path.join(this._cachePath, kUnreliableRootDir, params.guidStr, params.hashStr);
            await trx.writeFilesToPath(unreliableFilePath);
            helpers.log(consts.LOG_DBG, `Unreliable version artifacts saved to ${unreliableFilePath}`);
        }

        if(info.state !== ReliabilityManager.reliabilityStates.ReliableNew) {
            helpers.log(consts.LOG_DBG, `Invalidating transaction from client at ${trx.clientAddress} for GUID: ${params.guidStr} Hash: ${params.hashStr} ReliabilityState: ${info.state.toString()}`);
            await trx.invalidate();
        }
    }

    /**
     *
     * @param {string} guidStr
     * @param {string} hashStr
     * @param {boolean} create
     * @returns {null|Object}
     */
    getEntry(guidStr, hashStr, create = false) {
        const versionId = `${guidStr}-${hashStr}`;
        let entry = this._db_versionReliability.by("versionId", versionId);

        if(!entry && create === true) {
            entry = this._db_versionReliability.insert({
                versionId: versionId,
                guid: guidStr,
                hash: hashStr,
                factor: 0,
                state: ReliabilityManager.reliabilityStates.Pending
            });
        }

        return entry;
    }

    /**
     *
     * @param guidStr
     * @param hashStr
     */
    removeEntry(guidStr, hashStr) {
        this._db_versionReliability.findAndRemove({versionId: `${guidStr}-${hashStr}`});
    }
}

ReliabilityManager.reliabilityStates = {
    Unreliable: 'Unreliable',
    Pending: 'Pending',
    ReliableNew: 'ReliableNew',
    Reliable: 'Reliable'
};

ReliabilityManager._idCounter = 0;

module.exports = ReliabilityManager;