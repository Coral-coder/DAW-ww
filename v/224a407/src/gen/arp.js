// Arpeggiator: chord notes or a whole progression -> Note[].
import { createRng, clamp } from '../core/util.js';
import { makeNote } from './note-util.js';

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
