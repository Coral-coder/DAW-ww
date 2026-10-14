// Crash-safe autosave + session recovery + version history (IndexedDB 'daw3-recovery').
//
// Unlike the project autosave (autosave.js, whole project incl. samples on every change), recovery is incremental:
// snapshots hold the project JSON *without* samples, and each sample is stored once (content key = id + data size)
// and shared by every snapshot that references it.
//
//   const rec = createRecovery({ backend?, maxSnapshots = 20 })
//   rec.start(store, { intervalMs = 10000 })   snapshot every N s when changed, on tab hide / page hide, heartbeat;
//                                               marks this session "unclean" until pagehide (normal close) or stop()
//   await rec.findUnclean()                    -> { session, snapshot: {id, at, name, projectId} } of a previous
//                                                 session that died without closing (crash / killed tab), or null
//   await rec.loadSnapshot(id)                 -> project (samples restored)
//   await rec.snapshot(project, {label})       -> snapshot meta (null when unchanged since the last one)
//   await rec.listSnapshots(projectId?)        -> [{id, at, name, label, projectId, sessionId, size}] newest first
//   await rec.dismiss(sessionId)               forget an unclean session (user chose not to recover)
//   rec.stop()                                 (marks the session clean)
//
// Backends: idbBackend() (browser) and memoryBackend() (Node tests) share one tiny async KV API per store.
import { uid } from '../core/util.js';

export const RECOVERY_STORES = ['sessions', 'snapshots', 'samples'];

export function memoryBackend() {
  const stores = Object.fromEntries(RECOVERY_STORES.map((s) => [s, new Map()]));
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    get: async (s, k) => clone(stores[s].get(k)),
    put: async (s, v) => { stores[s].set(v.id, clone(v)); },
    delete: async (s, k) => { stores[s].delete(k); },
    all: async (s) => [...stores[s].values()].map(clone),
    _stores: stores,
  };
}

export function idbBackend(name = 'daw3-recovery') {
  let dbp = null;
  const open = () => {
    if (typeof indexedDB === 'undefined' || !indexedDB) return Promise.reject(new Error('IndexedDB unavailable'));
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const r = indexedDB.open(name, 1);
        r.onupgradeneeded = () => { for (const s of RECOVERY_STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'id' }); };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => { dbp = null; reject(r.error); };
      });
    }
    return dbp;
  };
  const run = (s, mode, fn) => open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(s, mode);
    let out;
    const q = fn(t.objectStore(s));
    if (q) q.onsuccess = () => { out = q.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  }));
  return {
    get: (s, k) => run(s, 'readonly', (os) => os.get(k)),
    put: (s, v) => run(s, 'readwrite', (os) => os.put(v)),
    delete: (s, k) => run(s, 'readwrite', (os) => os.delete(k)),
    all: (s) => run(s, 'readonly', (os) => os.getAll()).then((x) => x || []),
  };
}

const sampleKey = (s) => `${s.id}:${typeof s.data === 'string' ? s.data.length : (s.data?.byteLength || 0)}`;

/** Project without samples + its sample references (content keys). */
function split(project) {
  const { samples = {}, ...rest } = project;
  const refs = {};
  for (const [id, s] of Object.entries(samples)) if (s) refs[id] = sampleKey(s);
  return { json: JSON.stringify(rest), refs, samples };
}

export function createRecovery(opts = {}) {
  const backend = opts.backend || idbBackend();
  const now = opts.now || (() => Date.now());
  const maxSnapshots = opts.maxSnapshots ?? 20;
  const staleMs = opts.staleMs ?? 15000; // a session whose heartbeat is older than this is not running anymore
  const sessionId = opts.sessionId || uid('ses');
  let lastJson = null;
  let lastRefs = '';
  let timers = [];
  let offs = [];
  let session = null;
  let busy = Promise.resolve();

  const serial = (fn) => { busy = busy.then(fn, fn); return busy; }; // no overlapping writes

  async function writeSession(patch) {
    session = { ...(session || { id: sessionId, startedAt: new Date(now()).toISOString(), clean: false }), ...patch, heartbeatAt: now() };
    await backend.put('sessions', session);
  }

  async function snapshot(project, { label = 'auto', force = false } = {}) {
    if (!project) return null;
    return serial(async () => {
      const { json, refs, samples } = split(project);
      const refStr = JSON.stringify(refs);
      if (!force && json === lastJson && refStr === lastRefs) return null;
      // samples first (each content key once), then the snapshot that points at them
      for (const [id, key] of Object.entries(refs)) {
        if (await backend.get('samples', key)) continue;
        await backend.put('samples', { id: key, sample: samples[id] });
      }
      const meta = {
        id: uid('snap'), projectId: project.id || null, sessionId, at: new Date(now()).toISOString(),
        name: project.name || 'Untitled Project', label, json, refs, size: json.length,
      };
      await backend.put('snapshots', meta);
      lastJson = json;
      lastRefs = refStr;
      await writeSession({ projectId: project.id || null, projectName: meta.name, lastSnapshotId: meta.id, lastSnapshotAt: meta.at });
      await prune(project.id || null);
      const { json: _j, ...info } = meta;
      return info;
    });
  }

  /** Keep the newest `maxSnapshots` per project; drop samples no snapshot references any more. */
  async function prune(projectId) {
    const all = await backend.all('snapshots');
    const mine = all.filter((s) => s.projectId === projectId).sort((a, b) => b.at.localeCompare(a.at) || (b.id > a.id ? 1 : -1));
    const drop = mine.slice(maxSnapshots);
    for (const s of drop) await backend.delete('snapshots', s.id);
    if (!drop.length) return;
    const keep = new Set();
    for (const s of all) if (!drop.includes(s)) for (const k of Object.values(s.refs || {})) keep.add(k);
    for (const smp of await backend.all('samples')) if (!keep.has(smp.id)) await backend.delete('samples', smp.id);
  }

  async function loadSnapshot(id) {
    const meta = await backend.get('snapshots', id);
    if (!meta) return null;
    const project = JSON.parse(meta.json);
    project.samples = {};
    for (const [sid, key] of Object.entries(meta.refs || {})) {
      const rec = await backend.get('samples', key);
      if (rec?.sample) project.samples[sid] = rec.sample;
    }
    return project;
  }

  async function listSnapshots(projectId) {
    const all = await backend.all('snapshots');
    return all
      .filter((s) => projectId === undefined || s.projectId === projectId)
      .sort((a, b) => b.at.localeCompare(a.at))
      .map(({ json, refs, ...info }) => info);
  }

  async function findUnclean() {
    const sessions = await backend.all('sessions');
    const dead = sessions
      .filter((s) => s.id !== sessionId && !s.clean && s.lastSnapshotId && now() - (s.heartbeatAt || 0) > staleMs)
      .sort((a, b) => (b.heartbeatAt || 0) - (a.heartbeatAt || 0));
    for (const s of dead) {
      const snap = await backend.get('snapshots', s.lastSnapshotId);
      if (snap) return { session: s, snapshot: { id: snap.id, at: snap.at, name: snap.name, projectId: snap.projectId } };
    }
    return null;
  }

  async function dismiss(id) {
    const s = await backend.get('sessions', id);
    if (s) await backend.put('sessions', { ...s, clean: true });
    // old clean sessions are just bookkeeping
    for (const x of await backend.all('sessions')) if (x.clean && x.id !== sessionId && now() - (x.heartbeatAt || 0) > 7 * 864e5) await backend.delete('sessions', x.id);
  }

  async function markClean() {
    if (!session) return;
    await writeSession({ clean: true });
  }

  function start(store, { intervalMs = 10000, heartbeatMs = 5000 } = {}) {
    stop(false);
    writeSession({ clean: false }).catch(() => {});
    const snap = (label) => snapshot(store.get(), { label }).catch((e) => opts.onError?.(e));
    timers.push(setInterval(() => snap('auto'), intervalMs));
    timers.push(setInterval(() => { if (session && !session.clean) writeSession({}).catch(() => {}); }, heartbeatMs));
    if (typeof document !== 'undefined' && typeof addEventListener === 'function') {
      const vis = () => { if (document.visibilityState === 'hidden') snap('hidden'); else if (session?.clean) writeSession({ clean: false }).catch(() => {}); };
      // pagehide = the page is going away normally (close / reload / navigate): last snapshot, session is clean
      const hide = () => { snap('close'); busy.then(() => markClean()).catch(() => {}); };
      document.addEventListener('visibilitychange', vis);
      addEventListener('pagehide', hide);
      offs.push(() => document.removeEventListener('visibilitychange', vis), () => removeEventListener('pagehide', hide));
    }
    return api;
  }

  function stop(clean = true) {
    timers.forEach(clearInterval);
    timers = [];
    offs.forEach((f) => f());
    offs = [];
    if (clean) markClean().catch(() => {});
  }

  const api = {
    sessionId, start, stop, snapshot, loadSnapshot, listSnapshots, findUnclean, dismiss, markClean, prune,
    get session() { return session; },
  };
  return api;
}
