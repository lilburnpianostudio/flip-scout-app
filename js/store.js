// store.js — IndexedDB mirror (ADR-006). ALL UI reads come from here; no UI
// code ever awaits the network. Records are {kind, id, data, sha, pending}.

const DB_NAME = 'flipscout';
const DB_VER = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      const rec = db.createObjectStore('records', { keyPath: 'key' });
      rec.createIndex('kind', 'kind');
      db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      db.createObjectStore('meta', { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const s = t.objectStore(storeName);
    const out = fn(s);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
  }));
}

function reqToPromise(storeName, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const r = fn(t.objectStore(storeName));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

const key = (kind, id) => kind + ':' + id;

// ---- records ----
export function upsertLocal(kind, id, data, { pending = true, sha = null } = {}) {
  return tx('records', 'readwrite', (s) => s.put({ key: key(kind, id), kind, id, data, sha, pending }));
}

export function get(kind, id) {
  return reqToPromise('records', 'readonly', (s) => s.get(key(kind, id)));
}

export function getAll(kind) {
  return reqToPromise('records', 'readonly', (s) => s.index('kind').getAll(kind));
}

// Case-insensitive substring search across the given data fields.
export async function search(kind, query, fields) {
  const rows = await getAll(kind);
  const q = (query || '').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => fields.some((f) => String(r.data[f] || '').toLowerCase().includes(q)));
}

export function markSynced(kind, id, sha) {
  return get(kind, id).then((rec) => {
    if (!rec) return;
    rec.pending = false;
    rec.sha = sha || rec.sha;
    return tx('records', 'readwrite', (s) => s.put(rec));
  });
}

// ---- outbox ----
export function outboxAdd(op) {
  return tx('outbox', 'readwrite', (s) => s.add(op));
}
export function outboxAll() {
  return reqToPromise('outbox', 'readonly', (s) => s.getAll());
}
export function outboxDelete(seq) {
  return tx('outbox', 'readwrite', (s) => s.delete(seq));
}
export function outboxPut(op) {
  return tx('outbox', 'readwrite', (s) => s.put(op));
}
export function outboxCount() {
  return reqToPromise('outbox', 'readonly', (s) => s.count());
}

// ---- meta (counter cache, hydration stamps) ----
export function metaGet(k) {
  return reqToPromise('meta', 'readonly', (s) => s.get(k)).then((r) => (r ? r.v : undefined));
}
export function metaSet(k, v) {
  return tx('meta', 'readwrite', (s) => s.put({ k, v }));
}

// ---- signout wipe (story 1.1 contract) ----
export function wipe() {
  dbPromise = null;
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}
