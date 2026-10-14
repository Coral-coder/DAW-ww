// Named project versions (snapshots) in IndexedDB, next to the autosaved projects.
// DB 'daw3-versions' / store 'versions': { id, projectId, name, note, author, createdAt, json }.
// Snapshots keep sample metadata but not the bytes (those live in the project / autosave);
// restoring takes sample data from the current project. Versions can ride along in a .daW3 file
// as `versions: [...]` (exportWithVersions / takeImportedVersions).
import { uid } from '../core/util.js';

const DB = 'daw3-versions';
const STORE = 'versions';
export const isVersioningAvailable = () => typeof indexedDB !== 'undefined' && indexedDB !== null;

let dbp = null;
function db() {
  if (!isVersioningAvailable()) return Promise.reject(new Error('IndexedDB is not available.'));
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const os = req.result.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('projectId', 'projectId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbp = null; reject(req.error); };
    });
  }
  return dbp;
}

function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    let out;
    const r = fn(t.objectStore(STORE));
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
  }));
}

/** Project -> snapshot JSON without sample bytes and without per-user fields. */
export function snapshotJson(project) {
  const { samples = {}, versions, ...rest } = project;
  const metas = {};
  for (const [id, s] of Object.entries(samples)) { if (s) { const { data, ...m } = s; metas[id] = m; } }
  return JSON.stringify({ ...rest, samples: metas });
}

/** Snapshot JSON -> full project, sample bytes from `current` where available. */
export function hydrateSnapshot(json, current) {
  const p = typeof json === 'string' ? JSON.parse(json) : json;
  const samples = {};
  for (const [id, m] of Object.entries(p.samples || {})) {
    const data = current?.samples?.[id]?.data;
    if (data) samples[id] = { ...m, data };
  }
  p.samples = samples;
  return p;
}

export function makeVersion(project, name, { author = null, note = '', parentId = null } = {}) {
  return { id: uid('ver'), projectId: project.id || null, name: name || 'Version', note, author, parentId, createdAt: new Date().toISOString(), json: snapshotJson(project) };
}

export async function saveVersion(project, name, opts) {
  const v = makeVersion(project, name, opts);
  await tx('readwrite', (s) => s.put(v));
  return v;
}

export async function putVersions(list) { for (const v of list) await tx('readwrite', (s) => s.put(v)); }

export async function listVersions(projectId) {
  if (!isVersioningAvailable()) return [];
  const all = (await tx('readonly', (s) => s.index('projectId').getAll(projectId || ''))) || [];
  return all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function getVersion(id) { return tx('readonly', (s) => s.get(id)); }
export async function deleteVersion(id) { return tx('readwrite', (s) => s.delete(id)); }

/** The project plus its versions, for "Save with versions". */
export async function exportWithVersions(project) {
  const versions = await listVersions(project.id);
  return { ...project, versions: versions.map(({ id, name, note, author, parentId, createdAt, json }) => ({ id, name, note, author, parentId, createdAt, json })) };
}

/** If a just-opened project carries `versions`, remove them from it and return them. */
export function takeImportedVersions(project) {
  if (!project || !Array.isArray(project.versions)) return [];
  const list = project.versions.filter((v) => v && typeof v.json === 'string').map((v) => ({ ...v, id: v.id || uid('ver'), projectId: project.id || null }));
  delete project.versions;
  return list;
}
