// Idiom engine: finds the shortest FAITHFUL Strudel expression for a part (a note list over a loop length).
// Pure (runs under Node).
//
//   renderPart(notes, lengthBeats, ctx) -> { expr, form, verified, notes }
//       ctx: { kind: 'melodic'|'drums', bpb, key: {root, scale}, spell, verify (default true) }
//       expr: the note-producing expression, e.g.  n("0 2 4 2".add("<0 3 5 4>")).scale("G4:minor")
//             or  s("bd*4, [~ cp]*2, hh*8")  (no track-level controls: sound, gain, fx are added by the caller)
//   quantizePart(notes, lengthBeats, bpb) -> cleaned notes (onsets on 1/16 or 1/24 beat, velocities on 0.05)
//   compactSteps(tokens), barsText(segs), euclid detection, scale degrees, motif + transposition, arps, chords
//   verifyExpr(expr, targetNotes, {cycles, bpb, kind}) -> boolean   (evaluates through the src/code/strudel.js facade)
//
// How it works: the part is quantized (humanized timing snaps to the grid, velocities to 0.05 steps), split into bars
// (bar groups when notes cross bar lines) and non-overlapping layers, and rendered by several candidate writers —
// scale degrees (n().scale()), a motif moved per bar (n("cell".add("<offsets>"))), arps (.arp()), chord symbols
// (chord().voicing()), note names (note()) — each using the same mini-notation compressor (`!n`, `*n`, `@n`,
// `<a!3 b>`, column alternation `<a b c <d!3 e>>`, euclid `bd(3,8)`, `[a b]*2`). Velocities get their own coarsest
// fitting pattern (constant, per-step accents, per-bar `<>`), within VEL_TOL of every note. Candidates are scored by
// length (+ a small readability penalty for note names) and verified in order by evaluating them through the code
// engine facade and comparing every onset / pitch / duration / velocity with the quantized part; the first faithful
// one wins. Results are cached per part content and engine version.
import { DRUM_PADS } from '../core/model.js';
import { evaluate, queryEvents, codeEngineVersion, bjork } from './strudel.js';
import { SCALES, resolveScaleId } from '../theory/scales.js';
import { detectChord } from '../theory/chords.js';

const EPS = 1e-6;
export const VEL_TOL = 0.1;
export const DEFAULT_VEL = 0.8;
const PITCH_TO_SHORT = Object.fromEntries(DRUM_PADS.map((p) => [p.pitch, p.short]));
const SHORT_TO_PITCH = Object.fromEntries(DRUM_PADS.map((p) => [p.short, p.pitch]));
const DRUM_ORDER = new Map(DRUM_PADS.map((p, i) => [p.pitch, i]));
const RES = [1, 2, 4, 3, 8, 6, 12, 16, 24];

const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
const mod = (n, m) => ((n % m) + m) % m;

/** Velocity literal: 0.8 -> ".8", 1 -> "1". */
export function velStr(v) {
  const r = round(clamp(v, 0, 1), 2);
  if (r >= 1) return '1';
  if (r <= 0) return '0';
  return String(r).replace(/^0\./, '.');
}
export const qVel = (v) => Math.round(clamp(v, 0, 1) * 20) / 20;

/**
 * Onset quantisation: onsets on the 1/24-beat grid (16ths, 32nds, 8th and 16th triplets) stay; others snap to
 * the nearest 16th when within 0.05 beat (humanised or strummed notes), else to the nearest 1/24 beat.
 */
export function snapBeat(b) {
  const s24 = Math.round(b * 24) / 24;
  if (Math.abs(b - s24) < 0.002) return s24;
  const s16 = Math.round(b * 4) / 4;
  if (Math.abs(b - s16) <= 0.05 + 1e-9) return s16;
  return Math.round(b * 24) / 24;
}

/** Continuous swing warp of a time in beats (as src/gen/groove.js bakes it into notes; beats are fixed points). */
export function swingWarp(t, s8 = 0.5, s16 = 0.5) {
  const b = Math.floor(t + 1e-4);
  let x = Math.max(0, t - b);
  if (s8 !== 0.5) x = x < 0.5 ? (x * s8) / 0.5 : s8 + ((x - 0.5) * (1 - s8)) / 0.5;
  else if (s16 !== 0.5) {
    const h = x < 0.5 ? 0 : 0.5;
    const y = (x - h) / 0.5;
    x = h + (y < 0.5 ? (y * s16) / 0.5 : s16 + ((y - 0.5) * (1 - s16)) / 0.5) * 0.5;
  }
  return b + x;
}

const LATE_MAX = 0.075; // humanised notes sit at most this late (beats) behind their grid step
/**
 * Snaps a humanised onset to its 16th: the step just before it (late-only micro-timing and strums), or null
 * when no step is close (triplets, rolls, 32nds).
 */
export function grooveSnap(t, { early = 0.012, late = LATE_MAX } = {}) {
  const base = Math.floor(t * 4) / 4;
  let best = null;
  for (const g of [base - 0.25, base, base + 0.25]) {
    const d = t - g;
    if (d >= -early && d <= late && (best === null || Math.abs(d) < best.d)) best = { g, d: Math.abs(d) };
  }
  return best ? best.g : null;
}

/** Snaps to the coarsest fine grid (8ths of a beat, triplets, 64ths, 1/24) within a few ms; else snapBeat. */
export function snapFine(t) {
  for (const r of [8, 6, 12, 16, 24]) {
    const g = Math.round(t * r) / r;
    if (t - g >= -0.006 && t - g <= 0.014) return g;
  }
  return snapBeat(t);
}

/**
 * Swing as Strudel's swingBy(x, n) plays it: in every slice of h beats (h = 1: 8th swing, 0.5: 16th swing) the
 * second half is delayed by d beats. unswing(t) maps a played time back to the straight time the code writes.
 */
export function unswing(t, groove) {
  if (!groove || !(groove.d > 0)) return t;
  const h = groove.h;
  const s0 = Math.floor(t / h + 1e-9) * h;
  const q = t - s0;
  return q >= h / 2 + groove.d - 0.012 ? t - groove.d : t;
}

/**
 * The swing a part was played with: {h, d} (d = 0: straight) — candidates from the genre's groove and a sweep;
 * chosen when it puts clearly more onsets on the 16th grid than straight timing does.
 */
export function detectSwing(notes, prior = null) {
  const starts = (notes || []).map((n) => n.start).filter((t) => Number.isFinite(t));
  const none = { h: 1, d: 0 };
  if (starts.length < 8) return none;
  const onGridCount = (g) => starts.filter((t) => grooveSnap(unswing(t, g)) !== null).length;
  const cands = [];
  if (prior) {
    if (prior.s8 && prior.s8 !== 0.5) cands.push({ h: 1, d: round(prior.s8 - 0.5, 3) });
    else if (prior.s16 && prior.s16 !== 0.5) cands.push({ h: 0.5, d: round((prior.s16 - 0.5) * 0.5, 3) });
  }
  for (let v = 0.04; v <= 0.205; v += 0.02) cands.push({ h: 1, d: round(v, 2) });
  for (let v = 0.02; v <= 0.105; v += 0.01) cands.push({ h: 0.5, d: round(v, 2) });
  const base = onGridCount(none);
  let best = none, bestN = base, bestR = Infinity;
  // notes the swing explains: off the straight grid, on it once un-swung
  const moved = (g) => starts.filter((t) => grooveSnap(t) === null && unswing(t, g) !== t && grooveSnap(unswing(t, g)) !== null).length;
  // how far the un-swung onsets still sit from their steps (several amounts can put them all on the grid —
  // the played one leaves the least residue)
  const residue = (g) => starts.reduce((a, t) => { const u = unswing(t, g); const s = grooveSnap(u); return a + (s === null ? 0 : Math.abs(u - s)); }, 0);
  for (const c of cands) {
    const n = onGridCount(c);
    if (n <= base + Math.max(3, starts.length * 0.1) || moved(c) < Math.max(4, starts.length * 0.15)) continue;
    const r = residue(c);
    if (n > bestN || (n === bestN && r < bestR - 1e-6)) { best = c; bestN = n; bestR = r; }
  }
  return best;
}

/**
 * Notes -> quantized notes inside [0, L): {pitch, start, dur, vel, vel0} (vel0 = the original velocity).
 * groove {h, d}: onsets are un-swung, then humanised onsets snap to the 16th they were pushed from.
 */
export function quantizePart(notes, L, { groove = null } = {}) {
  const snapStart = (t) => {
    if (!groove) return snapBeat(t);
    if (!(groove.d > 0)) return grooveSnap(t, { late: 0.012 }) ?? snapFine(t) ?? snapBeat(t);
    // code time c plays at c (first half of a swing slice) or c + d (second half): pick the closest
    const { h, d } = groove;
    const second = (c) => c - Math.floor(c / h + 1e-9) * h >= h / 2 - 1e-9;
    const real = (c) => (second(c) ? c + d : c);
    let best = null;
    for (const u of [t, t - d]) {
      for (const [c, grid] of [[grooveSnap(u), true], [snapFine(u), false]]) {
        if (c === null) continue;
        const off = t - real(c);
        // the 16th grid with late-only humanisation first; finer grid positions only when nothing else fits
        const cost = (off >= -0.012 ? Math.abs(off) : Math.abs(off) * 3 + 0.05) + (grid ? 0 : 0.08);
        if (!best || cost < best.cost - 1e-9) best = { c, cost };
      }
    }
    return best.c;
  };
  return (notes || [])
    .map((n) => {
      const st = snapStart(n.start);
      const end = n.start + (n.dur > 0 ? n.dur : 0.25);
      // the end snaps with the start (pushed grid); otherwise the played length stays
      let dur = n.dur > 0 ? n.dur : 0.25;
      if (groove) { const ge = grooveSnap(unswing(end, groove), { early: 0.06, late: 0.06 }); if (ge !== null && ge > st && Math.abs(ge - st - dur) < 0.13) dur = ge - st; } else dur = end - st;
      return { pitch: n.pitch, start: st, dur: dur > 0 ? dur : 0.25, vel: qVel(n.vel ?? DEFAULT_VEL), vel0: n.vel ?? DEFAULT_VEL };
    })
    .filter((n) => n.start >= -EPS && n.start < L - EPS)
    .map((n) => ({ ...n, start: Math.max(0, n.start), dur: Math.max(1 / 24, Math.min(Math.round(n.dur * 24) / 24 || 1 / 24, L - n.start)) }))
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch || b.dur - a.dur)
    // notes that land on the same step (a roll squeezed by the grid) play once
    .filter((n, i, a) => !(i > 0 && a[i - 1].pitch === n.pitch && Math.abs(a[i - 1].start - n.start) < 1e-9));
}

/** Strudel swing for a detected groove: '.swingBy(x, n)' ('' when straight). */
export function swingCall(groove, bpb) {
  if (!groove || !(groove.d > 0)) return '';
  const x = round((2 * groove.d) / groove.h, 3);
  return `.swingBy(${velStr(x) === '1' && x !== 1 ? x : String(x).replace(/^0\./, '.')}, ${round(bpb / groove.h, 3)})`;
}

// ------------------------------------------------------------------------------------ mini-notation writer

const onGrid = (times, r) => times.every((t) => Math.abs(t * r - Math.round(t * r)) < 1e-3 * r + 1e-6);
export function chooseRes(times) {
  for (const r of RES) if (onGrid(times, r)) return r;
  return 24;
}
/** Brackets a mini-notation term when it has top-level spaces or commas: "a b" -> "[a b]". */
export function wrap(x) {
  let depth = 0;
  for (const c of x) {
    if ('[<{('.includes(c)) depth++;
    else if (']>})'.includes(c)) depth--;
    else if ((c === ' ' || c === ',') && depth === 0) return `[${x}]`;
  }
  return x;
}

/** Drop rests at every other (or every 2nd/3rd of three) position while possible: "bd ~ sd ~" -> "bd sd". */
function reduceRests(tokens) {
  for (;;) {
    let done = true;
    for (const f of [2, 3]) {
      if (tokens.length > 1 && tokens.length % f === 0 && tokens.every((t, i) => i % f === 0 || t === '~')) {
        tokens = tokens.filter((_, i) => i % f === 0);
        done = false;
        break;
      }
    }
    if (done) return tokens;
  }
}

/** "x(k,n)" when the hits of a one-voice step grid are an (unrotated) euclidean rhythm. */
export function euclidOf(tokens) {
  const n = tokens.length;
  if (n < 5 || n > 32) return null;
  const hits = tokens.filter((t) => t !== '~');
  if (hits.length < 2 || hits.length >= n - 1 || hits.some((t) => t !== hits[0])) return null;
  if (/[\s[\]<>,]/.test(hits[0])) return null;
  const k = hits.length;
  const e = bjork(k, n);
  for (let i = 0; i < n; i++) if (!!e[i] !== (tokens[i] !== '~')) return null;
  return `${hits[0]}(${k},${n})`;
}

const stepsMemo = new Map();
/** Compact mini-notation for a grid of one-step tokens (drum hits / velocities). */
export function compactSteps(tokens, opts = {}) {
  const k = `${opts.rests !== false ? 1 : 0}${opts.euclid !== false ? 1 : 0}|${tokens.join(' ')}`;
  let r = stepsMemo.get(k);
  if (r === undefined) {
    r = compactStepsRaw(tokens, opts);
    if (stepsMemo.size > 20000) stepsMemo.clear();
    stepsMemo.set(k, r);
  }
  return r;
}
function compactStepsRaw(tokens, { rests = true, euclid = true } = {}) {
  if (rests) tokens = reduceRests(tokens);
  const n = tokens.length;
  if (n === 0) return '~';
  if (n === 1) return tokens[0];
  if (tokens.every((t) => t === tokens[0])) return tokens[0] === '~' ? '~' : `${wrap(tokens[0])}*${n}`;
  const cands = [];
  for (const g of [4, 3, 2, 8, 6]) {
    if (n % g || n / g < 2) continue;
    const per = n / g;
    const parts = [];
    for (let i = 0; i < g; i++) parts.push(wrap(compactSteps(tokens.slice(i * per, (i + 1) * per), { rests, euclid })));
    cands.push(parts.join(' '));
  }
  for (let p = 1; p <= n / 2; p++) {
    if (n % p) continue;
    let ok = true;
    for (let i = p; i < n && ok; i++) ok = tokens[i] === tokens[i - p];
    if (ok) { cands.push(`${wrap(compactSteps(tokens.slice(0, p), { rests, euclid }))}*${n / p}`); break; }
  }
  if (euclid) { const e = euclidOf(tokens); if (e) cands.push(e); }
  cands.push(runs(tokens));
  let best = cands[0];
  for (const c of cands) if (c.length < best.length) best = c;
  return best;
}

/** "a a a b" -> "a!3 b" (only where shorter). */
function runs(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length;) {
    let j = i + 1;
    while (j < tokens.length && tokens[j] === tokens[i]) j++;
    const t = tokens[i];
    const k = j - i;
    if (k > 1 && t !== '~' && `${t}!${k}`.length < (t.length + 1) * k - 1) out.push(`${wrap(t)}!${k}`);
    else for (let m = 0; m < k; m++) out.push(t);
    i = j;
  }
  return out.join(' ');
}

/** Weighted items [{tok, w}] -> "c3@3 e3" (weights reduced by their gcd). */
export function weightedSeq(items) {
  if (!items.length) return '~';
  const g = items.reduce((a, it) => gcd(a, it.w), 0) || 1;
  const ws = items.map((it) => it.w / g);
  if (ws.every((w) => w === 1)) return compactSteps(items.map((it) => it.tok), { rests: false, euclid: false });
  const n = items.length;
  // periodic: "x@3 ~ x@3 ~" -> "[x@3 ~]*2"
  for (let p = 1; p <= n / 2; p++) {
    if (n % p) continue;
    let ok = true;
    for (let i = p; i < n && ok; i++) ok = items[i].tok === items[i - p].tok && ws[i] === ws[i - p];
    if (ok) return `${wrap(weightedSeq(items.slice(0, p).map((it, i) => ({ tok: it.tok, w: ws[i] }))))}*${n / p}`;
  }
  return items.map((it, i) => (ws[i] === 1 ? it.tok : `${wrap(it.tok)}@${ws[i]}`)).join(' ');
}

export function mergeRests(items) {
  const out = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && last.tok === '~' && it.tok === '~') last.w += it.w;
    else out.push({ ...it });
  }
  return out;
}

/** Plain alternation of segments [{text, w}] -> "<a b@2 c!2>" (periodic lists collapse to their period). */
export function alternation(segs, { collapse = true } = {}) {
  if (!segs.length) return '~';
  const key = (s) => `${s.text}@${s.w}`;
  // (a period of nested alternations can't collapse: they advance once per selection)
  if (segs.some((s) => s.text.includes('<'))) collapse = false;
  for (let p = 1; collapse && p < segs.length; p++) {
    if (segs.length % p) continue;
    let ok = true;
    for (let i = p; i < segs.length && ok; i++) ok = key(segs[i]) === key(segs[i - p]);
    if (ok) { segs = segs.slice(0, p); break; }
  }
  if (segs.length === 1 && segs[0].w === 1) return segs[0].text;
  const out = [];
  for (let i = 0; i < segs.length;) {
    let j = i + 1;
    while (j < segs.length && key(segs[j]) === key(segs[i])) j++;
    const s = segs[i];
    let t = wrap(s.text) + (s.w !== 1 ? `@${s.w}` : '');
    if (j - i > 1) t += `!${j - i}`;
    out.push(t);
    i = j;
  }
  return `<${out.join(' ')}>`;
}

/**
 * Bars (segments [{text, w}], w = bars) -> the shortest alternation: plain `<a b c d>` / `<a!3 b>`, or a
 * column form for phrases that repeat with a varied ending: `<a b c <d!3 e>>` (nested alternations advance
 * once per selection, so column j plays bars j, j+P, j+2P, …).
 */
export function barsText(segs) {
  let best = alternation(segs);
  const N = segs.length;
  if (N >= 4 && segs.every((s) => s.w === 1)) {
    for (let P = 2; P <= N / 2; P++) {
      if (N % P) continue;
      const cols = [];
      for (let j = 0; j < P; j++) {
        const col = [];
        for (let i = j; i < N; i += P) col.push({ text: segs[i].text, w: 1 });
        cols.push({ text: alternation(col), w: 1 });
      }
      const t = alternation(cols, { collapse: false });
      if (t.length < best.length) best = t;
    }
  }
  return best;
}

// ------------------------------------------------------------------------------------ structure

/** Splits [0, bars) into groups so no note crosses a group boundary. -> [[barStart, barEnd]] */
export function barGroups(notes, bars, barLen) {
  // every note joins the bars it sounds in (start bar .. bar of its end) into one group
  const reach = new Array(bars).fill(0).map((_, i) => i + 1);
  for (const n of notes) {
    const b0 = Math.floor(n.start / barLen + 1e-9);
    if (b0 < 0 || b0 >= bars) continue;
    const b1 = Math.min(bars, Math.max(b0 + 1, Math.ceil((n.start + n.dur) / barLen - 1e-4)));
    if (b1 > reach[b0]) reach[b0] = b1;
  }
  const groups = [];
  for (let b = 0; b < bars;) {
    let end = reach[b];
    for (let k = b + 1; k < end; k++) end = Math.max(end, reach[k]);
    groups.push([b, end]);
    b = end;
  }
  return groups;
}

/** Bar layout of a part: whole bars when L is a whole number of bars, else one "bar" of length L (slow ≠ 1). */
export function barLayout(L, bpb) {
  const whole = Math.abs(L / bpb - Math.round(L / bpb)) < EPS && Number.isInteger(bpb) && L >= bpb - EPS;
  return whole ? { bars: Math.round(L / bpb), barLen: bpb, slow: 1 } : { bars: 1, barLen: L, slow: L / bpb };
}

/**
 * Melodic structure: layers of chord events per bar group.
 * -> { groups: [[a,b]], layers: [{ groups: [{w, S, items: [{ps: number[]|null, w, vels: number[]}]}] }] }
 */
export function melodicStructure(clean, L, bpb) {
  const { bars, barLen } = barLayout(L, bpb);
  const groups = barGroups(clean, bars, barLen);
  const inGroup = (n, [a, b]) => n.start >= a * barLen - EPS && n.start < b * barLen - EPS;
  const perGroup = groups.map((g) => {
    const span = (g[1] - g[0]) * barLen;
    const ns = clean.filter((n) => inGroup(n, g)).map((n) => ({ ...n, t: n.start - g[0] * barLen }));
    const rOn = chooseRes(ns.map((n) => n.t));
    const re = Math.max(rOn, 4);
    const r = chooseRes(ns.flatMap((n) => [n.t, Math.round(Math.min(span, n.t + n.dur) * re) / re]));
    const S = Math.max(1, Math.round(span * r));
    const evMap = new Map();
    for (const n of ns) {
      const s0 = Math.min(S - 1, Math.round(n.t * r));
      const d = Math.max(1, Math.min(S - s0, Math.round(n.dur * r)));
      const k = `${s0}|${d}`;
      if (!evMap.has(k)) evMap.set(k, { s0, d, ps: [], vels: [] });
      const e = evMap.get(k);
      if (!e.ps.includes(n.pitch)) { e.ps.push(n.pitch); e.vels.push(n.vel); }
    }
    const evs = [...evMap.values()].sort((a, b) => a.s0 - b.s0 || b.d - a.d);
    for (const e of evs) e.ps.sort((a, b) => a - b);
    const layers = [];
    for (const e of evs) {
      let lay = layers.find((l) => l.end <= e.s0);
      if (!lay) { lay = { end: 0, evs: [] }; layers.push(lay); }
      lay.evs.push(e);
      lay.end = e.s0 + e.d;
    }
    return { S, r, layers, w: g[1] - g[0] };
  });
  const nLayers = Math.max(1, ...perGroup.map((g) => g.layers.length));
  const layers = [];
  for (let li = 0; li < nLayers; li++) {
    layers.push({
      groups: perGroup.map((g) => {
        const lay = g.layers[li];
        const items = [];
        let pos = 0;
        for (const e of lay ? lay.evs : []) {
          if (e.s0 > pos) items.push({ ps: null, w: e.s0 - pos });
          items.push({ ps: e.ps, w: e.d, vels: e.vels });
          pos = e.s0 + e.d;
        }
        if (pos < g.S) items.push({ ps: null, w: g.S - pos });
        return { w: g.w, S: g.S, items };
      }),
    });
  }
  return { groups, layers, barLen };
}

/** Text of one layer given a token writer for pitch lists. */
function layerText(layer, tok) {
  const segs = layer.groups.map((g) => {
    const items = g.items.map((it) => ({ tok: it.ps ? tok(it.ps) : '~', w: it.w }));
    const allRest = items.every((it) => it.tok === '~');
    return { text: allRest ? '~' : weightedSeq(mergeRests(items)), w: g.w };
  });
  return barsText(segs);
}

// ------------------------------------------------------------------------------------ scales

/** Project scale id -> Strudel scale name (":"-separated) — the ones both engines know. */
const STRUDEL_SCALE = {
  major: 'major', minor: 'minor', ionian: 'major', aeolian: 'minor', dorian: 'dorian', phrygian: 'phrygian', lydian: 'lydian',
  mixolydian: 'mixolydian', locrian: 'locrian', 'harmonic-minor': 'harmonic:minor', 'melodic-minor': 'melodic:minor',
  'minor-pentatonic': 'minor:pentatonic', 'major-pentatonic': 'major:pentatonic', blues: 'minor:blues', 'major-blues': 'major:blues',
};
/** Related scales tried when the project scale doesn't fit every note (raised 7ths in minor, modal borrowing). */
const RELATED = {
  minor: ['harmonic-minor', 'dorian', 'phrygian', 'melodic-minor'],
  major: ['mixolydian', 'lydian'],
  dorian: ['minor', 'mixolydian', 'melodic-minor'],
  phrygian: ['minor', 'harmonic-minor'],
  mixolydian: ['major', 'dorian'],
  lydian: ['major'],
  'harmonic-minor': ['minor', 'melodic-minor'],
  'melodic-minor': ['minor', 'dorian', 'harmonic-minor'],
  'minor-pentatonic': ['minor', 'dorian', 'blues'],
  'major-pentatonic': ['major', 'mixolydian'],
  blues: ['minor-pentatonic', 'dorian', 'minor'],
  'major-blues': ['mixolydian', 'major'],
};

export function scaleCandidates(scaleId) {
  const id = resolveScaleId(scaleId);
  const ids = [id, ...(RELATED[id] || []), 'minor', 'major'].filter((x, i, a) => a.indexOf(x) === i && STRUDEL_SCALE[x]);
  return ids.map((x) => ({ id: x, name: STRUDEL_SCALE[x], intervals: SCALES[x].intervals }));
}

/** Pitch -> scale degree (0-based from `rootMidi`), or null when the pitch isn't in the scale. */
export function toDegree(pitch, rootMidi, intervals) {
  const rel = pitch - rootMidi;
  const oct = Math.floor(rel / 12);
  const idx = intervals.indexOf(mod(rel, 12));
  return idx < 0 ? null : oct * intervals.length + idx;
}
export function fromDegree(d, rootMidi, intervals) {
  const k = intervals.length;
  return rootMidi + 12 * Math.floor(d / k) + intervals[mod(d, k)];
}
const COMMON = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const rootName = (pc) => COMMON[mod(pc, 12)];
export function scaleLabel(rootMidi, sc) {
  return `${rootName(rootMidi % 12)}${Math.floor(rootMidi / 12) - 1}:${sc.name}`;
}

/**
 * Converts a pitch set to degrees in the first fitting scale (project scale, then related ones).
 * -> [{ sc, roots: [rootMidi…] }] candidates where every pitch fits.
 */
function degreeContexts(pitches, key) {
  if (!key || key.root == null || !pitches.length) return [];
  const out = [];
  const lo = Math.min(...pitches);
  const hi = Math.max(...pitches);
  const mid = (lo + hi) / 2;
  for (const sc of scaleCandidates(key.scale)) {
    if (!pitches.every((p) => sc.intervals.includes(mod(p - key.root, 12)))) continue;
    // anchor octaves: the root at/below the lowest note, and the one nearest the middle of the range
    const r0 = lo - mod(lo - key.root, 12);
    const roots = [...new Set([r0, r0 + 12, mid - mod(mid - key.root, 12)].map(Math.round))].filter((r) => r >= 12 && r <= 108);
    out.push({ sc, roots });
    if (out.length >= 2) break;
  }
  return out;
}

// ------------------------------------------------------------------------------------ velocities

/** Best velocity value (0.05 grid) for a set of velocities, or null if they span more than 2·tol. */
function fitVel(vs, tol = VEL_TOL) {
  if (!vs.length) return null;
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const mid = Math.round(((lo + hi) / 2) * 20) / 20;
  for (const v of [mid, mid - 0.05, mid + 0.05]) {
    if (v >= 0 && v <= 1 && hi - v <= tol + 1e-9 && v - lo <= tol + 1e-9) return round(v, 2);
  }
  return null;
}

/**
 * Coarsest velocity pattern for events [{t (beats), vel}] over L beats: null (all ≈ .8), a number, or a mini string
 * (looked up by onset time: per-step accents in a bar, per-bar `<>`, or a full literal).
 */
export function velocityModel(evs, L, bpb, tol = VEL_TOL) {
  if (!evs.length) return null;
  const vs = evs.map((e) => e.vel);
  if (vs.every((v) => Math.abs(v - DEFAULT_VEL) <= tol + 1e-9)) return null;
  const c = fitVel(vs, tol);
  if (c !== null) return c;
  const { bars, barLen } = barLayout(L, bpb);
  const gridFor = (list, g) => {
    // g cells per bar; values of notes falling in each cell
    const cells = Array.from({ length: g }, () => []);
    for (const e of list) cells[Math.min(g - 1, Math.floor(round((mod(e.t, barLen) / barLen) * g, 6)))].push(e.vel);
    const vals = [];
    for (const cvs of cells) {
      if (!cvs.length) { vals.push(null); continue; }
      const v = fitVel(cvs, tol);
      if (v === null) return null;
      vals.push(v);
    }
    // empty cells take a neighbour's value (a rest in the velocity pattern would drop notes)
    for (let i = 0; i < g; i++) if (vals[i] === null) vals[i] = vals.slice(0, i).reverse().find((x) => x !== null) ?? vals.find((x) => x !== null);
    return compactSteps(vals.map(velStr), { rests: false, euclid: false });
  };
  const GRIDS = [...new Set([1, 2, bpb, 2 * bpb, 3 * bpb, 4 * bpb, 6 * bpb, 8 * bpb, 12 * bpb, 24 * bpb])].filter((g) => Number.isInteger(g) && g >= 1);
  const tryGrids = (list) => { for (const g of GRIDS) { const t = gridFor(list, g); if (t !== null) return t; } return null; };
  let best = null;
  const whole = tryGrids(evs);
  if (whole !== null) best = whole;
  if (bars > 1) {
    const barList = Array.from({ length: bars }, (_, b) => evs.filter((e) => e.t >= b * barLen - EPS && e.t < (b + 1) * barLen - EPS));
    const own = barList.map((list) => (list.length ? tryGrids(list) : '__'));
    const fill = (segs) => {
      // empty bars repeat a neighbour (no rests in velocity patterns)
      for (let i = 0; i < segs.length; i++) if (segs[i].text === '__') segs[i].text = (segs.slice(0, i).reverse().find((x) => x.text !== '__') || segs.find((x) => x.text !== '__') || { text: velStr(DEFAULT_VEL) }).text;
      return segs;
    };
    const cands = [];
    if (own.every((t) => t !== null)) cands.push(barsText(fill(own.map((t) => ({ text: t, w: 1 })))));
    // one accent pattern shared by most bars, the others (crescendos, fills) spelled out on their own
    for (const g of GRIDS) {
      const cells = Array.from({ length: g }, () => []);
      const cellOf = (e) => Math.min(g - 1, Math.floor(round((mod(e.t, barLen) / barLen) * g, 6)));
      for (const e of evs) cells[cellOf(e)].push(e.vel);
      const P = cells.map((cvs) => (cvs.length ? qVel(cvs.slice().sort((x, y) => x - y)[cvs.length >> 1]) : null));
      for (let i = 0; i < g; i++) if (P[i] === null) P[i] = P.slice(0, i).reverse().find((x) => x !== null) ?? P.find((x) => x !== null);
      const fits = barList.map((list) => list.every((e) => Math.abs(e.vel - P[cellOf(e)]) <= tol + 1e-9));
      if (fits.filter(Boolean).length < Math.max(2, bars / 2)) continue;
      const ptext = compactSteps(P.map(velStr), { rests: false, euclid: false });
      const segs = barList.map((list, b) => ({ text: !list.length ? '__' : fits[b] ? ptext : own[b], w: 1 }));
      if (segs.some((x) => x.text === null)) continue;
      cands.push(barsText(fill(segs)));
      break;
    }
    for (const t of cands) if (best === null || t.length < best.length) best = t;
  }
  if (best !== null) return best;
  // literal: every onset on the 1/24 grid, one alternation step per bar
  const segs = [];
  for (let b = 0; b < bars; b++) {
    const list = evs.filter((e) => e.t >= b * barLen - EPS && e.t < (b + 1) * barLen - EPS);
    const S = Math.max(1, Math.round(barLen * 24));
    const cells = new Array(S).fill(null);
    for (const e of list) { const i = Math.min(S - 1, Math.round((e.t - b * barLen) * 24)); cells[i] = Math.max(cells[i] ?? 0, qVel(e.vel)); }
    let last = cells.find((x) => x !== null) ?? DEFAULT_VEL;
    for (let i = 0; i < S; i++) { if (cells[i] === null) cells[i] = last; else last = cells[i]; }
    segs.push({ text: compactSteps(cells.map(velStr), { rests: false, euclid: false }), w: 1 });
  }
  return barsText(segs);
}

export const velCall = (v) => (v === null || v === undefined ? '' : typeof v === 'number' ? `.velocity(${velStr(v)})` : `.velocity("${v}")`);

// ------------------------------------------------------------------------------------ verification

/** Events of an expression (cycles = bars) -> notes in beats: [{pitch, start, dur, vel}] (null on error). */
export function exprNotes(expr, { cycles, bpb, kind }) {
  let r;
  try { r = evaluate(expr); } catch { return null; }
  if (!r || r.error || r.pending || !r.entries?.length) return null;
  let evs;
  try { evs = queryEvents(r, 0, cycles); } catch { return null; }
  if (r.queryError) return null;
  const out = [];
  for (const e of evs) {
    const v = e.value;
    let pitch = null;
    if (kind === 'drums') {
      const s = typeof v.s === 'string' ? v.s : '';
      pitch = s === 'perc' && typeof v.n === 'number' && v.n >= 24 ? v.n : SHORT_TO_PITCH[s] ?? (s === 'perc' ? 63 : null);
    } else if (typeof v.note === 'number') pitch = Math.round(v.note);
    if (pitch === null || !Number.isFinite(pitch)) return null;
    out.push({ pitch, start: e.begin * bpb, dur: (e.end - e.begin) * bpb, vel: typeof v.velocity === 'number' ? v.velocity : DEFAULT_VEL });
  }
  return out;
}

/** True when `expr` plays exactly `target` (quantized notes) over `cycles` bars: onsets, pitches, durations, velocities. */
export function verifyExpr(expr, target, { cycles, bpb, kind, tol = VEL_TOL }) {
  const got = exprNotes(expr, { cycles, bpb, kind });
  if (!got || got.length !== target.length) return false;
  const key = (n) => `${n.pitch}@${Math.round(n.start * 48)}`;
  const pool = new Map();
  for (const g of got) { const k = key(g); if (!pool.has(k)) pool.set(k, []); pool.get(k).push(g); }
  for (const t of target) {
    const list = pool.get(key(t));
    if (!list?.length) return false;
    const g = list.pop();
    if (Math.abs(g.start - t.start) > 1e-3) return false;
    if (kind !== 'drums' && Math.abs(g.dur - t.dur) > Math.max(0.13, t.dur * 0.05) + 1e-6 && !(t.dur < 0.25 && g.dur <= 0.25 + 1e-6)) return false;
    if (Math.abs(g.vel - (t.vel0 ?? t.vel)) > tol + 0.03) return false;
  }
  return true;
}

// ------------------------------------------------------------------------------------ candidates

const slowSuffix = (slow) => (Math.abs(slow - 1) < EPS ? '' : (Number.isInteger(round(1 / slow, 6)) ? `.fast(${round(1 / slow, 3)})` : `.slow(${round(slow, 4)})`));
const q = (s) => `"${s}"`;

/** Note-name writer ("c3", chords "[c3,e3,g3]"). */
function nameTok(spell) { return (ps) => (ps.length === 1 ? spell(ps[0]) : `[${ps.map(spell).join(',')}]`); }
function degTok(root, sc) { return (ps) => { const ds = ps.map((p) => toDegree(p, root, sc.intervals)); return ds.length === 1 ? String(ds[0]) : `[${ds.join(',')}]`; }; }

/** Motif moved per bar: every bar has the same rhythm, and its degrees are bar 0's + a constant. */
function motifCandidate(st, root, sc) {
  if (st.layers.length !== 1) return null;
  const gs = st.layers[0].groups;
  if (gs.length < 2 || gs.some((g) => g.w !== 1)) return null;
  const deg = (p) => toDegree(p, root, sc.intervals);
  const shape = (g) => g.items.map((it) => `${it.w}:${it.ps ? it.ps.length : '~'}`).join(' ');
  // reference: the first bar with notes
  const ref = gs.find((g) => g.items.some((it) => it.ps));
  if (!ref) return null;
  const refShape = shape(ref);
  const offs = [];
  for (const g of gs) {
    if (!g.items.some((it) => it.ps)) return null; // silent bars break the motif (handled by other writers)
    if (shape(g) !== refShape) return null;
    let off = null;
    for (let i = 0; i < g.items.length; i++) {
      const a = g.items[i], b = ref.items[i];
      if (!a.ps) continue;
      for (let k = 0; k < a.ps.length; k++) {
        const d = deg(a.ps[k]) - deg(b.ps[k]);
        if (off === null) off = d; else if (off !== d) return null;
      }
    }
    offs.push(off);
  }
  if (offs.every((o) => o === 0)) return null; // no movement: plain degrees are shorter
  const base = Math.min(...offs.filter((o) => o !== null));
  const cellTok = (ps) => { const ds = ps.map((p) => deg(p) + base); return ds.length === 1 ? String(ds[0]) : `[${ds.join(',')}]`; };
  const cellItems = ref.items.map((it) => ({ tok: it.ps ? cellTok(it.ps) : '~', w: it.w }));
  const cell = weightedSeq(mergeRests(cellItems));
  const offText = barsText(offs.map((o) => ({ text: String(o - base), w: 1 })));
  const out = [`n(${q(cell)}.add(${q(offText)}))`];
  // a single repeated degree: the alternation itself carries the line ("<0 3 5 4>!4", or .struct for rests)
  const toks = cellItems.filter((it) => it.tok !== '~');
  if (toks.every((it) => it.tok === toks[0].tok) && !toks[0].tok.startsWith('[')) {
    const v = Number(toks[0].tok);
    const alt = barsText(offs.map((o) => ({ text: String(o - base + v), w: 1 })));
    const altW = alt.startsWith('<') ? alt : `<${alt}>`;
    const allW1 = cellItems.every((it) => it.w === cellItems[0].w);
    if (allW1 && cellItems.every((it) => it.tok !== '~')) out.push(`n(${q(cellItems.length === 1 ? altW : `${altW}!${cellItems.length}`)})`);
    const struct = weightedSeq(mergeRests(cellItems.map((it) => ({ tok: it.tok === '~' ? '~' : 'x', w: it.w }))));
    out.push(`n(${q(altW)}).struct(${q(struct)})`);
  }
  return out;
}

/**
 * Rhythm × harmony: the bars comp chords (or pedal a note) in a rhythm -> n("<chords>").struct("<rhythm>"),
 * each compressed on its own. The harmony may change inside a bar (pushed chords: "[A@15 B]"): struct samples it
 * at every hit.
 */
function structCandidate(st, ctx, degCtxs) {
  const G = st.layers[0].groups.length;
  for (let i = 0; i < G; i++) {
    const g0 = st.layers[0].groups[i];
    if (g0.w !== 1 || st.layers.some((l) => l.groups[i].S !== g0.S)) return [];
  }
  let multi = false;
  const bars = []; // per bar: [{ps, w}] harmony runs (no rests) | null
  for (let i = 0; i < G; i++) {
    const S = st.layers[0].groups[i].S;
    const evs = [];
    for (const l of st.layers) {
      let pos = 0;
      for (const it of l.groups[i].items) { if (it.ps) evs.push({ s0: pos, ps: it.ps, k: it.ps.join(',') }); pos += it.w; }
    }
    evs.sort((x, y) => x.s0 - y.s0);
    const runs = [];
    for (const e of evs) {
      const last = runs[runs.length - 1];
      if (last && last.k === e.k) { multi = true; continue; }
      if (last && last.s0 === e.s0) return []; // two different chords at once: not one harmony
      runs.push({ k: e.k, ps: e.ps, s0: e.s0 });
    }
    if (!runs.length) { bars.push(null); continue; }
    runs[0].s0 = 0;
    runs.forEach((r, j) => { r.w = (j + 1 < runs.length ? runs[j + 1].s0 : S) - r.s0; });
    bars.push(runs);
  }
  if (!multi) return [];
  const rhythm = st.layers.map((l) => barsText(l.groups.map((g) => {
    const items = g.items.map((it) => ({ tok: it.ps ? 'x' : '~', w: it.w }));
    return { text: items.every((x) => x.tok === '~') ? '~' : weightedSeq(mergeRests(items)), w: 1 };
  }))).join(', ');
  const out = [];
  const harmText = (tok) => barsText(bars.map((runs) => ({ text: runs ? weightedSeq(runs.map((r) => ({ tok: tok(r.ps), w: r.w }))) : '~', w: 1 })));
  degCtxs.forEach(({ sc, roots }, si) => {
    for (const root of roots) out.push({ expr: `n(${q(harmText(degTok(root, sc)))}).struct(${q(rhythm)}).scale(${q(scaleLabel(root, sc))})`, penalty: si * 3 - 3 });
  });
  const nm = `note(${q(harmText(nameTok(ctx.spell)))}).struct(${q(rhythm)})`;
  out.push({ expr: nm, penalty: out.length ? Math.round(nm.length * 0.3) + 6 : 0 });
  return out;
}

/** Arpeggio: each bar picks from its chord (sorted degrees) with one index pattern. */
function arpCandidate(st, root, sc) {
  if (st.layers.length !== 1) return null;
  const gs = st.layers[0].groups;
  if (gs.some((g) => g.w !== 1)) return null;
  const deg = (p) => toDegree(p, root, sc.intervals);
  const chordSegs = [];
  const idxSegs = [];
  let size = 0;
  for (const g of gs) {
    const ps = [...new Set(g.items.filter((it) => it.ps).flatMap((it) => it.ps))].sort((a, b) => a - b);
    if (g.items.some((it) => it.ps && it.ps.length > 1)) return null;
    if (!ps.length) { chordSegs.push({ text: '~', w: 1 }); idxSegs.push({ text: '~', w: 1 }); continue; }
    if (ps.length < 2 || ps.length > 6) return null;
    size = Math.max(size, ps.length);
    chordSegs.push({ text: `[${ps.map(deg).join(',')}]`, w: 1 });
    idxSegs.push({ text: weightedSeq(mergeRests(g.items.map((it) => ({ tok: it.ps ? String(ps.indexOf(it.ps[0])) : '~', w: it.w })))), w: 1 });
  }
  if (!size) return null;
  const notesPerBar = gs.map((g) => g.items.filter((it) => it.ps).length);
  if (Math.max(...notesPerBar) <= size) return null; // not an arpeggio (each tone once)
  return [`n(${q(barsText(chordSegs))}).arp(${q(barsText(idxSegs))})`];
}

const chordMemo = new Map();
/** Chord symbols with the engine's voicing() — only kept when the engine voices them exactly like the part. */
function chordSymbolCandidate(st) {
  if (st.layers.length !== 1) return null;
  const gs = st.layers[0].groups;
  let chords = 0;
  const tok = (ps) => {
    if (ps.length < 3) return null;
    const ck = ps.join(',');
    if (!chordMemo.has(ck)) chordMemo.set(ck, detectChord(ps));
    const c = chordMemo.get(ck);
    if (!c || !c.exact) return null;
    chords++;
    return strudelChordName(c);
  };
  const segs = [];
  for (const g of gs) {
    const items = [];
    for (const it of g.items) {
      if (!it.ps) { items.push({ tok: '~', w: it.w }); continue; }
      const t = tok(it.ps);
      if (!t) return null;
      items.push({ tok: t, w: it.w });
    }
    segs.push({ text: items.every((x) => x.tok === '~') ? '~' : weightedSeq(mergeRests(items)), w: g.w });
  }
  if (!chords) return null;
  return [`chord(${q(barsText(segs))}).voicing()`];
}

const CHORD_SUFFIX = { maj: '', min: 'm', dim: 'o', aug: 'aug', sus2: 'sus2', sus4: 'sus4', maj7: '^7', min7: 'm7', '7': '7', dom7: '7', m7b5: 'm7b5', dim7: 'o7', '6': '6', min6: 'm6', add9: 'add9', '9': '9', maj9: '^9', min9: 'm9' };
function strudelChordName(c) {
  const suf = CHORD_SUFFIX[c.type];
  if (suf === undefined) return null;
  return `${COMMON[mod(c.root, 12)]}${suf}`;
}

/**
 * All candidate expressions for a melodic part, roughly best-first: [{expr, form, score}].
 */
function melodicCandidates(clean, L, ctx) {
  const { bpb, spell, key } = ctx;
  const st = melodicStructure(clean, L, bpb);
  const { slow } = barLayout(L, bpb);
  const sl = slowSuffix(slow);
  const pitches = clean.map((n) => n.pitch);
  const out = [];
  const add = (expr, form, penalty = 0) => { if (expr) out.push({ expr: expr + sl, form, score: expr.length + sl.length + penalty }); };
  const layersMini = (tok) => st.layers.map((l) => layerText(l, tok)).join(', ');
  // (the project's scale first: a related scale costs a little more than its name's length)
  degreeContexts(pitches, key).forEach(({ sc, roots }, si) => {
    const sp = si * 3;
    for (const root of roots) {
      const scaleCall = `.scale(${q(scaleLabel(root, sc))})`;
      add(`n(${q(layersMini(degTok(root, sc)))})${scaleCall}`, 'degrees', sp - 2);
      for (const m of motifCandidate(st, root, sc) || []) add(m + scaleCall, 'motif', sp - 4);
      for (const a of arpCandidate(st, root, sc) || []) add(a + scaleCall, 'arp', sp - 3);
    }
  });
  const names = `note(${q(layersMini(nameTok(spell)))})`;
  // scale degrees are the idiom when the part fits a scale: note names only win when clearly shorter
  add(names, 'notes', out.length ? Math.round(names.length * 0.3) + 6 : 0);
  for (const st2 of structCandidate(st, ctx, degreeContexts(pitches, key))) add(st2.expr, 'struct', st2.penalty);
  for (const c of chordSymbolCandidate(st) || []) add(c, 'chords', -6);
  return out.sort((a, b) => a.score - b.score);
}

// ------------------------------------------------------------------------------------ drums

/** Drum voices: [{name, pitch, segs: [{text, w}] (per bar), evs: [{t, vel}]}] */
function drumVoices(clean, L, bpb) {
  const { bars, barLen } = barLayout(L, bpb);
  const byVoice = new Map();
  for (const n of clean) {
    const name = PITCH_TO_SHORT[n.pitch] || `perc:${n.pitch}`;
    if (!byVoice.has(name)) byVoice.set(name, { name, order: DRUM_ORDER.get(n.pitch) ?? 99, notes: [] });
    byVoice.get(name).notes.push(n);
  }
  return [...byVoice.values()].sort((a, b) => a.order - b.order).map((v) => {
    const segs = [];
    for (let b = 0; b < bars; b++) {
      const ns = v.notes.filter((n) => n.start >= b * barLen - EPS && n.start < (b + 1) * barLen - EPS).map((n) => n.start - b * barLen);
      const r = chooseRes(ns);
      const S = Math.max(1, Math.round(barLen * r));
      const cells = new Array(S).fill('~');
      for (const t of ns) cells[Math.min(S - 1, Math.round(t * r))] = v.name;
      segs.push({ text: compactSteps(cells), w: 1 });
    }
    return { name: v.name, segs, mini: barsText(segs), evs: v.notes.map((n) => ({ t: n.start, vel: n.vel0 ?? n.vel })) };
  });
}

function drumCandidates(clean, L, ctx) {
  const { bpb } = ctx;
  const { slow } = barLayout(L, bpb);
  const sl = slowSuffix(slow);
  const voices = drumVoices(clean, L, bpb);
  const out = [];
  const add = (expr, form) => out.push({ expr, form, score: expr.length });
  // (a) one s() with a velocity pattern shared by every voice
  const joint = velocityModel(voices.flatMap((v) => v.evs), L, bpb);
  add(`s(${q(voices.map((v) => v.mini).join(', '))})${sl}${velCall(joint)}`, 'drums');
  // (b) voices grouped by their own velocity pattern
  const groups = new Map();
  for (const v of voices) {
    const m = velocityModel(v.evs, L, bpb);
    const k = m === null ? 'null' : String(m);
    if (!groups.has(k)) groups.set(k, { vel: m, minis: [] });
    groups.get(k).minis.push(v.mini);
  }
  if (groups.size > 1) {
    const parts = [...groups.values()].map((g) => `s(${q(g.minis.join(', '))})${velCall(g.vel)}`);
    add(`stack(${parts.join(', ')})${sl}`, 'drums');
  }
  return out.sort((a, b) => a.score - b.score);
}

// ------------------------------------------------------------------------------------ entry point

const cache = new Map();
const CACHE_MAX = 3000;

/**
 * Shortest faithful expression for a part.
 * -> { expr, form, verified, target (quantized notes), velocity }
 */
export function renderPart(notes, L, ctx) {
  const { kind = 'melodic', bpb = 4, key = null, verify = true } = ctx;
  L = Math.max(EPS, L || bpb);
  const groove = ctx.groove || null;
  const clean = quantizePart(notes, L, { groove });
  const ck = `${codeEngineVersion()}|${groove ? `${groove.h}:${groove.d}` : '-'}|${kind}|${bpb}|${L}|${key ? `${key.root}:${key.scale}` : '-'}|${ctx.spellKey || ''}|${verify}|${clean.map((n) => `${n.pitch},${n.start},${n.dur},${n.vel0}`).join(';')}`;
  if (cache.has(ck)) return cache.get(ck);
  const { slow } = barLayout(L, bpb);
  let res;
  if (!clean.length) {
    const fn = kind === 'drums' ? 's' : 'note';
    res = { expr: `${fn}("~")${slowSuffix(slow)}`, form: 'rest', verified: true, target: clean };
  } else {
    let cands;
    let vel = null;
    if (kind === 'drums') cands = drumCandidates(clean, L, ctx);
    else {
      vel = velocityModel(clean.map((n) => ({ t: n.start, vel: n.vel0 })), L, bpb);
      cands = melodicCandidates(clean, L, ctx).map((c) => ({ ...c, expr: c.expr + velCall(vel), score: c.score }));
    }
    const cycles = L / bpb;
    res = null;
    if (verify) {
      for (const c of cands.slice(0, 8)) {
        if (verifyExpr(c.expr, clean, { cycles, bpb, kind })) { res = { expr: c.expr, form: c.form, verified: true }; break; }
      }
    }
    if (!res) {
      // nothing verified (or verification off): the literal writer
      const lit = cands.find((c) => c.form === 'notes' || c.form === 'drums') || cands[0];
      res = { expr: lit.expr, form: lit.form, verified: false };
    }
    res.target = clean;
    res.velocity = vel;
  }
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(ck, res);
  return res;
}

/** Clears the render cache (tests). */
export function clearIdiomCache() { cache.clear(); }
