const cluster = require('cluster');
const path = require('path');
const helpers = require('../helpers');
const cm = require('../cluster_messages');
const consts = require('../constants');

const kDbVersionReliability = 'version_reliability_manager_versions';
const kUnreliableRootDir = '.unreliable';
const kDefaultReliabilityFactor = 0;

class ReliabilityManager {
    constructor(db, cachePath, options) {
        this._db = db;
        this._cachePath = cachePath;
        this._options = options;

        if(this._db) {
            this._db_versionReliability = db.getCollection(kDbVersionReliability);
            if (this._db_versionReliability == null) {
                this._db_versionReliability = db.addCollection(kDbVersionReliability, {
                    unique: ["versionId"],
                    indices: ["guid", "hash"]
                });
            }
        }

        cm.listenFor("_updateReliabilityFactorForVersion", async (data) => {
            return this._updateReliabilityFactorForVersion(data);
        });
    }

    /**
     *
     * @param {Object} params
     * @returns {Promise<Object>}
     * @private
     */
    async _updateReliabilityFactorForVersion(params) {
        if(cluster.isWorker) {
            return cm.send('_updateReliabilityFactorForVersion', params);
        }

        const entry = this.getEntry(params.guidStr, params.hashStr);
        if(!entry) {
            return this.createEntry(params.guidStr, params.hashStr, params.versionHashStr, kDefaultReliabilityFactor);
        }

        // Previously unstable versions cannot recover
        if(entry.factor < 0) return entry;

        if(entry.versionHash === params.versionHashStr) {
            entry.factor += 1;
            helpers.log(consts.LOG_DBG, `GUID: ${params.guidStr} Hash: ${params.hashStr} ReliabilityFactor: ${entry.factor}`);
        }
        else {
            entry.factor = -1;
            helpers.log(consts.LOG_ERR, `Unreliable version detected! GUID: ${params.guidStr} Hash: ${params.hashStr}`);
        }

        this._db_versionReliability.update(entry);
        return entry;
    }

    /**
     *
     * @param {PutTransaction} trx
     * @returns {Promise<void>}
     */
    async processTransaction(trx) {
        const params = {
            guidStr: helpers.GUIDBufferToString(trx.guid),
            hashStr: trx.hash.toString('hex'),
            versionHashStr: trx.filesHashStr,
            files: trx.files.map(f => {
                return {
                    type: f.type,
                    path: f.file,
                    byteHashStr: f.byteHash.toString('hex')
                }
            })
        };

        const info = await this._updateReliabilityFactorForVersion(params);

        if(info.factor < 0 && this._options.saveUnreliableVersionArtifacts) {
            const unreliableFilePath = path.join(this._cachePath, kUnreliableRootDir, params.guidStr, params.hashStr);
            await trx.writeFilesToPath(unreliableFilePath);
            helpers.log(consts.LOG_DBG, `Unreliable version artifacts saved to ${unreliableFilePath}`);
        }

        if(info.factor !== this._options.reliabilityThreshold) {
            helpers.log(consts.LOG_DBG, `Invalidating transaction from client at ${trx.clientAddress} for GUID: ${params.guidStr} Hash: ${params.hashStr} because ReliabilityFactor (${info.factor}) != ReliabilityThreshold (${this._options.reliabilityThreshold})`);
            await trx.invalidate();
        }
    }

    /**
     *
     * @param guidStr
     * @param hashStr
     * @returns {Object}
     */
    getEntry(guidStr, hashStr) {
        const versionId = `${guidStr}-${hashStr}`;
        return this._db_versionReliability.by("versionId", versionId);
    }

    /**
     *
     * @param guidStr
     * @param hashStr
     * @param versionHashStr
     * @param factor
     * @returns {Object}
     */
    createEntry(guidStr, hashStr, versionHashStr, factor) {
        const versionId = `${guidStr}-${hashStr}`;
        return this._db_versionReliability.insert({
            versionId: versionId,
            guid: guidStr,
            hash: hashStr,
            versionHash: versionHashStr,
            factor: factor
        });
    }

    /**
     *
     * @param guidStr
     * @param hashStr
     */
    removeEntry(guidStr, hashStr) {
        const entry = this.getEntry(guidStr, hashStr);
        if(entry)
            this._db_versionReliability.remove(entry);
    }
}

module.exports = ReliabilityManager;