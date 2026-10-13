// Chord progression generation + rhythmic rendering of progressions into notes.
import { createRng, clamp } from '../core/util.js';
import {
  romanToChord, getProgression, findProgressions, suggestNextChords, voiceLead, isMinorScale,
  chordPitchClasses, chordName, resolveScaleId, mod12, parseKey, scalePitchClasses, SCALES,
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

/** Chord pitch classes trimmed to `max` voices: omit the 5th first, then the 11th (as pianists do). */
export function voicingPitchClasses(chord, max = 5) {
  let pcs = chordPitchClasses(chord.root, chord.type);
  if (pcs.length <= max) return pcs;
  const fifth = mod12(chord.root + 7);
  if (pcs.includes(fifth)) pcs = pcs.filter((p) => p !== fifth);
  const eleventh = mod12(chord.root + 5);
  if (pcs.length > max && pcs.includes(eleventh)) pcs = pcs.filter((p) => p !== eleventh);
  return pcs.slice(0, max);
}

const EXT_RE = /(7|9|11|13|6|sus|add|5|ø|°|\+|maj)/;

/**
 * Re-colour a plain triad for a genre's harmonic flavour (only when the roman had no explicit extension).
 * flavor: 'neo-soul' | 'gospel' | 'house' | 'comp' | 'bossa' | 'future' | 'power' | 'lofi' | other (unchanged)
 */
export function colorChord(chord, flavor, rng = createRng(1)) {
  if (!chord || !flavor) return chord;
  const explicit = EXT_RE.test(String(chord.roman || '').replace(/^[b#]*[ivIV]+/, ''));
  let type = chord.type;
  const isDom = chord.type === 'maj' && chord.function === 'dominant';
  if (flavor === 'power') type = '5';
  else if (!explicit) {
    if (['neo-soul', 'gospel', 'lofi', 'comp', 'bossa'].includes(flavor)) {
      if (type === 'maj') type = isDom ? (rng.chance(0.5) ? '13' : '9') : rng.chance(0.6) ? 'maj9' : 'maj7';
      else if (type === 'min') type = rng.chance(0.6) ? 'm9' : 'm7';
      else if (type === 'dim') type = 'm7b5';
    } else if (['house', 'stabs-7', 'future', 'trance-gate'].includes(flavor)) {
      if (type === 'maj') type = isDom ? '7' : flavor === 'trance-gate' ? 'maj' : 'maj7';
      else if (type === 'min') type = flavor === 'trance-gate' ? 'min' : 'm7';
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
    const chord = colorChord(chord0, flavor, rng);
    const durBeats = Math.min(it.bars * bpb, total - beat);
    let notes;
    if (chord.type === '5') {
      let r = 40 + mod12(chord.root - 4);
      notes = [r, r + 7, r + 12];
    } else {
      notes = voiceLead(prev, voicingPitchClasses(chord, opts.maxVoices || 5), range);
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
  offbeat: [[H(0.5, 0.3, 0.85), H(1.5, 0.3, 0.8), H(2.5, 0.3, 0.85), H(3.5, 0.3, 0.8)]],
  skank: [
    [H(1, 0.35, 0.85), H(3, 0.35, 0.85)],
    [H(1, 0.3, 0.85), H(1.5, 0.2, 0.5), H(3, 0.3, 0.85), H(3.5, 0.2, 0.5)],
  ],
  pulse8: [[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((t) => H(t, 0.45, t % 1 === 0 ? 0.85 : 0.65))],
  house: [
    [H(0, 0.3, 0.95), H(0.75, 0.3, 0.75), H(1.5, 0.3, 0.85), H(2.5, 0.3, 0.8), H(3, 0.3, 0.75)],
    [H(0.5, 0.3, 0.9), H(1.25, 0.3, 0.7), H(2, 0.3, 0.8), H(2.75, 0.3, 0.75), H(3.5, 0.3, 0.85, { antic: true })],
    [H(0.75, 0.3, 0.85), H(1.5, 0.3, 0.8), H(2.75, 0.3, 0.85), H(3.5, 0.3, 0.8)],
  ],
  'trance-gate': [[0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75]
    .filter((_, i) => ![3, 7, 11, 14].includes(i)).map((t) => H(t, 0.2, t % 1 === 0 ? 0.9 : 0.6))],
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

  if (style === 'whole' || style === 'pad' || style === 'sustain' || !CHORD_RHYTHMS[style]) {
    for (const c of progression) for (const n of c.notes) push(n, c.startBeat, c.durBeats * (opts.gate ?? 0.98), baseVel * 0.9);
    return out;
  }
  const variants = CHORD_RHYTHMS[style];
  const bars = Math.ceil(length / bpb);
  const v0 = rng.int(0, variants.length - 1);
  for (let b = 0; b < bars; b++) {
    // mostly keep one variant for consistency; occasionally switch on odd bars
    const tpl = variants[b % 2 === 1 && variants.length > 1 && rng.chance(0.35) ? (v0 + 1) % variants.length : v0];
    for (const h of tpl) {
      if (h.t >= bpb) continue;
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
      const notes = chord.notes.slice().sort((a, x) => a - x);
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
    // gospel / neo-soul: chromatic approach chord a half-step below the next chord
    if ((style === 'gospel' || style === 'neo-soul') && rng.chance(0.4)) {
      const t = b * bpb + bpb - 0.25;
      const cur = chordAt(t);
      const nxt = chordAt(b * bpb + bpb + 1e-3);
      if (nxt && nxt !== cur && t + 0.25 < length) {
        for (const p of nxt.notes) push(p - 1, t, 0.22, baseVel * 0.55);
      }
    }
  }
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
