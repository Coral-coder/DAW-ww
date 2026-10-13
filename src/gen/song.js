// Full-song generator: builds tracks, per-section pattern variations, arrangement clips, scenes and markers
// using only the model factories from src/core/model.js.
import { createRng, uid, clamp } from '../core/util.js';
import { PRESETS } from '../audio/presets.js';
import { createTrack, createPattern, createClip, createScene, createNote, TRACK_COLORS } from '../core/model.js';
import { parsePitchClass, resolveScaleId, mod12, getProgression, pitchClassName, keyPrefersFlats } from '../theory/index.js';
import { GENRES, getGenre, ROLES } from './genres.js';
import { generateDrumPattern } from './drums.js';
import { generateProgression, progressionToNotes, pickGenreProgression, progressionBars, resolveKey } from './harmony.js';
import { generateBassline } from './bass.js';
import { generateMelody, generateCounterMelody } from './melody.js';
import { arpeggiate } from './arp.js';
import { progressionFromProject } from './analyze.js';

const ROLE_INFO = {
  drums: { name: 'Drums', color: TRACK_COLORS[0], volume: 0.85, pan: 0 },
  bass: { name: 'Bass', color: TRACK_COLORS[1], volume: 0.8, pan: 0 },
  chords: { name: 'Chords', color: TRACK_COLORS[6], volume: 0.62, pan: -0.15 },
  pad: { name: 'Pad', color: TRACK_COLORS[8], volume: 0.5, pan: 0.1 },
  lead: { name: 'Lead', color: TRACK_COLORS[3], volume: 0.68, pan: 0 },
  arp: { name: 'Arp', color: TRACK_COLORS[5], volume: 0.48, pan: 0.3 },
  fx: { name: 'FX', color: TRACK_COLORS[10], volume: 0.42, pan: 0 },
};

const BAND_FAMILIES = new Set(['rock', 'funk', 'jazz', 'blues', 'soul', 'caribbean', 'latin', 'americana', 'pop', 'african', 'retro', 'hiphop']);

/** Map a section name to an arrangement function. */
export function sectionKind(name = '') {
  const n = name.toLowerCase();
  if (/intro/.test(n)) return 'intro';
  if (/outro|fade out|ending/.test(n)) return 'outro';
  if (/build|pre|rise|lift/.test(n)) return 'build';
  if (/break|bridge|reflection|fade|calm/.test(n)) return 'break';
  if (/drop|chorus|hook|peak|climax|finale|bloom|^b$|solo/.test(n)) return 'main';
  return 'verse';
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
      const style = kind === 'intro' || kind === 'outro' ? (['808', 'sub', 'drill'].includes(g.bassStyle) ? g.bassStyle : 'root') : g.bassStyle;
      return generateBassline({ progression, style, key: root, scale, rng, beatsPerBar: bpb, length, density: 0.5 + e * 0.5, kickNotes: opts.kickNotes });
    }
    case 'chords': {
      const style = kind === 'intro' || kind === 'break' || kind === 'outro' ? (g.chordStyle === 'power' ? 'whole' : 'whole') : g.chordStyle;
      return progressionToNotes(progression, { style, rng, beatsPerBar: bpb, length, vel: 0.6 + e * 0.2 });
    }
    case 'pad': {
      const padProg = progression.map((c) => ({ ...c, notes: c.notes.map((n) => (n < 60 ? n + 12 : n)) }));
      return progressionToNotes(padProg, { style: 'whole', rng, beatsPerBar: bpb, length, vel: 0.5 + e * 0.15 });
    }
    case 'lead': {
      const style = opts.melodyStyle || (kind === 'break' ? 'sparse' : kind === 'verse' ? (g.melodyStyle === 'riff' ? 'riff' : 'vocal') : g.melodyStyle);
      return generateMelody({ progression, key: root, scale, style, rng, beatsPerBar: bpb, length, density: 0.35 + e * 0.5 });
    }
    case 'counter':
      return generateCounterMelody({ melody: opts.melody || [], progression, key: root, scale, rng, beatsPerBar: bpb, length, density: e });
    case 'arp': {
      const a = g.arp || {};
      const voiced = progression.map((c) => ({ ...c, notes: c.notes.map((n) => n + 12) }));
      return arpeggiate(voiced, { mode: a.mode || 'up', rate: kind === 'build' ? 0.25 : a.rate || 0.25, octaves: a.octaves || 1, gate: 0.6, rng, vel: 0.55 + e * 0.2 });
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
  const notes = generateRoleNotes(role, { genre: opts.genre, key: root, scale, progression, bars, beatsPerBar: bpb, energy: opts.energy ?? 0.85, kind: 'main', rng, kickNotes });
  return notes.filter((n) => n.start < length);
}

/**
 * generateSong({genre, key (pc | {root,scale} | 'F#'), scale, bpm, seed, name, progression}) -> partial project
 * {name, bpm, swing, key, genre, timeSig, tracks, patterns, clips, scenes, markers, loop, seed, progression}
 */
export function generateSong(opts = {}) {
  const g = getGenre(opts.genre) || GENRES.house;
  const seed = opts.seed ?? Math.floor(Math.random() * 1e9);
  const rng = createRng(seed);
  // key
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

  // harmony: one loop for the whole song (sections re-voice/re-rhythm it)
  const prog = opts.progression ? getProgression(opts.progression) : pickGenreProgression({ genre: g.id, scale, rng });
  let loopBars = prog ? Math.ceil(progressionBars(prog)) : 4;
  if (loopBars < 4) loopBars = 4;
  else if (loopBars > 4 && loopBars < 8) loopBars = 8;
  const progression = generateProgression({ key: root, scale, genre: g.id, bars: loopBars, beatsPerBar: bpb, rng, progression: prog ? prog.id || prog.romans : undefined });
  const loopBeats = loopBars * bpb;
  // drums use 8-bar phrases (fill at the phrase end) unless the harmonic loop is longer (12-bar blues -> 4-bar)
  const drumBars = loopBars > 8 ? 4 : 8;

  // tracks for every role used by the structure (and supported by the genre's palette)
  const used = new Set(g.structure.flatMap((s) => s.roles));
  const roles = ROLES.filter((r) => used.has(r) && (r === 'drums' || g.presets?.[r]));
  const tracks = roles.map((role) => {
    const info = ROLE_INFO[role];
    return createTrack({
      name: info.name, color: info.color, volume: info.volume, pan: info.pan, role,
      instrument: instrumentFor(role, g), sends: {},
    });
  });

  const patterns = {};
  const clips = [];
  const scenes = [];
  const markers = [];
  const cache = new Map(); // `${role}|${sectionName}` -> pattern
  const nameCount = {};
  let beat = 0;
  let best = { energy: -1, section: null };
  const sectionPatterns = [];

  for (const section of g.structure) {
    const kind = sectionKind(section.name);
    nameCount[section.name] = (nameCount[section.name] || 0) + 1;
    const label = nameCount[section.name] > 1 ? `${section.name} ${nameCount[section.name]}` : section.name;
    const slots = {};
    const secRng = createRng((seed + section.name.length * 7919 + Math.round(section.energy * 1000)) >>> 0);
    let kick = null;
    for (const role of roles) {
      if (!section.roles.includes(role)) continue;
      const track = tracks[roles.indexOf(role)];
      const key = `${role}|${section.name}|${Math.round(section.energy * 10)}`;
      let pat = cache.get(key);
      if (!pat) {
        const bars = role === 'drums' ? drumBars : loopBars;
        const notes = generateRoleNotes(role, {
          genre: g.id, key: root, scale, progression: role === 'drums' ? undefined : progression, bars: role === 'drums' ? drumBars : loopBars,
          beatsPerBar: bpb, energy: section.energy, kind, rng: secRng, kickNotes: role === 'bass' ? kick : undefined,
        });
        let pname = `${ROLE_INFO[role].name} – ${section.name}`;
        // the same section can recur at another energy (A / B / A'): keep pattern names unique per track
        for (let k = 2; Object.values(patterns).some((x) => x.trackId === track.id && x.name === pname); k++) pname = `${ROLE_INFO[role].name} – ${section.name} ${k}`;
        pat = createPattern(track.id, { name: pname, length: bars * bpb, notes: notes.filter((n) => n.start < bars * bpb), color: track.color });
        patterns[pat.id] = pat;
        cache.set(key, pat);
      }
      if (role === 'drums') {
        // bass locks to the kick (looped over the harmonic loop)
        kick = [];
        for (let off = 0; off < loopBeats; off += pat.length) for (const n of pat.notes) if (n.pitch === 36) kick.push(off + n.start);
      }
      slots[track.id] = pat.id;
      clips.push(createClip(track.id, { patternId: pat.id, start: beat, length: section.bars * bpb, name: label }));
    }
    markers.push({ id: uid('mk'), beat, name: label });
    scenes.push(createScene(label, slots));
    sectionPatterns.push({ section, slots, start: beat });
    if (section.energy > best.energy) best = { energy: section.energy, section, slots, start: beat };
    beat += section.bars * bpb;
  }

  // active patterns: the most energetic section where the track plays, else its first pattern
  for (const t of tracks) {
    const top = sectionPatterns.filter((s) => s.slots[t.id]).sort((a, b) => b.section.energy - a.section.energy)[0];
    t.activePatternId = top ? top.slots[t.id] : null;
  }
  const keyName = pitchClassName(root, keyPrefersFlats(root, scale));
  return {
    name: opts.name || `${g.name} in ${keyName}`,
    bpm,
    swing: g.swing || 0,
    key: { root, scale },
    genre: g.id,
    timeSig: [...timeSig],
    tracks,
    patterns,
    clips,
    scenes,
    markers,
    loop: { enabled: true, start: best.start || 0, end: (best.start || 0) + loopBeats },
    seed,
    progression: progression.map((c) => c.roman),
  };
}
