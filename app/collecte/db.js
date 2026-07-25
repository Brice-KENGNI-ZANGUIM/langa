// Stockage local hors-ligne des contributions (IndexedDB).
// Conserve texte + audio (Blob) sur l'appareil, avec un statut de synchro.

const DB_NAME = "collecte-nge";
const DB_VERSION = 1;
const STORE = "contributions";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "client_id" });
        os.createIndex("status", "status", { unique: false });
        os.createIndex("created_at", "created_at", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

export const DB = {
  async put(record) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const r = tx(db, "readwrite").put(record);
      r.onsuccess = () => resolve(record);
      r.onerror = () => reject(r.error);
    });
  },

  async get(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const r = tx(db, "readonly").get(id);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
  },

  async all() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const r = tx(db, "readonly").getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
  },

  async pending() {
    const items = await this.all();
    return items.filter((x) => x.status !== "sent");
  },

  async delete(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const r = tx(db, "readwrite").delete(id);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  },

  async markSent(id, serverId) {
    const rec = await this.get(id);
    if (!rec) return;
    rec.status = "sent";                 // « sent » = CONFIRMÉ présent dans la base distante
    rec.server_id = serverId || rec.server_id || null;
    rec.sent_at = rec.sent_at || new Date().toISOString();
    return this.put(rec);
  },

  /** Incrémente le compteur de tentatives d'envoi (pour la boucle de renvoi + l'affichage). */
  async bumpAttempt(id) {
    const rec = await this.get(id);
    if (!rec) return;
    rec.attempts = (rec.attempts || 0) + 1;
    rec.last_attempt = new Date().toISOString();
    return this.put(rec);
  },

  async counts() {
    const items = await this.all();
    return {
      total: items.length,
      pending: items.filter((x) => x.status !== "sent").length,
      sent: items.filter((x) => x.status === "sent").length,
    };
  },
};
