// The project data model. Everything in a project is plain JSON so it can be
// saved, reloaded, diffed and undone. See docs/ARCHITECTURE.md for the contract.
import { uid } from './util.js';

export const PROJECT_FORMAT = 'heroic-daw-project';
export const PROJECT_VERSION = 1;

export const TRACK_COLORS = [
  '#ff5f6d', '#ffa94d', '#ffd43b', '#a9e34b', '#38d9a9', '#3bc9db',
  '#4dabf7', '#748ffc', '#9775fa', '#da77f2', '#f783ac', '#ced4da',
];

/** General-MIDI-style drum map used by every drum kit (pad index -> pitch). */
export const DRUM_PADS = [
  { pitch: 36, key: 'kick', name: 'Kick', short: 'bd' },
  { pitch: 38, key: 'snare', name: 'Snare', short: 'sd' },
  { pitch: 39, key: 'clap', name: 'Clap', short: 'cp' },
  { pitch: 37, key: 'rim', name: 'Rim', short: 'rim' },
  { pitch: 42, key: 'hihat', name: 'Closed Hat', short: 'hh' },
  { pitch: 46, key: 'openhat', name: 'Open Hat', short: 'oh' },
  { pitch: 45, key: 'tomlow', name: 'Low Tom', short: 'lt' },
  { pitch: 47, key: 'tommid', name: 'Mid Tom', short: 'mt' },
  { pitch: 50, key: 'tomhigh', name: 'High Tom', short: 'ht' },
  { pitch: 49, key: 'crash', name: 'Crash', short: 'cr' },
  { pitch: 51, key: 'ride', name: 'Ride', short: 'rd' },
  { pitch: 56, key: 'cowbell', name: 'Cowbell', short: 'cb' },
  { pitch: 54, key: 'tambourine', name: 'Tambourine', short: 'tb' },
  { pitch: 70, key: 'shaker', name: 'Shaker', short: 'sh' },
  { pitch: 63, key: 'conga', name: 'Conga', short: 'perc' },
  { pitch: 75, key: 'clave', name: 'Clave', short: 'cl' },
];
export const DRUM_PITCH = Object.fromEntries(DRUM_PADS.map((p) => [p.key, p.pitch]));

export function createNote(pitch, start, dur = 0.25, vel = 0.8) {
  return { id: uid('n'), pitch, start, dur, vel };
}

export function createPattern(trackId, opts = {}) {
  return {
    id: uid('pat'),
    trackId,
    name: opts.name || 'Pattern',
    length: opts.length || 4, // beats
    notes: opts.notes || [],
    color: opts.color || null,
  };
}

/**
 * instrument: { type, preset, params }
 *   type ∈ 'synth' | 'fm' | 'organ' | 'drums' | 'sampler'
 *   params are owned by the audio module (INSTRUMENT_DEFS) — missing keys use defaults.
 */
export function createTrack(opts = {}) {
  const type = opts.type || 'instrument';
  return {
    id: uid('trk'),
    name: opts.name || 'Track',
    type, // 'instrument' | 'audio' | 'code'
    color: opts.color || TRACK_COLORS[Math.floor(Math.random() * TRACK_COLORS.length)],
    volume: opts.volume ?? 0.8, // linear gain 0..1.5
    pan: opts.pan ?? 0, // -1..1
    mute: false,
    solo: false,
    arm: false,
    fx: opts.fx || [], // [Effect]
    sends: opts.sends || {}, // { busId: 0..1 }
    instrument: type === 'instrument' ? (opts.instrument || { type: 'synth', preset: null, params: {} }) : null,
    code: type === 'code' ? (opts.code ?? 'note("c3 eb3 g3 bb3").s("sawtooth").lpf(1200)') : undefined,
    activePatternId: null,
    role: opts.role || null, // optional hint for generators/assistant: 'drums'|'bass'|'chords'|'lead'|'pad'|'arp'|'fx'|'vocal'
  };
}

export function createEffect(type, params = {}) {
  return { id: uid('fx'), type, enabled: true, params };
}

export function createClip(trackId, opts = {}) {
  return {
    id: uid('clip'),
    trackId,
    type: opts.type || 'pattern', // 'pattern' | 'audio'
    patternId: opts.patternId || null,
    sampleId: opts.sampleId || null,
    start: opts.start ?? 0, // beats
    length: opts.length ?? 4, // beats
    offset: opts.offset ?? 0, // beats into the pattern / sample
    gain: opts.gain ?? 1,
    name: opts.name || null,
  };
}

export function createBus(name, fx = []) {
  return { id: uid('bus'), name, volume: 0.8, pan: 0, mute: false, fx };
}

export function createScene(name, slots = {}) {
  return { id: uid('scn'), name, slots }; // slots: { trackId: patternId }
}

export function createProject(opts = {}) {
  const reverb = createBus('Reverb', [createEffect('reverb', { mix: 1, decay: 2.8 })]);
  const delay = createBus('Delay', [createEffect('delay', { mix: 1, time: 0.375, feedback: 0.4, pingpong: 1 })]);
  const now = new Date().toISOString();
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: opts.name || 'Untitled Project',
    bpm: opts.bpm || 120,
    timeSig: [4, 4],
    swing: 0, // 0..1, applied to off-beat 16ths
    key: { root: 0, scale: 'minor' }, // root: pitch class 0..11
    genre: opts.genre || null,
    mode: 'pattern', // 'pattern' (loop active patterns) | 'song' (play arrangement)
    loop: { enabled: true, start: 0, end: 16 },
    metronome: false,
    tracks: [],
    patterns: {}, // id -> Pattern
    clips: [], // arrangement clips
    scenes: [createScene('Scene 1')],
    buses: [reverb, delay],
    master: { volume: 0.9, fx: [createEffect('limiter', { threshold: -1 })] },
    samples: {}, // id -> { id, name, mime, data(base64), duration }
    markers: [], // [{ id, beat, name }] — arrangement section markers
    createdAt: now,
    modifiedAt: now,
  };
}

/** Bring older / partial project JSON up to the current shape. Never throws on missing keys. */
export function normalizeProject(p) {
  const base = createProject();
  const out = { ...base, ...p };
  out.format = PROJECT_FORMAT;
  out.version = PROJECT_VERSION;
  out.timeSig = Array.isArray(p.timeSig) ? p.timeSig : base.timeSig;
  out.key = { ...base.key, ...(p.key || {}) };
  out.loop = { ...base.loop, ...(p.loop || {}) };
  out.master = { ...base.master, ...(p.master || {}) };
  out.tracks = (p.tracks || []).map((t) => ({ ...createTrack({ type: t.type }), ...t, fx: t.fx || [], sends: t.sends || {} }));
  out.patterns = p.patterns || {};
  out.clips = p.clips || [];
  out.scenes = p.scenes?.length ? p.scenes : base.scenes;
  out.buses = p.buses || base.buses;
  out.samples = p.samples || {};
  out.markers = p.markers || [];
  return out;
}

export const beatsPerBar = (project) => project.timeSig[0] * (4 / project.timeSig[1]);
export const secondsPerBeat = (project) => 60 / project.bpm;

/** Song length in beats: end of last clip, rounded up to a whole bar (min 1 bar). */
export function songLengthBeats(project) {
  const bpb = beatsPerBar(project);
  const end = project.clips.reduce((m, c) => Math.max(m, c.start + c.length), 0);
  return Math.max(bpb, Math.ceil(end / bpb) * bpb);
}

export function patternsForTrack(project, trackId) {
  return Object.values(project.patterns).filter((p) => p.trackId === trackId);
}
