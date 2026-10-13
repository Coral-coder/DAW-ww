// Automation recording — pure logic (Node-safe, no DOM / Web Audio). The UI recorder
// (src/ui/automation-recorder.js) feeds it store snapshots and the playhead; this module decides
// what changed, collects the written points per target and merges a finished take into lanes.
//
// Write modes (per target):
//   touch — writes while the control is held; on release the lane's existing automation resumes.
//           Switched/stepped targets (mute, on/bypass, enum, bool) behave like latch (as in most DAWs).
//   latch — writes from the first touch and keeps writing the last value until the transport stops.
//   write — like latch, and also keeps the target overwritten across loop wraps from the loop start.
// Only the written spans are replaced: points before / after them (drawn or generated) are kept.
import { valueAt, replaceRange, sortPoints } from './automation.js';

export const SEP = '|'; // key = ownerId + SEP + target (owner ids never contain '|')
export const keyOf = (ownerId, target) => `${ownerId}${SEP}${target}`;
export function splitKey(key) {
  const i = key.indexOf(SEP);
  return { owner: key.slice(0, i), target: key.slice(i + 1) };
}

// ---------------------------------------------------------------------------- snapshots
/** Flatten params into {key: primitive}: top-level primitives, pads.<pad>.<key>, values.<address>. */
export function flattenParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null) continue;
    const t = typeof v;
    if (t === 'number' || t === 'boolean' || t === 'string') { out[k] = v; continue; }
    if (k === 'pads' && t === 'object') {
      for (const [pad, pv] of Object.entries(v)) {
        if (!pv || typeof pv !== 'object') continue;
        for (const [pk, x] of Object.entries(pv)) if (typeof x === 'number' || typeof x === 'boolean') out[`pads.${pad}.${pk}`] = x;
      }
    } else if (k === 'values' && t === 'object') {
      for (const [addr, x] of Object.entries(v)) if (typeof x === 'number' || typeof x === 'boolean') out[`values.${addr}`] = x;
    }
  }
  return out;
}

/**
 * Flat map of every automatable value in the project: Map(key -> primitive), key = owner|target.
 * Meta keys `owner|@inst` (instrument type) let diffTargets skip instrument swaps.
 * opts.resolveInst(instrument) -> {type, params} (preset + defaults resolved);
 * opts.resolveFx(effect) -> params (defaults resolved). Both optional (raw params used).
 */
export function snapshotTargets(project, opts = {}) {
  const snap = new Map();
  const put = (owner, target, v) => { if (v !== undefined) snap.set(keyOf(owner, target), v); };
  const fxOf = (owner, list) => {
    for (const f of list || []) {
      put(owner, `fxen:${f.id}`, f.enabled !== false);
      let params = f.params || {};
      if (opts.resolveFx) { try { params = { ...opts.resolveFx(f), ...(f.params?.values ? { values: f.params.values } : {}) }; } catch { /* raw */ } }
      for (const [k, v] of Object.entries(flattenParams(params))) put(owner, `fx:${f.id}:${k}`, v);
    }
  };
  for (const t of project?.tracks || []) {
    put(t.id, 'volume', t.volume ?? 0.8);
    put(t.id, 'pan', t.pan || 0);
    put(t.id, 'mute', !!t.mute);
    for (const b of project.buses || []) put(t.id, `send:${b.id}`, t.sends?.[b.id] || 0);
    if (t.type === 'instrument' && t.instrument) {
      let res = { type: t.instrument.type, params: t.instrument.params || {} };
      if (opts.resolveInst) { try { res = opts.resolveInst(t.instrument) || res; } catch { /* raw */ } }
      put(t.id, '@inst', `${res.type}`);
      for (const [k, v] of Object.entries(flattenParams(res.params))) put(t.id, `inst:${k}`, v);
    }
    fxOf(t.id, t.fx);
    if (t.patch?.enabled) for (const c of t.patch.cables || []) put(t.id, `cable:${c.id}`, c.gain ?? 1);
  }
  for (const b of project?.buses || []) {
    put(b.id, 'volume', b.volume ?? 0.8);
    put(b.id, 'pan', b.pan || 0);
    put(b.id, 'mute', !!b.mute);
    fxOf(b.id, b.fx);
  }
  if (project?.master) {
    put('master', 'volume', project.master.volume ?? 0.9);
    fxOf('master', project.master.fx);
  }
  return snap;
}

const sameVal = (a, b) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9);

/**
 * Changed targets between two snapshots -> [{key, owner, target, prev, next}].
 * Skipped: owners / effects / instruments that did not exist before (or whose instrument type
 * changed), meta keys. A key that is new inside an existing container (e.g. the first edit of a
 * Faust control, stored in params.values only once touched) is reported with prev undefined.
 */
export function diffTargets(prev, next) {
  const out = [];
  if (!prev || !next) return out;
  for (const [key, v] of next) {
    const { owner, target } = splitKey(key);
    if (target.startsWith('@')) continue;
    const had = prev.has(key);
    const p = prev.get(key);
    if (had && sameVal(p, v)) continue;
    if (!had) {
      // only inside a container that already existed
      if (!prev.has(keyOf(owner, 'volume'))) continue;
      if (target.startsWith('inst:')) { if (prev.get(keyOf(owner, '@inst')) !== next.get(keyOf(owner, '@inst'))) continue; }
      else if (target.startsWith('fx:')) { const fxId = target.split(':')[1]; if (!prev.has(keyOf(owner, `fxen:${fxId}`))) continue; }
      else continue;
    } else if (target.startsWith('inst:') && prev.get(keyOf(owner, '@inst')) !== next.get(keyOf(owner, '@inst'))) continue;
    out.push({ key, owner, target, prev: p, next: v });
  }
  return out;
}

// ---------------------------------------------------------------------------- point thinning
/**
 * Append a recorded point, thinning on the fly: a point closer than minGap beats to the previous one
 * replaces its value (keeps the earlier beat) unless the value jumps by more than jump (lane units).
 * Returns the array.
 */
export function pushThinned(points, pt, { minGap = 1 / 32, jump = Infinity } = {}) {
  const last = points[points.length - 1];
  if (last && pt.beat - last.beat < minGap && pt.beat >= last.beat && Math.abs(pt.value - last.value) <= jump && points.length > 1) {
    last.value = pt.value;
    return points;
  }
  if (last && pt.beat < last.beat) pt = { beat: last.beat, value: pt.value };
  points.push({ beat: pt.beat, value: pt.value });
  return points;
}

/**
 * Ramer–Douglas–Peucker on the value axis: drop points whose value is within eps of the straight line
 * between the kept neighbours (norm maps a value to 0..1 so eps is relative to the param range, e.g.
 * log-curve frequencies). Vertical jumps (equal beats) are always kept.
 */
export function simplifyPoints(points, eps = 0.005, norm = (v) => v) {
  const pts = sortPoints(points);
  if (pts.length <= 2) return pts.map((p) => ({ ...p }));
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  for (let i = 1; i < pts.length - 1; i++) if (pts[i].beat === pts[i - 1].beat || pts[i].beat === pts[i + 1].beat) keep[i] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const A = pts[a], B = pts[b];
    const span = B.beat - A.beat;
    const na = norm(A.value), nb = norm(B.value);
    let worst = -1, wd = 0;
    for (let i = a + 1; i < b; i++) {
      if (keep[i]) { worst = i; wd = Infinity; break; } // forced point: split there
      const u = span > 0 ? (pts[i].beat - A.beat) / span : 0;
      const d = Math.abs(norm(pts[i].value) - (na + (nb - na) * u));
      if (d > wd) { wd = d; worst = i; }
    }
    if (worst > 0 && wd > eps) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  return pts.filter((_, i) => keep[i]).map((p) => ({ ...p }));
}

/** Drop consecutive duplicate points (same beat and value) and collinear holds of equal value triples. */
export function dedupePoints(points) {
  const out = [];
  for (const p of points) {
    const l = out[out.length - 1];
    if (l && Math.abs(l.beat - p.beat) < 1e-9 && Math.abs(l.value - p.value) < 1e-9) continue;
    const l2 = out[out.length - 2];
    // a,b,c with equal values and increasing beats: b is redundant
    if (l && l2 && l.value === p.value && l2.value === p.value && l.beat > l2.beat && p.beat > l.beat) { out[out.length - 1] = { ...p }; continue; }
    out.push({ ...p });
  }
  return out;
}

const r6 = (x) => +(+x).toFixed(6);

/**
 * Merge written segments into a lane's points. Each segment {start, end, points} replaces the
 * lane in [start, end] with: the lane's previous value at `start` (punch-in), the simplified written
 * points, the last written value held to `end`, and the previous value at `end` (punch-out — the
 * existing automation resumes after the span). With an empty lane the previous value is
 * `staticValue` (the control's value before the take). Segments are applied in order, so a later
 * pass over the same region (loop recording) wins.
 * opts: { staticValue, stepped, eps, norm }
 */
export function mergeTake(basePoints, segments, opts = {}) {
  const { staticValue = 0, stepped = false, eps = 0.005, norm = (v) => v } = opts;
  let pts = sortPoints(basePoints || []).map((p) => ({ ...p }));
  for (const seg of segments || []) {
    const s = r6(seg.start), e = r6(Math.max(seg.start, seg.end));
    if (!seg.points?.length) continue;
    const before = pts.length ? valueAt(pts, s - 1e-6) : staticValue;
    const after = pts.length ? valueAt(pts, e + 1e-6) : staticValue;
    let rec = seg.points.map((p) => ({ beat: r6(Math.min(e, Math.max(s, p.beat))), value: p.value }));
    if (!stepped) rec = simplifyPoints(rec, eps, norm);
    const last = rec[rec.length - 1].value;
    const fresh = [{ beat: s, value: before }, ...rec, { beat: e, value: last }, { beat: e, value: after }];
    pts = replaceRange(pts, s, e, dedupePoints(fresh));
  }
  return dedupePoints(pts);
}

// ---------------------------------------------------------------------------- the take
/**
 * One recording pass. Beat-driven and clock-free so it can be unit-tested:
 *   take.write(key, beat, value, {stepped, mode})   a user change (value in lane units)
 *   take.release(key, beat)                         the user let go of the control
 *   take.advance(beat)                              playhead moved (detects loop wraps) — call often
 *   take.finish(beat?)                              transport stopped: close everything
 *   take.result()                                   [{key, owner, target, segments:[{start,end,points}]}]
 * Writers: { key, mode, stepped, touching, active, cur, segs, lastValue }.
 */
export class AutomationTake {
  constructor({ mode = 'touch', minGap = 1 / 32, wrapThreshold = 0.5 } = {}) {
    this.mode = mode;
    this.minGap = minGap;
    this.wrapThreshold = wrapThreshold;
    this.writers = new Map();
    this.lastBeat = null;
    this.wraps = 0;
  }

  /** Effective mode of a writer: stepped targets latch in touch mode. */
  modeFor(stepped) { return this.mode === 'touch' && stepped ? 'latch' : this.mode; }

  write(key, beat, value, { stepped = false, jump = Infinity } = {}) {
    if (this.lastBeat == null) this.lastBeat = beat;
    let w = this.writers.get(key);
    if (!w) {
      w = { key, mode: this.modeFor(stepped), stepped, touching: false, active: false, cur: null, segs: [], lastValue: value, firstBeat: beat };
      this.writers.set(key, w);
    }
    if (!w.cur) { w.cur = { start: beat, end: beat, points: [] }; w.segs.push(w.cur); }
    w.touching = true;
    w.active = true;
    if (stepped && w.cur.points.length) w.cur.points.push({ beat, value: w.lastValue });
    if (stepped) w.cur.points.push({ beat, value });
    else pushThinned(w.cur.points, { beat, value }, { minGap: this.minGap, jump });
    w.cur.end = Math.max(w.cur.end, beat);
    w.lastValue = value;
    return w;
  }

  /** Returns true when the writer stopped writing (touch mode) — playback of its lane resumes. */
  release(key, beat) {
    const w = this.writers.get(key);
    if (!w || !w.touching) return false;
    w.touching = false;
    if (w.mode !== 'touch') return false; // latch / write keep writing until stop
    this._close(w, beat);
    w.active = false;
    return true;
  }

  _close(w, beat) {
    if (!w.cur) return;
    const end = Math.max(w.cur.start, beat ?? w.cur.end);
    w.cur.end = end;
    const last = w.cur.points[w.cur.points.length - 1];
    if (!last || end - last.beat > 1e-6) w.cur.points.push({ beat: end, value: w.lastValue });
    w.cur = null;
  }

  /** Feed the playhead. A backward jump (loop wrap / seek back) closes the open segments at the last
   * beat and re-opens them at the new beat for writers still writing. Returns true on a wrap. */
  advance(beat) {
    if (this.lastBeat == null) { this.lastBeat = beat; return false; }
    if (beat < this.lastBeat - this.wrapThreshold) {
      const from = this.lastBeat;
      this.wraps++;
      for (const w of this.writers.values()) {
        if (!w.cur) continue;
        this._close(w, from);
        if (w.active) { w.cur = { start: beat, end: beat, points: [{ beat, value: w.lastValue }] }; w.segs.push(w.cur); }
      }
      this.lastBeat = beat;
      return true;
    }
    if (beat > this.lastBeat) {
      this.lastBeat = beat;
      for (const w of this.writers.values()) if (w.cur) w.cur.end = Math.max(w.cur.end, beat);
    }
    return false;
  }

  finish(beat) {
    if (beat != null) this.advance(beat);
    for (const w of this.writers.values()) { if (w.cur) this._close(w, this.lastBeat); w.active = false; w.touching = false; }
  }

  isWriting(key) { return !!this.writers.get(key)?.active; }
  keys() { return [...this.writers.keys()]; }

  result() {
    return [...this.writers.values()].filter((w) => w.segs.some((s) => s.points.length)).map((w) => ({
      key: w.key, ...splitKey(w.key), stepped: w.stepped, segments: w.segs.filter((s) => s.points.length).map((s) => ({ start: s.start, end: s.end, points: s.points.map((p) => ({ ...p })) })),
    }));
  }
}
