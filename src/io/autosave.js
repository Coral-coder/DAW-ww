// IndexedDB persistence of projects in the browser ('dawww' db, 'projects' store).
// In environments without IndexedDB (Node), list/load/delete resolve to empty results and
// saveLocal rejects with a readable error.
import { uid } from '../core/util.js';

const DB_NAME = 'dawww';
const STORE = 'projects';
const DB_VERSION = 1;

export const isAutosaveAvailable = () => typeof indexedDB !== 'undefined' && indexedDB !== null;

let dbPromise = null;
function openDb() {
  if (!isAutosaveAvailable()) return Promise.reject(new Error('Local storage (IndexedDB) is not available.'));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('modifiedAt', 'modifiedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error || new Error('Could not open IndexedDB.')); };
      req.onblocked = () => { dbPromise = null; reject(new Error('IndexedDB is blocked by another tab.')); };
    });
  }
  return dbPromise;
}

function run(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    const req = fn(store);
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
  }));
}

/** Ensures the project has an `id` (adds one via uid('prj')). */
export function ensureProjectId(project) {
  if (!project.id) project.id = uid('prj');
  return project.id;
}

/** Saves (insert/replace) the project. Resolves to { id, name, modifiedAt }. */
export async function saveLocal(project) {
  if (!isAutosaveAvailable()) throw new Error('Local storage (IndexedDB) is not available.');
  const id = ensureProjectId(project);
  const record = {
    id,
    name: project.name || 'Untitled Project',
    modifiedAt: project.modifiedAt || new Date().toISOString(),
    savedAt: new Date().toISOString(),
    // stored as JSON text: robust against non-cloneable values and cheap to restore
    json: JSON.stringify(project),
  };
  await run('readwrite', (s) => s.put(record));
  return { id, name: record.name, modifiedAt: record.modifiedAt };
}

/**
 * One-time migration: copy projects from databases created by earlier versions of the app
 * (named "<old-name>-daw" with the same 'projects' store) into the current database.
 */
let migrated = null;
function migrateLegacy() {
  if (migrated) return migrated;
  migrated = (async () => {
    if (typeof indexedDB.databases !== 'function') return;
    const dbs = await indexedDB.databases().catch(() => []);
    for (const { name } of dbs) {
      if (!name || name === DB_NAME || !/-daw$/.test(name)) continue;
      const old = await new Promise((res) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      });
      if (!old || !old.objectStoreNames.contains(STORE)) { old?.close(); continue; }
      const records = await new Promise((res) => {
        const req = old.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        req.onsuccess = () => res(req.result || []);
        req.onerror = () => res([]);
      });
      old.close();
      for (const rec of records) {
        const exists = await run('readonly', (st) => st.get(rec.id));
        if (!exists) await run('readwrite', (st) => st.put(rec));
      }
      indexedDB.deleteDatabase(name);
    }
  })().catch(() => {});
  return migrated;
}

/** [{ id, name, modifiedAt }] newest first. Resolves [] when IndexedDB is unavailable. */
export async function listLocal() {
  if (!isAutosaveAvailable()) return [];
  await migrateLegacy();
  const all = (await run('readonly', (s) => s.getAll())) || [];
  return all
    .map((r) => ({ id: r.id, name: r.name, modifiedAt: r.modifiedAt, savedAt: r.savedAt }))
    .sort((a, b) => String(b.savedAt || b.modifiedAt).localeCompare(String(a.savedAt || a.modifiedAt)));
}

/** Loads a project by id (null if missing / unavailable). */
export async function loadLocal(id) {
  if (!isAutosaveAvailable()) return null;
  const rec = await run('readonly', (s) => s.get(id));
  if (!rec) return null;
  return rec.json ? JSON.parse(rec.json) : rec.project || null;
}

export async function deleteLocal(id) {
  if (!isAutosaveAvailable()) return false;
  await run('readwrite', (s) => s.delete(id));
  return true;
}

/**
 * Saves the store's project shortly after every change (debounced).
 * Returns { stop(), flush(), get lastSaved, get lastError }.
 */
export function createAutosaver(store, { intervalMs = 2000, onSave, onError } = {}) {
  let timer = null;
  let knownId = store.get()?.id || null;
  let lastSaved = null;
  let lastError = null;
  const save = async () => {
    timer = null;
    const project = store.get();
    if (!project) return;
    if (!project.id && knownId) project.id = knownId; // undo may restore a snapshot without id
    try {
      const info = await saveLocal(project);
      knownId = info.id;
      lastSaved = info;
      lastError = null;
      onSave?.(info);
    } catch (e) {
      lastError = e;
      onError?.(e);
    }
  };
  const schedule = () => {
    if (!isAutosaveAvailable()) return;
    clearTimeout(timer);
    timer = setTimeout(save, intervalMs);
  };
  const offChange = store.on('change', schedule);
  const offLoad = store.on('load', (p) => { knownId = p?.id || null; });
  return {
    stop() { clearTimeout(timer); timer = null; offChange?.(); offLoad?.(); },
    async flush() { if (timer) { clearTimeout(timer); } await save(); },
    get lastSaved() { return lastSaved; },
    get lastError() { return lastError; },
  };
}
