// A tiny key-value store on IndexedDB, falling back to memory where IndexedDB is unavailable
// (private windows, tests). Used for the offline timeline cache and the outbox.
const DB_NAME = 'family-network';
const STORE = 'kv';
const memory = new Map();

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const hasIdb = () => typeof indexedDB !== 'undefined';

export async function get(key) {
  if (!hasIdb()) return memory.get(key);
  try {
    const value = await run('readonly', (s) => s.get(key));
    return value === undefined ? memory.get(key) : value;
  } catch {
    return memory.get(key);
  }
}

export async function set(key, value) {
  memory.set(key, value);
  if (!hasIdb()) return;
  try { await run('readwrite', (s) => s.put(value, key)); } catch { /* memory copy still works */ }
}

export async function del(key) {
  memory.delete(key);
  if (!hasIdb()) return;
  try { await run('readwrite', (s) => s.delete(key)); } catch { /* ignore */ }
}
