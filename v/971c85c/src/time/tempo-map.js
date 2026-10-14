// Tempo map + meter map: THE single place that converts beats <-> seconds and numbers bars (pure, Node-safe).
//
// project.bpm               tempo at beat 0 (authoritative for the first segment — the BPM field, setcpm, Link,
//                           MIDI clock-in all write it; compatibility with projects without a map)
// project.tempoMap?         [{ beat, bpm, curve: 'jump'|'linear' }]  (sorted by beat). `curve` shapes the segment
//                           AFTER the point: 'jump' holds bpm until the next point, 'linear' ramps linearly (in
//                           beats) to the next point's bpm. A point at beat 0 takes its bpm from project.bpm.
// project.timeSig           [num, den] of bar 0 (authoritative for the first meter)
// project.meterMap?         [{ bar, num, den, groups? }]  bar = 0-based bar index where the meter starts.
//                           groups (optional) = accent grouping in denominator units, e.g. [2,2,3] for 7/8.
//
// Positions are beats (quarter notes). A linear ramp bpm(b) = a + k·(b − b0) integrates exactly:
//   sec(b) = sec0 + 60/k · ln(bpm(b)/a)            (k → 0: 60·(b−b0)/a)
//   beat(s) = b0 + a · (exp(k·(s−sec0)/60) − 1)/k
// Tempo changes only apply in SONG mode: pattern mode (looping patterns, beat 0 → ∞) plays project.bpm and the
// first meter (`tempoMapFor(project, 'pattern')`).

const EPS = 1e-9;
export const CURVES = ['jump', 'linear'];
export const MIN_BPM = 10;
export const MAX_BPM = 999;
const clampBpm = (x) => Math.max(MIN_BPM, Math.min(MAX_BPM, Number(x) || 120));

/** Accent groups (denominator units) for a meter: 4/4 -> [1,1,1,1]; 6/8 -> [3,3]; 7/8 -> [2,2,3]; 5/8 -> [3,2]. */
export function meterGroups(num, den, groups) {
  if (Array.isArray(groups) && groups.length && groups.every((g) => g > 0) && groups.reduce((a, b) => a + b, 0) === num) return groups.slice();
  if (den < 8 || num <= 3) return Array(num).fill(1);
  if (num % 3 === 0) return Array(num / 3).fill(3);
  if (num === 5) return [3, 2];
  const out = [];
  let left = num;
  while (left > 3) { out.push(2); left -= 2; }
  out.push(left);
  return out;
}

export class TempoMap {
  /**
   * @param {{bpm:number, points?:Array, timeSig?:[number,number], meters?:Array}} o
   */
  constructor({ bpm = 120, points = [], timeSig = [4, 4], meters = [] } = {}) {
    // ---- tempo segments
    const pts = (points || [])
      .filter((p) => p && Number.isFinite(+p.beat) && +p.beat >= 0 && Number(p.bpm) > 0)
      .map((p) => ({ beat: +p.beat, bpm: clampBpm(p.bpm), curve: p.curve === 'linear' ? 'linear' : 'jump' }))
      .sort((a, b) => a.beat - b.beat);
    // collapse duplicates (two points on one beat = a jump: the later one wins for what follows)
    const uniq = [];
    for (const p of pts) {
      if (uniq.length && Math.abs(uniq[uniq.length - 1].beat - p.beat) < EPS) uniq[uniq.length - 1] = p;
      else uniq.push(p);
    }
    const first = { beat: 0, bpm: clampBpm(bpm), curve: 'jump' };
    if (uniq.length && uniq[0].beat < EPS) { first.curve = uniq[0].curve; uniq.shift(); }
    const list = [first, ...uniq];
    this.segs = [];
    let sec = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i], nx = list[i + 1];
      const end = nx ? nx.beat : Infinity;
      const k = p.curve === 'linear' && nx ? (nx.bpm - p.bpm) / (nx.beat - p.beat) : 0;
      const seg = { beat: p.beat, end, sec, bpm: p.bpm, k, curve: p.curve };
      this.segs.push(seg);
      if (nx) sec += this._segSpan(seg, nx.beat - p.beat);
    }
    this.bpm = this.segs[0].bpm;
    this.isConstant = this.segs.length === 1;

    // ---- meters
    const ts0 = Array.isArray(timeSig) && timeSig[0] > 0 && timeSig[1] > 0 ? timeSig : [4, 4];
    const ms = (meters || [])
      .filter((m) => m && Number.isFinite(+m.bar) && +m.bar >= 0 && m.num > 0 && m.den > 0)
      .map((m) => ({ bar: Math.round(+m.bar), num: Math.round(m.num), den: Math.round(m.den), groups: m.groups }))
      .sort((a, b) => a.bar - b.bar);
    const mlist = [{ bar: 0, num: ts0[0], den: ts0[1], groups: undefined }];
    for (const m of ms) {
      const last = mlist[mlist.length - 1];
      if (m.bar === last.bar) { if (m.bar === 0) last.groups = m.groups; else mlist[mlist.length - 1] = m; } else mlist.push(m);
    }
    this.meters = [];
    let beat = 0;
    for (let j = 0; j < mlist.length; j++) {
      const m = mlist[j];
      if (j > 0) { const pm = this.meters[j - 1]; beat = pm.beat + (m.bar - pm.bar) * pm.bpb; }
      this.meters.push({ bar: m.bar, beat, num: m.num, den: m.den, bpb: (m.num * 4) / m.den, unit: 4 / m.den, groups: meterGroups(m.num, m.den, m.groups) });
    }
  }

  /** Seconds a segment takes for `db` beats from its start. */
  _segSpan(seg, db) {
    if (Math.abs(seg.k) < 1e-12) return (60 * db) / seg.bpm;
    return (60 / seg.k) * Math.log1p((seg.k * db) / seg.bpm);
  }

  _seg(beat) {
    const s = this.segs;
    if (s.length === 1 || beat < s[1].beat) return s[0];
    let lo = 0, hi = s.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s[m].beat <= beat) lo = m; else hi = m - 1; }
    return s[lo];
  }

  _segBySec(sec) {
    const s = this.segs;
    if (s.length === 1 || sec < s[1].sec) return s[0];
    let lo = 0, hi = s.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s[m].sec <= sec) lo = m; else hi = m - 1; }
    return s[lo];
  }

  /** Tempo (bpm) at a beat. */
  bpmAt(beat) {
    const g = this._seg(beat);
    return g.k ? g.bpm + g.k * (beat - g.beat) : g.bpm;
  }
  /** Seconds per beat at a beat (instantaneous). */
  spbAt(beat) { return 60 / this.bpmAt(beat); }

  /** Seconds from beat 0 to `beat` (negative beats extrapolate the first tempo). */
  secAt(beat) {
    if (beat <= 0) return (60 * beat) / this.segs[0].bpm;
    const g = this._seg(beat);
    return g.sec + this._segSpan(g, beat - g.beat);
  }

  /** Beat at `sec` seconds from beat 0 (inverse of secAt). */
  beatAt(sec) {
    if (sec <= 0) return (sec * this.segs[0].bpm) / 60;
    const g = this._segBySec(sec);
    const ds = sec - g.sec;
    if (Math.abs(g.k) < 1e-12) return g.beat + (ds * g.bpm) / 60;
    return g.beat + (g.bpm * Math.expm1((g.k * ds) / 60)) / g.k;
  }

  /** Seconds between two beats. */
  span(b0, b1) { return this.secAt(b1) - this.secAt(b0); }

  /** Tempo breakpoints inside (b0, b1) (beats where the tempo curve changes shape). */
  breaks(b0, b1) {
    const out = [];
    for (const g of this.segs) if (g.beat > b0 + EPS && g.beat < b1 - EPS) out.push(g.beat);
    return out;
  }
  /** Does the tempo vary inside [b0, b1)? */
  isConstantIn(b0, b1) {
    const g = this._seg(b0);
    return !g.k && g.end >= b1 - EPS;
  }

  // ------------------------------------------------------------------ meters / bars
  meterAt(beat) {
    const m = this.meters;
    if (m.length === 1 || beat < m[1].beat) return m[0];
    let lo = 0, hi = m.length - 1;
    while (lo < hi) { const x = (lo + hi + 1) >> 1; if (m[x].beat <= beat + EPS) lo = x; else hi = x - 1; }
    return m[lo];
  }
  meterOfBar(bar) {
    let r = this.meters[0];
    for (const m of this.meters) if (m.bar <= bar) r = m; else break;
    return r;
  }
  /** Beat where (0-based) bar `bar` starts. */
  barStart(bar) {
    const m = this.meterOfBar(bar);
    return m.beat + (bar - m.bar) * m.bpb;
  }
  /** Bar info at a beat: { bar (0-based), start (beat), length (beats), num, den, unit (beats), offset (beats into bar) } */
  barAt(beat) {
    const m = this.meterAt(beat);
    const rel = (beat - m.beat) / m.bpb;
    const bar = m.bar + Math.floor(rel + 1e-9);
    const start = m.beat + (bar - m.bar) * m.bpb;
    return { bar, start, length: m.bpb, num: m.num, den: m.den, unit: m.unit, groups: m.groups, offset: beat - start };
  }
  /** Musical position { bar: 1-based, beat: 1-based (denominator units), sub: 0..3 (16ths in that unit), ticks } */
  position(beat, ppq = 960) {
    const b = this.barAt(beat);
    const unitIdx = Math.floor(b.offset / b.unit + 1e-9);
    const inUnit = b.offset - unitIdx * b.unit;
    return { bar: b.bar + 1, beat: unitIdx + 1, sub: Math.floor((inUnit / 0.25) + 1e-9), ticks: Math.round(inUnit * ppq), num: b.num, den: b.den };
  }
  /** "BAR.BEAT.SUB" like a hardware LCD (1-based bar & beat). */
  formatBBT(beat) {
    const p = this.position(Math.max(0, beat));
    return `${p.bar}.${p.beat}.${p.sub + 1}`;
  }
  /** Bars covering [0, beat]: count of whole + started bars. */
  barCount(beat) { return this.barAt(Math.max(0, beat - 1e-9)).bar + 1; }
  /** Beat `n` bars after `beat`'s bar start (phrase math in bars, meter changes respected). */
  addBars(beat, n) { const b = this.barAt(beat); return this.barStart(b.bar + n) + (n === 0 ? b.offset : 0); }

  /**
   * Metronome clicks in [b0, b1): one per denominator unit; level 2 = bar downbeat, 1 = accent-group start
   * (compound / odd meters), 0 = other. -> [{beat, level, accent}]
   */
  clicks(b0, b1) {
    const out = [];
    if (!(b1 > b0)) return out;
    for (let j = 0; j < this.meters.length; j++) {
      const m = this.meters[j];
      const end = this.meters[j + 1]?.beat ?? Infinity;
      const lo = Math.max(b0, m.beat), hi = Math.min(b1, end);
      if (!(hi > lo)) continue;
      // accent level per unit within a bar
      const levels = [];
      for (const g of m.groups) { levels.push(1); for (let i = 1; i < g; i++) levels.push(0); }
      levels[0] = 2;
      let k = Math.ceil((lo - m.beat) / m.unit - 1e-7);
      for (let b = m.beat + k * m.unit; b < hi - 1e-7; k++, b = m.beat + k * m.unit) {
        if (b < lo - 1e-7) continue;
        const idx = ((k % m.num) + m.num) % m.num;
        const level = levels[idx] ?? 0;
        out.push({ beat: b, level, accent: level === 2 });
      }
    }
    return out;
  }

  /** Grid lines for drawing [b0, b1): bars (and beats when `beats`). -> [{beat, bar?, kind:'bar'|'beat'}] */
  gridLines(b0, b1, { beats = true, maxLines = 4000 } = {}) {
    const out = [];
    let { bar } = this.barAt(Math.max(0, b0));
    for (let s = this.barStart(bar); s < b1 && out.length < maxLines; bar++, s = this.barStart(bar)) {
      const m = this.meterOfBar(bar);
      if (s >= b0 - EPS) out.push({ beat: s, bar, kind: 'bar' });
      if (beats) for (let u = 1; u < m.num; u++) { const b = s + u * m.unit; if (b >= b0 - EPS && b < b1) out.push({ beat: b, kind: 'beat' }); }
    }
    return out;
  }

  /** Stable key (cache identity). */
  get key() { return this._key || (this._key = JSON.stringify([this.segs.map((s) => [s.beat, s.bpm, s.k]), this.meters.map((m) => [m.bar, m.num, m.den, m.groups])])); }
}

// ------------------------------------------------------------------------------------- project access
const cache = new Map();
const keyOf = (project, constant) => `${constant ? 1 : 0}|${project.bpm}|${project.timeSig?.join('/')}|${constant ? '' : JSON.stringify(project.tempoMap || null)}|${JSON.stringify(project.meterMap || null)}`;

/**
 * The project's tempo map (cached by content). mode 'pattern' (or project.mode when omitted) gives the constant
 * map at project.bpm — tempo changes are a song-mode (arrangement) feature. Meter changes apply in both.
 */
export function tempoMapFor(project, mode) {
  if (!project) return new TempoMap();
  const constant = (mode || project.mode) === 'pattern' || !project.tempoMap?.length;
  const k = keyOf(project, constant);
  let m = cache.get(k);
  if (!m) {
    m = new TempoMap({ bpm: project.bpm, points: constant ? [] : project.tempoMap, timeSig: project.timeSig, meters: project.meterMap });
    if (cache.size > 32) cache.delete(cache.keys().next().value);
    cache.set(k, m);
  }
  return m;
}
/** The arrangement (song-mode) map regardless of the project's current mode. */
export const songTempoMap = (project) => tempoMapFor(project, 'song');

/** Constant map (e.g. for code that must ignore the map). */
export const constantMap = (bpm, timeSig = [4, 4]) => new TempoMap({ bpm, timeSig });

/** Does the project have tempo or meter changes? */
export function hasTempoChanges(project) {
  if (!project?.tempoMap?.length) return false;
  const m = songTempoMap(project);
  return m.segs.some((g) => g.k || Math.abs(g.bpm - m.bpm) > 1e-9);
}
export const hasMeterChanges = (project) => (project?.meterMap || []).some((m) => m.bar > 0);

/**
 * `spb` argument accepted by schedule helpers (mixer automation, clip envelopes): a number (constant seconds per
 * beat) or a TempoMap. spanOf(spb, b0, b1) = seconds from b0 to b1.
 */
export function spanOf(spb, b0, b1) {
  if (spb && typeof spb === 'object' && typeof spb.span === 'function') return spb.span(b0, b1);
  return (b1 - b0) * spb;
}
