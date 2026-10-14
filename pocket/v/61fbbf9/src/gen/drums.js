// Idiomatic drum-pattern generator. Output: Note[] with General-MIDI drum pitches (see DRUM_PADS).
import { createRng, clamp } from '../core/util.js';
import { DRUM_PITCH } from '../core/model.js';
import { getGenre } from './genres.js';
import { makeNote } from './note-util.js';

/** Euclidean rhythm: k hits spread over n steps, rotated right by `rotate`. -> boolean[] */
export function euclidean(k, n, rotate = 0) {
  n = Math.max(1, Math.floor(n));
  k = clamp(Math.floor(k), 0, n);
  const base = [];
  for (let i = 0; i < n; i++) base.push(((i * k) % n) < k);
  const r = ((Math.floor(rotate) % n) + n) % n;
  return base.map((_, i) => base[(i - r + n) % n]);
}

// Velocity alphabet used in the step strings below.
const VEL = { X: 1, x: 0.82, o: 0.62, '-': 0.45, g: 0.3 };

// Density threshold per pad: a lane plays when density >= threshold (override with "pad:0.5" keys).
const LANE_MIN = {
  kick: 0, snare: 0.22, clap: 0.22, rim: 0.45, hihat: 0.12, openhat: 0.4, tomlow: 0.55, tommid: 0.55, tomhigh: 0.55,
  crash: 0.6, ride: 0.35, cowbell: 0.45, tambourine: 0.5, shaker: 0.35, conga: 0.45, clave: 0.3,
};

const D = (name, lanes, o = {}) => ({ name, lanes, grid: 16, fill: 'toms', ...o });

/**
 * DRUM_STYLES {id: {name, grid (steps per 4/4 bar: 16 or 12 for triplet feels), lanes {pad[:minDensity]: steps},
 *   fill, engine?, alt?}}. Step strings may span several bars (length = grid * bars).
 * Velocity chars: X accent, x normal, o medium, - soft, g ghost, ? optional (density-dependent), . rest.
 */
export const DRUM_STYLES = {
  // ---- four-on-the-floor family ----
  house: D('House', {
    kick: 'X...X...X...X...', clap: '....X.......X...', openhat: '..x...x...x...x.', hihat: '.g.g.g.g.g.g.g.g',
    'shaker:0.6': 'xgogxgogxgogxgog', 'rim:0.7': '...........o..?.',
  }, { fill: 'build' }),
  'deep-house': D('Deep House', {
    kick: 'x...x...x...x...', clap: '....x.......x...', openhat: '..o...o...o...o.', shaker: 'gogxgogxgogxgogx',
    'rim:0.5': '...o......o..o..', 'conga:0.7': '......o.......g.',
  }, { fill: 'build' }),
  'tech-house': D('Tech House', {
    kick: 'X...X...X...X...', clap: '....X.......X...', openhat: '..x...x...x...x.', hihat: 'g.g.g.g.g.g.g.g.',
    'rim:0.4': '...x..x....x..x.', 'conga:0.6': '.......o.....o..', 'shaker:0.5': 'gxgxgxgxgxgxgxgx',
  }, { fill: 'build' }),
  techno: D('Techno', {
    kick: 'X...X...X...X...', 'clap:0.55': '....x.......x...', openhat: '..x...x...x...x.', hihat: 'gxg.gxg.gxg.gxg.',
    'rim:0.5': '...o......o..o..',
  }, { fill: 'build' }),
  minimal: D('Minimal', {
    kick: 'x...x...x...x...', 'rim:0.3': '..g..g...g..g...', hihat: '..o...o...o...o.', 'shaker:0.5': 'gg.gg.gggg.gg.g.',
    'clap:0.45': '....o.......o...',
  }, { fill: 'break' }),
  trance: D('Trance', {
    kick: 'X...X...X...X...', clap: '....X.......X...', openhat: '..X...X...X...X.', hihat: '.g.g.g.g.g.g.g.g',
  }, { fill: 'build' }),
  psytrance: D('Psytrance', {
    kick: 'X...X...X...X...', 'clap:0.5': '....o.......o...', openhat: '..x...x...x...x.', hihat: 'gx.xgx.xgx.xgx.x',
  }, { fill: 'build' }),
  progressive: D('Progressive House', {
    kick: 'X...X...X...X...', clap: '....X.......X...', openhat: '..x...x...x...x.', hihat: 'g.g.g.g.g.g.g.g.',
    'shaker:0.5': 'gogxgogxgogxgogx',
  }, { fill: 'build' }),
  eurobeat: D('Eurobeat', {
    kick: 'X...X...X...X...', snare: '....X.......X...', openhat: '..X...X...X...X.', hihat: 'gxg.gxg.gxg.gxg.',
    'clap:0.6': '....x.......x...',
  }, { fill: 'build' }),
  hardstyle: D('Hardstyle', {
    kick: 'X...X...X...X...', clap: '....X.......X...', openhat: '..x...x...x...x.', hihat: '.g.g.g.g.g.g.g.g',
  }, { fill: 'build' }),
  disco: D('Disco', {
    kick: 'x...x...x...x...', snare: '....X.......X...', openhat: '..X...X...X...X.', hihat: 'xg.gxg.gxg.gxg.g',
    'tambourine:0.5': 'g.x.g.x.g.x.g.x.', 'conga:0.7': '......o.o.....o.',
  }, { fill: 'toms' }),
  kpop: D('K-Pop', {
    kick: 'X...X...X...X.x.', clap: '....X.......X...', hihat: 'xgxgxgxgxgxgxgxg', 'openhat:0.6': '..o...o...o...o.',
    'snare:0.5': '....x.......x...',
  }, { fill: 'build' }),
  // ---- half-time / bass music ----
  dubstep: D('Dubstep', {
    kick: 'X.........x.....X.....x.......x.', snare: '........X...............X.......', hihat: 'x.o.x.o.x.o.x.o.x.o.x.o.x.o.x.o.',
    'clap:0.5': '........x...............x.......', 'openhat:0.7': '..............o...............o.',
  }, { fill: 'build' }),
  'future-bass': D('Future Bass', {
    kick: 'X.....x...x.....X.........x..x..', snare: '........X...............X.......', clap: '........x...............x.......',
    hihat: 'x.x.x.x.x.x.x.x.',
  }, { fill: 'build', engine: 'trap-hats', rollProb: 0.25 }),
  trap: D('Trap', {
    kick: 'X.........X.....', snare: '........X.......', clap: '........x.......', hihat: 'x.x.x.x.x.x.x.x.',
    'openhat:0.75': '..............o.',
  }, { fill: 'trap', engine: 'trap', rollProb: 0.35 }),
  drill: D('UK Drill', {
    kick: 'X.........x.......x...x.....x...', snare: '........X...............X..x....', hihat: 'x..x..x.x..x..x.',
    'rim:0.6': '......g.........g.....g.....g...',
  }, { fill: 'trap', engine: 'drill', grid: 16 }),
  phonk: D('Phonk', {
    kick: 'X.....x...x.....', snare: '........X.......', clap: '........X.......', hihat: 'x.x.x.x.x.x.x.x.',
    'cowbell:0.3': 'x..x..x...x..x..', 'openhat:0.7': '......o.........',
  }, { fill: 'trap', engine: 'trap-hats', rollProb: 0.3 }),
  rnb: D('R&B', {
    kick: 'X......x.x......', clap: '....X.......X...', hihat: 'x.x.x.x.x.x.x.x.', 'rim:0.5': '..........g...g.',
  }, { fill: 'trap', engine: 'trap-hats', rollProb: 0.15 }),
  footwork: D('Footwork', {
    kick: 'X..x..x..x..x.x.', clap: '........X.......', hihat: '.x.x.x.x.x.x.x.x', 'rim:0.6': 'x..x..x..x..x...',
    'snare:0.7': '....g.......g...',
  }, { fill: 'trap' }),
  // ---- breaks ----
  dnb: D('Drum & Bass', {
    kick: 'X.........X.....X.x.......X.....', snare: '....X.......X.......X.......X...', 'snare:0.6': '.......g.......g.........g....g.',
    hihat: 'x.x.x.x.x.x.x.x.', 'ride:0.75': '..x...x...x...x.', 'openhat:0.6': '..............o.',
  }, { fill: 'snare-roll' }),
  liquid: D('Liquid DnB', {
    kick: 'X.........X.....X.........X.....', snare: '....X.......X...', 'snare:0.6': '.........g......',
    hihat: 'x.o.x.o.x.o.x.oo', 'ride:0.8': '..o...o...o...o.', 'shaker:0.7': 'g.g.g.g.g.g.g.g.',
  }, { fill: 'snare-roll' }),
  jungle: D('Jungle (Amen)', {
    kick: 'X.X.......XX....', snare: '....X..X.X..X..X', hihat: 'x.x.x.x.x.x.x.x.', 'ride:0.6': 'x.x.x.x.x.x.x.x.',
  }, { fill: 'snare-roll', engine: 'amen' }),
  breakbeat: D('Breakbeat', {
    kick: 'X.x.......x.....', snare: '....X..g.g..X..g', hihat: 'x.x.x.x.x.x.x.x.', 'openhat:0.6': '..............o.',
  }, { fill: 'snare-roll', alt: { kick: 'X.x.......x..x..' } }),
  garage: D('UK Garage', {
    kick: 'X...X...X...X...', clap: '....X.......X...', hihat: '.x.x.x.x.x.x.x.x', 'openhat:0.5': '..o...o...o...o.',
    'rim:0.5': '...x.....x..x...', 'shaker:0.7': 'gggggggggggggggg',
  }, { fill: 'build' }),
  'two-step': D('2-Step', {
    kick: 'X.........X.....X......x..X.....', snare: '....X.......X...', hihat: '.g.x.g.x.g.x.g.x', 'rim:0.5': '...g..x.....g...',
    'openhat:0.7': '..............o.',
  }, { fill: 'break' }),
  // ---- hip-hop / chill ----
  'boom-bap': D('Boom Bap', {
    kick: 'X......x..x.....', snare: '....X.......X...', hihat: 'x.o.x.o.x.o.x.o.', 'openhat:0.75': '..............o.',
  }, { fill: 'break', alt: { kick: 'X.x.......x..x..' } }),
  lofi: D('Lo-fi', {
    kick: 'x......x..x.....', snare: '....o.......o..g', hihat: 'o.g.o.g.o.g.o.g.', 'shaker:0.6': 'g.g.g.g.g.g.g.g.',
    'rim:0.7': '..........g.....',
  }, { fill: 'break', alt: { kick: 'x.x.......x.....' } }),
  'neo-soul': D('Neo-Soul', {
    kick: 'X......x.x....x.', snare: '....X.......X...', 'snare:0.4': '.......g.g.....g', hihat: 'x.ox.ox.x.ox.ox.',
    'rim:0.7': '..g.........g...',
  }, { fill: 'break' }),
  pop: D('Pop', {
    kick: 'X.....x.X.......', snare: '....X.......X...', 'clap:0.5': '....x.......x...', hihat: 'x.x.x.x.x.x.x.x.',
    'shaker:0.6': 'gogogogogogogogo',
  }, { fill: 'toms', alt: { kick: 'X.....x.X.x.....' } }),
  synthwave: D('Synthwave', {
    kick: 'X.......X.......', snare: '....X.......X...', hihat: 'xgxgxgxgxgxgxgxg', 'openhat:0.7': '..............o.',
  }, { fill: 'toms', alt: { kick: 'X.......X.x.....' } }),
  chillwave: D('Chillwave', {
    kick: 'x.......x.x.....', snare: '....o.......o...', hihat: 'o.o.o.o.o.o.o.o.', shaker: 'g.g.g.g.g.g.g.g.',
  }, { fill: 'break' }),
  ambient: D('Ambient', {
    'kick:0.6': 'o...............', 'rim:0.3': '......g.......g.', 'shaker:0.2': 'g.g.g.g.g.g.g.g.', 'conga:0.5': '..........g.....',
  }, { fill: 'none' }),
  downtempo: D('Downtempo', {
    kick: 'X......x..x.....', snare: '....x.......x...', hihat: 'o.g.o.g.o.g.o.g.', 'shaker:0.5': 'gogogogogogogogo',
    'conga:0.6': '......o.....o.g.',
  }, { fill: 'break' }),
  'trip-hop': D('Trip-Hop', {
    kick: 'X......xX.......', snare: '....X.......X...', hihat: 'o.-.o.-.o.-.o.-.', 'openhat:0.6': '..............o.',
  }, { fill: 'break', alt: { kick: 'X.x....x..x.....' } }),
  idm: D('IDM', {}, { fill: 'none', engine: 'idm' }),
  glitch: D('Glitch', {}, { fill: 'none', engine: 'glitch' }),
  chiptune: D('Chiptune', {
    kick: 'X.......X.x.....', snare: '....X.......X...', hihat: 'x.x.x.x.x.x.x.x.',
  }, { fill: 'snare-roll' }),
  // ---- band ----
  rock: D('Rock', {
    kick: 'X.......X.x.....', snare: '....X.......X...', hihat: 'X.x.X.x.X.x.X.x.', 'ride:0.9': 'x.x.x.x.x.x.x.x.',
  }, { fill: 'toms', alt: { kick: 'X.....x.X.x.....' } }),
  punk: D('Punk (skate beat)', {
    kick: 'X...x...X...x...', snare: '..X...X...X...X.', hihat: 'x.x.x.x.x.x.x.x.',
  }, { fill: 'toms' }),
  metal: D('Metal', {
    kick: 'X.x.X.x.X.x.X.x.', 'kick:0.6': '.x.x.x.x.x.x.x.x', snare: '....X.......X...', 'ride:0.3': 'x...x...x...x...',
    'hihat:0.85': '..x...x...x...x.',
  }, { fill: 'toms' }),
  indie: D('Indie', {
    kick: 'X.....x.X.......', snare: '....X.......X...', hihat: 'x.x.x.x.x.x.x.x.', 'tambourine:0.5': '....x.......x...',
  }, { fill: 'toms' }),
  funk: D('Funk', {
    kick: 'X..x......x..x..', snare: '....X..g.g..X..g', hihat: 'xgxgxgxgxgxgxgxg', 'openhat:0.6': '..............o.',
  }, { fill: 'toms', engine: 'ghosts', alt: { kick: 'X.x.......x.....' } }),
  gospel: D('Gospel', {
    kick: 'X.....x.X.....x.', snare: '....X.......X...', 'snare:0.4': '.......g.g.....g', hihat: 'xgxgxgxgxgxgxgxg',
    'tambourine:0.6': '....x.......x...',
  }, { fill: 'toms', engine: 'ghosts' }),
  country: D('Country (train beat)', {
    kick: 'X.......X.......', snare: 'ggggXgggggggXggg', 'hihat:0.7': 'x.x.x.x.x.x.x.x.',
  }, { fill: 'toms' }),
  folk: D('Folk', {
    kick: 'X.......X.......', 'clap:0.3': '....x.......x...', tambourine: '....x.......x...', 'shaker:0.4': 'x.g.x.g.x.g.x.g.',
  }, { fill: 'break' }),
  // ---- swing / triplet feels (12 steps per bar) ----
  jazz: D('Jazz swing', {
    ride: 'X..x.gx..x.g', hihat: '...x.....x..', 'kick:0.4': 'g..g..g..g..',
  }, { grid: 12, fill: 'jazz', engine: 'jazz' }),
  blues: D('Blues shuffle', {
    kick: 'X.....x.....', snare: '...x.....x..', hihat: 'x.ox.ox.ox.o', 'ride:0.85': 'x.ox.ox.ox.o',
  }, { grid: 12, fill: 'toms' }),
  'one-drop': D('Reggae one-drop', {
    kick: '......X.....', rim: '......x.....', hihat: 'x.ox.ox.ox.o', 'openhat:0.7': '..........o.',
  }, { grid: 12, fill: 'toms' }),
  steppers: D('Dub steppers', {
    kick: 'X..X..X..X..', rim: '......x.....', hihat: 'x.ox.ox.ox.o', 'snare:0.75': '......x.....',
  }, { grid: 12, fill: 'toms' }),
  // ---- latin / caribbean / african ----
  dancehall: D('Dancehall', {
    kick: 'X.....x.....x...', clap: '....X.......X...', hihat: 'x.x.x.x.x.x.x.x.', 'rim:0.5': '...x......x.....',
  }, { fill: 'break' }),
  dembow: D('Reggaeton dembow', {
    kick: 'X...X...X...X...', snare: '...x..x....x..x.', hihat: 'x.x.x.x.x.x.x.x.', 'rim:0.6': '...g..g....g..g.',
    'openhat:0.75': '..............o.',
  }, { fill: 'break' }),
  afrobeat: D('Afrobeats', {
    kick: 'X......x..X.....', 'rim:0.3': '...x..x...x.x...', shaker: 'xgoxxgoxxgoxxgox', 'clap:0.5': '....x.......x...',
    'conga:0.45': '..o..o.o..o..o.o', 'openhat:0.75': '......o.......o.',
  }, { fill: 'latin' }),
  amapiano: D('Amapiano', {
    kick: 'x.......x.......', shaker: 'gxgxgxgxgxgxgxgx', 'rim:0.3': '...x..x....x..x.', clap: '....x.......x...',
    'openhat:0.4': '..o...o...o...o.', 'conga:0.6': '.....o.....o..o.',
  }, { fill: 'break', alt: { kick: 'x.......x.....x.' } }),
  bossa: D('Bossa nova', {
    kick: 'x..gx..gx..gx..g', rim: 'x.....x.....x.......x.....x.....', hihat: 'x.g.x.g.x.g.x.g.', 'shaker:0.5': 'gogogogogogogogo',
  }, { fill: 'break' }),
  salsa: D('Salsa (son clave 3-2)', {
    clave: 'x.....x.....x.......x...x.......', cowbell: 'X...x...X...x...', conga: 'g...x.g.g...g.oo',
    'kick:0.3': '......x.....x...', 'tomhigh:0.8': '...............x',
  }, { fill: 'latin' }),
  // ---- cinematic / industrial ----
  cinematic: D('Cinematic', {
    tomlow: 'X.....x.X.......', 'tommid:0.45': '...x.....x..x.x.', 'kick:0.5': 'X.......X.......', 'snare:0.75': '....x.......x...',
    'crash:0.9': 'x...............',
  }, { fill: 'cinematic' }),
  industrial: D('Industrial', {
    kick: 'X..x..x.X..x....', snare: '....X.......X...', clap: '....x.......x...', hihat: 'xgxgxgxgxgxgxgxg',
    'rim:0.5': '..x...x...x...x.',
  }, { fill: 'snare-roll' }),
};

// genre-only style ids map to existing patterns
const STYLE_ALIAS = { 'four-on-floor': 'house', 'two-step-garage': 'two-step', reggae: 'one-drop', dub: 'steppers', latin: 'salsa', reggaeton: 'dembow', 'drum-and-bass': 'dnb', orchestral: 'cinematic', 'hip-hop': 'boom-bap' };

export function resolveDrumStyle(styleOrGenre) {
  if (!styleOrGenre) return 'house';
  if (DRUM_STYLES[styleOrGenre]) return styleOrGenre;
  if (STYLE_ALIAS[styleOrGenre]) return STYLE_ALIAS[styleOrGenre];
  const g = getGenre(styleOrGenre);
  if (g && DRUM_STYLES[g.drumStyle]) return g.drumStyle;
  return 'house';
}

export function listDrumStyles() {
  return Object.entries(DRUM_STYLES).map(([id, s]) => ({ id, name: s.name }));
}

function parseLaneKey(key) {
  const [pad, min] = key.split(':');
  return { pad, min: min !== undefined ? Number(min) : (LANE_MIN[pad] ?? 0.3) };
}

/**
 * generateDrumPattern({genre | style, bars=4, density=0.7, variation=0.3, fill=false, crash=false,
 *   humanize=0, rng, seed, beatsPerBar=4, fillType}) -> Note[]
 */
export function generateDrumPattern(opts = {}) {
  const rng = opts.rng || createRng(opts.seed ?? 1);
  const styleId = resolveDrumStyle(opts.style || opts.genre);
  const style = DRUM_STYLES[styleId];
  const bars = Math.max(1, Math.round(opts.bars ?? 4));
  const density = clamp(opts.density ?? 0.7, 0, 1);
  const variation = clamp(opts.variation ?? 0.3, 0, 1);
  const bpb = opts.beatsPerBar || 4;
  const humanize = clamp(opts.humanize ?? 0, 0, 1);
  const length = bars * bpb;
  const grid = style.grid;
  const stepDur = 4 / grid; // beats per step (in 4/4 grid terms)
  const stepsPerBar = Math.round(bpb / stepDur);
  const hits = new Map(); // key `${pitch}@${start}` -> note
  const add = (pad, start, vel, dur = Math.min(0.25, stepDur)) => {
    const pitch = typeof pad === 'number' ? pad : DRUM_PITCH[pad];
    if (pitch == null || start < 0 || start >= length - 1e-6) return;
    const s = Math.round(start * 1000) / 1000;
    const key = `${pitch}@${s}`;
    const prev = hits.get(key);
    if (!prev || prev.vel < vel) hits.set(key, { pitch, start: s, dur, vel: clamp(vel, 0.05, 1) });
  };
  const remove = (pred) => { for (const [k, n] of hits) if (pred(n)) hits.delete(k); };

  const playLane = (pad, str, bar, laneScale = 1) => {
    const nBars = Math.max(1, Math.round(str.length / grid));
    const seg = str.slice((bar % nBars) * grid, (bar % nBars) * grid + grid);
    for (let i = 0; i < Math.min(seg.length, stepsPerBar); i++) {
      const ch = seg[i];
      if (ch === '.' || ch === ' ') continue;
      let vel;
      if (ch === '?') {
        if (!rng.chance(Math.max(0, density - 0.4))) continue;
        vel = 0.45;
      } else {
        vel = VEL[ch] ?? 0.8;
        // ghost notes thin out at low density
        if (ch === 'g' && density < 0.5 && rng.chance(0.6)) continue;
      }
      // accents get slightly softer at low density, intros feel calmer
      const dyn = 0.75 + 0.25 * density;
      add(pad, bar * bpb + i * stepDur, vel * dyn * laneScale);
    }
  };

  const engine = style.engine;
  if (engine === 'idm' || engine === 'glitch') {
    for (let b = 0; b < bars; b++) idmBar(b, add, rng, density, variation, bpb, engine === 'glitch');
  } else {
    // lanes
    const lanes = Object.entries(style.lanes).map(([k, v]) => ({ ...parseLaneKey(k), str: v }));
    const altLanes = style.alt ? Object.entries(style.alt).map(([k, v]) => ({ ...parseLaneKey(k), str: v })) : null;
    for (let b = 0; b < bars; b++) {
      const useAlt = altLanes && b % 2 === 1 && rng.chance(0.35 + variation * 0.65);
      for (const lane of lanes) {
        if (density < lane.min) continue;
        if (engine === 'trap' || engine === 'trap-hats' || engine === 'drill') {
          if (lane.pad === 'hihat') continue; // generated below
        }
        if (engine === 'amen' && (lane.pad === 'kick' || lane.pad === 'snare')) continue;
        const alt = useAlt ? altLanes.find((a) => a.pad === lane.pad) : null;
        playLane(lane.pad, alt ? alt.str : lane.str, b);
      }
      if (engine === 'trap' || engine === 'trap-hats') trapHats(b, add, rng, density, variation, style.rollProb ?? 0.3, bpb);
      if (engine === 'trap') trapKick(b, add, remove, rng, variation, bpb);
      if (engine === 'drill') drillHats(b, add, rng, density, variation, bpb);
      if (engine === 'amen') amenBar(b, add, rng, variation, bpb);
      if (engine === 'jazz') jazzComp(b, add, rng, density, variation, bpb);
      if (engine === 'ghosts') ghostNotes(b, add, rng, density, variation, bpb);
      // generic variation: small mutations on non-first bars
      if (b > 0 && engine !== 'jazz' && rng.chance(variation * 0.6)) mutateBar(b, add, remove, rng, style, bpb, stepDur);
    }
  }

  // fills
  if (opts.fill) {
    const type = opts.fillType || style.fill;
    applyFill(type, bars - 1, add, remove, rng, density, bpb, styleId, stepDur);
  }
  if (opts.crash) add('crash', 0, 0.9, 1);

  // Top-end discipline (per bar): only ONE continuous stream among hats / ride / shaker / tambourine, and a total
  // budget of top-end hits so the kit never turns into a wash. Trap-family hat rolls get a bigger hat budget.
  {
    const TOP = [DRUM_PITCH.hihat, DRUM_PITCH.ride, DRUM_PITCH.shaker, DRUM_PITCH.tambourine, DRUM_PITCH.openhat];
    const PRIORITY = [DRUM_PITCH.hihat, DRUM_PITCH.ride, DRUM_PITCH.shaker, DRUM_PITCH.tambourine]; // keep earlier ones
    const rolls = /trap|phonk|drill|footwork/.test(styleId);
    const budget = rolls ? 30 : 18;
    const barLen = bpb;
    const nBars = Math.ceil(length / barLen - 1e-9);
    for (let b = 0; b < nBars; b++) {
      const inBar = (n) => n.start >= b * barLen - 1e-6 && n.start < (b + 1) * barLen - 1e-6;
      const top = [...hits.entries()].filter(([, n]) => TOP.includes(n.pitch) && inBar(n));
      const count = (pitch) => top.filter(([, n]) => n.pitch === pitch).length;
      const streams = PRIORITY.filter((pitch) => count(pitch) >= 12);
      for (const pitch of streams.slice(1)) for (const [k, n] of top) if (n.pitch === pitch) hits.delete(k);
      let left = [...hits.entries()].filter(([, n]) => TOP.includes(n.pitch) && inBar(n));
      if (left.length > budget) {
        // trim the softest hits first, extra percussion before hats, never the open hats
        const rank = (n) => (n.pitch === DRUM_PITCH.openhat ? 9 : PRIORITY.indexOf(n.pitch) === 0 ? 1 : 0) + n.vel;
        left.sort((a, b2) => rank(a[1]) - rank(b2[1]));
        for (const [k] of left.slice(0, left.length - budget)) hits.delete(k);
      }
    }
  }

  // An open hat is choked by a closed hat on the same step: drop the closed one so the open hat rings.
  for (const n of [...hits.values()]) {
    if (n.pitch === DRUM_PITCH.openhat) hits.delete(`${DRUM_PITCH.hihat}@${n.start}`);
  }

  // humanize
  const out = [];
  for (const n of hits.values()) {
    let start = n.start;
    let vel = n.vel;
    if (humanize > 0) {
      start += (rng() - 0.5) * 0.03 * humanize;
      vel += (rng() - 0.5) * 0.16 * humanize;
      if (n.pitch === DRUM_PITCH.snare && styleId.match(/neo-soul|lofi|boom-bap|jazz/)) start += 0.012 * humanize; // lay back
    }
    const note = makeNote(n.pitch, clamp(start, 0, length - 0.01), n.dur, vel, length);
    if (note) out.push(note);
  }
  out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return out;
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

function trapHats(bar, add, rng, density, variation, rollProb, bpb) {
  const base = bar * bpb;
  const sixteenths = density > 0.65;
  for (let beat = 0; beat < bpb; beat++) {
    const t = base + beat;
    const roll = rng.chance(rollProb * (0.5 + variation)) && density > 0.3;
    if (roll) {
      const half = rng.chance(0.6) ? 0.5 : 0; // roll on the second half of the beat (more common)
      const subdiv = rng.pick([3, 4, 4, 6, 8]); // 16th triplets, 32nds, 32nd triplets, 64ths
      // first half normal
      if (half) { add('hihat', t, 0.8); if (sixteenths) add('hihat', t + 0.25, 0.5); }
      const len = 0.5;
      for (let k = 0; k < subdiv; k++) add('hihat', t + half + (k * len) / subdiv, 0.4 + 0.5 * (k / subdiv), len / subdiv);
      if (!half) { add('hihat', t + 0.5, 0.75); if (sixteenths) add('hihat', t + 0.75, 0.5); }
    } else {
      add('hihat', t, beat % 2 === 0 ? 0.85 : 0.75);
      if (sixteenths) add('hihat', t + 0.25, 0.45);
      add('hihat', t + 0.5, 0.65);
      if (sixteenths) add('hihat', t + 0.75, 0.45);
    }
  }
  if (rng.chance(0.25 * variation)) add('openhat', base + bpb - 0.5, 0.6);
}

const TRAP_KICKS = ['X.........X.....', 'X......x..X.....', 'X.....x...x..x..', 'X..x......X.....', 'X.x.......x...x.', 'X......x.x....x.'];

function trapKick(bar, add, remove, rng, variation, bpb) {
  if (bar === 0 || !rng.chance(0.4 + variation * 0.5)) return;
  const base = bar * bpb;
  remove((n) => n.pitch === DRUM_PITCH.kick && n.start >= base && n.start < base + bpb);
  const pat = rng.pick(TRAP_KICKS);
  for (let i = 0; i < Math.min(pat.length, bpb * 4); i++) if (pat[i] !== '.') add('kick', base + i * 0.25, VEL[pat[i]]);
}

function drillHats(bar, add, rng, density, variation, bpb) {
  const base = bar * bpb;
  // 3-3-2 / triplet-y skipping groups
  const groups = rng.chance(0.5) ? [0, 0.75, 1.5, 2, 2.75, 3.5] : [0, 0.75, 1.5, 2, 2.5, 3.25, 3.5];
  for (const g of groups) if (g < bpb) add('hihat', base + g, g % 1 === 0 ? 0.85 : 0.65);
  if (density > 0.6 && rng.chance(0.4 + variation * 0.4)) {
    // a triplet burst
    const at = rng.pick([1, 3]);
    for (let k = 0; k < 3; k++) add('hihat', base + at + k / 6, 0.5 + k * 0.12, 1 / 6);
  }
}

// The four-bar Amen break (16ths); chopped/rearranged with variation.
const AMEN = [
  { kick: [0, 2, 10, 11], snare: [4, 7, 9, 12, 15] },
  { kick: [0, 2, 10, 11], snare: [4, 7, 9, 12, 15] },
  { kick: [0, 2, 10], snare: [4, 7, 9, 14] },
  { kick: [2, 3, 10], snare: [1, 4, 7, 9, 14] },
];

function amenBar(bar, add, rng, variation, bpb) {
  const base = bar * bpb;
  const steps = bpb * 4;
  // build a per-step slice table, then optionally rearrange 4-step chunks (chopping)
  const slice = (srcBar, step) => ({
    kick: AMEN[srcBar].kick.includes(step), snare: AMEN[srcBar].snare.includes(step),
  });
  const order = [];
  for (let c = 0; c < steps / 4; c++) {
    if (bar > 0 && rng.chance(variation * 0.5)) order.push({ bar: rng.int(0, 3), chunk: rng.int(0, 3) });
    else order.push({ bar: bar % 4, chunk: c });
  }
  for (let c = 0; c < order.length; c++) {
    for (let s = 0; s < 4; s++) {
      const step = c * 4 + s;
      const sl = slice(order[c].bar, order[c].chunk * 4 + s);
      const t = base + step * 0.25;
      if (sl.kick) add('kick', t, 0.95);
      if (sl.snare) add('snare', t, (step % 8 === 4) ? 1 : 0.7);
    }
  }
  // occasional snare stutter
  if (rng.chance(variation * 0.4)) {
    const t = base + bpb - 0.5;
    for (let k = 0; k < 4; k++) add('snare', t + k * 0.125, 0.5 + k * 0.1, 0.125);
  }
}

function jazzComp(bar, add, rng, density, variation, bpb) {
  const base = bar * bpb;
  const trip = 1 / 3;
  for (let beat = 0; beat < bpb; beat++) {
    // snare "comping" on triplet partials
    if (rng.chance(0.18 + density * 0.2)) add('snare', base + beat + (rng.chance(0.6) ? 2 * trip : trip), 0.25 + rng() * 0.25);
  }
  if (rng.chance(0.15 + variation * 0.3)) add('kick', base + rng.int(0, bpb - 1) + 2 * trip, 0.7); // "bomb"
}

function ghostNotes(bar, add, rng, density, variation, bpb) {
  const base = bar * bpb;
  const candidates = [0.75, 1.75, 2.25, 2.75, 3.25, 3.75].filter((t) => t < bpb);
  for (const c of candidates) if (rng.chance(0.15 + 0.25 * variation) && density > 0.4) add('snare', base + c, 0.22 + rng() * 0.1);
}

function idmBar(bar, add, rng, density, variation, bpb, glitch) {
  const base = bar * bpb;
  const steps = bpb * 4;
  const kick = euclidean(rng.int(3, 5), steps, rng.int(0, 3));
  const snare = euclidean(rng.int(2, 3), steps, rng.int(3, 6));
  const hats = euclidean(rng.int(5, 11), steps, rng.int(0, 5));
  const percs = euclidean(rng.int(3, 7), steps, rng.int(0, 7));
  for (let i = 0; i < steps; i++) {
    const t = base + i * 0.25;
    if (kick[i]) add('kick', t, i === 0 ? 1 : 0.75);
    if (snare[i] && density > 0.25) add('snare', t, 0.8);
    if (hats[i] && density > 0.15) add('hihat', t, 0.4 + rng() * 0.4);
    if (percs[i] && density > 0.5) add(rng.pick(['rim', 'clave', 'conga', 'tomhigh']), t, 0.4 + rng() * 0.3);
    // ratchets / stutters
    if (rng.chance(0.06 + variation * (glitch ? 0.2 : 0.1))) {
      const n = rng.pick([2, 3, 4]);
      const pad = rng.pick(glitch ? ['snare', 'hihat', 'rim', 'clap'] : ['hihat', 'rim']);
      for (let k = 0; k < n; k++) add(pad, t + (k * 0.25) / n, 0.35 + 0.15 * k, 0.25 / n);
    }
  }
  if (glitch && rng.chance(0.3 + variation * 0.3)) {
    // stutter the last beat: repeat a 32nd snare/clap
    for (let k = 0; k < 8; k++) add(k % 2 ? 'clap' : 'snare', base + bpb - 1 + k * 0.125, 0.4 + k * 0.07, 0.125);
  }
}

function mutateBar(bar, add, remove, rng, style, bpb, stepDur) {
  const base = bar * bpb;
  const r = rng();
  if (style.grid !== 16) {
    if (r < 0.5) add('snare', base + bpb - 1 + 2 / 3, 0.3);
    return;
  }
  if (r < 0.3) {
    // extra syncopated kick
    const pos = rng.pick([0.75, 1.5, 2.5, 2.75, 3.5]);
    if (pos < bpb) add('kick', base + pos, 0.7);
  } else if (r < 0.55) {
    // ghost snare
    const pos = rng.pick([1.75, 2.25, 3.25, 3.75]);
    if (pos < bpb) add('snare', base + pos, 0.28);
  } else if (r < 0.75) {
    // open hat on the last off-beat
    add('openhat', base + bpb - 0.5, 0.6);
  } else {
    // drop a random hat for breath
    const pos = rng.int(0, bpb * 4 - 1) * stepDur;
    remove((n) => n.pitch === DRUM_PITCH.hihat && Math.abs(n.start - (base + pos)) < 1e-6);
  }
}

function applyFill(type, bar, add, remove, rng, density, bpb, styleId, stepDur = 0.25) {
  const sub = stepDur > 0.3 ? 1 / 3 : 0.25; // triplet grid styles fill in triplets
  if (type === 'none' || bar < 0) return;
  const end = (bar + 1) * bpb;
  const inZone = (from) => (n) => n.start >= from - 1e-6 && n.start < end;
  switch (type) {
    case 'build': {
      // snare/clap roll accelerating over the whole last bar (kick keeps going)
      const from = bar * bpb;
      remove((n) => inZone(from)(n) && n.pitch !== DRUM_PITCH.kick && n.pitch !== DRUM_PITCH.openhat);
      for (let t = 0; t < bpb; t += t < bpb / 2 ? 0.5 : t < bpb * 0.75 ? 0.25 : 0.125) {
        add('snare', from + t, 0.35 + 0.6 * (t / bpb), t < bpb * 0.75 ? 0.25 : 0.125);
      }
      break;
    }
    case 'snare-roll': {
      const from = end - 1;
      remove(inZone(from));
      for (let k = 0; k < 4; k++) add('snare', from + k * 0.25, 0.55 + k * 0.12);
      if (rng.chance(0.5)) add('tomhigh', from + 0.5 + 0.125, 0.6, 0.125);
      break;
    }
    case 'trap': {
      const from = end - 1;
      remove((n) => inZone(from)(n) && n.pitch === DRUM_PITCH.hihat);
      const sub = rng.pick([6, 8]);
      for (let k = 0; k < sub; k++) add('hihat', from + k / sub, 0.4 + 0.5 * (k / sub), 1 / sub);
      if (density > 0.4) for (let k = 0; k < 3; k++) add('snare', from + 0.5 + k / 6, 0.5 + k * 0.15, 1 / 6);
      break;
    }
    case 'jazz': {
      const from = end - 1;
      remove((n) => inZone(from)(n) && n.pitch !== DRUM_PITCH.ride);
      add('snare', from, 0.6); add('snare', from + 1 / 3, 0.45); add('tommid', from + 2 / 3, 0.7);
      break;
    }
    case 'break': {
      // drop the kick on the last two beats, leave a snare pickup
      const from = end - 2;
      remove((n) => inZone(from)(n) && (n.pitch === DRUM_PITCH.kick || n.pitch === DRUM_PITCH.snare || n.pitch === DRUM_PITCH.clap));
      add('snare', end - 0.25, 0.55);
      break;
    }
    case 'latin': {
      const from = end - 1;
      remove((n) => inZone(from)(n) && n.pitch !== DRUM_PITCH.clave && n.pitch !== DRUM_PITCH.cowbell);
      const pads = ['tomhigh', 'tomhigh', 'tommid', 'tommid'];
      for (let k = 0; k < 4; k++) add(pads[k], from + k * 0.25, 0.7 + k * 0.07);
      break;
    }
    case 'cinematic': {
      const from = end - 2;
      remove(inZone(from));
      for (let k = 0; k < 8; k++) add(k < 4 ? 'tommid' : 'tomlow', from + k * 0.25, 0.5 + k * 0.06);
      add('snare', end - 0.25, 0.9);
      break;
    }
    case 'toms':
    default: {
      // classic 16th tom run over the last 1–2 beats (2 beats at high density)
      const beats = density > 0.75 && styleId !== 'punk' ? 2 : 1;
      const from = end - beats;
      remove((n) => inZone(from)(n) && n.pitch !== DRUM_PITCH.kick);
      const per = Math.round(1 / sub);
      const order = ['snare', 'tomhigh', 'tommid', 'tomlow'];
      const count = beats * per;
      for (let k = 0; k < count; k++) {
        const pad = order[Math.min(order.length - 1, Math.floor((k / count) * order.length))];
        add(pad, from + k * sub, 0.65 + 0.3 * (k / count), sub);
      }
      break;
    }
  }
}
