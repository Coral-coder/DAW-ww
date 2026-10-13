// Orchestration depth for generated songs (pure, deterministic). generateSong writes the core band (drums, bass,
// chords, pad, lead, arp, fx); this module adds the layers a producer stacks on top, per genre and per section:
//
//   perc     — a second percussion player with its own groove: shakers / congas / tambourine / clave / cowbell, 3-over-4
//              shaker & rim polyrhythms (afro, latin, techno), taiko-style tom ostinati (cinematic), a variation every
//              4th bar and a fill at 8-bar ends, accelerating in builds
//   top      — a top loop / breakbeat layer (dnb, jungle, breaks, techno): the break's hats & ghost snares over the kit
//   sub      — sub-bass under a mid-bass (EDM / dnb / garage / reggaeton): the bass line's roots in octave 1, the
//              mid-bass high-passed
//   counter  — counter-melody / answer line (contrary motion, 3rds / 6ths under the lead, plays in the lead's rests)
//   strings  — a string section (high sustained lines in choruses, ostinato in builds)
//   brass    — brass stabs / shots answering the vocal (funk, soul, salsa, afrobeat, reggae, cinematic swells)
//   guitar   — rhythm guitar (muted 16ths, skanks, strums, highlife picking, lo-fi plucks)
//   color    — an ethnic / signature colour ostinato (banjo, sitar, steel drums, kalimba, marimba, glockenspiel…)
//   texture  — an evolving low-level texture pad (intros, breakdowns, outros)
//   vox      — a vocal-like hook double (oohs / choir) in choruses, choir pads in breakdowns
//   bells    — a modal-bell sparkle (cinematic, ambient, experimental)
//   organ    — a tonewheel organ bed (gospel, soul, rock)
//   impact   — impacts on drops / chorus downbeats and accelerating snare rolls into them
//
// Density rule: at most `maxLayers(section)` melodic layers sound at once (3 in intros / outros, 4 in breaks, 5–6 in
// verses, 6 in builds, 7–8 in the biggest choruses), extras enter by genre priority. Every melodic layer is written
// against the section's chords (chord tones / the counter-melody generator), stays in its own register and goes
// through the anti-monotony guard. Sounds: Faust plugins where they win (src/gen/plugins.js), real multisampled /
// GM instruments with a built-in fallback preset, synthesized kits for percussion.
//
// Also: harmonic turnarounds — the last two beats before a chorus / new section become a secondary dominant (V7/x),
// a borrowed iv or a bVII, so sections connect with a pull instead of a jump (two chords per bar at section ends).
import { createRng, clamp } from '../core/util.js';
import { createTrack, createPattern, createClip, createNote, createEffect, DRUM_PITCH, TRACK_COLORS } from '../core/model.js';
import { mod12, voiceChord, chordPitchClasses, romanToChord, scalePitchClasses } from '../theory/index.js';
import { progressionToNotes, padPart } from './harmony.js';
import { generateCounterMelody } from './melody.js';
import { arpFigures } from './arp.js';
import { varyPart } from './monotony.js';
import { applyGroove, shapeDynamics } from './groove.js';
import { mixTrack } from './mix.js';
import { faustFor } from './plugins.js';
import { realInstrumentDef } from '../audio/library/instrument-map.js';
import { AutomationBuilder, ARP_HOME } from './arrange.js';

const hash = (...xs) => xs.reduce((h, x) => (Math.imul(h ^ (typeof x === 'number' ? x : [...String(x)].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)), 2654435761) >>> 0), 0x2545f491);
const EPS = 1e-6;

export const EXTRA_ROLES = ['perc', 'top', 'sub', 'counter', 'strings', 'brass', 'guitar', 'color', 'texture', 'vox', 'bells', 'organ', 'impact'];
/** Extra roles that count as melodic layers (sub doubles the bass, perc / top / impact are drums). */
const MELODIC_EXTRA = new Set(['counter', 'strings', 'brass', 'guitar', 'color', 'texture', 'vox', 'bells', 'organ']);
const BASE_MELODIC = ['bass', 'chords', 'pad', 'lead', 'arp'];

const INFO = {
  perc: { name: 'Percussion', color: TRACK_COLORS[0], mix: 'drums', db: -8, hpf: 180 },
  top: { name: 'Break Ghosts', color: TRACK_COLORS[0], mix: 'drums', db: -12, hpf: 400 },
  sub: { name: 'Sub', color: TRACK_COLORS[1], mix: 'bass', db: -1 },
  counter: { name: 'Counter', color: TRACK_COLORS[4], mix: 'lead', db: -4.5 },
  strings: { name: 'Strings', color: TRACK_COLORS[7], mix: 'pad', db: -3 },
  brass: { name: 'Brass', color: TRACK_COLORS[2], mix: 'chords', db: -3.5 },
  guitar: { name: 'Guitar', color: TRACK_COLORS[9], mix: 'chords', db: -3 },
  color: { name: 'Color', color: TRACK_COLORS[5], mix: 'arp', db: -2 },
  texture: { name: 'Texture', color: TRACK_COLORS[8], mix: 'pad', db: -6 },
  vox: { name: 'Vox', color: TRACK_COLORS[3], mix: 'lead', db: -7 },
  bells: { name: 'Bells', color: TRACK_COLORS[5], mix: 'arp', db: -4 },
  organ: { name: 'Organ', color: TRACK_COLORS[6], mix: 'pad', db: -3.5 },
  impact: { name: 'Impacts', color: TRACK_COLORS[10], mix: 'drums', db: -6, hpf: 28 },
};

// ------------------------------------------------------------------------------------------- who plays per genre
const FAMILY_EXTRAS = {
  house: ['perc', 'vox', 'impact'], techno: ['perc', 'texture', 'impact'], trance: ['perc', 'counter', 'vox', 'impact', 'texture'],
  bass: ['sub', 'impact', 'vox', 'perc', 'texture'], dnb: ['top', 'sub', 'perc', 'impact', 'texture'], breaks: ['top', 'perc', 'sub', 'impact'],
  garage: ['perc', 'vox', 'sub', 'impact'], hiphop: ['perc', 'counter', 'impact', 'texture'], soul: ['strings', 'guitar', 'perc', 'organ', 'counter'],
  pop: ['strings', 'guitar', 'perc', 'counter', 'vox', 'impact'], retro: ['counter', 'perc', 'texture', 'impact'], ambient: ['texture', 'bells', 'counter'],
  chill: ['texture', 'guitar', 'perc', 'strings', 'counter'], experimental: ['perc', 'bells', 'texture', 'impact'], rock: ['guitar', 'perc', 'strings'],
  funk: ['guitar', 'brass', 'perc', 'strings', 'counter'], jazz: ['counter', 'brass'], latin: ['perc', 'counter', 'strings'], blues: ['counter', 'perc'],
  caribbean: ['perc', 'guitar', 'brass', 'counter'], african: ['perc', 'guitar', 'brass', 'color'], americana: ['color', 'perc', 'counter', 'strings'],
  cinematic: ['brass', 'perc', 'counter', 'bells', 'texture', 'impact', 'vox'], industrial: ['perc', 'texture', 'impact', 'sub'], hard: ['impact', 'vox', 'perc'],
};
export const GENRE_EXTRAS = {
  'tech-house': ['perc', 'impact'], minimal: ['perc', 'texture'], 'deep-house': ['perc', 'texture', 'vox', 'impact'],
  'future-bass': ['vox', 'perc', 'impact', 'texture'], footwork: ['perc', 'vox', 'sub'], 'liquid-dnb': ['sub', 'perc', 'counter', 'vox', 'texture'],
  jungle: ['top', 'sub', 'perc', 'impact', 'texture'], trap: ['counter', 'perc', 'impact', 'texture'], drill: ['counter', 'perc', 'impact'],
  phonk: ['perc', 'impact', 'counter'], 'boom-bap': ['perc', 'brass', 'counter', 'texture'], 'lofi-hip-hop': ['guitar', 'perc', 'texture'],
  'neo-soul': ['guitar', 'strings', 'perc', 'counter', 'organ'], gospel: ['organ', 'strings', 'brass', 'perc', 'counter'], rnb: ['guitar', 'strings', 'perc', 'counter', 'vox'],
  kpop: ['strings', 'perc', 'counter', 'vox', 'impact', 'guitar'], chiptune: ['counter', 'perc'], eurobeat: ['counter', 'perc', 'impact', 'vox'],
  punk: ['guitar', 'perc'], metal: ['guitar', 'vox', 'impact'], indie: ['guitar', 'color', 'perc', 'strings', 'organ'],
  disco: ['strings', 'guitar', 'brass', 'perc', 'vox'], 'nu-disco': ['guitar', 'perc', 'vox', 'strings', 'impact'], 'bossa-nova': ['perc', 'counter', 'strings'],
  salsa: ['perc', 'counter', 'guitar'], reggaeton: ['perc', 'sub', 'vox', 'impact'], dancehall: ['perc', 'color', 'sub', 'vox'], reggae: ['guitar', 'perc', 'brass', 'counter'],
  dub: ['perc', 'texture', 'guitar', 'impact'], amapiano: ['perc', 'color', 'texture', 'vox'], country: ['color', 'perc', 'counter', 'strings'],
  folk: ['color', 'counter', 'perc', 'strings'], psytrance: ['perc', 'color', 'texture', 'impact'], ambient: ['texture', 'bells', 'counter'],
  synthwave: ['counter', 'perc', 'texture', 'impact'], chillwave: ['counter', 'texture', 'perc', 'guitar'],
};
export const extrasFor = (g) => GENRE_EXTRAS[g.id] || FAMILY_EXTRAS[g.family] || [];

/** Melodic layers allowed at once in a section (orchestration density by energy / function). */
export function maxLayers(s) {
  if (s.kind === 'intro' || s.kind === 'outro') return 3;
  if (s.kind === 'break') return s.type === 'bridge' ? 5 : 4;
  if (s.kind === 'build') return 6;
  if (s.kind === 'verse') return s.occurrence > 1 || s.energy >= 0.7 ? 6 : 5;
  return s.energy >= 0.95 ? 8 : 7;
}

const SLOW = new Set(['cinematic', 'ambient', 'bossa-nova', 'folk', 'jazz']);
const ALWAYS_BRASS = new Set(['funk', 'salsa', 'afrobeat', 'reggae', 'gospel', 'disco', 'boom-bap', 'jazz']);
const TRANCEY = new Set(['trance', 'psytrance', 'progressive-house', 'hardstyle', 'eurobeat', 'future-bass', 'liquid-dnb', 'deep-house', 'house', 'amapiano', 'metal', 'cinematic']);

/** Does extra `role` play in section `s` (by its function), given the base roles R? */
function wants(role, s, R, g, finalMain) {
  const has = (r) => R.includes(r);
  const k = s.kind;
  switch (role) {
    case 'perc': return has('drums') && (s.energy >= 0.5 || k === 'main') && !(k === 'outro' && s.energy < 0.45);
    case 'top': return has('drums') && (k === 'main' || k === 'build' || (k === 'verse' && s.energy >= 0.7));
    case 'sub': return has('bass');
    case 'counter':
      if (!has('lead') || /trad/i.test(s.name)) return false;
      if (SLOW.has(g.id)) return k !== 'intro' && k !== 'outro' && (k !== 'main' || s.occurrence > 1 || finalMain || g.id !== 'jazz');
      return (k === 'main' && (s.occurrence > 1 || finalMain)) || (k === 'verse' && s.occurrence > 1);
    case 'strings': return (has('chords') || has('pad')) && (k === 'main' || (k === 'build' && s.energy >= 0.6) || s.type === 'bridge');
    case 'brass': return k === 'main' && (ALWAYS_BRASS.has(g.id) || s.occurrence > 1 || finalMain) && !(g.id === 'jazz' && s.name.toLowerCase() === 'solo' && s.occurrence < 2);
    case 'guitar': return has('chords') && ['verse', 'main', 'build'].includes(k);
    case 'color': return (k === 'main' || (k === 'verse' && s.occurrence > 1) || (k === 'break' && s.energy >= 0.3)) && R.some((r) => BASE_MELODIC.includes(r));
    case 'texture': return (['intro', 'break', 'outro'].includes(k) || g.family === 'ambient' || g.id === 'cinematic') && R.some((r) => r !== 'drums' && r !== 'fx');
    case 'vox': return (k === 'main' && has('lead')) || (k === 'break' && TRANCEY.has(g.id) && R.some((r) => r === 'pad' || r === 'chords'));
    case 'bells': return k === 'main' || (k === 'break' && (g.id === 'cinematic' || g.family === 'ambient'));
    case 'organ': return has('chords') && (k === 'main' || (g.id === 'gospel' && k !== 'intro'));
    case 'impact': return k === 'main' && !!s.prev && s.prev.kind !== 'main';
    default: return false;
  }
}

/** Plan which extra layers play where (sets s.extra = [role]); returns the extra roles the song uses. */
export function planExtras(g, sections) {
  const list = extrasFor(g);
  const mains = sections.filter((s) => s.kind === 'main');
  const finalMain = mains[mains.length - 1];
  const used = new Set();
  for (const s of sections) {
    s.extra = [];
    const R = s.roles;
    let layers = R.filter((r) => BASE_MELODIC.includes(r)).length + (s.enter || []).filter((r) => BASE_MELODIC.includes(r)).length;
    for (const role of list) {
      if (!wants(role, s, R, g, s === finalMain)) continue;
      // one arpeggiated layer at a time: color / bells stay out where the arp (or the other one) already runs,
      // and outside the arp genres they only season the last chorus
      if (role === 'color' || role === 'bells') {
        const taken = R.includes('arp') || (s.enter || []).includes('arp') || s.extra.includes('color') || s.extra.includes('bells');
        if (taken || (!ARP_HOME.has(g.id) && s.kind === 'main' && s !== finalMain && g.family !== 'ambient')) continue;
      }
      if (MELODIC_EXTRA.has(role)) { if (layers >= maxLayers(s)) continue; layers++; }
      s.extra.push(role);
      used.add(role);
    }
  }
  return list.filter((r) => used.has(r));
}

// ------------------------------------------------------------------------------------------- sounds
const COUNTER_GM = {
  pop: 'cello', kpop: 'cello', rnb: 'electric_guitar_clean', gospel: 'trombone', soul: 'alto_sax', funk: 'tenor_sax', disco: 'string_ensemble_1',
  'nu-disco': 'electric_guitar_clean', blues: 'harmonica', country: 'harmonica', folk: 'accordion', reggae: 'accordion', salsa: 'trombone',
  'bossa-nova': 'flute', 'boom-bap': 'flute', 'liquid-dnb': 'electric_piano_1', latin: 'flute', caribbean: 'accordion',
};
const COUNTER_PRESET = { chiptune: 'chip-lead', eurobeat: 'square-lead', phonk: 'bell', default: 'pluck' };
const GUITAR_GM = {
  funk: 'electric_guitar_muted', disco: 'electric_guitar_muted', 'nu-disco': 'electric_guitar_muted', reggae: 'electric_guitar_clean', dub: 'electric_guitar_clean',
  pop: 'acoustic_guitar_steel', kpop: 'acoustic_guitar_nylon', rock: 'electric_guitar_clean', indie: 'electric_guitar_clean', punk: 'overdriven_guitar',
  metal: 'overdriven_guitar', 'neo-soul': 'electric_guitar_jazz', rnb: 'electric_guitar_clean', soul: 'electric_guitar_clean', gospel: 'electric_guitar_clean',
  salsa: 'acoustic_guitar_nylon', chillwave: 'electric_guitar_clean',
};
const COLOR_GM = { country: 'banjo', psytrance: 'sitar', dancehall: 'steel_drums', afrobeat: 'marimba', amapiano: 'marimba', indie: 'glockenspiel' };
const COLOR_PRESET = { banjo: 'koto', sitar: 'koto', steel_drums: 'steel-drum', kalimba: 'kalimba', marimba: 'marimba', glockenspiel: 'celesta' };
const PERC_KIT = { latin: 'latin', african: 'afro', caribbean: 'latin', cinematic: 'cinematic', funk: 'latin', house: 'house', techno: 'techno', trance: 'techno', garage: 'garage', dnb: 'breaks', breaks: 'breaks', hiphop: 'trap', industrial: 'industrial' };

const sample = (gm, role, fallbackPreset, params = {}) => realInstrumentDef(gm, { role, fallbackPreset, params });

/** Instrument def of an extra role in a genre. */
export function extraInstrument(role, g, opts = {}) {
  const plugins = opts.plugins !== false && opts.soundfonts !== false;
  const sf = opts.soundfonts !== false;
  const drums = (kit) => ({ type: 'drums', preset: kit, params: { kit } });
  const fx = plugins ? faustFor(role, g.id, null) : null;
  if (fx && fx.fallbackPreset) return fx;
  switch (role) {
    case 'perc': return drums(g.id === 'salsa' || g.id === 'bossa-nova' ? 'latin' : PERC_KIT[g.family] || (g.family === 'cinematic' ? 'cinematic' : 'acoustic'));
    case 'top': return drums(g.family === 'dnb' || g.family === 'breaks' ? 'breaks' : g.family === 'garage' ? 'garage' : '909');
    case 'impact': return drums('cinematic');
    case 'sub': return { type: 'synth', preset: 'sub-bass', params: {} };
    case 'counter': {
      const gm = COUNTER_GM[g.id] || COUNTER_GM[g.family];
      if (gm && sf) return sample(gm, 'lead', gm.includes('guitar') ? 'guitar-clean' : gm.includes('string') ? 'strings' : gm === 'cello' ? 'strings' : gm === 'electric_piano_1' ? 'electric-piano' : 'flute', { attack: 0.02, release: 0.3 });
      return { type: 'synth', preset: COUNTER_PRESET[g.id] || (gm ? 'flute' : COUNTER_PRESET.default), params: {} };
    }
    case 'strings': return sf ? sample('string_ensemble_1', 'pad', 'strings', { attack: 0.12, release: 0.7 }) : { type: 'synth', preset: 'strings', params: {} };
    case 'brass': {
      const gm = g.id === 'cinematic' || g.id === 'jazz' ? 'trombone' : 'brass_section';
      return sf ? sample(gm, 'chords', 'brass-section', { attack: 0.015, release: 0.2 }) : { type: 'synth', preset: 'brass-section', params: {} };
    }
    case 'guitar': {
      const gm = GUITAR_GM[g.id] || 'electric_guitar_clean';
      return sf ? sample(gm, 'chords', /overdriven|distortion/.test(gm) ? 'guitar-dist' : 'guitar-clean', { release: 0.25 }) : { type: 'synth', preset: 'guitar-clean', params: {} };
    }
    case 'color': {
      const gm = COLOR_GM[g.id] || 'kalimba';
      return sf ? sample(gm, 'arp', COLOR_PRESET[gm] || 'kalimba', { release: 0.5 }) : { type: 'synth', preset: COLOR_PRESET[gm] || 'kalimba', params: {} };
    }
    case 'vox': {
      const gm = ['metal', 'cinematic', 'hardstyle', 'trance', 'psytrance', 'gospel'].includes(g.id) ? 'choir_aahs' : 'voice_oohs';
      return sf ? sample(gm, 'pad', 'choir-pad', { attack: 0.08, release: 0.6 }) : { type: 'synth', preset: 'choir-pad', params: {} };
    }
    case 'texture': return { type: 'synth', preset: 'ambient-pad', params: {} };
    case 'bells': return { type: 'synth', preset: 'celesta', params: {} };
    case 'organ': return { type: 'organ', preset: 'organ-drawbar', params: {} };
    default: return { type: 'synth', preset: 'pluck', params: {} };
  }
}

/** The def the mixer's level tables should see (a plugin's built-in fallback preset — Faust gains are calibrated to it). */
export const mixInstrument = (inst) => (inst?.type === 'faust' && inst.fallbackPreset ? { type: 'synth', preset: inst.fallbackPreset, params: {} } : inst);

// ------------------------------------------------------------------------------------------- parts
const P = DRUM_PITCH;
const note = (pitch, start, dur, vel, length) => (start >= -EPS && start < length - EPS ? createNote(pitch, Math.round(start * 1000) / 1000, Math.min(dur, length - start), clamp(vel, 0.05, 1)) : null);

/** Top-end pitches (hats, ride, tambourine, shaker): what the density budget counts. */
export const TOP_END = new Set([42, 44, 46, 51, 53, 54, 69, 70, 82]);
/** Max top-end hits per bar across every drum track of a section (the main kit may already exceed it: then nothing is added). */
export const topEndBudget = (g) => (g.family === 'dnb' ? 16 : 20);
/** Max hits per bar of the percussion layer, and of distinct voices. */
export const PERC_MAX_HITS = 8;
export const PERC_MAX_VOICES = 2;

/** Per-bar top-end hit counts / 16th streams (a voice with >= 12 hits in the bar) of a drum part. */
export function topEndPerBar(notes, bars, bpb) {
  const out = Array.from({ length: bars }, () => ({ hits: 0, streams: 0, per: {} }));
  for (const n of notes || []) {
    if (!TOP_END.has(n.pitch)) continue;
    const b = Math.floor((n.start + 0.02) / bpb);
    if (!out[b]) continue;
    out[b].hits++;
    out[b].per[n.pitch] = (out[b].per[n.pitch] || 0) + 1;
  }
  for (const b of out) b.streams = Object.values(b.per).filter((x) => x >= 12).length;
  return out;
}

/**
 * Percussion player — complements the main kit, never duplicates it: 1–2 voices, <= 8 hits per bar, fixed velocity
 * families (accent / normal, nothing random), a variation every 4th bar and a short fill at 8-bar ends. Top-end
 * voices (shaker / tambourine) only play in bars where the main kit leaves room in the budget and has no shaker of
 * its own; never a 16th stream. Styles: congas + clave (afro / latin, 3-2 son clave, dotted-8th polyrhythm on the
 * conga), conga + tambourine (club), 3-over-4 rim (techno), light 8th shaker (dnb — only if the kit has none),
 * rim (hip-hop), tambourine / shaker (band), low-tom ostinato (cinematic). main = the main kit's notes in the section.
 */
export function percPart(g, s, { bpb, main = [] }) {
  const len = s.bars * bpb;
  const steps = Math.round(bpb * 4);
  const fam = g.family;
  const style = g.id === 'cinematic' ? 'taiko' : ['african', 'latin'].includes(fam) || ['afrobeat', 'amapiano', 'salsa', 'bossa-nova', 'reggaeton'].includes(g.id) ? 'afro'
    : fam === 'caribbean' ? 'island' : ['techno', 'industrial', 'trance'].includes(fam) ? 'techno' : fam === 'dnb' ? 'dnb'
      : ['house', 'garage', 'breaks', 'bass', 'hard'].includes(fam) ? 'club' : fam === 'hiphop' ? 'hiphop' : ['ambient', 'chill', 'experimental'].includes(fam) ? 'soft' : 'band';
  const kit = topEndPerBar(main, s.bars, bpb);
  const kitHasShaker = main.some((n) => n.pitch === P.shaker);
  const budget = topEndBudget(g);
  const out = [];
  const ramp = (bar) => (s.kind === 'build' ? 0.75 + 0.25 * (bar / Math.max(1, s.bars - 1)) : 1);
  for (let bar = 0; bar < s.bars; bar++) {
    const varBar = bar % 4 === 3;
    const fillBar = bar % 8 === 7 && bar < s.bars - 1 || (bar === s.bars - 1 && !!s.next);
    const room = budget - kit[bar].hits; // top-end hits this bar may still add
    const hits = []; // [pad, step, level 'A'|'N'|'G']
    const lane = (pad, stepsList, lvl = 'N') => { for (const st of stepsList) if (st < steps) hits.push([pad, st, typeof lvl === 'function' ? lvl(st) : lvl]); };
    switch (style) {
      case 'afro':
        // conga: open tones on the dotted-8th grid (3-over-4 against the kick), clave 3-2 son
        lane('conga', varBar ? [0, 3, 6, 10, 13] : [3, 6, 10, 14], (st) => (st === 6 || st === 14 ? 'A' : 'N'));
        lane('clave', bar % 2 === 0 ? [0, 6, 12] : [4, 8], 'N');
        break;
      case 'island':
        lane('conga', varBar ? [6, 11, 14] : [6, 14], 'N');
        if (!kitHasShaker && room >= 4) lane('shaker', [2, 6, 10, 14], 'N');
        break;
      case 'techno': {
        // 3-over-4 rim: a dotted-8th cycle that drifts across the bar line
        const off = (3 - ((bar * steps) % 3)) % 3;
        const st = [];
        for (let i = off; i < steps; i += 3) st.push(i);
        lane('rim', st, (x) => (x === off ? 'A' : 'N'));
        break;
      }
      case 'dnb':
        // at most a light 8th-note shaker, only when the kit has none and the bar has room
        if (!kitHasShaker && room >= 8 && (s.kind === 'main' || s.energy >= 0.7)) lane('shaker', [0, 2, 4, 6, 8, 10, 12, 14], (x) => (x % 4 === 2 ? 'N' : 'G'));
        break;
      case 'club':
        lane('conga', varBar ? [3, 7, 10, 14] : [6, 10, 14], (x) => (x === 10 ? 'A' : 'N'));
        if (room >= 2) lane('tambourine', [4, 12], 'N');
        break;
      case 'hiphop':
        lane('rim', varBar ? [3, 6, 10, 14] : [3, 10], 'N');
        break;
      case 'soft':
        if (!kitHasShaker && room >= 4) lane('shaker', [2, 6, 10, 14], 'N');
        if (varBar) lane('conga', [14], 'N');
        break;
      case 'taiko':
        if (fillBar) lane('tomlow', [0, 4, 8, 10, 12, 13, 14, 15], (x) => (x === 0 ? 'A' : 'N'));
        else { lane('tomlow', [0, 2, 4, 8, 10, 12], (x) => (x % 8 === 0 ? 'A' : 'N')); lane('tommid', [6, 14], 'N'); }
        break;
      default: { // band: tambourine backbeat (8ths in choruses), or shaker 8ths in verses — one voice, only with room
        const fk = ['funk', 'disco', 'nu-disco', 'soul'].includes(g.id) || fam === 'funk';
        if (s.kind === 'main' && room >= 8 && !kitHasShaker) lane('tambourine', [0, 2, 4, 6, 8, 10, 12, 14], (x) => (x % 8 === 4 ? 'A' : 'N'));
        else if (room >= 8 && !kitHasShaker && !fk) lane('shaker', [0, 2, 4, 6, 8, 10, 12, 14], (x) => (x % 4 === 2 ? 'N' : 'G'));
        else if (room >= 2) lane('tambourine', [4, 12], 'N');
        if (fk) lane('conga', varBar ? [6, 11, 14] : [6, 14], 'N');
      }
    }
    // a short conga / rim pickup at 8-bar ends when the voice budget allows (never on top of the kit's top end)
    if (fillBar && style !== 'taiko' && style !== 'dnb') {
      const pad = style === 'techno' || style === 'hiphop' ? 'rim' : 'conga';
      for (const st of [steps - 3, steps - 2, steps - 1]) if (!hits.some((h) => h[1] === st)) hits.push([pad, st, 'N']);
    }
    // caps: <= 2 voices, <= 8 hits (keep accents first), top-end within the room left by the kit
    const voices = [...new Set(hits.map((h) => h[0]))].slice(0, PERC_MAX_VOICES);
    let kept = hits.filter((h) => voices.includes(h[0]));
    const topHits = kept.filter((h) => TOP_END.has(P[h[0]]));
    if (topHits.length > Math.max(0, room)) kept = kept.filter((h) => !TOP_END.has(P[h[0]]));
    kept.sort((a, b) => ({ A: 0, N: 1, G: 2 }[a[2]] - { A: 0, N: 1, G: 2 }[b[2]]) || a[1] - b[1]);
    kept = kept.slice(0, PERC_MAX_HITS);
    const seen = new Set();
    for (const [pad, st, lvl] of kept) {
      const key = `${pad}@${st}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const vel = { A: 0.72, N: 0.55, G: 0.32 }[lvl] * ramp(bar);
      const n = note(P[pad], bar * bpb + st / 4, pad.startsWith('tom') ? 0.4 : 0.12, Math.max(0.28, vel), len);
      if (n) out.push(n);
    }
  }
  // the section keeps its two main voices (a bar-to-bar change of instrument would read as a third player)
  const count = {};
  for (const n of out) count[n.pitch] = (count[n.pitch] || 0) + 1;
  const keep = new Set(Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, PERC_MAX_VOICES).map(([p]) => Number(p)));
  const res = out.filter((n) => keep.has(n.pitch)).sort((a, b) => a.start - b.start);
  return s.kind === 'build' && s.next?.kind === 'main' ? res.filter((n) => n.start < len - 0.5) : res;
}

/**
 * Break ghost layer (dnb / jungle / breaks only): a few off-step ghost snares (the 'e' / 'a' 16ths) where the main kit
 * has no snare or kick, at one quiet level — no kick, no backbeat, no hats / ride (the kit owns those). High-passed
 * and >= 10 dB under the kit on its track.
 */
function topPart(g, s, { bpb, main = [] }) {
  const len = s.bars * bpb;
  const busy = new Set(main.filter((n) => [P.snare, P.clap, P.kick, P.rim].includes(n.pitch)).map((n) => Math.round(n.start * 4)));
  const out = [];
  const cands = [3, 7, 9, 13, 15, 11, 5, 1]; // off-step 16ths, most idiomatic first
  for (let bar = 0; bar < s.bars; bar++) {
    const want = bar % 4 === 3 ? 4 : bar % 2 ? 3 : 2;
    let k = 0;
    for (const st of cands) {
      if (k >= want || st >= bpb * 4) break;
      const q = bar * bpb * 4 + st;
      if (busy.has(q) || busy.has(q - 1) || busy.has(q + 1)) continue;
      const n = note(P.snare, q / 4, 0.1, 0.32, len);
      if (n) { out.push(n); k++; }
    }
  }
  out.sort((a, b) => a.start - b.start);
  return s.kind === 'build' && s.next?.kind === 'main' ? out.filter((n) => n.start < len - 0.5) : out;
}

/** Impacts on the section downbeat (+ an accelerating snare roll at the end of builds). */
function impactPart(g, s, { bpb }) {
  const len = s.bars * bpb;
  const out = [note(P.kick, 0, 1, 1, len), note(P.crash, 0, 2, 0.9, len), note(P.tomlow, 0, 1, 0.85, len)];
  if (g.id === 'cinematic') out.push(note(P.tomlow, 0.5, 0.5, 0.6, len), note(P.tommid, 1, 0.5, 0.55, len));
  return out.filter(Boolean);
}

/** Accelerating snare roll (quarters -> 8ths -> 16ths -> 32nds) over the last 2 bars of a build, crescendo. */
function buildRoll(s, { bpb }) {
  const len = s.bars * bpb;
  const a = len - 2 * bpb;
  const out = [];
  const stepAt = (t) => (t < a + bpb * 0.5 ? 1 : t < a + bpb ? 0.5 : t < len - 1 ? 0.25 : 0.125);
  for (let t = a; t < len - 0.5 - EPS; t += stepAt(t)) {
    const n = note(P.snare, t, 0.1, 0.3 + 0.65 * ((t - a) / (2 * bpb)), len);
    if (n) out.push(n);
  }
  return out;
}

/** Sub: the bass line's notes an octave (or two) down into E1–D#2, merged into sustained notes. */
function subPart(bass, len) {
  const out = [];
  for (const n of [...bass].sort((x, y) => x.start - y.start)) {
    let p = n.pitch;
    while (p > 39) p -= 12;
    while (p < 28) p += 12;
    const prev = out[out.length - 1];
    if (prev && prev.pitch === p && n.start - (prev.start + prev.dur) < 0.3) { prev.dur = Math.min(len - prev.start, n.start + n.dur - prev.start); continue; }
    if (prev && prev.start + prev.dur > n.start) prev.dur = Math.max(0.05, n.start - prev.start);
    const x = note(p, n.start, Math.max(n.dur, 0.2), Math.min(1, n.vel + 0.05), len);
    if (x) out.push(x);
  }
  return out;
}

/** Thin a pad-style part to its top `k` voices at each onset (string lines / airy textures). */
function topVoices(notes, k, which = 'top') {
  const by = new Map();
  for (const n of notes) { const key = Math.round(n.start * 100); (by.get(key) || by.set(key, []).get(key)).push(n); }
  const out = [];
  for (const g of by.values()) { g.sort((a, b) => a.pitch - b.pitch); out.push(...(which === 'top' ? g.slice(-k) : g.slice(0, k))); }
  return out.sort((a, b) => a.start - b.start);
}

const GUITAR_STYLE = { funk: 'offbeat', disco: 'offbeat', 'nu-disco': 'offbeat', reggae: 'skank', dub: 'skank', salsa: 'montuno', 'neo-soul': 'arp', rnb: 'arp', soul: 'arp', gospel: 'arp' };

/** Notes of one melodic extra role over a section's progression (chord tones / chord-scale aware generators). */
function melodicPart(role, g, s, ctx) {
  const { bpb, rng, progression, root, scale, lead = [], len } = ctx;
  const e = s.energy;
  const arpTaken = s.roles.includes('arp') || (s.enter || []).includes('arp') || (s.extra || []).some((r) => r === 'color' || r === 'bells');
  switch (role) {
    case 'counter': {
      const range = SLOW.has(g.id) ? [57, 76] : [55, 74];
      // call & response: in verses the counter only answers in the lead's rests (low density), in choruses it weaves
      return generateCounterMelody({ melody: lead, progression, key: root, scale, rng, beatsPerBar: bpb, length: len, density: s.kind === 'main' ? 0.45 + e * 0.35 : 0.3, range });
    }
    case 'strings': {
      if (s.kind === 'build' && !arpTaken) return arpFigures(progression, { mode: 'updown', rate: 0.5, beatsPerBar: bpb, length: len, lo: 60, hi: 84, gate: 0.85, rng, vel: 0.45 + e * 0.2 });
      return topVoices(padPart(progression, { range: [64, 88], rng, length: len, vel: 0.45 + e * 0.2, center: 74 }), 3);
    }
    case 'brass': {
      const stabs = progressionToNotes(progression, { style: 'stabs', rng, beatsPerBar: bpb, length: len, vel: 0.72 + e * 0.2 });
      const lift = stabs.length && Math.min(...stabs.map((n) => n.pitch)) < 58 ? 12 : 0;
      // answers: stabs on the 2nd and 4th bar of each 4-bar phrase (the call is the vocal / lead), shot at the end
      const out = stabs.filter((n) => Math.floor(n.start / bpb) % 2 === 1 || n.start >= len - bpb).map((n) => ({ ...n, pitch: n.pitch + lift, dur: Math.min(n.dur, 0.45) }));
      return topVoices(out, 3);
    }
    case 'guitar': {
      const st = GUITAR_STYLE[g.id];
      if (!arpTaken && (g.id === 'afrobeat' || g.id === 'amapiano' || g.family === 'chill' || g.id === 'lofi-hip-hop' || st === 'arp')) {
        return arpFigures(progression, { mode: 'up', rate: 0.5, beatsPerBar: bpb, length: len, lo: 59, hi: 81, gate: 0.5, rng, vel: 0.5 + e * 0.2 });
      }
      const notes = progressionToNotes(progression, { style: st || 'strum', rng, beatsPerBar: bpb, length: len, vel: 0.55 + e * 0.2, motion: true, motionRange: [52, 79] });
      return topVoices(notes, 4);
    }
    case 'color':
      return arpFigures(progression, { mode: g.id === 'psytrance' ? 'random' : 'updown', rate: g.id === 'country' || g.id === 'folk' ? 0.25 : 0.5, beatsPerBar: bpb, length: len, lo: 64, hi: 88, gate: 0.55, rng, vel: 0.5 + e * 0.2 });
    case 'texture':
      return topVoices(padPart(progression, { range: [60, 84], rng, length: len, vel: 0.4 + e * 0.1, center: 72 }), 2);
    case 'vox': {
      if (s.kind === 'break' || !lead.length) return topVoices(padPart(progression, { range: [57, 79], rng, length: len, vel: 0.45 + e * 0.15 }), 3);
      // hook double: the lead an octave down (or unison when it sits low), held notes only — a "sung" layer
      const med = lead.map((n) => n.pitch).sort((a, b) => a - b)[Math.floor(lead.length / 2)];
      const sh = med >= 74 ? -12 : 0;
      return lead.filter((n) => n.dur >= 0.45).map((n) => ({ ...n, pitch: n.pitch + sh, vel: n.vel * 0.8 }));
    }
    case 'bells': {
      const notes = arpFigures(progression, { mode: 'down', rate: 1, beatsPerBar: bpb, length: len, lo: 72, hi: 96, gate: 0.9, rng, vel: 0.4 + e * 0.2 });
      return notes.filter((n, i) => i % 2 === 0 || rng.chance(0.3));
    }
    case 'organ':
      return topVoices(progressionToNotes(progression, { style: 'whole', rng, beatsPerBar: bpb, length: len, vel: 0.5 + e * 0.15, motion: true, motionRange: [55, 79] }), 4);
    default: return [];
  }
}

const GROOVE_ROLE = { perc: 'drums', top: 'drums', impact: 'drums', sub: 'bass', counter: 'lead', strings: 'pad', brass: 'chords', guitar: 'chords', color: 'arp', texture: 'pad', vox: 'lead', bells: 'arp', organ: 'pad' };
const VARY_ROLE = { counter: 'lead', strings: 'pad', brass: 'chords', guitar: 'chords', color: 'arp', bells: 'arp', organ: 'chords' };

/**
 * Add the extra orchestration to a song being generated (mutates the passed collections).
 * ctx: {g, sections, progs, extras (from planExtras), tracks, patterns, clips, sectionSlots, sectionNotes, patternHarmony,
 *       auto, buses, drumTrackId, seed, bpb, bpm, root, scale, groove, opts}
 */
export function addOrchestra(ctx) {
  const { g, sections, progs, extras, tracks, patterns, clips, sectionSlots, sectionNotes, patternHarmony, auto, buses, seed, bpb, bpm, root, scale, groove, opts = {} } = ctx;
  if (!extras.length) return [];
  const side = createRng(hash(seed, 'oside')).chance(0.5) ? 1 : -1;
  const made = new Map();
  for (const role of extras) {
    const info = INFO[role];
    const instrument = extraInstrument(role, g, opts);
    const t = createTrack({ name: info.name, color: info.color, role, instrument, sends: {} });
    mixTrack(t, { genre: g.id, role: info.mix, instrument: mixInstrument(instrument), drumTrackId: ctx.drumTrackId, buses, side: role === 'brass' || role === 'counter' ? -side : side });
    t.volume = Math.round(clamp(t.volume * 10 ** (info.db / 20), 0.02, 1.5) * 1000) / 1000;
    if (info.hpf) t.fx.unshift(createEffect('eq8', { b1On: true, b1Type: 'highpass', b1Freq: info.hpf, b1Q: 0.7 }));
    if (role === 'perc') t.pan = 0.2 * side;
    if (role === 'counter' || role === 'brass' || role === 'guitar') t.pan = Math.round(0.35 * (role === 'guitar' ? side : -side) * 100) / 100;
    if (role === 'color' || role === 'bells') t.pan = Math.round(-0.3 * side * 100) / 100;
    tracks.push(t);
    auto.set(t.id, new AutomationBuilder());
    made.set(role, t);
  }
  // the mid-bass leaves the sub octave to the Sub track
  if (made.has('sub')) {
    const bass = tracks.find((t) => t.role === 'bass');
    const eq = bass?.fx.find((f) => f.type === 'eq8' && f.params.b1On);
    if (eq) eq.params.b1Freq = 95;
    if (bass) bass.volume = Math.round(bass.volume * 0.89 * 1000) / 1000;
  }
  sections.forEach((s, si) => {
    const len = s.bars * bpb;
    const mod = s.modulation || 0;
    const progression = progs[si];
    const harmonyOut = progression.map((c) => ({
      startBeat: c.startBeat, durBeats: c.durBeats, roman: c.roman, root: mod12(c.chord.root + mod), type: c.chord.type,
      bass: c.chord.bass != null ? mod12(c.chord.bass + mod) : null, name: mod ? `${c.chord.name} (+${mod})` : c.chord.name,
    }));
    const lead = (sectionNotes[si]?.lead || []).map((n) => ({ ...n, pitch: n.pitch - mod }));
    const bass = sectionNotes[si]?.bass || [];
    const roles = [...(s.extra || [])];
    // accelerating snare rolls into drops / choruses ride on the impact track
    // (only where the main kit sits out — it plays its own build fill, two snare parts would double)
    const roll = made.has('impact') && s.kind === 'build' && s.next?.kind === 'main' && s.bars >= 2 && !s.roles.includes('drums');
    if (roll && !roles.includes('impact')) roles.push('impact');
    for (const role of roles) {
      const t = made.get(role);
      if (!t) continue;
      const rng = createRng(hash(seed, s.index, role, 'x'));
      let notes;
      const main = sectionNotes[si]?.drums || [];
      if (role === 'perc') notes = percPart(g, s, { bpb, main });
      else if (role === 'top') notes = topPart(g, s, { bpb, main });
      else if (role === 'impact') notes = s.kind === 'build' ? buildRoll(s, { bpb }) : impactPart(g, s, { bpb });
      else if (role === 'sub') notes = subPart(bass, len); // already grooved / modulated with the bass
      else notes = melodicPart(role, g, s, { bpb, rng, progression, root, scale, lead, len });
      notes = notes.filter((n) => n && n.start < len - EPS && n.dur > 0);
      if (!notes.length) continue;
      if (VARY_ROLE[role]) varyPart(notes, { role: VARY_ROLE[role], genre: g.id, progression, bpb, length: len, rng: createRng(hash(seed, s.index, role, 'vary')) });
      if (GROOVE_ROLE[role] === 'drums' && role !== 'impact') {
        // extra drum layers: swing / timing of the genre, but their fixed velocity families stay (no added ghosts)
        const vel = new Map(notes.map((n) => [n, n.vel]));
        applyGroove(notes, { genre: g.id, groove: { ...groove, ghosts: 0 }, role: 'drums', bpm, rng, length: len, energy: s.energy });
        notes = notes.filter((n) => vel.has(n));
        for (const n of notes) n.vel = vel.get(n);
      } else if (role !== 'sub' && role !== 'impact') {
        applyGroove(notes, { genre: g.id, groove, role: GROOVE_ROLE[role], bpm, rng, length: len, energy: s.energy });
        shapeDynamics(notes, { length: len, bpb, energy: s.energy, rise: 0, fall: s.kind === 'outro' ? Math.min(4, s.bars) : 0, role: GROOVE_ROLE[role] });
      }
      if (mod && role !== 'sub' && GROOVE_ROLE[role] !== 'drums') for (const n of notes) n.pitch += mod;
      const clean = notes.filter((n) => n.start >= 0 && n.start < len - EPS).map((n) => createNote(n.pitch, n.start, Math.max(0.01, Math.min(n.dur, len - n.start)), n.vel));
      const pat = createPattern(t.id, { name: `${t.name} – ${s.label}`, length: len, notes: clean, color: t.color });
      patterns[pat.id] = pat;
      if (GROOVE_ROLE[role] !== 'drums') patternHarmony[pat.id] = { harmony: harmonyOut, length: len, ...(mod ? { key: { root: mod12(root + mod), scale } } : {}) };
      sectionSlots[si].slots[t.id] = pat.id;
      clips.push(createClip(t.id, { patternId: pat.id, start: s.start, length: len, name: s.label }));
      (sectionNotes[si] ||= {})[role] = clean;
    }
  });
  // a layer that found no room anywhere (budget / density rules) is not added at all
  for (const [role, t] of made) {
    if (sectionSlots.some((x) => x.slots[t.id])) continue;
    tracks.splice(tracks.indexOf(t), 1);
    auto.delete(t.id);
    made.delete(role);
  }
  return [...made.values()];
}

// ------------------------------------------------------------------------------------------- harmony: turnarounds
const TURNAROUND_GENRES = new Set(['pop', 'kpop', 'rnb', 'neo-soul', 'gospel', 'soul', 'funk', 'disco', 'nu-disco', 'rock', 'indie', 'country', 'folk', 'cinematic', 'bossa-nova', 'jazz', 'synthwave', 'eurobeat', 'salsa', 'boom-bap', 'lofi-hip-hop', 'liquid-dnb', 'chillwave', 'afrobeat', 'reggae']);

/**
 * Section-end turnarounds (mutates `progs`, cloning the arrays it changes): when a section leads into a different
 * one, its last chord gives up its final 2 beats to a chord that pulls into the next section's first chord — the
 * secondary dominant V7/x (V7 when x is the tonic), a borrowed iv (plagal pull into a major tonic) or bVII in
 * mixolydian / rock. Two chords per bar at section ends (harmonic rhythm), only where the idiom has them.
 */
export function addTurnarounds(progs, sections, { g, root, scale, seed, bpb }) {
  if (!TURNAROUND_GENRES.has(g.id) || bpb < 4 || bpb % 2) return 0;
  const keyPcs = new Set(scalePitchClasses(root, scale));
  let n = 0;
  sections.forEach((s, si) => {
    const next = sections[si + 1];
    const prog = progs[si];
    const nprog = progs[si + 1];
    if (!next || !prog?.length || !nprog?.length || next.kind === 'outro' || s.kind === 'intro' && s.bars < 4) return;
    if ((s.modulation || 0) !== (next.modulation || 0)) return;
    if (!(next.kind === 'main' || next.type !== s.type)) return;
    const rng = createRng(hash(seed, 'turn', si));
    if (!(next.kind === 'main' || rng.chance(0.6))) return;
    const last = prog[prog.length - 1];
    const len = s.bars * bpb;
    if (last.startBeat + last.durBeats < len - EPS || last.durBeats < bpb - EPS) return;
    const target = nprog[0].chord;
    const tRoot = mod12(target.root);
    const tonic = tRoot === mod12(root);
    const majorKey = keyPcs.has(mod12(root + 4)) && !keyPcs.has(mod12(root + 3));
    let chord;
    if (tonic && majorKey && g.family !== 'jazz' && rng.chance(0.35)) chord = romanToChord('iv', root, 'minor'); // borrowed minor iv
    else if (tonic && ['rock', 'indie', 'country', 'folk'].includes(g.id) && rng.chance(0.4)) chord = romanToChord('bVII', root, 'major');
    else chord = { root: mod12(tRoot + 7), type: '7' };
    if (!chord) return;
    chord = { ...chord, type: chord.type || '7' };
    // the turnaround chord must not be the chord already sounding, nor clash with the next chord's root a semitone off
    if (mod12(chord.root) === mod12(last.chord.root)) return;
    const pcs = chordPitchClasses(chord.root, chord.type);
    // out-of-key tones must resolve by step into the target (leading tones) — skip borrowed sounds that don't
    if (pcs.some((pc) => !keyPcs.has(pc) && !chordPitchClasses(target.root, target.type).some((t) => Math.abs(mod12(t - pc + 6) - 6) <= 2))) return;
    const name = chordNameOf(chord);
    const cut = len - 2;
    const head = { ...last, durBeats: cut - last.startBeat };
    const notes = voiceChord({ root: chord.root, type: chord.type }, { prev: last.notes, range: [52, 76], maxVoices: 4 });
    const tr = String(nprog[0].roman || '').replace(/(maj|m|ø|°)?\d+$|sus\d*$/, '') || 'I';
    const turn = { roman: chord.roman || (tonic ? 'V7' : `V7/${tr}`), chord: { root: chord.root, type: chord.type, name, notes: pcs, function: 'dominant' }, startBeat: cut, durBeats: 2, notes };
    progs[si] = [...prog.slice(0, -1), head, turn];
    n++;
  });
  return n;
}

const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const chordNameOf = (c) => `${NAMES[mod12(c.root)]}${c.type === 'min' ? 'm' : c.type === 'maj' ? '' : c.type}`;
