// Full-song generator: builds tracks, per-section pattern variations, arrangement clips, scenes and markers
// using only the model factories from src/core/model.js.
import { createRng, uid, clamp } from '../core/util.js';
import { PRESETS } from '../audio/presets.js';
import { createTrack, createPattern, createClip, createScene, createNote, TRACK_COLORS } from '../core/model.js';
import { parsePitchClass, resolveScaleId, mod12, getProgression, pitchClassName, keyPrefersFlats, keyPitchClasses } from '../theory/index.js';
import { GENRES, getGenre, ROLES } from './genres.js';
import { generateDrumPattern } from './drums.js';
import { generateProgression, progressionToNotes, pickGenreProgression, progressionBars, resolveKey } from './harmony.js';
import { generateBassline } from './bass.js';
import { generateMelody, generateCounterMelody, MELODY_STYLES } from './melody.js';
import { arpeggiate, arpFigures } from './arp.js';
import { padPart } from './harmony.js';
import { varyPart } from './monotony.js';
import { voiceChord } from '../theory/index.js';
import { progressionFromProject } from './analyze.js';
import { sectionKind, planSections, planSectionHarmony, filterSweepPoints, AutomationBuilder } from './arrange.js';
import { resolveStructure } from './form.js';
import { applyGroove, shapeDynamics, grooveFor } from './groove.js';
import { instrumentForRole, strumFor } from './sound.js';
import { finishSong } from './production.js';
import { mixTrack, createSongBuses, createSongMaster } from './mix.js';
import { writeMelody, makeMotif, varyMotif } from './melody.js';
import { DRUM_STYLES, resolveDrumStyle } from './drums.js';
import { createEffect } from '../core/model.js';
import { addRides } from './rides.js';
import { buildGenMeta } from './livemeta.js';

const ROLE_INFO = {
  drums: { name: 'Drums', color: TRACK_COLORS[0], volume: 0.85, pan: 0 },
  bass: { name: 'Bass', color: TRACK_COLORS[1], volume: 0.8, pan: 0 },
  chords: { name: 'Chords', color: TRACK_COLORS[6], volume: 0.62, pan: -0.15 },
  pad: { name: 'Pad', color: TRACK_COLORS[8], volume: 0.5, pan: 0.1 },
  lead: { name: 'Lead', color: TRACK_COLORS[3], volume: 0.68, pan: 0 },
  arp: { name: 'Arp', color: TRACK_COLORS[5], volume: 0.48, pan: 0.3 },
  fx: { name: 'FX', color: TRACK_COLORS[10], volume: 0.42, pan: 0 },
};

/** Register plan: pads voiced in [55, 74] (thirds clear of the low-register mud), leads from E4 up, above the pad. */
const PAD_RANGE = [55, 74];
const LEAD_FLOOR = 64;

const BAND_FAMILIES = new Set(['rock', 'funk', 'jazz', 'blues', 'soul', 'caribbean', 'latin', 'americana', 'pop', 'african', 'retro', 'hiphop']);
/** Chord parts re-voice along inversions inside this register (the low end stays clear of slash-bass territory). */
const CHORD_MOTION_RANGE = [50, 81];

/** Bass style for a section: intros / outros of band songs play roots (with a 5th / octave line); dance tracks keep their riff. */
function bassStyleFor(g, kind) {
  if (kind !== 'intro' && kind !== 'outro') return g.bassStyle;
  if (['808', 'sub', 'drill'].includes(g.bassStyle)) return g.bassStyle;
  const dance = ELECTRONIC.has(g.family) || ['psy', 'rolling', 'offbeat', 'acid', 'tech', 'hardstyle', 'house', 'deep', 'garage'].includes(g.bassStyle);
  return dance ? g.bassStyle : 'root';
}

function instrumentFor(role, genre) {
  if (role === 'drums') return { type: 'drums', preset: genre.drumKit, params: {} };
  const preset = genre.presets?.[role] || null;
  return { type: PRESETS[preset]?.instrument.type || 'synth', preset, params: {} };
}

/**
 * Generate notes for one role over a progression.
 * opts: {genre, key, scale, progression, bars, beatsPerBar, energy (0..1), kind ('intro'|'verse'|'build'|'main'|'break'|'outro'),
 *        rng, kickNotes, melodyStyle}
 */
export function generateRoleNotes(role, opts) {
  const g = getGenre(opts.genre) || GENRES.house;
  const rng = opts.rng || createRng(opts.seed ?? 1);
  const bpb = opts.beatsPerBar || 4;
  const bars = opts.bars || 4;
  const length = bars * bpb;
  const e = clamp(opts.energy ?? 0.8, 0, 1);
  const kind = opts.kind || 'main';
  const { root, scale } = resolveKey({ key: opts.key, root: opts.root, scale: opts.scale, genre: g.id });
  const progression = opts.progression || generateProgression({ key: root, scale, genre: g.id, bars, beatsPerBar: bpb, rng });
  switch (role) {
    case 'drums': {
      const soft = kind === 'intro' || kind === 'outro' || kind === 'break';
      const band = BAND_FAMILIES.has(g.family);
      // a one-bar loop must not end in a fill (it would play the fill every bar)
      const fill = bars > 1 && (kind === 'build' || (e >= 0.5 && (bars >= 8 || band)));
      return generateDrumPattern({
        style: g.drumStyle, bars, rng, beatsPerBar: bpb, humanize: g.humanize || 0,
        density: soft ? Math.min(e + 0.1, kind === 'break' ? 0.3 : 0.45) : clamp(e, 0.3, 1),
        variation: 0.25 + e * 0.3, fill, fillType: band ? undefined : kind === 'build' ? 'build' : 'snare-roll',
        crash: kind === 'main' && e >= 0.9,
      });
    }
    case 'bass': {
      const style = bassStyleFor(g, kind);
      return generateBassline({ progression, style, key: root, scale, rng, beatsPerBar: bpb, length, density: 0.5 + e * 0.5, kickNotes: opts.kickNotes });
    }
    case 'chords': {
      const style = kind === 'intro' || kind === 'break' || kind === 'outro' ? (g.chordStyle === 'power' ? 'whole' : 'whole') : g.chordStyle;
      return progressionToNotes(progression, { style, rng, beatsPerBar: bpb, length, vel: 0.6 + e * 0.2, motion: true, motionRange: CHORD_MOTION_RANGE });
    }
    case 'pad':
      // pads get their own (thinner, 4-voice) voicing, voice-led, common tones tied, kept under the lead's register
      return padPart(progression, { range: PAD_RANGE, rng, length, vel: 0.5 + e * 0.15 });
    case 'lead': {
      const style = opts.melodyStyle || (kind === 'break' ? 'sparse' : kind === 'verse' ? (g.melodyStyle === 'riff' ? 'riff' : 'vocal') : g.melodyStyle);
      // the lead sits above the pad / chord bed by default
      const st = MELODY_STYLES[style] || MELODY_STYLES.lead;
      const range = [Math.max(st.range[0], LEAD_FLOOR), Math.max(st.range[1], LEAD_FLOOR + 17)];
      return generateMelody({ progression, key: root, scale, style, rng, beatsPerBar: bpb, length, density: 0.35 + e * 0.5, range, genre: g.id });
    }
    case 'counter':
      return generateCounterMelody({ melody: opts.melody || [], progression, key: root, scale, rng, beatsPerBar: bpb, length, density: e });
    case 'arp': {
      const a = g.arp || {};
      return arpFigures(progression, { mode: a.mode || 'up', rate: kind === 'build' ? 0.25 : a.rate || 0.25, beatsPerBar: bpb, length, lo: 60, hi: 96, gate: 0.6, rng, vel: 0.55 + e * 0.2 });
    }
    case 'fx': {
      if (kind === 'build') return [createNote(72, 0, length, 0.8)];
      return [createNote(60, 0, Math.min(bpb * 2, length), 0.6)];
    }
    default:
      return [];
  }
}

/**
 * Notes for a single part, as used by the UI's "generate part" actions.
 * generatePartNotes(role, {genre, key|root, scale, bars, beatsPerBar, rng, seed, project, energy}) -> Note[]
 * When `project` contains a chord part, new parts follow its harmony.
 */
export function generatePartNotes(role, opts = {}) {
  const rng = opts.rng || createRng(opts.seed ?? 1);
  const bpb = opts.beatsPerBar || 4;
  const bars = opts.bars || 4;
  const length = bars * bpb;
  const { root, scale } = resolveKey({ key: opts.key, root: opts.root, scale: opts.scale || opts.project?.key?.scale, genre: opts.genre });
  let progression = null;
  if (opts.project && role !== 'chords' && role !== 'drums') {
    const found = progressionFromProject(opts.project);
    if (found?.progression?.length) {
      // loop the detected progression to fill the requested length
      const srcLen = Math.max(found.pattern.length || 0, found.progression.reduce((m, c) => Math.max(m, c.startBeat + c.durBeats), 0));
      progression = [];
      for (let off = 0; off < length; off += srcLen) {
        for (const c of found.progression) if (off + c.startBeat < length) progression.push({ ...c, startBeat: off + c.startBeat, durBeats: Math.min(c.durBeats, length - off - c.startBeat) });
      }
    }
  }
  if (!progression) progression = generateProgression({ key: root, scale, genre: opts.genre, bars, beatsPerBar: bpb, rng });
  let kickNotes;
  if (role === 'bass' && opts.project) {
    const drums = (opts.project.tracks || []).find((t) => t.instrument?.type === 'drums' && t.activePatternId);
    const pat = drums && opts.project.patterns[drums.activePatternId];
    if (pat) {
      kickNotes = [];
      for (let off = 0; off < length; off += pat.length || length) for (const n of pat.notes) if (n.pitch === 36 && off + n.start < length) kickNotes.push(off + n.start);
    }
  }
  const notes = generateRoleNotes(role, { genre: opts.genre, key: root, scale, progression, bars, beatsPerBar: bpb, energy: opts.energy ?? 0.85, kind: 'main', rng, kickNotes }).filter((n) => n.start < length);
  // human feel (opts.groove === false keeps the grid): the genre's swing / micro-timing / accents
  if (opts.groove === false || role === 'fx') return notes;
  const g = getGenre(opts.genre);
  const style = role === 'drums' ? DRUM_STYLES[resolveDrumStyle(g?.drumStyle || opts.genre)] : null;
  return applyGroove(notes, { genre: opts.genre, role, bpm: opts.project?.bpm || g?.defaultBpm || 120, rng, length, tripletGrid: style?.grid === 12, energy: opts.energy ?? 0.85 });
}

// ---------------------------------------------------------------------------------------------------------------
// Full songs
// ---------------------------------------------------------------------------------------------------------------

/** Genres where a last-chorus key change is idiomatic. */
const MODULATING = new Set(['pop', 'kpop', 'gospel', 'country', 'rock', 'indie', 'synthwave', 'eurobeat', 'folk', 'rnb']);
const ELECTRONIC = new Set(['house', 'techno', 'trance', 'bass', 'dnb', 'garage', 'breaks', 'hard', 'experimental', 'industrial']);
const hash = (...xs) => xs.reduce((h, x) => (Math.imul(h ^ (typeof x === 'number' ? x : [...String(x)].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)), 2654435761) >>> 0), 0x9e3779b9);

/** Drum part for one section: 4-bar blocks with their own variations, phrase fills, transitions and crashes. */
function sectionDrums(g, s, ctx) {
  const { bpb, rng } = ctx;
  const band = BAND_FAMILIES.has(g.family) && !ELECTRONIC.has(g.family);
  const blockBars = s.bars % 4 === 0 || s.bars > 4 ? Math.min(4, s.bars) : s.bars;
  const nb = Math.ceil(s.bars / blockBars);
  const len = s.bars * bpb;
  const e = s.energy;
  const soft = s.kind === 'intro' || s.kind === 'outro' || s.kind === 'break';
  const density = soft ? Math.min(e + 0.1, s.kind === 'break' ? 0.3 : 0.45) : clamp(e, 0.3, 1);
  const nextMain = s.next && s.next.kind === 'main';
  const nextDrums = s.next && s.next.roles.includes('drums');
  const out = [];
  for (let i = 0; i < nb; i++) {
    const bars = Math.min(blockBars, s.bars - i * blockBars);
    const last = i === nb - 1;
    let fill = false, fillType;
    if (last && s.next && bars > 1) {
      fill = true;
      if (s.kind === 'build') fillType = 'build';
      else if (!nextDrums) fillType = 'break';
      else if (!band) fillType = nextMain && e >= 0.45 ? 'snare-roll' : 'break';
    } else if (!last && i % 2 === 1 && e >= 0.5 && bars > 1) {
      fill = band || rng.chance(0.6);
      if (!band) fillType = rng.chance(0.5) ? 'break' : 'snare-roll';
    }
    const crash = (i === 0 && (s.kind === 'main' || (band && s.prev && s.prev.roles.includes('drums')))) || (band && s.kind === 'main' && i % 2 === 0);
    const notes = generateDrumPattern({
      style: g.drumStyle, bars, rng, beatsPerBar: bpb, humanize: 0,
      // builds and long DJ intros ramp up block by block (percussion builds)
      density: s.kind === 'build' || (s.kind === 'intro' && nb >= 4) ? clamp(density + (i / nb) * 0.2, 0, 1) : density,
      variation: 0.2 + e * 0.35 + (i % 2) * 0.1, fill, fillType, crash: crash && e >= 0.45,
    });
    const off = i * blockBars * bpb;
    for (const n of notes) { n.start += off; out.push(n); }
  }
  // pre-drop gap: the last half beat of a build goes silent so the drop hits
  if (s.kind === 'build' && nextMain) return out.filter((n) => n.start < len - 0.5);
  return out;
}

/** The chords of [a, b) of a section's harmony, re-based to start at 0. */
function sliceHarmony(harmony, a, b) {
  const out = [];
  for (const c of harmony) {
    const s0 = Math.max(a, c.startBeat), s1 = Math.min(b, c.startBeat + c.durBeats);
    if (s1 - s0 > 1e-6) out.push({ ...c, startBeat: s0 - a, durBeats: s1 - s0 });
  }
  return out;
}

/** A bass walk-up / pickup into the next section's root on the last beat (band genres). */
function bassPickup(notes, len, nextRoot, key) {
  if (nextRoot == null) return notes;
  const keyPcs = new Set(key.pcs);
  const kept = notes.filter((n) => n.start < len - 1 + 1e-6 || n.start < len - 1);
  const before = kept.filter((n) => n.start < len - 1 - 1e-6);
  const last = before[before.length - 1];
  const ref = last ? last.pitch : nextRoot;
  let target = nextRoot;
  while (target - ref > 6) target -= 12;
  while (ref - target > 6) target += 12;
  const below = (p) => { let q = p - 1; while (!keyPcs.has(mod12(q))) q--; return q; };
  const s1 = below(target), s2 = below(s1);
  const out = before.map((n) => (n.start + n.dur > len - 1 ? { ...n, dur: Math.max(0.1, len - 1 - n.start - 0.02) } : n));
  const mk = (p, t, d, v) => { const x = createNote(p, t, d, v); return x; };
  if (target < 28) target += 12;
  out.push(mk(Math.max(28, s2), len - 0.5, 0.22, 0.72), mk(Math.max(28, s1), len - 0.25, 0.22, 0.78));
  return out;
}

/**
 * generateSong({genre, key (pc | {root,scale} | 'F#'), scale, bpm, seed, name, progression, withHarmony, soundfonts, sampledDrums,
 *               length: 'short'|'standard'|'extended'|'club', targetMinutes})
 *  -> partial project {name, bpm, swing, key, genre, timeSig, tracks, patterns, clips, scenes, markers, buses, master, loop, seed,
 *     progression, harmony? + harmonyLength? + patternHarmony? (withHarmony: the exact chords every pattern was written against)}
 * A produced arrangement: per-section progressions (verse / chorus / pre-chorus / bridge), a motif-based lead with a
 * distinct chorus hook, section-length patterns that vary every 4–8 bars (fills, drop-outs, crashes), genre groove
 * (swing, micro-timing, ghost notes, strums, dynamics), filter / fade automation, genre sounds (sampled drum
 * machines, SoundFonts for acoustic genres) and a mix (gain staging, EQ, compression, sidechain, sends, buses).
 */
export function generateSong(opts = {}) {
  const g = getGenre(opts.genre) || GENRES.house;
  const seed = opts.seed ?? Math.floor(Math.random() * 1e9);
  const rng = createRng(seed);
  let root = null;
  if (typeof opts.key === 'number') root = mod12(opts.key);
  else if (opts.key && typeof opts.key === 'object') root = mod12(opts.key.root ?? 0);
  else if (typeof opts.key === 'string') root = parsePitchClass(opts.key);
  else if (typeof opts.root === 'number') root = mod12(opts.root);
  if (root == null) root = g.keys ? rng.pick(g.keys) : rng.int(0, 11);
  const scale = resolveScaleId(opts.scale || opts.key?.scale || rng.pick(g.scales));
  const bpm = Math.round(opts.bpm || g.defaultBpm);
  const timeSig = g.timeSig || [4, 4];
  const bpb = timeSig[0] * (4 / timeSig[1]);
  const key = { root, scale };

  // ---- harmony: the chorus/drop loop + per-section progressions
  const prog = opts.progression ? getProgression(opts.progression) : pickGenreProgression({ genre: g.id, scale, rng });
  let loopBars = prog ? Math.ceil(progressionBars(prog)) : 4;
  if (loopBars < 4) loopBars = 4;
  else if (loopBars > 4 && loopBars < 8) loopBars = 8;
  let mainId = prog ? prog.id || prog.romans : undefined;
  let mainLoop = generateProgression({ key: root, scale, genre: g.id, bars: loopBars, beatsPerBar: bpb, rng, progression: mainId });
  let loopBeats = loopBars * bpb;

  // the form: the genre's standard structure, or one fitted to the requested length (short / extended / club / minutes)
  const structure = resolveStructure(g, { length: opts.length, targetMinutes: opts.targetMinutes, bpm });
  const used = new Set(structure.flatMap((s) => s.roles));
  const roles = ROLES.filter((r) => used.has(r) && (r === 'drums' || g.presets?.[r]));
  const sections = planSections(g, { bpb, available: new Set(roles), structure, evolve: !['jazz', 'blues', 'latin'].includes(g.family) });
  // key change: the last chorus (and what follows) goes up a half / whole step in pop / gospel / rock / country songs
  const mainsOfChorus = sections.filter((s) => s.type === 'chorus');
  const lastMain = mainsOfChorus[mainsOfChorus.length - 1];
  if (MODULATING.has(g.id) && mainsOfChorus.length >= 3 && lastMain.prev && lastMain.prev.kind !== 'main' && createRng(hash(seed, 'mod', g.id)).chance(0.5)) {
    const k = createRng(hash(seed, 'modk')).pick(g.id === 'country' || g.id === 'gospel' ? [1, 2] : [2, 1, 2]);
    for (const s of sections) if (s.index >= lastMain.index) s.modulation = k;
  }
  const hplan = planSectionHarmony({ genre: g, root, scale, rng: createRng(hash(seed, 'harm')), main: mainId || mainLoop.map((c) => c.roman), sections });
  // drone / vamp genres: the plan gives the drop / chorus loop its own movement (one-chord songs never happen)
  if (opts.progression) { delete hplan.main; hplan.chorus = mainId; }
  if (hplan.main) {
    mainId = hplan.main;
    loopBars = Math.max(4, Math.ceil(hplan.main.length / 4) * 4);
    mainLoop = generateProgression({ key: root, scale, genre: g.id, bars: loopBars, beatsPerBar: bpb, rng: createRng(hash(seed, 'main')), progression: mainId });
    loopBeats = loopBars * bpb;
  }
  const progCache = new Map();
  const progs = sections.map((s) => {
    const src = hplan[s.type] || mainId;
    // the chorus re-uses the main loop's exact colours; other sections are voiced / coloured on their own
    if (!hplan[s.type] || src === mainId) {
      const out = [];
      for (let off = 0; off < s.bars * bpb; off += loopBeats) for (const c of mainLoop) if (off + c.startBeat < s.bars * bpb) out.push({ ...c, startBeat: off + c.startBeat, durBeats: Math.min(c.durBeats, s.bars * bpb - off - c.startBeat) });
      return out;
    }
    // same type & length -> the same chords (deterministic), so repeats share one progression
    const ck = `${s.type}|${s.bars}`;
    if (!progCache.has(ck)) progCache.set(ck, generateProgression({ key: root, scale, genre: g.id, bars: s.bars, beatsPerBar: bpb, rng: createRng(hash(seed, s.type)), progression: src }));
    return progCache.get(ck);
  });
  const pcsOfKey = keyPitchClasses(root, scale);

  // ---- tracks: genre sounds + mix
  const [reverbBus, delayBus] = createSongBuses(g.id);
  const tracks = roles.map((role) => {
    const info = ROLE_INFO[role];
    const instrument = instrumentForRole(role, g.id, { soundfonts: opts.soundfonts, sampledDrums: opts.sampledDrums });
    return createTrack({ name: info.name, color: info.color, volume: info.volume, pan: info.pan, role, instrument, sends: {} });
  });
  const trackOf = (role) => tracks[roles.indexOf(role)];
  const drumTrack = trackOf('drums');
  const side = rng.chance(0.5) ? 1 : -1; // keys / guitars on one side, the arp answers on the other
  for (const t of tracks) {
    mixTrack(t, { genre: g.id, role: t.role, instrument: t.instrument, drumTrackId: drumTrack?.id, buses: [reverbBus, delayBus], side: t.role === 'chords' ? side : -side });
  }
  const groove = grooveFor(g.id);
  const tripletDrums = (DRUM_STYLES[resolveDrumStyle(g.drumStyle)]?.grid || 16) === 12;

  // ---- motifs: one idea per section type, re-used (with variation) whenever the section returns
  const melodyMode = ['riff', 'ambient'].includes(g.melodyStyle) ? 'classic' : 'motif';
  const mDensity = g.melodyStyle === 'sparse' ? 0.3 : g.melodyStyle === 'vocal' ? 0.55 : 0.65;
  const motifs = {
    verse: makeMotif({ rng: createRng(hash(seed, 'mv')), bpb, density: mDensity }),
    chorus: makeMotif({ rng: createRng(hash(seed, 'mc')), bpb, density: mDensity, hook: true }),
    bridge: makeMotif({ rng: createRng(hash(seed, 'mb')), bpb, density: mDensity * 0.8 }),
  };

  const patterns = {};
  const clips = [];
  const scenes = [];
  const markers = [];
  const patternHarmony = {};
  const auto = new Map(tracks.map((t) => [t.id, new AutomationBuilder()]));
  const filterFx = new Map(); // trackId -> filter effect (added on demand for sweeps)
  const ensureFilter = (t) => {
    if (!filterFx.has(t.id)) {
      const fx = createEffect('filter', { type: 'lowpass', cutoff: 20000, resonance: 1.1, slope: '12', depth: 0, mix: 1 });
      filterFx.set(t.id, fx);
      t.fx.unshift(fx);
    }
    return filterFx.get(t.id);
  };
  const sweep = (t, a, b, from, to) => auto.get(t.id).add(`fx:${ensureFilter(t).id}:cutoff`, filterSweepPoints(a, b, from, to));
  const sectionNotes = sections.map(() => ({}));
  const electronic = ELECTRONIC.has(g.family) || ['synthwave', 'kpop', 'pop', 'future-bass', 'chillwave', 'eurobeat'].includes(g.id);
  let best = { energy: -1, start: 0 };
  const sectionSlots = [];

  sections.forEach((s, si) => {
    const len = s.bars * bpb;
    const progression = progs[si];
    const srng = createRng(hash(seed, s.index, s.name));
    const slots = {};
    let kicks = [];
    const nextProg = progs[si + 1];
    const rise = s.next && s.next.energy > s.energy + 0.15 ? Math.min(2, s.bars) : 0;
    const fall = s.kind === 'outro' ? Math.min(4, s.bars) : 0;
    const mod = s.modulation || 0;
    const harmonyOut = progression.map((c) => ({
      startBeat: c.startBeat, durBeats: c.durBeats, roman: c.roman, root: mod12(c.chord.root + mod), type: c.chord.type,
      bass: c.chord.bass != null ? mod12(c.chord.bass + mod) : null, name: mod ? `${c.chord.name} (+${mod})` : c.chord.name,
    }));
    const harmonyKey = mod ? { root: mod12(root + mod), scale } : null;
    // layers that enter halfway through a long section (an arp / pad joining the groove) keep long sections evolving
    const half = Math.floor(s.bars / 2) * bpb;
    for (const role of roles) {
      const entering = !s.roles.includes(role) && (s.enter || []).includes(role);
      if (!s.roles.includes(role) && !entering) continue;
      const track = trackOf(role);
      const rrng = createRng(hash(seed, s.index, role));
      let notes = [];
      if (role === 'drums') {
        notes = sectionDrums(g, s, { bpb, rng: rrng });
        kicks = notes.filter((n) => n.pitch === 36).map((n) => n.start);
      } else if (role === 'bass') {
        const style = bassStyleFor(g, s.kind);
        notes = generateBassline({ progression, style, key: root, scale, rng: rrng, beatsPerBar: bpb, length: len, density: 0.45 + s.energy * 0.55, kickNotes: kicks.length ? kicks : undefined });
        const band = BAND_FAMILIES.has(g.family) && !['808', 'sub', 'drill', 'walking', 'blues', 'drone', 'reese'].includes(style);
        if (band && s.next?.roles.includes('bass') && nextProg?.length && s.kind !== 'build') {
          notes = bassPickup(notes, len, (nextProg[0].chord.bass ?? nextProg[0].chord.root) + ((s.next.modulation || 0) - (s.modulation || 0)), { pcs: pcsOfKey });
        }
        // later choruses: a few octave pops on short off-beat notes
        if (s.kind === 'main' && s.occurrence > 1) for (const n of notes) if (n.dur <= 0.5 && n.start % 1 !== 0 && rrng.chance(0.15) && n.pitch + 12 <= 55) n.pitch += 12;
      } else if (role === 'chords') {
        const calm = s.kind === 'break' || (ELECTRONIC.has(g.family) && (s.kind === 'intro' || s.kind === 'outro'));
        // jazz: the second solo chorus changes the comping (sustained behind the soloist)
        const varied = (g.family === 'jazz' || g.family === 'latin') && s.kind === 'main' && s.occurrence % 2 === 0;
        const style = calm || varied ? 'whole' : g.chordStyle;
        notes = progressionToNotes(progression, { style, rng: rrng, beatsPerBar: bpb, length: len, vel: 0.58 + s.energy * 0.22, motion: true, motionRange: CHORD_MOTION_RANGE });
      } else if (role === 'pad') {
        notes = padPart(progression, { range: PAD_RANGE, rng: createRng(hash(seed, 'pad', s.type)), length: len, vel: 0.5 + s.energy * 0.15 });
      } else if (role === 'lead') {
        if (melodyMode === 'classic' || s.name.toLowerCase() === 'solo') {
          notes = generateRoleNotes('lead', { genre: g.id, key: root, scale, progression, bars: s.bars, beatsPerBar: bpb, energy: s.energy, kind: s.kind, rng: rrng, melodyStyle: s.name.toLowerCase() === 'solo' ? 'lead' : undefined });
        } else {
          const chorusLike = s.kind === 'main';
          const breakLike = (s.kind === 'break' && s.type !== 'bridge') || s.kind === 'intro' || s.kind === 'outro';
          let motif = chorusLike ? motifs.chorus : s.type === 'bridge' ? motifs.bridge : breakLike ? motifs.chorus : motifs.verse;
          if (breakLike) motif = varyMotif(motif, 'augment', rrng);
          if (s.kind === 'build') motif = varyMotif(motifs.verse, 'fragment', rrng);
          const lo = LEAD_FLOOR;
          notes = writeMelody({
            progression, key: root, scale, motif, bpb, length: len, rng: rrng,
            plan: chorusLike ? 'hook' : breakLike ? 'sparse' : s.bars >= 8 ? 'verse' : 'short',
            range: [lo, chorusLike ? 90 : 86], center: chorusLike ? lo + 12 : lo + 8, variation: s.occurrence > 1 ? 0.8 : 0.3,
            blues: g.id === 'blues',
          });
        }
      } else if (role === 'arp') {
        notes = generateRoleNotes('arp', { genre: g.id, key: root, scale, progression, bars: s.bars, beatsPerBar: bpb, energy: s.energy * 0.85, kind: s.kind, rng: rrng });
      } else if (role === 'fx') {
        notes = generateRoleNotes('fx', { genre: g.id, key: root, scale, progression, bars: s.bars, beatsPerBar: bpb, energy: s.energy, kind: s.kind, rng: rrng });
      }
      notes = notes.filter((n) => n.start < len - 1e-6);
      // anti-monotony guard: a part that loops one tiny cell / sits on too few pitches is developed (inversions,
      // octave displacement, bass answers) before the groove is applied
      if (role !== 'drums' && role !== 'fx') varyPart(notes, { role, genre: g.id, progression, bpb, length: len, rng: createRng(hash(seed, s.index, role, 'vary')) });
      // trading 4s: the soloist plays four bars, the drums answer four bars
      if (role === 'lead' && /trad/i.test(s.name)) notes = notes.filter((n) => Math.floor(n.start / (4 * bpb)) % 2 === 0);
      const off = entering ? half : 0;
      const plen = len - off;
      // a sustained note that is still ringing at the entry point (a tied pad voice) re-enters with the layer
      if (entering) notes = notes.filter((n) => n.start >= off - 1e-6 || (role === 'pad' && n.start + n.dur - off >= 1)).map((n) => (n.start >= off - 1e-6 ? { ...n, start: n.start - off, dur: Math.min(n.dur, plen - (n.start - off)) } : { ...n, start: 0, dur: Math.min(n.start + n.dur - off, plen) }));
      // feel: groove (swing, micro-timing, ghosts, strums) and phrase dynamics
      if (role !== 'fx') {
        applyGroove(notes, { genre: g.id, groove, role, bpm, rng: rrng, length: plen, strum: strumFor(track.instrument), tripletGrid: role === 'drums' && tripletDrums, energy: s.energy });
        shapeDynamics(notes, { length: plen, bpb, energy: s.energy, rise, fall, role });
      }
      if (mod && role !== 'drums' && role !== 'fx') for (const n of notes) n.pitch += mod;
      if (!entering) sectionNotes[si][role] = notes;
      const pat = createPattern(track.id, { name: `${ROLE_INFO[role].name} – ${s.label}${entering ? ' (enters)' : ''}`, length: plen, notes: notes.map((n) => createNote(n.pitch, n.start, n.dur, n.vel)), color: track.color });
      patterns[pat.id] = pat;
      if (role !== 'drums' && role !== 'fx') patternHarmony[pat.id] = { harmony: entering ? sliceHarmony(harmonyOut, off, len) : harmonyOut, length: plen, ...(harmonyKey ? { key: harmonyKey } : {}) };
      slots[track.id] = pat.id;
      clips.push(createClip(track.id, { patternId: pat.id, start: s.start + off, length: plen, name: s.label }));
      // automation: filtered intros and rising filters through builds (electronic); a lifting filter in pre-choruses
      if (electronic && s.kind === 'intro' && (role === 'drums' || role === 'chords' || role === 'pad') && s.bars >= 4) sweep(track, s.start, s.start + len, role === 'drums' ? 380 : 500, 16000);
      if (s.kind === 'build' && ['chords', 'pad', 'arp'].includes(role)) sweep(track, s.start, s.start + len, electronic ? 450 : 1500, 17000);
    }
    markers.push({ id: uid('mk'), beat: s.start, name: s.label });
    scenes.push(createScene(s.label, slots));
    sectionSlots.push({ s, slots });
    if (s.energy > best.energy) best = { energy: s.energy, start: s.start };
  });

  // outro fade on loop-based genres; bands ring out on the last chord
  const songEnd = sections.reduce((m, s) => Math.max(m, s.start + s.bars * bpb), 0);
  const master = createSongMaster(g.id);
  const outro = sections[sections.length - 1];
  if (outro?.kind === 'outro' && (electronic || ['chill', 'ambient', 'retro', 'hiphop'].includes(g.family))) {
    const fadeBars = Math.min(8, outro.bars);
    master.automation.push({ id: uid('aut'), target: 'volume', enabled: true, points: [{ beat: songEnd - fadeBars * bpb, value: master.volume }, { beat: songEnd, value: 0 }] });
  }
  addRides({ genre: g, tracks, sections, bpb, auto, notesBy: (i, role) => sectionNotes[i]?.[role], buses: [reverbBus, delayBus], electronic, rng: createRng(hash(seed, 'rides')), ensureFilter });
  for (const t of tracks) t.automation = auto.get(t.id).lanes();
  for (const t of tracks) {
    const top = sectionSlots.filter((x) => x.slots[t.id]).sort((a, b) => b.s.energy - a.s.energy)[0];
    t.activePatternId = top ? top.slots[t.id] : null;
  }
  const keyName = pitchClassName(root, keyPrefersFlats(root, scale));
  const song = {
    name: opts.name || `${g.name} in ${keyName}`,
    bpm,
    swing: 0, // the groove (incl. swing) is baked into the notes
    key,
    genre: g.id,
    timeSig: [...timeSig],
    tracks,
    patterns,
    clips,
    scenes,
    markers,
    buses: [reverbBus, delayBus],
    master,
    loop: { enabled: true, start: best.start || 0, end: (best.start || 0) + loopBeats },
    seed,
    progression: mainLoop.map((c) => c.roman),
    sections: sections.map((s, i) => ({
      name: s.label, kind: s.kind, type: s.type, start: s.start, bars: s.bars, energy: s.energy, roles: [...s.roles], progression: [...new Set(progs[i].map((c) => c.roman))],
      ...(s.enter?.length ? { enter: [...s.enter] } : {}), ...(s.modulation ? { modulation: s.modulation } : {}),
    })),
    // compact intent (form, layers, chord symbols) for the live-coder song code (src/code/livecoder.js)
    genMeta: buildGenMeta({ sections, progs, bpb, key }),
    ...(opts.withHarmony ? {
      harmony: mainLoop.map((c) => ({ startBeat: c.startBeat, durBeats: c.durBeats, roman: c.roman, root: c.chord.root, type: c.chord.type, bass: c.chord.bass ?? null, name: c.chord.name })),
      harmonyLength: loopBeats,
      patternHarmony,
    } : {}),
  };
  // performance expression, sampled ranges, preset FX, layers, reverb space, mastering (src/gen/production.js)
  if (opts.production !== false) finishSong(song, { genre: g.id, seed });
  return song;
}

