/**
 * storage.js
 * IndexedDB 封装 — 持久化音频文件及元数据
 *
 * 存储结构：
 *   DB: aurora_player_db v1
 *   Store: tracks (keyPath: id, autoIncrement)
 *   Record: { id, name, audioBuffer, coverArt, lyrics, addedAt }
 */

const DB_NAME = 'aurora_player_db';
const DB_VERSION = 1;
const STORE_NAME = 'tracks';

class TrackStorage {
    constructor() {
        this._db = null;
        this._ready = null;
    }

    /* ---- 连接管理 ---- */

    async _ensureDB() {
        if (this._db) return this._db;
        if (this._ready) return this._ready;
        this._ready = this._open();
        this._db = await this._ready;
        return this._db;
    }

    _open() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                }
            };
            request.onsuccess = (e) => resolve(e.target.result);
            request.onerror = () => reject(request.error);
        });
    }

    /* ---- CRUD ---- */

    /**
     * 保存一首歌到 IndexedDB
     * @returns {Promise<number>} 自增 ID
     */
    async saveTrack(name, audioBuffer, coverArt, lyrics) {
        const db = await this._ensureDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const request = store.add({
                name,
                audioBuffer,
                coverArt: coverArt || null,
                lyrics: lyrics || null,
                addedAt: Date.now(),
            });
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * 获取所有歌曲（按添加顺序）
     * @returns {Promise<Array>}
     */
    async getAllTracks() {
        const db = await this._ensureDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.getAll();
            request.onsuccess = () => {
                const records = request.result || [];
                records.sort((a, b) => a.addedAt - b.addedAt);
                resolve(records);
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * 更新指定曲目的封面（用于用户手动上传封面后持久化）
     */
    async updateTrackCover(id, coverArt) {
        const db = await this._ensureDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const getReq = store.get(id);
            getReq.onsuccess = () => {
                const record = getReq.result;
                if (!record) return resolve(null);
                record.coverArt = coverArt;
                const putReq = store.put(record);
                putReq.onsuccess = () => resolve(id);
                putReq.onerror = () => reject(putReq.error);
            };
            getReq.onerror = () => reject(getReq.error);
        });
    }

    /**
     * 删除单首
     */
    async deleteTrack(id) {
        const db = await this._ensureDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * 更新指定曲目的歌词
     */
    async updateTrackLyrics(id, lyrics) {
        const db = await this._ensureDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const getReq = store.get(id);
            getReq.onsuccess = () => {
                const record = getReq.result;
                if (!record) return resolve(null);
                record.lyrics = lyrics;
                store.put(record).onsuccess = () => resolve(id);
            };
            getReq.onerror = () => reject(getReq.error);
        });
    }

    /**
     * 清空所有
     */
    async clearAll() {
        const db = await this._ensureDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * 曲目数量
     */
    async getCount() {
        const db = await this._ensureDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.count();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
}

export const trackStorage = new TrackStorage();
