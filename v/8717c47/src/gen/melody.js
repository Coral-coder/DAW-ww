// Melody + counter-melody generator: chord tones on strong beats, stepwise passing/neighbour tones,
// motif repetition with variation (call & response) and phrase endings that resolve.
import { createRng, clamp } from '../core/util.js';
import { mod12, scaleNotesInRange, chordPitchClasses } from '../theory/index.js';
import { getGenre } from './genres.js';
import { resolveKey } from './harmony.js';
import { makeNote } from './note-util.js';
import { fitNotesToHarmony } from './fit.js';

export const MELODY_STYLES = {
  lead: { name: 'Lead', grid: 0.25, notesPerBar: [4, 8], legato: 0.85, leap: 0.25, syncopation: 0.3, range: [62, 84] },
  hook: { name: 'Hook', grid: 0.25, notesPerBar: [3, 7], legato: 0.75, leap: 0.2, syncopation: 0.6, range: [62, 81] },
  vocal: { name: 'Vocal-like', grid: 0.5, notesPerBar: [3, 6], legato: 0.95, leap: 0.12, syncopation: 0.35, range: [60, 79], pickup: true },
  riff: { name: 'Riff', grid: 0.25, notesPerBar: [5, 10], legato: 0.6, leap: 0.3, syncopation: 0.45, range: [55, 76], repeatAll: true },
  sparse: { name: 'Sparse', grid: 0.5, notesPerBar: [1, 3], legato: 1, leap: 0.3, syncopation: 0.25, range: [64, 84] },
  ambient: { name: 'Ambient', grid: 1, notesPerBar: [0.5, 1.5], legato: 1.6, leap: 0.4, syncopation: 0, range: [64, 88] },
};

/** Build a one-bar rhythm motif: [{t, d}] */
function makeRhythm(style, density, bpb, rng) {
  const st = MELODY_STYLES[style];
  const [minN, maxN] = st.notesPerBar;
  let n = Math.round(minN + (maxN - minN) * density + (rng() - 0.5));
  if (style === 'ambient') n = rng.chance(0.4 + density * 0.5) ? 1 : 0;
  n = Math.max(style === 'ambient' ? 0 : 1, n);
  const slots = [];
  for (let t = 0; t < bpb - 1e-6; t += st.grid) slots.push(Math.round(t * 1000) / 1000);
  const weight = (t) => {
    if (t === 0) return style === 'vocal' ? 1.2 : 3; // vocal phrases often start after the downbeat
    if (t % 1 === 0) return 2;
    if (t % 0.5 === 0) return 1 + st.syncopation * 1.5;
    return 0.4 + st.syncopation;
  };
  const chosen = new Set();
  if (style !== 'vocal' || rng.chance(0.5)) chosen.add(0);
  let guard = 0;
  while (chosen.size < Math.min(n, slots.length) && guard++ < 200) {
    chosen.add(rng.weighted(slots, slots.map(weight)));
  }
  const ts = [...chosen].sort((a, b) => a - b);
  return ts.map((t, i) => {
    const next = i + 1 < ts.length ? ts[i + 1] : bpb;
    const gap = next - t;
    const d = style === 'ambient' ? bpb * (1 + rng()) : Math.max(0.12, Math.min(gap * st.legato, gap > 1 ? gap * 0.9 : gap * st.legato));
    return { t, d };
  });
}

function nearest(cands, target) {
  let best = cands[0];
  for (const c of cands) if (Math.abs(c - target) < Math.abs(best - target)) best = c;
  return best;
}

/**
 * generateMelody({progression, key, scale, genre, style='lead', bars, density=0.6, range, rng, seed,
 *   beatsPerBar=4, phraseBars=4, length}) -> Note[]
 */
export function generateMelody(opts = {}) {
  const rng = opts.rng || createRng(opts.seed ?? 1);
  const genre = getGenre(opts.genre);
  const style = MELODY_STYLES[opts.style] ? opts.style : MELODY_STYLES[genre?.melodyStyle] ? genre.melodyStyle : 'lead';
  const st = MELODY_STYLES[style];
  const { root, scale } = resolveKey(opts);
  const bpb = opts.beatsPerBar || 4;
  const progression = opts.progression || [];
  const progLen = progression.reduce((m, c) => Math.max(m, c.startBeat + c.durBeats), 0);
  const length = opts.length ?? (opts.bars ? opts.bars * bpb : progLen || 4 * bpb);
  const bars = Math.ceil(length / bpb);
  const density = clamp(opts.density ?? 0.6, 0, 1);
  const [lo, hi] = opts.range || st.range;
  const phraseBars = opts.phraseBars || 4;
  const pool = scaleNotesInRange(root, scale, lo, hi);
  if (!pool.length) return [];
  const chordAt = (t) => {
    if (!progression.length) return null;
    const tt = progLen ? t % progLen : t;
    return progression.find((c) => tt >= c.startBeat - 1e-6 && tt < c.startBeat + c.durBeats - 1e-6) || progression[progression.length - 1];
  };
  const chordTonesAt = (t) => {
    const c = chordAt(t);
    const pcs = c ? chordPitchClasses(c.chord.root, c.chord.type) : [root, mod12(root + 4), mod12(root + 7)];
    const tones = [];
    for (let m = lo; m <= hi; m++) if (pcs.includes(mod12(m))) tones.push(m);
    return tones.length ? tones : pool;
  };
  const idxOf = (p) => {
    let best = 0;
    for (let i = 0; i < pool.length; i++) if (Math.abs(pool[i] - p) < Math.abs(pool[best] - p)) best = i;
    return best;
  };

  const out = [];
  let prev = nearest(chordTonesAt(0), (lo + hi) / 2);
  let dir = rng.chance(0.5) ? 1 : -1;
  let repeatCount = 0;

  const pickPitch = (t, strong) => {
    let p;
    if (strong) {
      const tones = chordTonesAt(t).filter((x) => Math.abs(x - prev) <= 7);
      const cands = tones.length ? tones : chordTonesAt(t);
      // prefer motion in the current direction, small intervals
      const scored = cands.map((c) => {
        const d = c - prev;
        let s = Math.abs(d);
        if (d !== 0 && Math.sign(d) !== dir) s += 2;
        if (d === 0) s += repeatCount >= 1 ? 6 : 1.5;
        return { c, s: s + rng() * 2.5 };
      }).sort((a, b) => a.s - b.s);
      p = scored[0].c;
    } else {
      let i = idxOf(prev);
      const leap = rng.chance(st.leap * (0.6 + density * 0.4));
      const step = leap ? rng.int(2, 4) : rng.chance(0.75) ? 1 : 2;
      i += step * dir;
      if (rng.chance(0.15)) i = idxOf(prev) - dir; // neighbour tone
      i = clamp(i, 0, pool.length - 1);
      p = pool[i];
    }
    // contour management: turn around at range edges / after leaps (gap fill)
    if (p >= hi - 2) dir = -1;
    else if (p <= lo + 2) dir = 1;
    else if (Math.abs(p - prev) > 4) dir = -Math.sign(p - prev) || dir;
    else if (rng.chance(0.2)) dir = -dir;
    repeatCount = p === prev ? repeatCount + 1 : 0;
    prev = p;
    return p;
  };

  for (let phraseStart = 0; phraseStart < bars; phraseStart += phraseBars) {
    const rhythmA = makeRhythm(style, density, bpb, rng);
    const rhythmB = rng.chance(0.5) ? makeRhythm(style, density, bpb, rng) : rhythmA;
    let motif = null; // scale-index steps of the A bar
    for (let k = 0; k < phraseBars && phraseStart + k < bars; k++) {
      const bar = phraseStart + k;
      const isLastBar = k === phraseBars - 1 || bar === bars - 1;
      let rhythm = k === 2 ? rhythmB : rhythmA;
      if (st.repeatAll) rhythm = rhythmA;
      if (style === 'vocal' && k % 2 === 1) {
        // breathe: the response bar ends early
        rhythm = rhythm.filter((h) => h.t < bpb - 1);
      }
      if (isLastBar && style !== 'riff') {
        // cadence: fewer notes, end on a long stable tone
        const keep = rhythm.filter((h) => h.t < bpb / 2 + 1e-6);
        rhythm = keep.length ? keep : [{ t: 0, d: bpb }];
      }
      const base = bar * bpb;
      const pitches = [];
      const useMotif = motif && (k === 1 || k === 3 || st.repeatAll) && rhythm === rhythmA;
      if (useMotif) {
        // call & response: repeat the motif's contour, sequenced to fit the current chord
        const tones = chordTonesAt(base);
        const startP = st.repeatAll && rng.chance(0.7) ? pool[motif.start] : nearest(tones, pool[motif.start] + (rng.chance(0.5) ? 0 : (rng.chance(0.5) ? 2 : -2)));
        let idx = idxOf(startP);
        motif.steps.forEach((s, j) => {
          idx = clamp(idx + s, 0, pool.length - 1);
          let p = pool[idx];
          const h = rhythm[j];
          if (!h) return;
          const strong = h.t % 1 === 0;
          if (strong && !chordTonesAt(base + h.t).includes(p)) p = nearest(chordTonesAt(base + h.t), p);
          pitches.push(p);
        });
        // variation on the tail
        if (pitches.length > 2 && rng.chance(0.45)) {
          prev = pitches[pitches.length - 2];
          pitches[pitches.length - 1] = pickPitch(base + rhythm[pitches.length - 1].t, false);
        }
        prev = pitches[pitches.length - 1] ?? prev;
        while (pitches.length < rhythm.length) pitches.push(pickPitch(base + rhythm[pitches.length].t, rhythm[pitches.length].t % 1 === 0));
      } else {
        for (const h of rhythm) pitches.push(pickPitch(base + h.t, h.t % 1 === 0 || h === rhythm[0]));
        if (k === 0 && pitches.length) {
          const idxs = pitches.map(idxOf);
          motif = { start: idxs[0], steps: idxs.map((v, j) => (j === 0 ? 0 : v - idxs[j - 1])) };
        }
      }
      if (isLastBar && style !== 'riff' && pitches.length) {
        // resolve: final note on tonic (or chord root/3rd) nearest to the previous pitch
        const lastT = base + rhythm[rhythm.length - 1].t;
        const tones = chordTonesAt(lastT);
        const tonics = tones.filter((x) => mod12(x) === mod12(root));
        const target = tonics.length && rng.chance(0.65) ? nearest(tonics, prev) : nearest(tones, prev);
        pitches[pitches.length - 1] = target;
        prev = target;
      }
      rhythm.forEach((h, j) => {
        const t = base + h.t;
        if (t >= length - 1e-6 || pitches[j] == null) return;
        let d = h.d;
        // "avoid notes": a sustained non-chord tone a half step above a chord tone clashes — resolve it
        const tones = chordTonesAt(t);
        if (d >= 0.5 && !tones.includes(pitches[j]) && tones.some((x) => mod12(pitches[j] - x) === 1)) pitches[j] = nearest(tones, pitches[j]);
        if (isLastBar && j === rhythm.length - 1 && style !== 'riff') d = Math.max(d, bpb - h.t - 0.1);
        d = Math.min(d, length - t);
        const vel = (h.t === 0 ? 0.9 : h.t % 1 === 0 ? 0.82 : 0.7) * (0.93 + rng() * 0.07);
        const note = makeNote(pitches[j], t, Math.max(0.08, d), vel, length);
        if (note) out.push(note);
      });
    }
  }
  // judge every note against the chord it sounds over (chord-scale), not just the project scale
  fitNotesToHarmony(out, progression, { key: { root, scale }, blues: genre?.id === 'blues' || /blues/.test(scale), range: [lo, hi] });
  return out.sort((a, b) => a.start - b.start);
}

/**
 * generateCounterMelody({melody, progression, key, scale, range=[52,72], density=0.5, rng, seed, length})
 * Fills gaps/long notes of the melody with chord tones below it, preferring contrary motion and 3rds/6ths.
 */
export function generateCounterMelody(opts = {}) {
  const rng = opts.rng || createRng(opts.seed ?? 2);
  const melody = (opts.melody || []).slice().sort((a, b) => a.start - b.start);
  const progression = opts.progression || [];
  const { root, scale } = resolveKey(opts);
  const length = opts.length ?? Math.max(
    progression.reduce((m, c) => Math.max(m, c.startBeat + c.durBeats), 0),
    melody.reduce((m, n) => Math.max(m, n.start + n.dur), 0),
  );
  const [lo, hi] = opts.range || [52, 72];
  const density = clamp(opts.density ?? 0.5, 0, 1);
  const pool = scaleNotesInRange(root, scale, lo, hi);
  const chordAt = (t) => progression.find((c) => t >= c.startBeat - 1e-6 && t < c.startBeat + c.durBeats - 1e-6) || progression[progression.length - 1];
  const sounding = (t) => melody.filter((n) => n.start <= t + 1e-6 && n.start + n.dur > t + 1e-6).pop();
  const onsetsIn = (a, b) => melody.filter((n) => n.start >= a - 1e-6 && n.start < b - 1e-6);
  const out = [];
  let prev = null;
  let prevMel = null;
  let prevInterval = null;
  const slot = density > 0.6 ? 0.5 : 1;
  for (let t = 0; t < length - 1e-6; t += slot) {
    const busy = onsetsIn(t, t + slot).length;
    const mel = sounding(t);
    // play where the melody rests or sustains; skip when the melody is busy
    if (busy > 1) continue;
    if (busy === 1 && !(mel && mel.dur >= 1) && rng() > density * 0.5) continue;
    if (!mel && rng() > 0.4 + density * 0.6) continue;
    const c = chordAt(t);
    const pcs = c ? chordPitchClasses(c.chord.root, c.chord.type) : [root, mod12(root + 4), mod12(root + 7)];
    let cands = pool.filter((p) => pcs.includes(mod12(p)));
    if (!cands.length) cands = pool;
    if (mel) {
      // below the melody, prefer imperfect consonances (3rds / 6ths)
      const below = cands.filter((p) => p < mel.pitch && [3, 4, 8, 9].includes((mel.pitch - p) % 12));
      if (below.length) cands = below;
      else cands = cands.filter((p) => p < mel.pitch - 2).length ? cands.filter((p) => p < mel.pitch - 2) : cands;
    }
    const melDir = mel && prevMel ? Math.sign(mel.pitch - prevMel) : 0;
    const scored = cands.map((p) => {
      let s = prev == null ? Math.abs(p - (lo + hi) / 2) * 0.5 : Math.abs(p - prev);
      if (prev != null && melDir && Math.sign(p - prev) === melDir) s += 3; // contrary motion
      if (mel && prevInterval != null) {
        const iv = (mel.pitch - p) % 12;
        if ((iv === 0 || iv === 7) && iv === prevInterval) s += 8; // no parallel 5ths/8ves
      }
      return { p, s: s + rng() * 1.5 };
    }).sort((a, b) => a.s - b.s);
    const p = scored[0].p;
    const dur = Math.min(slot * (mel && mel.dur >= 1 ? 1 : 0.9), length - t);
    const note = makeNote(p, t, dur, 0.55 + rng() * 0.15, length);
    if (note) out.push(note);
    prev = p;
    prevMel = mel ? mel.pitch : prevMel;
    prevInterval = mel ? (mel.pitch - p) % 12 : null;
  }
  fitNotesToHarmony(out, progression, { key: { root, scale }, range: [lo, hi] });
  return out;
}

// ---------------------------------------------------------------------------
// Songwriting: motif-based melodies (used by generateSong)
// ---------------------------------------------------------------------------

/**
 * A motif "idea": a 1-bar rhythm (always leaving breathing room at the end of the bar) and a scale-step contour.
 * makeMotif({hook, density, bpb, rng, grid}) -> {rhythm:[{t,d}], steps:[int], hook}
 *  hook: chorus / drop hook — fewer, longer notes, a syncopated push and more repetition.
 */
export function makeMotif(opts = {}) {
  const rng = opts.rng || createRng(1);
  const bpb = opts.bpb || 4;
  const hook = !!opts.hook;
  const density = clamp(opts.density ?? 0.6, 0, 1);
  const grid = opts.grid || (density > 0.75 && !hook ? 0.25 : 0.5);
  const usable = bpb - (hook ? 1 : 1.5); // rest at the end of the bar: a human melody breathes
  const slots = [];
  for (let t = 0; t <= usable + 1e-6; t += grid) slots.push(Math.round(t * 1000) / 1000);
  let n = hook ? rng.int(3, 4) : Math.round(3 + density * 3 + (rng() - 0.5) * 1.5);
  n = clamp(n, 2, slots.length);
  const weight = (t) => (t === 0 ? (hook ? 1.5 : 2) : t % 1 === 0 ? 1.6 : t % 0.5 === 0 ? (hook ? 1.6 : 1.1) : 0.6);
  const chosen = new Set([hook && rng.chance(0.35) ? 0.5 : 0]);
  let guard = 0;
  while (chosen.size < n && guard++ < 100) chosen.add(rng.weighted(slots, slots.map(weight)));
  const ts = [...chosen].sort((a, b) => a - b);
  const rhythm = ts.map((t, i) => {
    const next = i + 1 < ts.length ? ts[i + 1] : Math.min(bpb, t + (hook ? 2 : 1.25));
    const gap = next - t;
    return { t, d: Math.max(0.2, i + 1 < ts.length ? gap * (hook ? 0.95 : 0.85) : gap * 0.9) };
  });
  // contour: mostly steps, an occasional leap that is recovered by step in the other direction
  const steps = [0];
  let dir = rng.chance(0.55) ? 1 : -1;
  for (let i = 1; i < rhythm.length; i++) {
    const prev = steps[i - 1] - (steps[i - 2] ?? steps[i - 1]);
    let s;
    if (Math.abs(prev) >= 3) s = -Math.sign(prev); // gap fill
    else if (rng.chance(hook ? 0.18 : 0.22)) s = dir * rng.int(2, 4);
    else if (hook && rng.chance(0.3)) s = 0; // repeated notes make hooks
    else s = dir * (rng.chance(0.7) ? 1 : 2);
    if (rng.chance(0.25)) dir = -dir;
    steps.push(steps[i - 1] + s);
  }
  return { rhythm, steps, hook, bpb };
}

/** Variation operators on a motif (pure; return a new motif). */
export function varyMotif(m, kind, rng = createRng(1)) {
  const bpb = m.bpb || 4;
  const r = m.rhythm.map((h) => ({ ...h }));
  const s = m.steps.slice();
  switch (kind) {
    case 'displace': { // rhythmic displacement by an 8th
      const out = r.map((h) => ({ t: h.t + 0.5, d: h.d })).filter((h) => h.t < bpb - 0.75);
      return { ...m, rhythm: out.length ? out : r, steps: s.slice(0, out.length || r.length) };
    }
    case 'tail': { // new ending: invert the last interval
      if (s.length > 2) s[s.length - 1] = s[s.length - 2] - (s[s.length - 1] - s[s.length - 2]) + (rng.chance(0.5) ? 1 : -1);
      return { ...m, rhythm: r, steps: s };
    }
    case 'fragment': { // first half twice
      const half = Math.max(1, Math.ceil(r.length / 2));
      const span = r[half - 1].t + r[half - 1].d;
      const off = Math.max(1, Math.ceil(span * 2) / 2);
      const rr = [...r.slice(0, half), ...r.slice(0, half).map((h) => ({ t: h.t + off, d: h.d }))].filter((h) => h.t < bpb - 0.5);
      const ss = [...s.slice(0, half), ...s.slice(0, half).map((x) => x + (rng.chance(0.5) ? 1 : -1))].slice(0, rr.length);
      return { ...m, rhythm: rr, steps: ss };
    }
    case 'augment': { // breakdown: fewer, longer notes
      const keep = r.filter((_, i) => i % 2 === 0);
      const rr = keep.map((h, i) => ({ t: h.t, d: Math.max(h.d, (keep[i + 1]?.t ?? bpb) - h.t - 0.25) }));
      return { ...m, rhythm: rr, steps: s.filter((_, i) => i % 2 === 0) };
    }
    case 'ornament': { // a 16th-note neighbour before the last note
      if (r.length < 2) return m;
      const last = r[r.length - 1];
      if (last.t < 0.5 || r.some((h) => Math.abs(h.t - (last.t - 0.25)) < 1e-6)) return m;
      const rr = [...r.slice(0, -1), { t: last.t - 0.25, d: 0.22 }, last];
      const ss = [...s.slice(0, -1), s[s.length - 1] + 1, s[s.length - 1]];
      return { ...m, rhythm: rr, steps: ss };
    }
    default: return m;
  }
}

/** Bar plans for an 8-bar period (antecedent = question, consequent = answer). */
const PLANS = {
  verse: ['M', 'S', 'V', 'Q', 'M', 'S', 'V2', 'A'],
  hook: ['M', 'M', 'S', 'Q', 'M', 'M', 'V', 'A'],
  short: ['M', 'S', 'V', 'A'],
  sparse: ['M', 'R', 'S', 'Q', 'M', 'R', 'V', 'A'],
};

/**
 * writeMelody({progression, key, scale, motif, plan ('verse'|'hook'|'sparse'), range:[lo,hi], center, length, bpb, rng,
 *   variation (0..1: how much the second period differs), resolveEnd (true)}) -> Note[]
 * A period: motif (M) -> sequence fitted to the next chord (S) -> variation (V) -> question / answer cadence (Q / A);
 * R = rest bar. Strong-beat long notes land on chord tones; the answer resolves to the tonic.
 */
export function writeMelody(opts = {}) {
  const rng = opts.rng || createRng(1);
  const { root, scale } = resolveKey(opts);
  const bpb = opts.bpb || opts.beatsPerBar || 4;
  const progression = opts.progression || [];
  const progLen = progression.reduce((m, c) => Math.max(m, c.startBeat + c.durBeats), 0);
  const length = opts.length ?? (progLen || 8 * bpb);
  const [lo, hi] = opts.range || [64, 86];
  const center = opts.center ?? Math.round((lo + hi) / 2);
  const pool = scaleNotesInRange(root, scale, lo, hi);
  if (!pool.length || !progression.length) return [];
  const motif = opts.motif || makeMotif({ rng, bpb });
  const bars = Math.ceil(length / bpb);
  const plan = PLANS[opts.plan] || PLANS.verse;
  const period = bars >= 8 ? plan : plan.length === 4 ? plan : PLANS.short;
  const chordAt = (t) => {
    const tt = progLen ? ((t % progLen) + progLen) % progLen : t;
    return progression.find((c) => tt >= c.startBeat - 1e-6 && tt < c.startBeat + c.durBeats - 1e-6) || progression[progression.length - 1];
  };
  const tonesAt = (t) => {
    const c = chordAt(t);
    const pcs = chordPitchClasses(c.chord.root, c.chord.type);
    const out = [];
    for (let m = lo; m <= hi; m++) if (pcs.includes(mod12(m))) out.push(m);
    return out.length ? out : pool;
  };
  const idxOf = (p) => { let b = 0; for (let i = 0; i < pool.length; i++) if (Math.abs(pool[i] - p) < Math.abs(pool[b] - p)) b = i; return b; };
  const out = [];
  let prevEnd = center;
  const tonic = mod12(root);
  const varKinds = ['displace', 'tail', 'fragment', 'ornament'];
  const v1 = rng.pick(varKinds);
  const v2 = rng.pick(varKinds.filter((k) => k !== v1));

  const emit = (m, base, anchor) => {
    let idx = idxOf(anchor);
    const ps = [];
    m.rhythm.forEach((h, i) => {
      const step = (m.steps[i] ?? 0) - (m.steps[i - 1] ?? 0);
      idx = i === 0 ? idx : idx + step;
      if (idx < 0 || idx >= pool.length) idx = clamp(idx - 2 * step, 0, pool.length - 1); // bounce off the range edge
      let p = pool[idx];
      const t = base + h.t;
      if (h.t % 1 === 0 && h.d >= 0.45) { p = nearest(tonesAt(t), p); idx = idxOf(p); }
      ps.push(p);
      if (t < length - 1e-6) {
        const n = makeNote(p, t, Math.min(h.d, length - t), (h.t === 0 ? 0.86 : h.t % 1 === 0 ? 0.8 : 0.72) * (0.94 + rng() * 0.08), length);
        if (n) out.push(n);
      }
    });
    if (ps.length) prevEnd = ps[ps.length - 1];
    return ps;
  };
  let lastAnchorIdx = null;
  for (let bar = 0; bar < bars; bar++) {
    const slot = period[bar % period.length];
    const base = bar * bpb;
    const secondHalf = Math.floor(bar / period.length) % 2 === 1;
    // anchor: the chord tone nearest the register centre (sequence = same shape re-anchored on each chord)
    const tones = tonesAt(base + 0.01);
    let target = slot === 'M' ? center + (secondHalf && opts.variation > 0.5 ? 2 : 0) : (prevEnd + center) / 2;
    if (slot === 'S' && lastAnchorIdx != null) target = pool[clamp(lastAnchorIdx + (rng.chance(0.5) ? 1 : 2), 0, pool.length - 1)];
    const anchor = nearest(tones, target);
    if (slot === 'R') continue;
    if (slot === 'Q' || slot === 'A') {
      // cadence: 1–2 notes, then a held tone (question: 3rd/5th/2nd degree - open; answer: the tonic when it fits)
      const final = slot === 'A' && bar === bars - 1 || (slot === 'A' && (opts.resolveEnd ?? true));
      const lead = motif.rhythm.length > 2 && rng.chance(0.6);
      let t0 = 0;
      if (lead) {
        const p0 = pool[clamp(idxOf(prevEnd) + (rng.chance(0.5) ? 1 : -1), 0, pool.length - 1)];
        const n0 = makeNote(p0, base, 0.45, 0.74, length);
        if (n0) out.push(n0);
        t0 = 0.5;
      }
      const at = base + t0 + 0.01;
      const ts = tonesAt(at);
      let cands = ts;
      if (slot === 'A' && final) {
        const tonics = ts.filter((p) => mod12(p) === tonic);
        if (tonics.length) cands = tonics;
      } else {
        const c = chordAt(at);
        const open = ts.filter((p) => mod12(p) !== tonic && mod12(p) !== mod12(c.chord.root));
        if (open.length) cands = open;
      }
      const p = nearest(cands, prevEnd);
      const c = chordAt(at);
      const chordEnd = Math.floor(at / (progLen || Infinity)) * progLen + c.startBeat + c.durBeats;
      const d = Math.min(bpb - t0 - 0.5, Math.max(1, chordEnd - (base + t0) - 0.05));
      const n = makeNote(p, base + t0, d, slot === 'A' ? 0.8 : 0.76, length);
      if (n) out.push(n);
      prevEnd = p;
      continue;
    }
    let m = motif;
    if (slot === 'V') m = varyMotif(motif, secondHalf ? v2 : v1, rng);
    if (slot === 'V2') m = varyMotif(motif, v2, rng);
    if (secondHalf && slot === 'M' && opts.variation > 0.7) m = varyMotif(motif, 'ornament', rng);
    emit(m, base, anchor);
    lastAnchorIdx = idxOf(anchor);
  }
  fitNotesToHarmony(out, progression, { key: { root, scale }, blues: /blues/.test(scale) || opts.blues, range: [lo, hi] });
  // no overlaps inside the line (mono leads glide otherwise)
  out.sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < out.length; i++) {
    const maxD = out[i + 1].start - out[i].start - 0.02;
    if (out[i].dur > maxD) out[i].dur = Math.max(0.05, Math.round(maxD * 10000) / 10000);
  }
  return out;
}
