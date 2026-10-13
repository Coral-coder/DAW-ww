// Chord progression generation + rhythmic rendering of progressions into notes.
import { createRng, clamp } from '../core/util.js';
import {
  romanToChord, getProgression, findProgressions, suggestNextChords, isMinorScale,
  chordPitchClasses, chordName, resolveScaleId, mod12, parseKey, scalePitchClasses, SCALES,
  chordVoicingPcs, voiceChord, keyPitchClasses, voicingProblem,
} from '../theory/index.js';
import { getGenre } from './genres.js';
import { makeNote } from './note-util.js';

/** Resolve {key, scale} options: key may be a pitch class, {root, scale} or a note name. */
export function resolveKey(opts = {}) {
  let root = 0;
  let scale = opts.scale;
  const k = opts.key;
  if (typeof k === 'number') root = mod12(k);
  else if (typeof opts.root === 'number') root = mod12(opts.root);
  else if (k && typeof k === 'object') { root = mod12(k.root ?? 0); scale = scale || k.scale; }
  else if (typeof k === 'string') { const pk = parseKey(k); if (pk) { root = pk.root; scale = scale || (/^\s*[A-Ga-g][#b]?\s*$/.test(k) ? undefined : pk.scale); } }
  const g = getGenre(opts.genre);
  if (!scale) scale = g?.scales?.[0] || 'minor';
  return { root, scale: resolveScaleId(scale) };
}

function progressionFitsScale(p, scale) {
  if (!p) return false;
  if (p.mode === 'any') return true;
  if (p.mode === scale) return romansFitScale(p.romans, scale) || (scale !== 'major' && scale !== 'minor');
  const family = isMinorScale(scale) ? p.mode !== 'major' && p.mode !== 'lydian' : p.mode === 'major' || p.mode === 'lydian';
  if (!family) return false;
  return romansFitScale(p.romans, scale);
}

/**
 * Plain (accidental-free, non-secondary) romans are read on the scale's own degrees, so a progression written
 * for another mode can produce chromatic garbage (e.g. 'IVmaj7' in Lydian -> #IVmaj7). For heptatonic scales,
 * require the triad of every plain roman to be diatonic; explicit borrowings (bVII, V/V) are intentional.
 */
function isDiatonicTriad(chord, root, scale) {
  if (!chord) return false;
  const set = new Set(scalePitchClasses(root, scale));
  return chordPitchClasses(chord.root, chord.type).slice(0, 3).every((pc) => set.has(pc));
}

function romansFitScale(romans, scale) {
  if ((SCALES[scale]?.intervals?.length || 0) !== 7) return true; // pentatonic/blues: idiomatic non-diatonic chords
  const set = new Set(scalePitchClasses(0, scale));
  return romans.every((r) => {
    if (/^[b#♭♯]|\//.test(r)) return true;
    const c = romanToChord(r, 0, scale);
    if (!c) return true;
    const triad = chordPitchClasses(c.root, c.type).slice(0, 3);
    return triad.every((pc) => set.has(pc));
  });
}

/** Pick one of the genre's signature progressions that fits the scale (major vs minor). -> progression | null */
export function pickGenreProgression({ genre, scale = 'minor', rng = createRng(1) } = {}) {
  const g = getGenre(genre);
  let pool = (g?.progressions || []).map((p) => getProgression(p)).filter((p) => progressionFitsScale(p, scale));
  if (!pool.length) pool = findProgressions({ genre: g?.id, mode: isMinorScale(scale) ? 'minor' : 'major' }).filter((p) => progressionFitsScale(p, scale));
  return pool.length ? rng.pick(pool) : null;
}

/** Length of a progression in bars (sum of chord durations). */
export function progressionBars(p) {
  if (!p) return 0;
  return p.romans.reduce((s, _, i) => s + (p.durs?.[i] ?? 1), 0);
}

/** Chord pitch classes trimmed to `max` voices: omit the 5th first, then a clashing 11th, then 13th / 9th. */
export function voicingPitchClasses(chord, max = 5, opts = {}) {
  return chordVoicingPcs(chord, max, opts);
}

/** Chord styles that are short, punchy hits: thinner voicings (max 4 notes) keep them tight. */
export const STAB_STYLES = new Set(['stabs', 'house', 'offbeat', 'skank', 'pulse8', 'trance-gate', 'future', 'power', 'bossa', 'montuno']);

const EXT_RE = /(7|9|11|13|6|sus|add|5|ø|°|\+|maj)/;

/**
 * Re-colour a plain triad for a genre's harmonic flavour (only when the roman had no explicit extension).
 * flavor: 'neo-soul' | 'gospel' | 'house' | 'comp' | 'bossa' | 'future' | 'power' | 'lofi' | other (unchanged)
 * Extensions are taken from the key (opts.key = {root, scale}) so they never contradict it or the chord quality:
 * a 7th is added only in the form the key provides (maj7 vs b7), a 9th only when the natural 9 is diatonic
 * (no m9 on iii in major — that would be a b9-against-the-key F#), minor chords never get a major 3rd, and
 * dominants get natural 9/13 only (alterations stay explicit in the roman numeral).
 */
export function colorChord(chord, flavor, rng = createRng(1), opts = {}) {
  if (!chord || !flavor) return chord;
  const explicit = EXT_RE.test(String(chord.roman || '').replace(/^[b#]*[ivIV]+/, ''));
  let type = chord.type;
  const keyPcs = opts.key ? keyPitchClasses(opts.key.root, opts.key.scale) : null;
  const r = chord.root;
  const inKey = (i) => !keyPcs || keyPcs.includes(mod12(r + i));
  const isDom = chord.type === 'maj' && (chord.function === 'dominant' || (keyPcs && inKey(10) && !inKey(11)));
  const rich = ['neo-soul', 'gospel', 'lofi', 'comp', 'bossa'].includes(flavor);
  const seventhish = ['house', 'stabs-7', 'future'].includes(flavor);
  if (flavor === 'power') type = '5';
  else if (!explicit && (rich || seventhish)) {
    if (type === 'maj') {
      if (isDom) {
        const nine = rich && inKey(2) && (!keyPcs || !inKey(1));
        type = nine ? (inKey(9) && rng.chance(0.5) ? '13' : '9') : '7';
      } else if (inKey(11)) type = rich && inKey(2) && rng.chance(0.6) ? 'maj9' : 'maj7';
      else if (rich && inKey(2)) type = 'add9';
    } else if (type === 'min') {
      if (inKey(10)) type = rich && inKey(2) && rng.chance(0.6) ? 'm9' : 'm7';
      else if (rich && inKey(2)) type = 'madd9';
    } else if (type === 'dim') {
      if (inKey(10)) type = 'm7b5';
      else if (inKey(9) && rich) type = 'dim7';
    }
  }
  if (type === chord.type) return chord;
  const out = { ...chord, type, notes: chordPitchClasses(chord.root, type) };
  out.name = chordName(out);
  return out;
}

/**
 * generateProgression({key, scale, genre, bars=4, chordsPerBar, progression (id | romans[]), rng, seed,
 *   beatsPerBar=4, range=[52,76], flavor}) -> [{roman, chord, startBeat, durBeats, notes (MIDI voicing)}]
 */
export function generateProgression(opts = {}) {
  const rng = opts.rng || createRng(opts.seed ?? 1);
  const { root, scale } = resolveKey(opts);
  const genre = getGenre(opts.genre);
  const bpb = opts.beatsPerBar || 4;
  const bars = Math.max(1, opts.bars ?? 4);
  const range = opts.range || [52, 76];
  const minor = isMinorScale(scale);
  let prog = opts.progression ? getProgression(opts.progression) : null;
  if (!prog) prog = pickGenreProgression({ genre: genre?.id, scale, rng });
  let items;
  if (prog) {
    items = prog.romans.map((r, i) => ({ roman: r, bars: prog.durs?.[i] ?? 1 }));
  } else {
    // Markov walk with the theory engine's functional suggestions
    const romans = [minor ? 'i' : 'I'];
    while (romans.length < 4) {
      let sug = suggestNextChords(romans, root, scale, genre?.id, { limit: 8 });
      // suggestions are written for major / natural minor: in modes keep only chords that fit the scale
      const fit = (SCALES[scale]?.intervals?.length || 0) === 7 ? sug.filter((s) => isDiatonicTriad(s.chord, root, scale)) : sug;
      sug = (fit.length ? fit : sug).slice(0, 5);
      romans.push(rng.weighted(sug.map((s) => s.roman), sug.map((s) => s.score ** 2)));
    }
    items = romans.map((r) => ({ roman: r, bars: 1 }));
  }
  if (opts.chordsPerBar) items = items.map((it) => ({ ...it, bars: 1 / opts.chordsPerBar }));
  const flavor = opts.flavor ?? genre?.chordStyle;
  const out = [];
  let beat = 0;
  let prev = [];
  let i = 0;
  const total = bars * bpb;
  while (beat < total - 1e-6) {
    const it = items[i % items.length];
    const chord0 = romanToChord(it.roman, root, scale) || romanToChord(minor ? 'i' : 'I', root, scale);
    chord0.function = mod12(chord0.root - root) === 7 ? 'dominant' : undefined;
    const chord = colorChord(chord0, flavor, rng, { key: { root, scale } });
    const durBeats = Math.min(it.bars * bpb, total - beat);
    let notes;
    if (chord.type === '5') notes = voiceChord(chord, { range: [40, 64] });
    else {
      const maxVoices = opts.maxVoices || (STAB_STYLES.has(opts.style || genre?.chordStyle) ? 4 : 5);
      notes = voiceChord(chord, { prev, range, maxVoices });
    }
    out.push({ roman: it.roman, chord, startBeat: beat, durBeats, notes });
    prev = notes;
    beat += durBeats;
    i++;
  }
  out.name = prog?.name || 'Generated';
  return out;
}

// ---------------------------------------------------------------------------
// Rhythm styles
// ---------------------------------------------------------------------------

const H = (t, d, v = 0.8, extra = {}) => ({ t, d, v, ...extra });

/** Per-bar hit templates (beats within a 4/4 bar). Arrays of variants. */
export const CHORD_RHYTHMS = {
  stabs: [
    [H(0, 0.25, 1), H(0.75, 0.25, 0.7), H(1.5, 0.25, 0.8), H(2.5, 0.25, 0.75), H(3, 0.25, 0.7)],
    [H(0, 0.5, 1), H(1.5, 0.25, 0.75), H(2.25, 0.25, 0.7), H(3.5, 0.25, 0.8, { antic: true })],
    [H(0, 0.25, 1), H(1, 0.25, 0.6), H(1.75, 0.25, 0.8), H(2.5, 0.5, 0.75)],
  ],
  offbeat: [
    [H(0.5, 0.3, 0.85), H(1.5, 0.3, 0.8), H(2.5, 0.3, 0.85), H(3.5, 0.3, 0.8)],
    [H(0.5, 0.3, 0.85), H(1.5, 0.3, 0.8), H(1.75, 0.2, 0.6), H(2.5, 0.3, 0.85), H(3.5, 0.3, 0.8)],
  ],
  skank: [ // short, choked upstrokes
    [H(1, 0.25, 0.85), H(3, 0.25, 0.85)],
    [H(1, 0.25, 0.85), H(1.5, 0.25, 0.5), H(3, 0.25, 0.85), H(3.5, 0.25, 0.5)],
  ],
  pulse8: [
    [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((t) => H(t, 0.45, t % 1 === 0 ? 0.85 : 0.65)),
    [0, 0.5, 1, 1.5, 2, 2.5, 3].map((t) => H(t, t === 3 ? 0.9 : 0.45, t % 1 === 0 ? 0.85 : 0.65)),
  ],
  house: [
    [H(0, 0.3, 0.95), H(0.75, 0.3, 0.75), H(1.5, 0.3, 0.85), H(2.5, 0.3, 0.8), H(3, 0.3, 0.75)],
    [H(0.5, 0.3, 0.9), H(1.25, 0.3, 0.7), H(2, 0.3, 0.8), H(2.75, 0.3, 0.75), H(3.5, 0.3, 0.85, { antic: true })],
    [H(0.75, 0.3, 0.85), H(1.5, 0.3, 0.8), H(2.75, 0.3, 0.85), H(3.5, 0.3, 0.8)],
  ],
  'trance-gate': [[3, 7, 11, 14], [2, 5, 10, 13], [1, 5, 9, 11, 15]].map((rests) => [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75]
    .filter((_, i) => !rests.includes(i)).map((t) => H(t, 0.2, t % 1 === 0 ? 0.9 : 0.6))),
  future: [
    [H(0, 0.7, 1), H(0.75, 0.5, 0.75), H(1.5, 0.5, 0.8), H(2.5, 0.25, 0.7), H(3, 0.75, 0.85)],
    [H(0, 0.4, 1), H(0.5, 0.4, 0.7), H(1.5, 0.4, 0.8), H(2, 0.4, 0.7), H(2.75, 0.25, 0.65), H(3.5, 0.5, 0.8, { antic: true })],
  ],
  power: [[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((t) => H(t, 0.42, t % 1 === 0 ? 0.95 : 0.75))],
  strum: [[
    H(0, 0.95, 0.9, { strum: 1 }), H(1, 0.5, 0.7, { strum: 1 }), H(1.5, 0.5, 0.55, { strum: -1 }),
    H(2.5, 0.5, 0.6, { strum: -1 }), H(3, 0.5, 0.75, { strum: 1 }), H(3.5, 0.5, 0.55, { strum: -1 }),
  ]],
  comp: [
    [H(0, 0.6, 0.8), H(1.5, 0.4, 0.7)],
    [H(0.5, 0.5, 0.7), H(2, 0.5, 0.65), H(3.5, 0.4, 0.7, { antic: true })],
    [H(0, 0.9, 0.75), H(2.5, 0.4, 0.7)],
  ],
  bossa: [
    [H(0, 0.3, 0.8), H(0.75, 0.3, 0.6), H(1.5, 0.3, 0.7), H(2.5, 0.3, 0.65), H(3.25, 0.3, 0.6)],
    [H(0.5, 0.3, 0.7), H(1.25, 0.3, 0.6), H(2.25, 0.3, 0.65), H(3, 0.3, 0.65), H(3.75, 0.25, 0.6, { antic: true })],
  ],
  shuffle: [[0, 1, 2, 3].flatMap((b) => [H(b, 0.6, 0.8), H(b + 2 / 3, 0.3, 0.55)])],
  gospel: [
    [H(0, 1.4, 0.9, { strum: 1 }), H(1.5, 0.4, 0.6), H(2, 1, 0.8), H(3.5, 0.5, 0.75, { antic: true })],
    [H(0, 0.9, 0.9), H(1, 0.4, 0.55), H(1.75, 0.25, 0.6), H(2, 1.4, 0.85), H(3.5, 0.4, 0.7, { antic: true })],
  ],
  'neo-soul': [
    [H(0, 1.5, 0.75, { strum: 1 }), H(1.75, 0.5, 0.55), H(2.5, 1, 0.7, { strum: 1 })],
    [H(0, 0.75, 0.75, { strum: 1 }), H(1.5, 1, 0.6), H(3, 0.5, 0.55), H(3.75, 0.25, 0.6, { antic: true })],
  ],
  montuno: [[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((t, i) => H(t, 0.35, i % 2 ? 0.65 : 0.85, { voice: [-1, 1, -2, 0, -1, 1, -2, 'antic'][i] }))],
  arp: [[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((t, i) => H(t, 0.45, i % 2 ? 0.6 : 0.8, { voice: [0, 1, 2, 1, 3, 2, 1, 2][i] }))],
  ostinato: [[...Array(16).keys()].map((i) => H(i * 0.25, 0.2, [0, 3, 6, 8, 11, 14].includes(i) ? 0.95 : 0.55))],
};

/**
 * progressionToNotes(progression, {style='whole', rng, vel=0.75, beatsPerBar=4, length, octave=0, gate=1})
 * Renders a generated progression with a rhythm style. Styles: whole, stabs, offbeat, skank, pulse8, house,
 * trance-gate, future, power, strum, comp, bossa, shuffle, gospel, neo-soul, montuno, arp, ostinato.
 */
export function progressionToNotes(progression, opts = {}) {
  const rng = opts.rng || createRng(opts.seed ?? 1);
  const bpb = opts.beatsPerBar || 4;
  const baseVel = opts.vel ?? 0.75;
  const length = opts.length ?? progression.reduce((m, c) => Math.max(m, c.startBeat + c.durBeats), 0);
  const shift = (opts.octave || 0) * 12;
  const style = opts.style || 'whole';
  const out = [];
  const push = (pitch, start, dur, vel) => {
    if (start < 0 || start >= length - 1e-6) return;
    const n = makeNote(pitch + shift, start, Math.max(0.05, dur), vel, length);
    if (n) out.push(n);
  };
  const chordAt = (t) => progression.find((c) => t >= c.startBeat - 1e-6 && t < c.startBeat + c.durBeats - 1e-6) || progression[progression.length - 1];
  // motion: a chord that comes back (held over several bars, or the loop's next pass) is re-voiced along an inversion
  // path, so the top voice sings a line instead of hammering one shape
  const voicing = opts.motion ? motionVoicings(progression, { rng, range: opts.motionRange }) : null;
  const notesOf = (c) => (voicing?.get(c) || c.notes);

  if (style === 'whole' || style === 'pad' || style === 'sustain' || !CHORD_RHYTHMS[style]) {
    for (const c of progression) for (const n of notesOf(c)) push(n, c.startBeat, c.durBeats * (opts.gate ?? 0.98), baseVel * 0.9);
    return out;
  }
  const variants = CHORD_RHYTHMS[style];
  const bars = Math.ceil(length / bpb);
  const v0 = rng.int(0, variants.length - 1);
  for (let b = 0; b < bars; b++) {
    // mostly keep one variant for consistency; occasionally switch on odd bars
    let vi = b % 2 === 1 && variants.length > 1 && rng.chance(0.35) ? (v0 + 1) % variants.length : v0;
    // motion: the 4th bar of a phrase answers with another rhythm, the 8th breathes (rests on the last beat)
    if (voicing && b % 4 === 3 && variants.length > 1) vi = (v0 + 1 + (b >> 3)) % variants.length;
    const tpl = variants[vi];
    const breath = voicing && b % 8 === 7 && bars > 4;
    for (const h of tpl) {
      if (h.t >= bpb) continue;
      if (breath && h.t >= bpb - 1 && !h.antic) continue;
      const t = b * bpb + h.t;
      if (t >= length) continue;
      let chord = chordAt(t);
      if (h.antic || h.voice === 'antic') {
        const nxt = chordAt(t + 0.5 + 1e-3);
        if (nxt && nxt !== chord && t + 0.5 > nxt.startBeat - 1e-6) chord = nxt;
      }
      // a hit never rings past the next chord change (except anticipations that tie over)
      const chordEnd = chord.startBeat + chord.durBeats;
      const dur = h.antic ? h.d : Math.min(h.d, Math.max(0.1, chordEnd - t));
      const vel = baseVel * h.v * (0.92 + rng() * 0.08);
      const notes = notesOf(chord).slice().sort((a, x) => a - x);
      if (typeof h.voice === 'number') {
        const idx = h.voice < 0 ? notes.length + h.voice : h.voice % notes.length;
        push(notes[clamp(idx, 0, notes.length - 1)], t, dur, vel);
        if (style === 'montuno' && h.voice === -1) push(notes[clamp(idx, 0, notes.length - 1)] - 12, t, dur, vel * 0.9);
        continue;
      }
      if (h.voice === 'antic') { push(notes[notes.length - 1], t, dur, vel); continue; }
      const order = h.strum === -1 ? notes.slice().reverse() : notes;
      order.forEach((p, k) => {
        const off = h.strum ? k * 0.015 : 0;
        push(p, t + off, dur - off, vel * (h.strum ? 1 - k * 0.04 : 1));
      });
    }
    // gospel: a 16th-note chromatic "sidestep" (the next chord a half step below) — only into a free slot, so it
    // never stacks on top of a chord that is still ringing (that made 10-note semitone clusters)
    if (style === 'gospel' && rng.chance(0.4)) {
      const t = b * bpb + bpb - 0.25;
      const cur = chordAt(t);
      const nxt = chordAt(b * bpb + bpb + 1e-3);
      const busy = out.some((n) => n.start < t + 0.25 - 1e-6 && n.start + n.dur > t + 1e-6);
      if (nxt && nxt !== cur && t + 0.25 < length && !busy) {
        for (const p of notesOf(nxt)) push(p - 1, t, 0.22, baseVel * 0.55);
      }
    }
  }
  return out;
}

/**
 * The voicing moved `k` inversions (k > 0: the lowest note goes up an octave, k < 0: the highest comes down), or null
 * when it leaves `range` or breaks the low-interval limits (voicingProblem).
 */
export function invertVoicing(notes, k, range = [48, 86]) {
  let v = [...new Set(notes)].sort((a, b) => a - b);
  if (!v.length) return null;
  for (let i = 0; i < Math.abs(k); i++) {
    if (k > 0) { let up = v.shift() + 12; while (v.includes(up)) up += 12; v.push(up); }
    else { let dn = v.pop() - 12; while (v.includes(dn)) dn -= 12; v.unshift(dn); }
    v.sort((a, b) => a - b);
  }
  if (v[0] < range[0] || v[v.length - 1] > range[1] || voicingProblem(v)) return null;
  return v;
}

/** Inversion paths (per return of the same chord) — a small arch, so the top voice moves and comes home. */
const MOTION_PATHS = [[0, 1, 0, -1], [0, 1, 2, 1], [0, -1, 0, 1], [0, 1, 1, 0, -1, 0], [0, 0, 1, -1], [0, 2, 1, 0]];

/** Map progression entry -> voicing: each return of a chord (same root / type) takes the next step of an inversion path. */
export function motionVoicings(progression, { rng = createRng(1), range = [48, 86], path } = {}) {
  const p = path || MOTION_PATHS[rng.int(0, MOTION_PATHS.length - 1)];
  const seen = new Map();
  const out = new Map();
  for (const c of progression) {
    if (!c.chord || c.chord.type === '5' || !c.notes?.length) { out.set(c, c.notes); continue; }
    const key = `${c.chord.root}|${c.chord.type}`;
    const k = seen.get(key) || 0;
    seen.set(key, k + 1);
    const step = p[k % p.length];
    out.set(c, (step && (invertVoicing(c.notes, step, range) || invertVoicing(c.notes, -step, range))) || c.notes);
  }
  return out;
}

const PASS_PATH = [0, -1, 0, 1, 0, -1];
const ARCH = [0, 1, 2, 1, 0, -1, -2, -1];

/** Every clean voicing of the same notes (inversions ±2, with and without an open 2nd voice) inside range, by top note. */
export function voicingStates(v, range) {
  const seen = new Map();
  for (let k = -2; k <= 2; k++) {
    const inv = k ? invertVoicing(v, k, range) : v.slice().sort((a, b) => a - b);
    if (!inv) continue;
    const cands = [inv];
    if (inv.length >= 4) {
      const open = [inv[0], ...inv.slice(2), inv[1] + 12].sort((a, b) => a - b);
      if (open[open.length - 1] <= range[1] && !voicingProblem(open)) cands.push(open);
    }
    for (const c of cands) seen.set(c.join(), c);
  }
  return [...seen.values()].sort((a, b) => a[a.length - 1] - b[b.length - 1] || a[0] - b[0]);
}
const sameChord = (a, b) => !!a?.chord && !!b?.chord && a.chord.root === b.chord.root && a.chord.type === b.chord.type;

/**
 * Pad part: sustained, voice-led voicings (4 voices, `range`), common tones tied across chords and repeats of the same
 * chord re-voiced along a slow inversion path, so the inner voices move while the pad holds.
 * opts: {range=[55,74], maxVoices=4, center=63, bpb, length, vel=0.6, rng} -> Note[]
 */
export function padPart(progression, opts = {}) {
  const rng = opts.rng || createRng(opts.seed ?? 1);
  const range = opts.range || [55, 74];
  const length = opts.length ?? progression.reduce((m, c) => Math.max(m, c.startBeat + c.durBeats), 0);
  const vel = (opts.vel ?? 0.6) * 0.9;
  const center = opts.center ?? 63;
  const archOff = rng.chance(0.5) ? 0 : 4;
  const drift = [0, 1, 2, 1, 0, -1];
  const out = [];
  let prev = [];
  let open = new Map();
  let runStart = null;
  let runIdx = 0;
  const passes = new Map();
  progression.forEach((c, i) => {
    let v;
    const repeat = i > 0 && sameChord(progression[i - 1], c);
    if (repeat && runStart) {
      // a held chord: walk through its voicings (inversions / open spacings) in an arch, so the top voice sings a
      // slow line and inner voices move while the common tones stay tied
      runIdx++;
      const states = voicingStates(runStart, [range[0] - 2, range[1] + 2]);
      const home = Math.max(0, states.findIndex((x) => x.join() === runStart.join()));
      const idx = Math.max(0, Math.min(states.length - 1, home + ARCH[(runIdx + archOff) % ARCH.length]));
      v = states[idx] || runStart;
    } else {
      v = c.chord?.type === '5' ? c.notes.map((n) => (n < 52 ? n + 12 : n))
        : voiceChord(c.chord, { prev, range, maxVoices: opts.maxVoices || 4, context: c.notes, center: center + drift[i % drift.length] });
      if (!v.length) v = c.notes;
      // a chord that comes back on a later pass of the loop is voiced a step higher / lower (the pad's top line arcs)
      const key = c.chord ? `${c.chord.root}|${c.chord.type}` : String(i);
      const k = passes.get(key) || 0;
      passes.set(key, k + 1);
      const step = PASS_PATH[k % PASS_PATH.length];
      if (step) v = invertVoicing(v, step, [range[0] - 2, range[1]]) || invertVoicing(v, -step, [range[0] - 2, range[1]]) || v;
      runStart = v;
      runIdx = 0;
    }
    const end = c.startBeat + c.durBeats;
    const next = new Map();
    for (const p of v) {
      const held = open.get(p);
      if (held && held.start + held.dur >= c.startBeat - 0.25) {
        held.dur = Math.round((Math.min(length, end - 0.02 * c.durBeats) - held.start) * 10000) / 10000;
        next.set(p, held);
      } else {
        const n = makeNote(p, c.startBeat, c.durBeats * 0.98, vel, length);
        if (n) { out.push(n); next.set(p, n); }
      }
    }
    open = next;
    prev = v;
  });
  return out;
}

/** Convenience: generate + render in one call. -> {progression, notes} */
export function generateChordPart(opts = {}) {
  const rng = opts.rng || createRng(opts.seed ?? 1);
  const progression = opts.progressionData || generateProgression({ ...opts, rng });
  const genre = getGenre(opts.genre);
  const notes = progressionToNotes(progression, { style: opts.style || genre?.chordStyle || 'whole', rng, vel: opts.vel, beatsPerBar: opts.beatsPerBar, length: opts.length });
  return { progression, notes };
}
