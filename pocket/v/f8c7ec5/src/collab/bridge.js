// Bridge between the app Store and the project CRDT (crdt.js). Node-safe (no DOM / network).
//
//   local edit:  store 'change' -> doc.commit(projectAsDocJson) -> ops  (emitted as 'ops')
//   remote ops:  doc.applyOps -> doc.view() -> reconcile into store.project in place -> 'change'
//   undo/redo:   store.history = bridge, so Ctrl+Z reverts only this replica's own ops.
//
// Kept local (never shared): transport-ish fields (mode, metronome, loop.enabled), modifiedAt and
// the sample bytes — samples are shared as metadata + SHA-256 hash; bytes go peer-to-peer on demand.
import { Emitter, uid } from '../core/util.js';
import { Doc, LocalHistory } from './crdt.js';
import { reconcileObject } from './reconcile.js';
import { SampleHasher } from './samples.js';

export const LOCAL_FIELDS = ['modifiedAt', 'metronome', 'mode'];
const SKIP = new Set([...LOCAL_FIELDS, 'samples', 'loop']);

/** Project -> the JSON that is replicated (local fields dropped, samples as metadata). */
export function toDocJson(project, hashOf = null, pending = null) {
  const out = {};
  for (const [k, v] of Object.entries(project)) if (!SKIP.has(k)) out[k] = v;
  if (project.loop) { const { enabled, ...rest } = project.loop; out.loop = rest; }
  const samples = {};
  for (const [id, s] of Object.entries(project.samples || {})) {
    if (!s) continue;
    const { data, hash: _h, ...meta } = s;
    samples[id] = { ...meta, hash: hashOf ? hashOf(id, data) : _h || null };
  }
  if (pending) for (const [id, meta] of pending) if (!samples[id]) samples[id] = meta;
  out.samples = samples;
  return out;
}

/** Track ids touched by a list of ops (for soft locks / activity). */
export function touchedTracks(ops, view) {
  const out = new Set();
  for (const op of ops) {
    const [root, id] = op.p;
    if (!id) continue;
    if (root === 'tracks') out.add(id);
    else if (root === 'patterns') { const t = view?.patterns?.[id]?.trackId; if (t) out.add(t); }
    else if (root === 'clips') { const c = view?.clips?.find?.((x) => x.id === id); if (c?.trackId) out.add(c.trackId); }
  }
  return [...out];
}

function ensureIds(project) {
  const fix = (arr, prefix) => { if (Array.isArray(arr)) for (const e of arr) if (e && typeof e === 'object' && typeof e.id !== 'string') e.id = uid(prefix); };
  fix(project.tracks, 'trk'); fix(project.clips, 'clip'); fix(project.markers, 'mk'); fix(project.scenes, 'scn'); fix(project.buses, 'bus');
  for (const p of Object.values(project.patterns || {})) fix(p?.notes, 'n');
  for (const o of [...(project.tracks || []), ...(project.buses || []), project.master]) { fix(o?.fx, 'fx'); fix(o?.automation, 'al'); }
}

export class CollabBridge extends Emitter {
  constructor(store, { replica = uid('r').replace(/\./g, ''), now } = {}) {
    super();
    this.store = store;
    this.replica = replica;
    this._now = now;
    this.doc = new Doc(replica, { now });
    this.history = new LocalHistory(this.doc, { now });
    this.hasher = new SampleHasher();
    this.sampleData = new Map(); // hash -> base64
    this.pending = new Map(); // sample id -> meta (bytes not here yet)
    this._off = null;
    this._quiet = false;
  }

  _hashOf = (id, data) => {
    if (!data) return this.pending.get(id)?.hash || null;
    const h = this.hasher.hash(id, data);
    this.sampleData.set(h, data);
    return h;
  };

  docJson(project = this.store.get()) { return toDocJson(project, this._hashOf, this.pending); }

  /** Seed the document from the current project (session host). Returns the ops. */
  seed() {
    ensureIds(this.store.get());
    return this.doc.commit(this.docJson()).ops;
  }

  /** Replace the local document with a peer's state (joining an existing session). */
  adopt(state) {
    this.doc = new Doc(this.replica, { now: this._now });
    this.history = new LocalHistory(this.doc, { now: this._now });
    this.doc.mergeState(state);
    this.pending.clear();
    this.syncStore('collab:join');
  }

  /** Merge a peer's full state (re-sync after a reconnect). */
  mergeState(state) {
    if (this.doc.mergeState(state)) this.syncStore('collab:remote');
  }

  attach() {
    if (this._off) return;
    this._off = this.store.on('change', (project, label) => this._onChange(project, label));
    this.store.history = this;
  }

  detach() {
    this._off?.();
    this._off = null;
    if (this.store.history === this) {
      this.store.history = null;
      // the snapshot undo stack would roll back other people's edits — start fresh
      this.store.undoStack.length = 0;
      this.store.redoStack.length = 0;
    }
  }

  _onChange(project, label) {
    if (this._quiet || (typeof label === 'string' && label.startsWith('collab:'))) return;
    const lc = this.store.lastCommit || {};
    if (label === 'load') this.pending.clear();
    ensureIds(project);
    const { ops, inverse } = this.doc.commit(this.docJson(project));
    if (!ops.length) return;
    this.history.record(label, inverse, label === 'load' ? { undo: false } : { undo: lc.undo !== false, coalesce: !!lc.coalesce });
    this.emit('ops', ops, label);
  }

  /** Apply ops from a peer. Returns the number of state changes. */
  applyRemote(ops, label = 'collab:remote') {
    const n = this.doc.applyOps(ops);
    if (n) this.syncStore(label);
    return n;
  }

  /** Make store.project match the document (in place) and emit a change. */
  syncStore(label) {
    const view = this.doc.view();
    const project = this.store.get();
    const json = { ...view, samples: {} };
    if (view.loop) json.loop = { ...view.loop, enabled: project.loop?.enabled ?? false };
    for (const [id, meta] of Object.entries(view.samples || {})) {
      const data = meta.hash ? this.sampleData.get(meta.hash) : null;
      if (data) { this.pending.delete(id); json.samples[id] = { ...meta, data }; }
      else if (meta.hash) {
        if (!this.pending.has(id)) { this.pending.set(id, meta); this.emit('need-sample', meta.hash, meta); }
        else this.pending.set(id, meta);
      }
    }
    for (const id of [...this.pending.keys()]) if (!view.samples?.[id]) this.pending.delete(id);
    for (const s of Object.values(json.samples)) delete s.hash;
    this._quiet = true;
    try {
      reconcileObject(project, json, new Set(LOCAL_FIELDS));
    } finally { this._quiet = false; }
    this.store._emitChange(label);
  }

  /** Sample bytes arrived (verified by the caller). */
  receiveSample(hash, data) {
    this.sampleData.set(hash, data);
    if ([...this.pending.values()].some((m) => m.hash === hash)) this.syncStore('collab:sample');
  }

  hasSample(hash) { return this.sampleData.has(hash); }
  getSample(hash) { return this.sampleData.get(hash) || null; }

  // ---- store.history interface ----
  canUndo() { return this.history.canUndo(); }
  canRedo() { return this.history.canRedo(); }
  undo() { return this._step(this.history.undo(), 'Undo'); }
  redo() { return this._step(this.history.redo(), 'Redo'); }
  _step(r, verb) {
    if (!r) return null;
    this.syncStore(`collab:${verb.toLowerCase()}`);
    if (r.ops.length) this.emit('ops', r.ops, `${verb} ${r.label}`);
    return r.label;
  }
}
