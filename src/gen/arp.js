// Arpeggiator: chord notes or a whole progression -> Note[].
import { createRng, clamp } from '../core/util.js';
import { makeNote } from './note-util.js';
import { chordPitchClasses } from '../theory/index.js';

export const ARP_MODES = ['up', 'down', 'updown', 'downup', 'random', 'chord', 'converge', 'diverge', 'pinky', 'thumb', 'order'];

/** Expand notes over octaves and order them for a mode. */
export function arpSequence(notes, mode = 'up', octaves = 1, rng = createRng(1)) {
  const base = [...new Set(notes)].sort((a, b) => a - b);
  const pool = [];
  for (let o = 0; o < Math.max(1, octaves); o++) for (const n of base) pool.push(n + 12 * o);
  if (!pool.length) return [];
  switch (mode) {
    case 'down': return pool.slice().reverse();
    case 'updown': return pool.length < 3 ? pool : [...pool, ...pool.slice(1, -1).reverse()];
    case 'downup': {
      const d = pool.slice().reverse();
      return d.length < 3 ? d : [...d, ...d.slice(1, -1).reverse()];
    }
    case 'random': return pool.map(() => rng.pick(pool));
    case 'converge': {
      const out = [];
      let i = 0, j = pool.length - 1;
      while (i <= j) { out.push(pool[i]); if (i !== j) out.push(pool[j]); i++; j--; }
      return out;
    }
    case 'diverge': {
      const conv = arpSequence(notes, 'converge', octaves, rng);
      return conv.reverse();
    }
    case 'pinky': {
      const top = pool[pool.length - 1];
      return pool.slice(0, -1).flatMap((n) => [n, top]);
    }
    case 'thumb': {
      const bottom = pool[0];
      return pool.slice(1).flatMap((n) => [bottom, n]);
    }
    case 'order': return notes.slice();
    case 'chord': return [pool];
    case 'up':
    default: return pool;
  }
}

/** Parse a gate pattern: 'x.xx' / [1,0,1,1] / [0.9, 0, 0.6] -> velocity multipliers (0 = rest). */
function parsePattern(p) {
  if (!p) return null;
  if (Array.isArray(p)) return p.map((v) => (v === true ? 1 : v === false ? 0 : Number(v) || 0));
  return String(p).replace(/\s+/g, '').split('').map((c) => (c === 'X' ? 1 : c === 'x' ? 0.85 : c === 'o' ? 0.6 : c === '-' ? 0.4 : 0));
}

/**
 * arpeggiate(input, opts) -> Note[]
 *  input: MIDI[] (one chord) or progression [{startBeat, durBeats, notes}]
 *  opts: {mode, rate (beats per step, default 0.25), octaves (1), gate (0..1, default 0.8), pattern ('x.xx' | number[]),
 *         length (beats, for a single chord; default 4), start (beat offset), vel (0.75), accent (true), rng, seed, restart (true:
 *         restart sequence on each chord)}
 */
export function arpeggiate(input, opts = {}) {
  const rng = opts.rng || createRng(opts.seed ?? 1);
  const mode = opts.mode || 'up';
  const rate = opts.rate > 0 ? opts.rate : 0.25;
  const octaves = clamp(Math.round(opts.octaves ?? 1), 1, 4);
  const gate = clamp(opts.gate ?? 0.8, 0.05, 1.5);
  const pattern = parsePattern(opts.pattern);
  const baseVel = opts.vel ?? 0.75;
  const accent = opts.accent !== false;
  const isProg = Array.isArray(input) && input.length && typeof input[0] === 'object' && Array.isArray(input[0].notes);
  const segments = isProg
    ? input.map((c) => ({ start: c.startBeat, dur: c.durBeats, notes: c.notes }))
    : [{ start: opts.start ?? 0, dur: opts.length ?? 4, notes: input || [] }];
  const total = isProg ? segments.reduce((m, s) => Math.max(m, s.start + s.dur), 0) : (opts.start ?? 0) + (opts.length ?? 4);
  const out = [];
  let seqPos = 0;
  for (const seg of segments) {
    const seq = arpSequence(seg.notes, mode, octaves, rng);
    if (!seq.length) continue;
    if (opts.restart !== false) seqPos = 0;
    const steps = Math.round(seg.dur / rate);
    for (let k = 0; k < steps; k++) {
      const t = seg.start + k * rate;
      if (t >= total - 1e-6) break;
      const stepIdx = Math.round(t / rate);
      const pv = pattern ? pattern[stepIdx % pattern.length] : 1;
      if (!pv) { continue; }
      const beatPos = t % 1;
      const acc = accent ? (Math.abs(beatPos) < 1e-6 ? 1 : Math.abs(beatPos - 0.5) < 1e-6 ? 0.85 : 0.72) : 0.85;
      const vel = clamp(baseVel * acc * pv * (0.95 + rng() * 0.05) / 0.85, 0.05, 1);
      // a step never rings into the next chord (that would sound the old chord over the new one)
      const segEnd = isProg ? seg.start + seg.dur : total;
      const dur = Math.max(0.03, Math.min(rate * gate, total - t, gate <= 1 ? segEnd - t : Infinity));
      let item;
      if (mode === 'random') item = rng.pick(seq);
      else item = seq[seqPos % seq.length];
      seqPos++;
      const pitches = Array.isArray(item) ? item : [item];
      for (const p of pitches) { const n = makeNote(p, t, dur, vel, total); if (n) out.push(n); }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Arp figures: what a player programs into an arpeggiator — shapes over a chord-tone ladder spanning 2–3 octaves,
// gate patterns with rests, transposed with every chord, varied every 4 / 8 bars (figure, octave, density).
// ---------------------------------------------------------------------------------------------------------------

/** Figures as indices into the chord-tone ladder (0 = root, 1 = 3rd, 2 = 5th, 3 = octave … for a triad). */
export const ARP_FIGURES = {
  '1-5-8-10': [0, 2, 3, 4],
  '1-3-5-8-5-3': [0, 1, 2, 3, 2, 1],
  up2: [0, 1, 2, 3, 4, 5],
  updown2: [0, 1, 2, 3, 4, 5, 4, 3, 2, 1],
  broken: [0, 2, 1, 3, 2, 4, 3, 5],
  pedal: [0, 3, 1, 3, 2, 3, 1, 3],
  trance: [0, 2, 3, 2, 4, 2, 3, 2],
  cascade: [5, 4, 3, 2, 3, 2, 1, 0],
  psy: [0, 0, 3, 0, 0, 4, 0, 2],
  roll: [0, 3, 2, 3, 0, 4, 2, 5],
  spread: [0, 4, 2, 5, 1, 3],
};

/** Figure sets per arp mode of a genre (the genre's `arp.mode`). */
const FIGURE_SETS = {
  up: ['1-5-8-10', 'up2', '1-3-5-8-5-3', 'broken'],
  updown: ['updown2', '1-3-5-8-5-3', 'trance', '1-5-8-10'],
  down: ['cascade', '1-3-5-8-5-3', 'spread'],
  random: ['psy', 'pedal', 'roll', '1-5-8-10'],
  default: ['1-5-8-10', '1-3-5-8-5-3', 'up2', 'pedal'],
};

/** 16-step gate patterns ('x' = play, '.' = rest). */
const GATES = ['xxxxxxxxxxxxxxxx', 'x.xxx.xxx.xxx.xx', 'xx.xxx.xxx.xx.x.', 'x.x.x.xxx.x.x.xx', 'xxx.xx.xxxx.xx.x'];

/** Chord tones (one per pitch class, root first, up to a 7th) stacked from `lo` over `octaves` octaves. */
function chordLadder(c, lo, octaves = 3) {
  const pcs = c.chord ? chordPitchClasses(c.chord.root, c.chord.type).slice(0, 4) : [...new Set(c.notes.map((n) => ((n % 12) + 12) % 12))];
  const root = c.chord ? c.chord.root : pcs[0];
  const base = lo + ((((root - lo) % 12) + 12) % 12);
  const rel = [...new Set(pcs.map((p) => ((p - root) % 12 + 12) % 12))].sort((a, b) => a - b);
  const out = [];
  for (let o = 0; o < octaves; o++) for (const r of rel) out.push(base + r + 12 * o);
  return out;
}

/**
 * arpFigures(progression, {mode, figures, rate=0.25, bpb=4, length, lo=60, hi=96, gate=0.6, vel=0.7, rng, energy})
 *  -> Note[] — chord tones only, never ringing into the next chord. Every 4-bar block may change octave or gate
 *  (density); every 8 bars the figure changes.
 */
export function arpFigures(progression, opts = {}) {
  const rng = opts.rng || createRng(opts.seed ?? 1);
  if (!progression?.length) return [];
  const rate = opts.rate > 0 ? opts.rate : 0.25;
  const bpb = opts.beatsPerBar || opts.bpb || 4;
  const length = opts.length ?? progression.reduce((m, c) => Math.max(m, c.startBeat + c.durBeats), 0);
  const lo = opts.lo ?? 60;
  const hi = opts.hi ?? 96;
  const gateLen = opts.gate ?? 0.6;
  const baseVel = opts.vel ?? 0.7;
  const names = (opts.figures || FIGURE_SETS[opts.mode] || FIGURE_SETS.default).filter((n) => ARP_FIGURES[n]);
  const order = names.slice();
  for (let i = order.length - 1; i > 0; i--) { const j = rng.int(0, i); [order[i], order[j]] = [order[j], order[i]]; }
  const gates = rate >= 0.5 ? ['xxxxxxxxxxxxxxxx'] : GATES;
  const g0 = rng.int(0, Math.min(2, gates.length - 1));
  const blockBars = 4;
  const nBlocks = Math.ceil(length / (bpb * blockBars));
  // per block: figure (changes every 8 bars), octave lift (one block in four), gate (density changes on odd blocks)
  const blocks = [];
  for (let b = 0; b < nBlocks; b++) {
    blocks.push({
      fig: ARP_FIGURES[order[Math.floor(b / 2) % order.length]],
      oct: b % 4 === 3 || (b % 2 === 1 && rng.chance(0.35)) ? 12 : 0,
      gate: gates[(g0 + (b % 2 ? 1 + (b >> 2) : 0)) % gates.length],
    });
  }
  const chordAt = (t) => progression.find((c) => t >= c.startBeat - 1e-6 && t < c.startBeat + c.durBeats - 1e-6) || progression[progression.length - 1];
  const out = [];
  let cur = null;
  let pos = 0;
  let ladder = [];
  let ladderLo = null;
  const steps = Math.round(length / rate);
  for (let k = 0; k < steps; k++) {
    const t = k * rate;
    if (t >= length - 1e-6) break;
    const c = chordAt(t);
    const blk = blocks[Math.min(blocks.length - 1, Math.floor(t / (bpb * blockBars)))];
    // restart the figure on each chord and each bar (so it locks to the groove)
    if (c !== cur || Math.abs(t % bpb) < 1e-6) {
      if (c !== cur || ladderLo !== lo + blk.oct) { ladderLo = lo + blk.oct; ladder = chordLadder(c, ladderLo); }
      cur = c;
      pos = 0;
    }
    const stepInBar = Math.round((t % bpb) / rate);
    const g = blk.gate[Math.round(stepInBar * (0.25 / rate)) % blk.gate.length];
    // rests don't advance the figure: the whole shape plays, syncopated by the gate
    if (g !== 'x') continue;
    const idx = blk.fig[pos % blk.fig.length];
    pos++;
    let p = ladder[Math.min(idx, ladder.length - 1)];
    while (p > hi) p -= 12;
    const end = c.startBeat + c.durBeats;
    const dur = Math.max(0.03, Math.min(rate * gateLen, end - t, length - t));
    const beatPos = t % 1;
    const acc = Math.abs(beatPos) < 1e-6 ? 1 : Math.abs(beatPos - 0.5) < 1e-6 ? 0.85 : 0.72;
    const n = makeNote(p, t, dur, clamp(baseVel * acc * (0.95 + rng() * 0.05) / 0.85, 0.05, 1), length);
    if (n) out.push(n);
  }
  return out;
}
