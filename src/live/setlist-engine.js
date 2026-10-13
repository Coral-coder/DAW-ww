// Setlist: a continuous, DJ-style generator. Pure logic (Node-testable, no DOM / audio).
//
// A set is a run of equal-length PHRASES (4 / 8 / 16 bars). Every phrase each LAYER (one track of a generated
// song: drums, perc, bass, sub, chords, pad, lead, arp, fx, …) plays one looping clip. The next phrase is planned
// ahead of time as a VARIATION of what is playing now (same rhythm cells / groove / register / sound, small
// mutations, fills at phrase ends) and an energy arc (intro → groove → build → drop → breakdown → …) decides which
// layers play. Key moves (relative, dominant, Camelot ±1, …) are quantized to the next phrase: the last bar of the
// current phrase becomes a pivot (the new key's dominant) and harmonic layers continue in the new key on the same
// rhythm, while drums keep going untouched.
//
// The browser runner (src/live/setlist-runner.js) places the phrases as clips on the song timeline (song mode),
// so what was played is an ordinary arrangement: undo, export (.daW3 / WAV / MIDI) and editing all work.
import { createRng, clamp } from '../core/util.js';
import { SCALES, pitchClassName, keyPrefersFlats, resolveScaleId } from '../theory/index.js';
import { generateSong } from '../gen/song.js';
import { sectionKind } from '../gen/arrange.js';

const mod12 = (x) => ((x % 12) + 12) % 12;
const EPS = 1e-6;

// ------------------------------------------------------------------------------------------------ keys

const intervalsOf = (scale) => (SCALES[resolveScaleId(scale)] || SCALES.minor).intervals;
/** Minor-family scale (has a minor third and no major third). */
export const isMinorScale = (scale) => { const iv = intervalsOf(scale); return iv.includes(3) && !iv.includes(4); };

export function keyName(key) {
  const id = resolveScaleId(key.scale);
  const short = { minor: 'minor', aeolian: 'minor', major: 'major', ionian: 'major' }[id];
  const name = short || (SCALES[id]?.name || key.scale).toLowerCase();
  return `${pitchClassName(mod12(key.root), keyPrefersFlats(mod12(key.root), short === 'minor' ? 'minor' : short === 'major' ? 'major' : key.scale))} ${name}`;
}

/** Camelot wheel position: A minor = 8A, C major = 8B; +1 = a fifth up. */
export function camelot(key) {
  const minor = isMinorScale(key.scale);
  const base = minor ? mod12(key.root - 9) : mod12(key.root);
  const num = ((mod12(base * 7) + 7) % 12) + 1;
  return { num, letter: minor ? 'A' : 'B', code: `${num}${minor ? 'A' : 'B'}` };
}

/** '8A' -> {root: 9, scale: 'minor'}. */
export function keyFromCamelot(code) {
  const m = /^(\d{1,2})([AB])$/i.exec(String(code).trim());
  if (!m) return null;
  const num = ((Number(m[1]) - 1) % 12 + 12) % 12 + 1;
  const minor = m[2].toUpperCase() === 'A';
  const steps = mod12(num - 8); // fifths above 8A / 8B
  const base = mod12(steps * 7);
  return minor ? { root: mod12(base + 9), scale: 'minor' } : { root: base, scale: 'major' };
}

const keepFamily = (scale, minor) => (isMinorScale(scale) === minor ? resolveScaleId(scale) : minor ? 'minor' : 'major');

/** Harmonic-mixing moves. `camelot` = the Camelot step shown in the UI. */
export const KEY_MOVES = [
  { id: 'relative', label: 'Relative', hint: 'Same notes, other mode (Camelot A↔B) — the smoothest move' },
  { id: 'dominant', label: 'Dominant +5th', hint: 'Up a fifth (Camelot +1) — lifts the energy' },
  { id: 'subdominant', label: 'Subdominant +4th', hint: 'Up a fourth (Camelot −1) — relaxes' },
  { id: 'diagonal', label: 'Diagonal', hint: 'Camelot +1 and switch mode — a classic DJ energy change' },
  { id: 'parallel', label: 'Parallel', hint: 'Same root, major ↔ minor — mood switch' },
  { id: 'lift1', label: '+1 semitone', hint: 'Energy lift: everything up a half step (Camelot +7)' },
  { id: 'lift2', label: '+2 semitones', hint: 'Energy lift: up a whole step (Camelot +2)' },
];

export function keyMoveTarget(key, moveId) {
  const minor = isMinorScale(key.scale);
  const r = mod12(key.root);
  switch (moveId) {
    case 'relative': return minor ? { root: mod12(r + 3), scale: 'major' } : { root: mod12(r + 9), scale: 'minor' };
    case 'parallel': return { root: r, scale: minor ? 'major' : 'minor' };
    case 'dominant': return { root: mod12(r + 7), scale: resolveScaleId(key.scale) };
    case 'subdominant': return { root: mod12(r + 5), scale: resolveScaleId(key.scale) };
    case 'diagonal': return minor ? { root: mod12(r + 10), scale: 'major' } : { root: mod12(r + 4), scale: 'minor' };
    case 'lift1': return { root: mod12(r + 1), scale: resolveScaleId(key.scale) };
    case 'lift2': return { root: mod12(r + 2), scale: resolveScaleId(key.scale) };
    case 'camelot+1': case 'camelot-1': {
      const c = camelot(key);
      const k = keyFromCamelot(`${c.num + (moveId === 'camelot+1' ? 1 : -1 + 12)}${c.letter}`);
      return { root: k.root, scale: keepFamily(key.scale, minor) };
    }
    default: return { root: r, scale: resolveScaleId(key.scale) };
  }
}

/** Buttons for the UI: [{id, label, hint, target, text: 'A minor → C major (relative)', camelot: '8A → 8B'}]. */
export function keyMoveOptions(key) {
  return KEY_MOVES.map((m) => {
    const target = keyMoveTarget(key, m.id);
    return { ...m, target, text: `${keyName(key)} → ${keyName(target)} (${m.label.toLowerCase()})`, camelot: `${camelot(key).code} → ${camelot(target).code}` };
  });
}

/** Signed root shift from `from` to `to`, in −5..+6 (the smaller jump). */
export function rootShift(from, to) {
  const d = mod12(to.root - from.root);
  return d > 6 ? d - 12 : d;
}

/**
 * Re-pitch notes from one key into another, degree by degree (rhythm untouched): the i-th scale degree of `from`
 * becomes the i-th degree of `to` (chromatic notes keep their offset). Different-size scales: transpose + snap.
 */
export function mapToKey(notes, from, to) {
  const shift = rootShift(from, to);
  if (!shift && resolveScaleId(from.scale) === resolveScaleId(to.scale)) return notes.map((n) => ({ ...n }));
  const fi = intervalsOf(from.scale), ti = intervalsOf(to.scale);
  const toPcs = new Set(ti.map((i) => mod12(to.root + i)));
  return notes.map((n) => {
    let p;
    if (fi.length === ti.length) {
      const rel = n.pitch - from.root;
      const oct = Math.floor(rel / 12), pc = mod12(rel);
      let d = 0;
      for (let i = 0; i < fi.length; i++) if (fi[i] <= pc) d = i;
      p = from.root + shift + oct * 12 + ti[d] + (pc - fi[d]);
    } else {
      p = n.pitch + shift;
      if (!toPcs.has(mod12(p))) p = toPcs.has(mod12(p - 1)) ? p - 1 : p + 1;
    }
    return { ...n, pitch: clamp(p, 0, 127) };
  });
}

/** Fraction of notes whose pitch class is in the key's scale. */
export function inScaleRatio(notes, key) {
  if (!notes.length) return 1;
  const pcs = new Set(intervalsOf(key.scale).map((i) => mod12(key.root + i)));
  return notes.filter((n) => pcs.has(mod12(n.pitch))).length / notes.length;
}

/** The dominant-7th pitch classes of a key (V7 — major third even in minor). */
export function dominantPcs(key) {
  const r = mod12(key.root + 7);
  return [r, mod12(r + 4), mod12(r + 7), mod12(r + 10)];
}

const nearestPc = (pitch, pcs) => {
  let best = pitch, bd = 99;
  for (let d = 0; d <= 6; d++) for (const s of [d, -d]) if (Math.abs(s) < bd && pcs.includes(mod12(pitch + s))) { bd = Math.abs(s); best = pitch + s; }
  return best;
};

/**
 * Pivot bar: the last bar [barStart, length) of a harmonic part is re-pitched onto the dominant (V7) of the new key,
 * notes held into it are split at the barline. Bass parts land on the dominant's root / fifth.
 */
export function pivotBar(notes, { length, barStart, toKey, bass = false }) {
  const pcs = bass ? dominantPcs(toKey).slice(0, 3).filter((_, i) => i !== 1) : dominantPcs(toKey);
  const out = [];
  for (const n of notes) {
    if (n.start + EPS >= length) continue;
    if (n.start + EPS >= barStart) { out.push({ ...n, pitch: nearestPc(n.pitch, pcs) }); continue; }
    if (n.start + n.dur > barStart + 0.05) {
      out.push({ ...n, dur: barStart - n.start });
      out.push({ ...n, id: undefined, start: barStart, dur: Math.min(n.start + n.dur, length) - barStart, pitch: nearestPc(n.pitch, pcs) });
      continue;
    }
    out.push({ ...n });
  }
  // a part silent in the pivot bar (e.g. a held pad that ended) still gets the chord for harmonic layers
  if (!bass && !out.some((n) => n.start + EPS >= barStart) && notes.length) {
    const center = Math.round(notes.reduce((s, n) => s + n.pitch, 0) / notes.length);
    const vel = notes.reduce((s, n) => s + (n.vel ?? 0.7), 0) / notes.length;
    const chord = [...new Set(pcs.slice(0, 3).map((pc) => nearestPc(center, [pc])))];
    for (const p of chord) out.push({ pitch: p, start: barStart, dur: length - barStart - 0.05, vel });
  }
  return out.map(cleanNote);
}

const cleanNote = (n) => ({ ...(n.id ? { id: n.id } : {}), pitch: n.pitch, start: +n.start.toFixed(5), dur: Math.max(0.02, +n.dur.toFixed(5)), vel: clamp(n.vel ?? 0.8, 0.05, 1), ...pickExtras(n) });
const pickExtras = (n) => { const o = {}; for (const k of ['glide', 'gt', 'bend', 'bendAt', 'vib', 'flam']) if (n[k] != null) o[k] = n[k]; return o; };

// ------------------------------------------------------------------------------------------------ rhythm

const stepOf = (t) => Math.round(t * 4);

/** Jaccard similarity of the 16th-grid onset sets (per drum voice for drum parts). 1 = identical rhythm. */
export function rhythmSimilarity(a, b, { drums = false } = {}) {
  const key = (n) => (drums ? `${n.pitch}:${stepOf(n.start)}` : String(stepOf(n.start)));
  const A = new Set(a.map(key)), B = new Set(b.map(key));
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// ------------------------------------------------------------------------------------------------ layers & arc

/** Layer family of a generated track (drives the energy arc). */
export function layerCategory(track) {
  const r = track.role || '';
  if (r === 'drums') return 'drums';
  if (r === 'perc' || r === 'top') return 'perc';
  if (r === 'impact') return 'impact';
  if (r === 'bass' || r === 'sub') return 'bass';
  if (r === 'chords' || r === 'guitar' || r === 'organ' || r === 'brass' || r === 'strings' || r === 'stabs') return 'chords';
  if (r === 'pad' || r === 'texture') return 'pad';
  if (r === 'arp') return 'arp';
  if (r === 'fx') return 'fx';
  if (track.instrument?.type === 'drums' || track.instrument?.type === 'drumsampler') return 'perc';
  return 'lead'; // lead, counter, vox, chop, color, bells, …
}
export const isDrumTrack = (track) => track.instrument?.type === 'drums' || track.instrument?.type === 'drumsampler';

export const SECTIONS = {
  intro: { label: 'Intro', energy: 0.35, cats: ['drums', 'perc', 'pad'] },
  groove: { label: 'Groove', energy: 0.6, cats: ['drums', 'perc', 'bass', 'chords'] },
  build: { label: 'Build', energy: 0.75, cats: ['drums', 'perc', 'chords', 'pad', 'arp', 'fx'] },
  drop: { label: 'Drop', energy: 1, cats: ['drums', 'perc', 'bass', 'chords', 'pad', 'lead', 'arp', 'impact'] },
  breakdown: { label: 'Breakdown', energy: 0.4, cats: ['pad', 'chords', 'lead', 'fx'] },
};
/** The automatic DJ arc (after the intro it cycles from index 1). */
export const ARC = ['intro', 'groove', 'groove', 'build', 'drop', 'drop', 'breakdown', 'build', 'drop', 'drop', 'groove', 'groove'];
/** What follows a section the user picked by hand. */
const AFTER = { intro: 1, groove: 2, build: 4, drop: 5, breakdown: 7 };

/** Section of the phrase after `cur`: queued choice > hold > arc. Returns {section, arcIndex}. */
export function nextSection({ arcIndex = 0, queued = null, hold = false, current = 'intro' } = {}) {
  if (queued && SECTIONS[queued]) return { section: queued, arcIndex: AFTER[queued] };
  if (hold) return { section: current, arcIndex };
  let i = arcIndex + 1;
  if (i >= ARC.length) i = 1;
  return { section: ARC[i], arcIndex: i };
}

/**
 * Which layers play in a phrase. layers: [{id, category, mode:'auto'|'on'|'off'}]; energy 0..1 (global fader).
 * Energy thins / thickens the section's layer set; `firstOfSection` lets impacts hit only on the first drop phrase.
 */
export function activeLayers(layers, section, energy = 0.7, { firstOfSection = true } = {}) {
  const def = SECTIONS[section] || SECTIONS.groove;
  const cats = new Set(def.cats);
  if (energy >= 0.8) { if (section === 'groove') { cats.add('lead'); cats.add('pad'); } if (section === 'intro') cats.add('bass'); if (section === 'breakdown') cats.add('arp'); }
  if (energy < 0.6 && section !== 'build') cats.delete('arp');
  if (energy < 0.45) { cats.delete('perc'); cats.delete('lead'); }
  if (energy < 0.25) { cats.delete('chords'); if (section !== 'breakdown' && section !== 'intro') cats.delete('pad'); }
  if (energy < 0.1) cats.delete('bass');
  if (!firstOfSection) cats.delete('impact');
  // within a category, low energy keeps only the first layer (e.g. bass without the sub)
  const seen = {};
  const out = new Set();
  for (const l of layers) {
    if (l.mode === 'off') continue;
    if (l.mode === 'on') { out.add(l.id); continue; }
    if (!cats.has(l.category)) continue;
    seen[l.category] = (seen[l.category] || 0) + 1;
    if (energy < 0.5 && seen[l.category] > 1 && l.category !== 'drums') continue;
    out.add(l.id);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ variation

const HATS = new Set([42, 44, 46, 51, 53, 59]);
const KICK = 36, SNARE = 38, CLAP = 39;
const scaleSteps = (key) => intervalsOf(key.scale).map((i) => mod12(key.root + i));
function stepDiatonic(pitch, dir, key) {
  const pcs = scaleSteps(key);
  let p = pitch + dir;
  for (let g = 0; g < 3 && !pcs.includes(mod12(p)); g++) p += dir;
  return p;
}

/** Drum fill over the last `beats` of the phrase: snare / tom 16ths, crescendo; kicks on the beat stay. */
export function drumFill(notes, { length, beats = 2, type = 'fill', rng = Math.random }) {
  const a = length - beats;
  const keep = notes.filter((n) => n.start < a - EPS || (n.pitch === KICK && Math.abs(n.start - Math.round(n.start)) < EPS && type !== 'build'));
  const toms = [50, 48, 47, 45, 43];
  const step = type === 'build' ? 0.25 : rng() < 0.5 ? 0.25 : 0.5;
  for (let t = a, i = 0; t < length - EPS; t += step, i++) {
    const prog = (t - a) / beats;
    const pitch = type === 'build' || rng() < 0.55 ? SNARE : toms[Math.min(toms.length - 1, Math.floor(prog * toms.length))];
    keep.push({ pitch, start: t, dur: 0.1, vel: 0.45 + prog * 0.5 });
  }
  return keep;
}

/** Snare roll build over the last `bars` bars: 8ths, then 16ths, then 32nds, crescendo (no kick in the last beat). */
export function buildRoll(notes, { length, bpb = 4, bars = 2 }) {
  const a = Math.max(0, length - bars * bpb);
  const out = notes.filter((n) => n.start < a - EPS || (n.pitch === KICK && n.start < length - 1 - EPS) || HATS.has(n.pitch));
  for (let t = a; t < length - 0.5 - EPS;) {
    const prog = (t - a) / (length - a);
    const step = prog < 0.5 ? 0.5 : prog < 0.85 ? 0.25 : 0.125;
    out.push({ pitch: SNARE, start: t, dur: 0.08, vel: 0.35 + prog * 0.6 });
    t += step;
  }
  return out.filter((n) => n.start < length - 0.5 - EPS || n.pitch === SNARE);
}

/**
 * A variation of a phrase that keeps its identity: same rhythm cells, register and sound.
 * opts: {drums, category, mutate 0..1, density 0..1.25, rng, length, bpb, key, fill: null|'fill'|'build'}
 */
export function varyNotes(notes, opts) {
  const { drums = false, category = 'lead', length, bpb = 4, key = { root: 0, scale: 'minor' } } = opts;
  const rng = opts.rng || createRng(1);
  const m = clamp(opts.mutate ?? 0.35, 0, 1);
  const density = clamp(opts.density ?? 1, 0, 1.25);
  const bars = Math.max(1, Math.round(length / bpb));
  let out = notes.filter((n) => n.start < length - EPS).map((n) => ({ ...n }));

  if (drums) {
    for (let b = 0; b < bars; b++) {
      const b0 = b * bpb;
      if (rng() < m * 0.5) {
        // toggle one off-beat hat 16th
        const hat = out.find((n) => HATS.has(n.pitch)) || null;
        const step = b0 + (rng.int(0, bpb * 2 - 1) * 0.5) + 0.25;
        const at = out.findIndex((n) => HATS.has(n.pitch) && Math.abs(n.start - step) < 0.02);
        if (at >= 0) out.splice(at, 1);
        else if (hat) out.push({ pitch: hat.pitch, start: step, dur: 0.1, vel: (hat.vel ?? 0.6) * 0.75 });
      }
      if (rng() < m * 0.25) {
        const sn = out.find((n) => n.pitch === SNARE || n.pitch === CLAP);
        if (sn) out.push({ pitch: sn.pitch, start: b0 + rng.pick([0.75, 1.75, 2.25, 3.75].filter((x) => x < bpb)), dur: 0.1, vel: 0.22 });
      }
    }
    if (m > 0) for (const n of out) n.vel = clamp((n.vel ?? 0.8) + (rng() - 0.5) * 0.12 * m, 0.1, 1);
    if (density < 1) {
      // thin the weakest non-kick / non-backbeat voices first
      const cand = out.filter((n) => n.pitch !== KICK && n.pitch !== SNARE && n.pitch !== CLAP).sort((x, y) => (x.vel ?? 0.8) - (y.vel ?? 0.8));
      const drop = new Set(cand.slice(0, Math.round(cand.length * (1 - density) * 0.85)));
      out = out.filter((n) => !drop.has(n) && (density > 0.15 || n.pitch === KICK));
    } else if (density > 1) {
      const hat = out.find((n) => HATS.has(n.pitch));
      if (hat) for (let t = 0; t < length - EPS; t += 0.25) if (rng() < (density - 1) * 2 && !out.some((n) => HATS.has(n.pitch) && Math.abs(n.start - t) < 0.05)) out.push({ pitch: hat.pitch, start: t, dur: 0.1, vel: 0.3 });
    }
    if (opts.fill === 'build') out = buildRoll(out, { length, bpb, bars: Math.min(2, bars) });
    else if (opts.fill === 'fill') out = drumFill(out, { length, beats: bars >= 8 && rng() < 0.4 ? bpb : 2, rng });
    return out.sort((x, y) => x.start - y.start).map(cleanNote);
  }

  // melodic / harmonic parts: per-bar motif variation, rhythm kept
  const barNotes = (b) => out.filter((n) => n.start >= b * bpb - EPS && n.start < (b + 1) * bpb - EPS);
  const chordal = category === 'chords' || category === 'pad';
  for (let b = 0; b < bars; b++) {
    const ns = barNotes(b);
    if (!ns.length) continue;
    if (!chordal && rng() < m * 0.5) {
      // diatonic neighbour on 1–2 notes off the downbeat
      const off = ns.filter((n) => Math.abs(n.start - b * bpb) > EPS);
      for (let k = 0; k < Math.min(off.length, rng.int(1, 2)); k++) { const n = rng.pick(off); n.pitch = stepDiatonic(n.pitch, rng.chance(0.5) ? 1 : -1, key); }
    }
    if (category === 'lead' || category === 'arp') {
      if (rng() < m * 0.15) { const n = rng.pick(ns); n.pitch += n.pitch > 72 ? -12 : 12; }
    }
    if (category === 'bass' && rng() < m * 0.2) {
      const off = ns.filter((n) => (n.start % 1) > EPS);
      if (off.length) { const n = rng.pick(off); n.pitch += n.pitch < 40 ? 12 : -12; }
    }
    if (chordal && rng() < m * 0.2) {
      // re-voice: lowest voice up an octave (an inversion) for this bar
      const starts = [...new Set(ns.map((n) => n.start.toFixed(3)))];
      for (const s of starts) { const grp = ns.filter((n) => n.start.toFixed(3) === s); if (grp.length > 2) { const lo = grp.reduce((a, n) => (n.pitch < a.pitch ? n : a)); if (lo.pitch + 12 <= 84) lo.pitch += 12; } }
    }
  }
  // motif repetition: occasionally copy one bar's pitches (same rhythm) onto a later bar with the same onsets
  if (!chordal && bars >= 2 && rng() < m * 0.35) {
    const b = rng.int(1, bars - 1);
    const src = barNotes(b - 1), dst = barNotes(b);
    if (src.length === dst.length && src.every((n, i) => Math.abs((n.start % bpb) - (dst[i].start % bpb)) < 0.02)) dst.forEach((n, i) => { n.pitch = src[i].pitch; });
  }
  if (m > 0) for (const n of out) n.vel = clamp((n.vel ?? 0.8) + (rng() - 0.5) * 0.08 * m, 0.1, 1);
  if (density < 1 && !chordal) {
    const weak = out.filter((n) => (n.start % 1) > EPS).sort((x, y) => (x.vel ?? 0.8) - (y.vel ?? 0.8));
    const drop = new Set(weak.slice(0, Math.round(weak.length * (1 - density))));
    out = out.filter((n) => !drop.has(n));
  } else if (density < 0.5 && chordal) {
    out = out.filter((n) => (n.start % bpb) < EPS || n.dur >= bpb - EPS);
  }
  return out.sort((x, y) => x.start - y.start).map(cleanNote);
}

// ------------------------------------------------------------------------------------------------ phrase timing

export const phraseBeats = (bars, bpb = 4) => bars * bpb;
export const phraseIndexAt = (pos, P) => Math.max(0, Math.floor((pos + EPS) / P));
export const phraseStart = (i, P) => i * P;
/** 0..1 progress through the current phrase. */
export const phraseProgress = (pos, P) => clamp((pos - phraseIndexAt(pos, P) * P) / P, 0, 1);
/**
 * Beat at which phrase i+1 must be planned and placed (and the pivot written into phrase i's last bar):
 * at least one bar + `safetySec` before the last bar starts, so the lookahead scheduler (≤ 1.5 s in a hidden tab)
 * never has played past what we edit.
 */
export function prepareBeat(i, P, { bpb = 4, bpm = 120, safetySec = 2 } = {}) {
  const lead = bpb + Math.max(bpb, Math.ceil((safetySec * bpm) / 60));
  return Math.max(i * P, (i + 1) * P - lead);
}

// ------------------------------------------------------------------------------------------------ material

const KIND_MAP = { intro: 'intro', outro: 'intro', verse: 'groove', build: 'build', main: 'drop', break: 'breakdown' };

/** Notes of a looping pattern clip inside the absolute window [a, b), re-based to a. */
export function clipWindowNotes(pattern, clip, a, b) {
  const out = [];
  const L = pattern.length || 4;
  const c0 = Math.max(a, clip.start), c1 = Math.min(b, clip.start + clip.length);
  if (c1 <= c0) return out;
  const anchor = clip.start - (clip.offset || 0);
  for (let k = Math.floor((c0 - anchor) / L) - 1; anchor + k * L < c1; k++) {
    for (const n of pattern.notes) {
      const s = anchor + k * L + n.start;
      if (s >= c0 - EPS && s < c1 - EPS) out.push({ ...n, start: s - a, dur: Math.min(n.dur, b - s) });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

const loopTo = (notes, srcLen, length) => {
  if (srcLen >= length - EPS || !notes.length) return notes.filter((n) => n.start < length - EPS);
  const out = [];
  for (let off = 0; off < length - EPS; off += srcLen) for (const n of notes) if (off + n.start < length - EPS) out.push({ ...n, start: off + n.start });
  return out;
};

/**
 * Per-layer, per-section material from a generated song: material[trackId][section] = notes (song key, P beats).
 * Builds take the LAST bars of the section (their roll / riser), the rest the first bars.
 */
export function extractMaterial(song, P) {
  const bpb = (song.timeSig?.[0] || 4) * (4 / (song.timeSig?.[1] || 4));
  const sections = (song.sections || []).map((s) => ({ ...s, a: s.start, b: s.start + s.bars * bpb, kind: KIND_MAP[s.kind || sectionKind(s.name)] || 'groove' }));
  const out = {};
  for (const t of song.tracks) {
    const mat = {};
    for (const kind of Object.keys(SECTIONS)) {
      for (const s of sections.filter((x) => x.kind === kind)) {
        const clips = song.clips.filter((c) => c.trackId === t.id && c.start < s.b - EPS && c.start + c.length > s.a + EPS);
        if (!clips.length) continue;
        const len = s.b - s.a;
        const a = kind === 'build' && len > P ? s.b - P : s.a;
        const b = Math.min(s.b, a + P);
        let notes = [];
        for (const c of clips) { const pat = song.patterns[c.patternId]; if (pat) notes.push(...clipWindowNotes(pat, c, a, b)); }
        if (!notes.length) continue;
        mat[kind] = loopTo(notes.sort((x, y) => x.start - y.start), b - a, P).map(cleanNote);
        break;
      }
    }
    out[t.id] = mat;
  }
  return out;
}

/** Fallback order when a layer has no material for a section. */
const FALLBACK = { intro: ['intro', 'groove', 'drop', 'breakdown', 'build'], groove: ['groove', 'drop', 'intro', 'build', 'breakdown'], build: ['build', 'groove', 'drop', 'breakdown', 'intro'], drop: ['drop', 'groove', 'build', 'breakdown', 'intro'], breakdown: ['breakdown', 'drop', 'groove', 'intro', 'build'] };
export function materialFor(mat, section) {
  for (const k of FALLBACK[section] || FALLBACK.groove) if (mat?.[k]?.length) return { notes: mat[k], from: k };
  return { notes: [], from: null };
}

// ------------------------------------------------------------------------------------------------ the set

/**
 * Start a set: generates a song for the genre / key (its tracks, sounds, Strudel patches, mix, buses, master) and
 * extracts per-section material from it. Returns {song, state}: `song` is the partial project to load (its
 * clips / patterns / markers / automation are for reference only; the runner clears them), `state` the generator.
 */
export function createSetlist({ genre = 'tech-house', key = { root: 0, scale: 'minor' }, bpm, seed = 1, phraseBars = 8, energy = 0.7 } = {}) {
  const song = generateSong({ genre, key: { root: mod12(key.root), scale: key.scale }, scale: key.scale, bpm, seed, withHarmony: true });
  const bpb = (song.timeSig?.[0] || 4) * (4 / (song.timeSig?.[1] || 4));
  const P = phraseBars * bpb;
  const material = extractMaterial(song, P);
  const layers = song.tracks.map((t) => ({
    id: t.id, name: t.name, role: t.role, category: layerCategory(t), drums: isDrumTrack(t),
    material: material[t.id] || {}, mode: 'auto', lock: false, mutate: 0.35, density: 1, regen: false, fresh: null,
    lastSection: null, lastNotes: null, lastKey: null,
  }));
  const state = {
    genre, bpm: song.bpm, bpb, phraseBars, songKey: { ...song.key }, key: { ...song.key }, pendingKey: null,
    section: null, arcIndex: 0, queued: null, hold: false, energy, autoDrift: false, driftEvery: 4,
    index: -1, sectionPhrase: 0, seed, layers, history: [],
  };
  return { song, state };
}

const hashSeed = (...xs) => xs.reduce((h, x) => (Math.imul(h ^ (typeof x === 'number' ? x : [...String(x)].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)), 2654435761) >>> 0), 0x9e3779b9);

/** Change the phrase length (applies to the next phrase; materials are re-cut from the song). */
export function setPhraseBars(state, song, bars) {
  state.phraseBars = bars;
  const mat = extractMaterial(song, bars * state.bpb);
  for (const l of state.layers) { l.material = mat[l.id] || {}; l.lastNotes = l.lastNotes ? loopTo(l.lastNotes, Math.max(...l.lastNotes.map((n) => n.start + n.dur), state.bpb), bars * state.bpb).filter((n) => n.start < bars * state.bpb) : null; }
}

/** Queue a key change for the next phrase. */
export function queueKeyMove(state, moveId) {
  const from = state.pendingKey || state.key;
  state.pendingKey = keyMoveTarget(from, moveId);
  return state.pendingKey;
}

/**
 * A new idea for one layer: the same role from a freshly generated song (other seed, same genre / tempo, current
 * key), cut to the phrase. Stored as `layer.fresh` and used by the next phrase.
 */
export function freshIdea(state, layerId, seed) {
  const l = state.layers.find((x) => x.id === layerId);
  if (!l) return null;
  const P = state.phraseBars * state.bpb;
  let song = null;
  try { song = generateSong({ genre: state.genre, key: { ...state.songKey }, scale: state.songKey.scale, bpm: state.bpm, seed }); } catch { song = null; }
  const t = song?.tracks.find((x) => x.role === l.role);
  let notes = null;
  if (t) {
    const mat = extractMaterial({ ...song, tracks: [t] }, P)[t.id];
    notes = materialFor(mat, state.section || 'drop').notes;
  }
  l.fresh = notes && notes.length ? notes : null;
  l.regen = true;
  return l.fresh;
}

/**
 * Plan the next phrase. ctx.current: {layerId: notes|null} (what each layer plays NOW, incl. the user's edits),
 * ctx.edited: {layerId: true} (the user changed it — keep following it).
 * Returns {index, section, key, prevKey, keyChanged, layers: {id: {active, notes}}, pivot: {id: notes} (rewritten
 * current phrase, last bar on the new key's V7) | null, fill}.
 */
export function planPhrase(state, ctx = {}) {
  const current = ctx.current || {};
  const edited = ctx.edited || {};
  const index = state.index + 1;
  const P = state.phraseBars * state.bpb;
  const bpb = state.bpb;
  const rng = createRng(hashSeed(state.seed, index, 'phrase'));

  // section
  let section, arcIndex;
  if (index === 0) { section = state.queued && SECTIONS[state.queued] ? state.queued : 'intro'; arcIndex = state.queued ? AFTER[state.queued] ?? 0 : 0; }
  else ({ section, arcIndex } = nextSection({ arcIndex: state.arcIndex, queued: state.queued, hold: state.hold, current: state.section }));
  const firstOfSection = section !== state.section;

  // key: queued move or auto-drift (a Camelot neighbour every N phrases)
  const prevKey = { ...state.key };
  let key = state.key;
  if (!state.pendingKey && state.autoDrift && index > 0 && index % Math.max(1, state.driftEvery) === 0) {
    state.pendingKey = keyMoveTarget(state.key, rng.pick(['camelot+1', 'camelot-1', 'relative', 'camelot+1']));
  }
  const keyChanged = !!state.pendingKey && (state.pendingKey.root !== key.root || resolveScaleId(state.pendingKey.scale) !== resolveScaleId(key.scale));
  if (state.pendingKey) { key = { ...state.pendingKey }; state.pendingKey = null; }

  // the section after this one decides the fill at this phrase's end
  const peek = nextSection({ arcIndex, queued: null, hold: state.hold, current: section }).section;
  const active = activeLayers(state.layers, section, state.energy, { firstOfSection });
  const out = {};
  const pivot = keyChanged && index > 0 ? {} : null;
  for (const l of state.layers) {
    const cur = current[l.id] || null;
    const lrng = createRng(hashSeed(state.seed, index, l.id));
    let base, baseKey;
    if (l.lock && (cur || l.lastNotes)) { base = cur || l.lastNotes; baseKey = l.lastKey || prevKey; }
    else if (l.regen && l.fresh) { base = l.fresh; baseKey = state.songKey; }
    else if (cur && cur.length && (edited[l.id] || l.lastSection === section)) { base = cur; baseKey = l.lastKey || prevKey; }
    else {
      const m = materialFor(l.material, section);
      base = m.notes; baseKey = state.songKey;
      // a layer that keeps playing across sections keeps its own rhythm when the material for the new section is
      // missing (fell back to another section) — follow what's playing
      if (cur && cur.length && m.from !== section) { base = cur; baseKey = l.lastKey || prevKey; }
    }
    let notes = base ? base.filter((n) => n.start < P - EPS).map((n) => ({ ...n })) : [];
    if (!l.drums) notes = mapToKey(notes, baseKey, key);
    const locked = l.lock && !l.regen;
    if (!locked) {
      let fill = null;
      if (l.category === 'drums') {
        if (section === 'build' && !(l.material.build && base === l.material.build)) fill = 'build';
        else if (peek !== section || (state.sectionPhrase + (firstOfSection ? 0 : 1)) % 2 === 1) fill = section === 'build' ? null : 'fill';
      }
      notes = varyNotes(notes, { drums: l.drums, category: l.category, mutate: l.regen ? Math.max(l.mutate, 0.2) : l.mutate, density: l.density, rng: lrng, length: P, bpb, key, fill });
    } else notes = notes.map(cleanNote);
    // impacts: one hit at the top of the section
    if (l.category === 'impact') notes = notes.filter((n) => n.start < bpb - EPS);
    out[l.id] = { active: active.has(l.id), notes };
    if (pivot && !l.drums && l.category !== 'impact' && cur && cur.length) {
      pivot[l.id] = pivotBar(cur, { length: P, barStart: P - bpb, toKey: key, bass: l.category === 'bass' });
    }
    l.regen = false; l.fresh = null;
    l.lastSection = section; l.lastNotes = notes; l.lastKey = { ...key };
  }
  state.index = index;
  state.sectionPhrase = firstOfSection ? 0 : state.sectionPhrase + 1;
  state.section = section;
  state.arcIndex = arcIndex;
  state.queued = null;
  state.key = { ...key };
  const plan = { index, section, key: { ...key }, prevKey, keyChanged, layers: out, pivot, start: index * P, length: P, firstOfSection };
  state.history.push({ index, section, key: { ...key }, start: index * P });
  if (state.history.length > 512) state.history.shift();
  return plan;
}

/** Filter-sweep automation points for a build phrase [a, b) on a low-pass whose resting cutoff is `rest`. */
export function buildSweepPoints(a, b, rest = 2000, from = 350) {
  const to = Math.max(rest, 2000);
  return [
    { beat: Math.max(0, a - 0.01), value: rest }, { beat: a, value: from },
    { beat: a + (b - a) * 0.7, value: Math.round(Math.sqrt(from * to)) }, { beat: b - 0.02, value: to }, { beat: b, value: rest },
  ];
}
