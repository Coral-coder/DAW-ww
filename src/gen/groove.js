// Groove / humanization: genre feel templates applied to generated parts (pure, deterministic with rng).
//
//  * swing is baked into the notes as a time warp of the straight 8th / 16th grid (beats stay fixed points, so
//    chord changes and pattern bounds never move). The scheduler's project swing only touches notes sitting
//    exactly on odd 16ths, so generated songs carry their feel in the notes and set project.swing to 0.
//  * micro-timing per role / drum pad (ms, converted with the tempo): MPC "Dilla" late snares, laid-back bass,
//    lead slightly behind on soul / jazz, tight techno. Offsets are late-only (never across a beat line), so a
//    note keeps its step in the step sequencer and its chord in the harmony.
//  * velocity: hat accent cycles, ghost notes, phrase shaping and crescendos into section changes.
//  * strums / rolls for guitar- and piano-like chord parts (ends stay put: no smearing into the next chord).
import { createRng, clamp } from '../core/util.js';
import { DRUM_PITCH } from '../core/model.js';
import { getGenre } from './genres.js';

const T = (o = {}) => ({
  swing8: 0.5, // position of the off-beat 8th inside a beat (0.5 straight, 0.667 triplet swing)
  swing16: null, // position of the odd 16th inside an 8th (null = from genre.swing)
  drums: {}, // pad -> {late ms, jit ms, vel multiplier}
  hatAccents: [1, 0.66, 0.84, 0.7], // per 16th within a beat
  ghosts: 0, // probability of extra snare ghost notes before backbeats
  bassLate: 3, chordLate: 4, leadLate: 3, jitter: 3, velJit: 0.05,
  ...o,
});

const DILLA = T({
  swing8: 0.57, // MPC-style lazy 8ths (hats / keys), on top of the late snare
  drums: { snare: { late: 20, jit: 6 }, clap: { late: 16, jit: 5 }, rim: { late: 12, jit: 6 }, hihat: { late: 6, jit: 9 }, openhat: { late: 8, jit: 6 }, kick: { late: 0, jit: 7 }, shaker: { late: 4, jit: 8 } },
  hatAccents: [1, 0.55, 0.8, 0.62], ghosts: 0.35, bassLate: 14, chordLate: 9, leadLate: 8, jitter: 5, velJit: 0.07,
});

export const GROOVES = {
  dilla: DILLA,
  tight: T({ drums: { hihat: { late: 0, jit: 1 }, clap: { late: 1, jit: 1 } }, hatAccents: [1, 0.7, 0.88, 0.72], bassLate: 1, chordLate: 1, leadLate: 1, jitter: 1, velJit: 0.03 }),
  house: T({ drums: { clap: { late: 5, jit: 3 }, hihat: { late: 2, jit: 3 }, openhat: { late: 3, jit: 2 }, shaker: { late: 3, jit: 5 }, rim: { late: 4, jit: 3 } }, hatAccents: [0.9, 0.62, 1, 0.68], bassLate: 3, chordLate: 3, leadLate: 2, jitter: 2 }),
  trap: T({ drums: { snare: { late: 2, jit: 2 }, clap: { late: 3, jit: 2 }, hihat: { late: 0, jit: 2 } }, hatAccents: [1, 0.7, 0.85, 0.72], bassLate: 0, chordLate: 3, leadLate: 2, jitter: 2 }),
  band: T({ drums: { snare: { late: 7, jit: 5 }, hihat: { late: 2, jit: 6 }, kick: { late: 0, jit: 5 }, ride: { late: 2, jit: 5 }, crash: { late: 0, jit: 4 }, tomlow: { late: 3, jit: 6 }, tommid: { late: 3, jit: 6 }, tomhigh: { late: 3, jit: 6 } }, hatAccents: [1, 0.6, 0.82, 0.64], ghosts: 0.12, bassLate: 5, chordLate: 6, leadLate: 5, jitter: 5, velJit: 0.06 }),
  funk: T({ drums: { snare: { late: 4, jit: 3 }, hihat: { late: 1, jit: 3 } }, hatAccents: [1, 0.5, 0.8, 0.55], ghosts: 0.3, bassLate: 2, chordLate: 3, leadLate: 4, jitter: 3 }),
  soul: T({ drums: { snare: { late: 12, jit: 5 }, clap: { late: 10, jit: 4 }, hihat: { late: 4, jit: 6 }, kick: { late: 0, jit: 5 } }, hatAccents: [1, 0.58, 0.82, 0.62], ghosts: 0.25, bassLate: 9, chordLate: 7, leadLate: 9, jitter: 4, velJit: 0.06 }),
  reggae: T({ drums: { snare: { late: 10, jit: 4 }, rim: { late: 10, jit: 4 }, hihat: { late: 4, jit: 5 }, kick: { late: 2, jit: 3 } }, bassLate: 13, chordLate: 8, leadLate: 8, jitter: 4 }),
  jazz: T({ swing8: 0.66, drums: { ride: { late: 0, jit: 5 }, snare: { late: 6, jit: 8 }, hihat: { late: 2, jit: 4 }, kick: { late: 2, jit: 6 } }, bassLate: 0, chordLate: 9, leadLate: 12, jitter: 6, velJit: 0.08 }),
  shuffle: T({ swing8: 0.66, drums: { snare: { late: 8, jit: 5 }, hihat: { late: 2, jit: 5 } }, bassLate: 5, chordLate: 6, leadLate: 8, jitter: 5, velJit: 0.07 }),
  latin: T({ drums: { conga: { late: 3, jit: 5 }, clave: { late: 0, jit: 2 }, cowbell: { late: 0, jit: 2 }, rim: { late: 3, jit: 4 } }, bassLate: 2, chordLate: 4, leadLate: 6, jitter: 4 }),
  garage: T({ drums: { snare: { late: 4, jit: 3 }, clap: { late: 5, jit: 3 }, hihat: { late: 2, jit: 4 }, rim: { late: 5, jit: 4 } }, hatAccents: [1, 0.6, 0.9, 0.66], bassLate: 3, chordLate: 4, leadLate: 4, jitter: 3 }),
  dnb: T({ drums: { snare: { late: 3, jit: 2 }, hihat: { late: 1, jit: 3 }, ride: { late: 1, jit: 3 } }, ghosts: 0.15, bassLate: 1, chordLate: 4, leadLate: 4, jitter: 2 }),
  float: T({ drums: { hihat: { late: 3, jit: 8 }, rim: { late: 4, jit: 8 }, shaker: { late: 3, jit: 9 } }, bassLate: 4, chordLate: 10, leadLate: 10, jitter: 7, velJit: 0.06 }),
};

const GENRE_GROOVE = {
  'boom-bap': 'dilla', 'lofi-hip-hop': 'dilla', 'neo-soul': 'dilla', 'trip-hop': 'dilla', downtempo: 'dilla', chillwave: 'soul',
  techno: 'tight', minimal: 'tight', trance: 'tight', psytrance: 'tight', hardstyle: 'tight', industrial: 'tight', eurobeat: 'tight',
  chiptune: 'tight', idm: 'tight', glitch: 'tight', 'progressive-house': 'house', synthwave: 'tight', brostep: 'tight', dubstep: 'trap',
  house: 'house', 'deep-house': 'house', 'tech-house': 'house', 'nu-disco': 'house', amapiano: 'house', kpop: 'house', pop: 'house',
  trap: 'trap', drill: 'trap', phonk: 'trap', 'future-bass': 'trap', footwork: 'trap', reggaeton: 'trap', dancehall: 'trap',
  rock: 'band', punk: 'band', metal: 'band', indie: 'band', country: 'band', folk: 'band',
  funk: 'funk', disco: 'funk', gospel: 'soul', rnb: 'soul', afrobeat: 'latin',
  reggae: 'reggae', dub: 'reggae', jazz: 'jazz', blues: 'shuffle', 'bossa-nova': 'latin', salsa: 'latin',
  'uk-garage': 'garage', 'two-step': 'garage', 'drum-and-bass': 'dnb', 'liquid-dnb': 'dnb', jungle: 'dnb', breakbeat: 'dnb',
  ambient: 'float', cinematic: 'float',
};

const PITCH_PAD = Object.fromEntries(Object.entries(DRUM_PITCH).map(([k, v]) => [v, k]));

/** Groove template for a genre: {swing8, swing16, drums, hatAccents, ghosts, bassLate, chordLate, leadLate, jitter, velJit}. */
export function grooveFor(genreId) {
  const g = getGenre(genreId);
  const base = GROOVES[GENRE_GROOVE[g?.id] || 'house'];
  const sw = clamp(g?.swing || 0, 0, 1);
  // project swing s delays odd 16ths by s/8 beat -> odd 16th sits at 0.5 + s/4 of its 8th
  const swing16 = base.swing8 > 0.55 ? 0.5 : base.swing16 ?? 0.5 + sw * 0.25;
  return { ...base, swing16, id: GENRE_GROOVE[g?.id] || 'house' };
}

const EPS = 1e-4;
const onGrid = (t, step) => Math.abs(t / step - Math.round(t / step)) < EPS / step;

/** Continuous swing warp of a time in beats (beats are fixed points). */
export function swingWarp(t, swing8 = 0.5, swing16 = 0.5) {
  const b = Math.floor(t + EPS);
  let x = t - b;
  if (x < 0) x = 0;
  if (swing8 !== 0.5) x = x < 0.5 ? (x * swing8) / 0.5 : swing8 + ((x - 0.5) * (1 - swing8)) / 0.5;
  else if (swing16 !== 0.5) {
    const h = x < 0.5 ? 0 : 0.5;
    const y = (x - h) / 0.5;
    const w = y < 0.5 ? (y * swing16) / 0.5 : swing16 + ((y - 0.5) * (1 - swing16)) / 0.5;
    x = h + w * 0.5;
  }
  return b + x;
}

/**
 * applyGroove(notes, {genre, role ('drums'|'bass'|'chords'|'pad'|'lead'|'arp'|'fx'), bpm, rng, length, strum (ms per note,
 *   0 = block chord), tripletGrid (drum style on a 12-step grid: no 8th/16th warp), groove (template override), energy})
 * Mutates and returns notes. Every note stays inside [0, length).
 */
export function applyGroove(notes, opts = {}) {
  if (!notes?.length) return notes || [];
  const gr = opts.groove || grooveFor(opts.genre);
  const rng = opts.rng || createRng(1);
  const role = opts.role || 'lead';
  const bpm = opts.bpm || 120;
  const length = opts.length ?? Infinity;
  const msToBeats = (ms) => (ms * bpm) / 60000;
  const drums = role === 'drums';
  const s8 = opts.tripletGrid ? 0.5 : gr.swing8;
  const s16 = opts.tripletGrid ? 0.5 : gr.swing16;

  for (const n of notes) n._g16 = onGrid(n.start, 0.25) ? Math.round((n.start % 1) * 4) % 4 : null;
  // 1) swing warp of grid notes (16th-grid notes only; triplets / rolls stay where they are)
  if (s8 !== 0.5 || s16 !== 0.5) {
    for (const n of notes) {
      if (!onGrid(n.start, 0.25)) continue;
      const end = n.start + n.dur;
      const s = swingWarp(n.start, s8, s16);
      const e = onGrid(end, 0.25) || n.dur > 0.2 ? swingWarp(end, s8, s16) : s + n.dur;
      n.start = s;
      n.dur = Math.max(0.02, e - s);
    }
  }

  // 2) ghost notes (drums): soft snares on the 'a' before / the 'e' after backbeats where nothing else hits
  if (drums && gr.ghosts > 0 && (opts.energy ?? 0.7) > 0.35) {
    const snares = notes.filter((n) => n.pitch === DRUM_PITCH.snare || n.pitch === DRUM_PITCH.clap);
    const backbeats = snares.filter((n) => n.vel >= 0.6 && onGrid(n.start, 1));
    const busy = new Set(notes.filter((n) => n.pitch === DRUM_PITCH.snare || n.pitch === DRUM_PITCH.kick).map((n) => Math.round(n.start * 8)));
    for (const b of backbeats) {
      for (const off of [-0.25, 0.25, 0.75]) {
        const t = swingWarp(b.start + off, s8, s16);
        if (t <= 0 || t >= length - 0.05 || !rng.chance(gr.ghosts * (off === -0.25 ? 1 : 0.5))) continue;
        if (busy.has(Math.round(t * 8)) || busy.has(Math.round((t - 0.06) * 8)) || busy.has(Math.round((t + 0.06) * 8))) continue;
        busy.add(Math.round(t * 8));
        notes.push({ ...b, id: `${b.id}g${Math.round(t * 1000)}`, pitch: DRUM_PITCH.snare, start: t, dur: 0.1, vel: 0.14 + rng() * 0.1 });
      }
    }
  }

  const lateFor = role === 'bass' ? gr.bassLate : role === 'chords' || role === 'pad' ? gr.chordLate : role === 'lead' ? gr.leadLate : role === 'arp' ? gr.chordLate * 0.5 : 0;
  const maxShift = role === 'bass' ? 0.024 : role === 'chords' || role === 'pad' ? 0.02 : 0.045;
  const chordish = role === 'chords' || role === 'pad';

  // 3) chord parts: each hit moves as one (shared late offset), strummed / rolled when the instrument wants it
  //    (low->high on downbeats, high->low on upstrokes). The whole roll stays inside a 32nd: still one chord.
  if (chordish) {
    const groups = new Map();
    for (const n of notes) {
      const k = Math.round(n.start * 1000);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(n);
    }
    for (const [, g] of groups) {
      const late = Math.min(maxShift, msToBeats(lateFor + rng() * gr.jitter));
      const up = !onGrid(g[0].start, 1) && rng.chance(0.6);
      g.sort((a, b) => (up ? b.pitch - a.pitch : a.pitch - b.pitch));
      const per = opts.strum > 0 && g.length > 1 ? Math.min(msToBeats(opts.strum), 0.028 / (g.length - 1)) : 0;
      g.forEach((n, i) => {
        const d = late + i * per * (0.85 + rng() * 0.3);
        const end = n.start + n.dur;
        n.start = Math.round((n.start + d) * 10000) / 10000;
        n.dur = Math.max(0.03, end - n.start);
        if (per) n.vel *= up ? 1 - i * 0.05 : 1 - i * 0.025;
      });
    }
  }

  // 4) micro-timing + velocity
  for (const n of notes) {
    let late = 0;
    let velMul = 1;
    if (drums) {
      const pad = PITCH_PAD[n.pitch];
      const d = gr.drums[pad] || { late: 0, jit: gr.jitter };
      late = Math.min(0.08, msToBeats((d.late || 0) + rng() * (d.jit ?? gr.jitter)));
      if ((pad === 'hihat' || pad === 'shaker' || pad === 'ride') && n._g16 != null) {
        velMul = 0.65 + 0.45 * (gr.hatAccents[n._g16] / Math.max(...gr.hatAccents));
      }
    } else if (!chordish) {
      late = Math.min(maxShift, msToBeats(lateFor + rng() * gr.jitter));
    }
    delete n._g16;
    const end = n.start + n.dur;
    n.start = Math.round((n.start + late) * 10000) / 10000;
    if (drums) n.dur = Math.max(0.02, n.dur);
    else n.dur = Math.max(0.03, end - n.start);
    n.vel = clamp(n.vel * Math.min(1.1, velMul) * (1 + (rng() - 0.5) * 2 * gr.velJit), 0.05, 1);
  }
  // 5) bounds
  for (const n of notes) {
    if (n.start >= length - 0.005) n.start = Math.max(0, length - 0.02);
    if (n.start + n.dur > length) n.dur = Math.max(0.01, length - n.start);
    n.dur = Math.round(n.dur * 10000) / 10000;
    n.vel = Math.round(n.vel * 100) / 100;
  }
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return notes;
}

/**
 * Phrase-level dynamics (mutates): velocity follows the section energy, accents the start of each phrase and,
 * with `rise` (bars), swells into the next section; `fall` (bars) eases off (outro / before a breakdown).
 * opts: {length, bpb, energy, phraseBars=4, rise=0, fall=0, role}
 */
export function shapeDynamics(notes, opts = {}) {
  const bpb = opts.bpb || 4;
  const length = opts.length || 0;
  const e = clamp(opts.energy ?? 0.7, 0, 1);
  const base = 0.78 + 0.27 * e; // verses sit softer than choruses
  const phrase = (opts.phraseBars || 4) * bpb;
  const riseFrom = opts.rise ? length - opts.rise * bpb : Infinity;
  const fallFrom = opts.fall ? length - opts.fall * bpb : Infinity;
  for (const n of notes) {
    let m = base;
    const inPhrase = n.start % phrase;
    if (inPhrase < 0.05) m *= 1.06; // phrase downbeat
    else if (inPhrase > phrase - bpb) m *= 0.97; // the bar before the next phrase breathes a little
    if (n.start >= riseFrom) m *= 1 + 0.22 * ((n.start - riseFrom) / (length - riseFrom));
    if (n.start >= fallFrom) m *= 1 - 0.3 * ((n.start - fallFrom) / (length - fallFrom));
    n.vel = Math.round(clamp(n.vel * m, 0.05, 1) * 100) / 100;
  }
  return notes;
}

/** Natural note lengths by role / style: staccato stabs, legato pads; returns notes (mutated). */
export function articulate(notes, { role, style = 'normal', length = Infinity } = {}) {
  const gate = { stab: 0.55, staccato: 0.6, normal: 0.92, legato: 1 }[style] ?? 0.92;
  if (gate >= 1) return notes;
  for (const n of notes) {
    if (role === 'drums') continue;
    const min = role === 'bass' ? 0.08 : 0.06;
    n.dur = Math.max(min, Math.min(n.dur, length - n.start) * gate);
    n.dur = Math.round(n.dur * 10000) / 10000;
  }
  return notes;
}
