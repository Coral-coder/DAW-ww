// Project CRDT: a JSON document replicated as a flat map of registers keyed by stable paths.
//
//   * Every path (e.g. tracks/<trackId>/name, patterns/<patId>/notes/<noteId>/pitch) is a
//     last-writer-wins register stamped with a hybrid-logical-clock timestamp (hlc.js).
//   * Arrays of objects with stable `id`s (tracks, clips, notes, fx, automation lanes, …) and the
//     `patterns` map are add-wins sets: an element is alive while some add-tag of it has not been
//     observed-removed. Order inside arrays is a per-element LWW position (fractional number).
//   * Containers (objects / collections) carry an incarnation id `inc`: children written before
//     the container was (re)created are hidden, so replacing an object never resurrects old keys.
//   * Everything else (numbers, strings, automation point lists, timeSig, …) is an atomic LWW value.
//
// Ops are { o:'set', p, r:{k,v?,inc?}, ts } | { o:'ins', p, tag, ts } | { o:'del', p, tags, ts }.
// applyOp is idempotent and commutative, so replicas that saw the same set of ops (in any order,
// with duplicates) materialize the same JSON. Local changes are made by diffing a new project JSON
// against the materialized view (commit), which also yields the inverse ops used for local undo:
// undo only reverts registers whose latest write is still our own. Pure / Node-safe.
import { HLC, replicaOf } from './hlc.js';

export const SEP = '\u001f';
export const POS = '\u0000pos';
const ROOT = Object.freeze({ k: 'o', inc: '', ts: '' });

/** Collections by schema path ('*' = any element id). 'a' = id'd array, 'm' = id-keyed map. */
const SCHEMA = [
  ['tracks', 'a'], ['clips', 'a'], ['scenes', 'a'], ['buses', 'a'], ['markers', 'a'], ['patterns', 'm'],
  ['tracks/*/fx', 'a'], ['tracks/*/automation', 'a'], ['buses/*/fx', 'a'], ['buses/*/automation', 'a'],
  ['master/fx', 'a'], ['master/automation', 'a'], ['patterns/*/notes', 'a'],
  ['tracks/*/patch/nodes', 'a'], ['tracks/*/patch/cables', 'a'],
].map(([p, k]) => [p.split('/'), k]);

export function schemaKind(path) {
  outer: for (const [pat, k] of SCHEMA) {
    if (pat.length !== path.length) continue;
    for (let i = 0; i < pat.length; i++) if (pat[i] !== '*' && pat[i] !== path[i]) continue outer;
    return k;
  }
  return null;
}

const badKey = (k) => k === POS || k === '' || k.includes(SEP);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function idList(arr) {
  const seen = new Set();
  for (const e of arr) {
    if (!isObj(e) || typeof e.id !== 'string' || badKey(e.id) || seen.has(e.id)) return false;
    seen.add(e.id);
  }
  return true;
}

export function kindOf(path, v, curKind = null) {
  if (Array.isArray(v)) {
    if (!v.length) return schemaKind(path) === 'a' || curKind === 'a' ? 'a' : 'v';
    return idList(v) ? 'a' : 'v';
  }
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (keys.some(badKey)) return 'v';
    if (schemaKind(path) === 'm' && keys.every((k) => isObj(v[k]))) return 'm';
    return 'o';
  }
  return 'v';
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
  return true;
}

const childKey = (key, seg) => (key === '' ? seg : key + SEP + seg);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const stripReg = (r) => (r.k === 'v' ? { k: 'v', v: r.v } : r.k === 'x' ? { k: 'x' } : { k: r.k, inc: r.inc });

export class Doc {
  constructor(replica, { now } = {}) {
    this.clock = new HLC(replica, now);
    this.regs = new Map(); // key -> { k:'v'|'o'|'a'|'m'|'x', v?, inc?, ts }
    this.tags = new Map(); // element key -> { adds:Set, rems:Set }
    this.kids = new Map(); // parent key -> Set(child segment)
    this._view = null;
    this._rec = null; // inverse ops being recorded by the current local change
    this._ops = null;
  }

  get replica() { return this.clock.replica; }

  _link(key) {
    const i = key.lastIndexOf(SEP);
    const pk = i < 0 ? '' : key.slice(0, i);
    let s = this.kids.get(pk);
    if (!s) this.kids.set(pk, (s = new Set()));
    s.add(i < 0 ? key : key.slice(i + 1));
  }

  _alive(key) {
    const t = this.tags.get(key);
    if (!t) return false;
    for (const a of t.adds) if (!t.rems.has(a)) return true;
    return false;
  }

  _liveTags(key) {
    const t = this.tags.get(key);
    return t ? [...t.adds].filter((a) => !t.rems.has(a)) : [];
  }

  /** Apply one (local or remote) op. Returns true if the state changed. */
  applyOp(op) {
    if (!op || typeof op.ts !== 'string' || !Array.isArray(op.p)) return false;
    this.clock.observe(op.ts);
    const key = op.p.join(SEP);
    let changed = false;
    if (op.o === 'set') {
      const cur = this.regs.get(key);
      if (!cur || cur.ts < op.ts) {
        if (!cur) this._link(key);
        this.regs.set(key, { ...stripReg(op.r), ts: op.ts });
        changed = true;
      }
    } else if (op.o === 'ins' || op.o === 'del') {
      let t = this.tags.get(key);
      if (!t) { this._link(key); this.tags.set(key, (t = { adds: new Set(), rems: new Set() })); }
      if (op.o === 'ins') { if (!t.adds.has(op.tag)) { t.adds.add(op.tag); changed = true; } }
      else for (const tag of op.tags || []) if (!t.rems.has(tag)) { t.rems.add(tag); changed = true; }
    }
    if (changed) this._view = null;
    return changed;
  }

  applyOps(ops) { let n = 0; for (const op of ops) if (this.applyOp(op)) n++; return n; }

  // -------------------------------------------------------------- materialization
  /** The current JSON value (cached; treat as read-only). */
  view() {
    if (!this._view) this._view = this._mat('', ROOT);
    return this._view;
  }

  _mat(key, reg) {
    if (reg.k === 'v') return reg.v;
    const kids = this.kids.get(key) || [];
    if (reg.k === 'o') {
      const o = {};
      for (const seg of kids) {
        if (seg === POS) continue;
        const ck = childKey(key, seg);
        const cr = this.regs.get(ck);
        if (!cr || cr.k === 'x' || cr.ts <= reg.inc) continue;
        o[seg] = this._mat(ck, cr);
      }
      return o;
    }
    const els = [];
    for (const seg of kids) {
      const ck = childKey(key, seg);
      const cr = this.regs.get(ck);
      if (!cr || cr.k !== 'o' || cr.ts <= reg.inc || !this._alive(ck)) continue;
      els.push({ seg, pos: this.regs.get(ck + SEP + POS)?.v ?? 0, ck, cr });
    }
    els.sort((a, b) => a.pos - b.pos || cmpStr(a.seg, b.seg));
    if (reg.k === 'a') return els.map((e) => this._mat(e.ck, e.cr));
    const m = {};
    for (const e of els) m[e.seg] = this._mat(e.ck, e.cr);
    return m;
  }

  // -------------------------------------------------------------- state sync
  state() {
    return {
      regs: [...this.regs],
      tags: [...this.tags].map(([k, t]) => [k, [...t.adds], [...t.rems]]),
    };
  }

  /** State-based merge (join): same result as having applied all ops behind `state`. */
  mergeState(state) {
    let n = 0;
    for (const [key, reg] of state.regs || []) n += this.applyOp({ o: 'set', p: key.split(SEP), r: reg, ts: reg.ts }) ? 1 : 0;
    for (const [key, adds, rems] of state.tags || []) {
      const p = key.split(SEP);
      for (const tag of adds) n += this.applyOp({ o: 'ins', p, tag, ts: tag }) ? 1 : 0;
      if (rems.length) n += this.applyOp({ o: 'del', p, tags: rems, ts: rems[0] }) ? 1 : 0;
    }
    return n;
  }

  // -------------------------------------------------------------- local changes
  _emit(op) {
    op.ts = this.clock.tick();
    if (op.o === 'ins') op.tag = op.ts;
    const key = op.p.join(SEP);
    if (this._rec) {
      if (op.o === 'set') {
        const prev = this.regs.get(key);
        this._rec.push({ o: 'set', p: op.p, r: prev ? stripReg(prev) : { k: 'x' } });
      } else if (op.o === 'ins') this._rec.push({ o: 'del', p: op.p, tags: [op.tag] });
      else this._rec.push({ o: 'ins', p: op.p });
    }
    this.applyOp(op);
    this._ops.push(op);
  }

  _begin() { this._ops = []; this._rec = []; }
  _end() { const out = { ops: this._ops, inverse: this._rec }; this._ops = null; this._rec = null; return out; }

  /**
   * Make the document equal to `next` (plain JSON; not retained). Returns { ops, inverse }:
   * ops to broadcast (already applied here), inverse ops for undo (see revert()).
   */
  commit(next) {
    const json = JSON.parse(JSON.stringify(next)); // normalizes undefined / NaN like a save would
    this._begin();
    this._diffObj([], '', ROOT, this.view(), json);
    return this._end();
  }

  /**
   * Undo: apply recorded inverse ops (newest first). A register is only restored if its latest
   * write is ours, so concurrent edits by others survive. Returns { ops, inverse } (inverse = redo).
   */
  revert(inverse) {
    this._begin();
    for (let i = inverse.length - 1; i >= 0; i--) {
      const inv = inverse[i];
      const key = inv.p.join(SEP);
      if (inv.o === 'set') {
        const cur = this.regs.get(key);
        if (cur && replicaOf(cur.ts) !== this.replica) continue;
        if (!cur && inv.r.k === 'x') continue;
        if (cur && deepEqual(stripReg(cur), inv.r)) continue;
        this._emit({ o: 'set', p: inv.p, r: inv.r });
      } else if (inv.o === 'del') {
        const tags = inv.tags.filter((t) => this.tags.get(key)?.adds.has(t) && !this.tags.get(key).rems.has(t));
        if (tags.length) this._emit({ o: 'del', p: inv.p, tags });
      } else if (inv.o === 'ins') {
        if (!this._alive(key)) this._emit({ o: 'ins', p: inv.p });
      }
    }
    return this._end();
  }

  _visible(key, parentReg) {
    const cur = this.regs.get(key);
    return cur && cur.k !== 'x' && cur.ts > parentReg.inc ? cur : null;
  }

  _diffChild(path, key, oldVal, newVal, parentReg) {
    const cur = this._visible(key, parentReg);
    if (newVal === undefined) {
      if (cur) this._emit({ o: 'set', p: path, r: { k: 'x' } });
      return;
    }
    const nk = kindOf(path, newVal, cur?.k);
    if (nk === 'v') {
      if (!cur || cur.k !== 'v' || !deepEqual(cur.v, newVal)) this._emit({ o: 'set', p: path, r: { k: 'v', v: newVal } });
      return;
    }
    if (!cur || cur.k !== nk) {
      this._emit({ o: 'set', p: path, r: { k: nk, inc: this.clock.tick() } });
      oldVal = undefined;
    }
    const reg = this.regs.get(key);
    if (nk === 'o') this._diffObj(path, key, reg, oldVal, newVal);
    else this._diffColl(path, key, reg, oldVal, newVal, nk);
  }

  _diffObj(path, key, reg, oldVal, newVal) {
    const keys = new Set(Object.keys(newVal));
    if (isObj(oldVal)) for (const k of Object.keys(oldVal)) keys.add(k);
    for (const k of keys) {
      if (badKey(k)) continue;
      this._diffChild([...path, k], childKey(key, k), isObj(oldVal) ? oldVal[k] : undefined, newVal[k], reg);
    }
  }

  _diffColl(path, key, reg, oldVal, newVal, kind) {
    const oldEls = new Map();
    if (Array.isArray(oldVal)) for (const e of oldVal) oldEls.set(e.id, e);
    else if (isObj(oldVal)) for (const [id, e] of Object.entries(oldVal)) oldEls.set(id, e);
    const list = kind === 'a' ? newVal.map((e) => [e.id, e]) : Object.entries(newVal);
    const newIds = new Set(list.map((x) => x[0]));
    for (const id of oldEls.keys()) {
      if (newIds.has(id)) continue;
      const ck = childKey(key, id);
      const tags = this._liveTags(ck);
      if (tags.length) this._emit({ o: 'del', p: [...path, id], tags });
    }
    const fresh = new Set();
    for (const [id, el] of list) {
      const ck = childKey(key, id);
      const p = [...path, id];
      if (oldEls.has(id)) { this._diffObj(p, ck, this.regs.get(ck), oldEls.get(id), el); continue; }
      fresh.add(id);
      this._emit({ o: 'ins', p });
      this._emit({ o: 'set', p, r: { k: 'o', inc: this.clock.tick() } });
      this._diffObj(p, ck, this.regs.get(ck), undefined, el);
    }
    if (kind === 'a') this._positions(path, key, list.map((x) => x[0]), fresh);
  }

  /** Keep the longest run of already-ordered elements; give moved / new ones positions in between. */
  _positions(path, key, ids, fresh) {
    const posOf = (id) => this.regs.get(childKey(key, id) + SEP + POS)?.v ?? 0;
    const setPos = (id, v) => { if (fresh.has(id) || posOf(id) !== v) this._emit({ o: 'set', p: [...path, id, POS], r: { k: 'v', v } }); };
    const items = ids.map((id) => ({ id, pos: posOf(id), keep: false }));
    const lt = (a, b) => a.pos < b.pos || (a.pos === b.pos && a.id < b.id);
    // LIS over kept elements (patience sorting with back-pointers)
    const tails = [], prevIdx = new Array(items.length).fill(-1);
    items.forEach((it, i) => {
      if (fresh.has(it.id)) return;
      let lo = 0, hi = tails.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (lt(items[tails[m]], it)) lo = m + 1; else hi = m; }
      prevIdx[i] = lo > 0 ? tails[lo - 1] : -1;
      tails[lo] = i;
    });
    for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prevIdx[i]) items[i].keep = true;
    let ok = true;
    let prev = null;
    for (let i = 0; i < items.length && ok; i++) {
      const it = items[i];
      if (it.keep) { prev = it; continue; }
      let next = null;
      for (let j = i + 1; j < items.length; j++) if (items[j].keep) { next = items[j]; break; }
      let v;
      if (!prev && !next) v = 0;
      else if (!next) v = prev.pos + 1;
      else if (!prev) v = next.pos - 1;
      else { v = (prev.pos + next.pos) / 2; if (!(v > prev.pos && v < next.pos)) ok = false; }
      it.pos = v;
      prev = it;
    }
    if (!ok) items.forEach((it, i) => { it.pos = i; it.keep = false; });
    for (const it of items) if (!it.keep) setPos(it.id, it.pos);
  }
}

// ---------------------------------------------------------------- local undo / redo
/** Per-replica undo history over Doc.commit / Doc.revert groups. */
export class LocalHistory {
  constructor(doc, { max = 200, coalesceMs = 800, mergeMs = 5000, now = () => Date.now() } = {}) {
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.max = max;
    this.coalesceMs = coalesceMs;
    this.mergeMs = mergeMs;
    this.now = now;
  }

  /** Record the inverse of a local change. opts.undo === false folds it into the previous step. */
  record(label, inverse, { undo = true, coalesce = false } = {}) {
    if (!inverse.length) return;
    const t = this.now();
    const last = this.undoStack[this.undoStack.length - 1];
    if (last && ((!undo && t - last.t < this.mergeMs) || (coalesce && last.label === label && t - last.t < this.coalesceMs))) {
      last.inverse.push(...inverse);
      last.t = t;
      return;
    }
    if (!undo) return;
    this.undoStack.push({ label, inverse, t });
    if (this.undoStack.length > this.max) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  /** -> { label, ops } or null. */
  undo() {
    const step = this.undoStack.pop();
    if (!step) return null;
    const { ops, inverse } = this.doc.revert(step.inverse);
    this.redoStack.push({ label: step.label, inverse, t: 0 });
    return { label: step.label, ops };
  }

  redo() {
    const step = this.redoStack.pop();
    if (!step) return null;
    const { ops, inverse } = this.doc.revert(step.inverse);
    this.undoStack.push({ label: step.label, inverse, t: 0 });
    return { label: step.label, ops };
  }

  clear() { this.undoStack.length = 0; this.redoStack.length = 0; }
}
