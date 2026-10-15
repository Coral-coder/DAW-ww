// Plugin palette for generated songs (pure, deterministic; only instrument / effect JSON — the plugins load at
// runtime, offline renders wait for them via awaitPluginsReady):
//  * Faust instruments from the catalog (src/plugins/faust-library.js) where they beat the built-in presets —
//    supersaw trance leads, analog poly pads, Karplus-Strong plucks, modal bells, physical-model flute / clarinet,
//    the tonewheel organ. Every def carries `fallbackPreset` (the closest built-in preset): if Faust can't load the
//    Instrument wrapper plays the preset instead, so a track never goes silent.
//  * Faust effects (Zita reverb / Freeverb on the reverb bus, tape echo on the delay bus, Moog ladder on acid /
//    analog basses, phaser on pads & funk keys, parallel Faust compression on band drums). Each carries
//    params.fallback = {type, params} — a built-in effect createEffect() swaps in when the plugin fails.
//  * WAMs are never used (live-only, unreliable offline).
// Levels: a Faust instrument's `gain` is calibrated so it plays at its fallback preset's loudness (measured by
// rendering both headless — see docs/SOUND.md), so the mixer's level tables (keyed by the fallback preset) hold.
import { createEffect } from '../core/model.js';
import { FAUST_INSTRUMENTS, FAUST_EFFECTS } from '../plugins/faust-library.js';
import { getGenre } from './genres.js';

/** Output gain per Faust instrument that matches its typical fallback preset (rendered RMS, see report). */
export const FAUST_GAIN = { 'va-poly': 0.55, supersaw: 0.6, pluck: 0.7, 'modal-bell': 0.8, flute: 0.9, clarinet: 0.9, organ: 0.55, 'warm-pad': 0.8 };

/** Instrument def for a catalog Faust instrument: {type:'faust', params:{name, code, values, gain, voices}, fallbackPreset}. */
export function faustInstrument(id, { fallbackPreset, values = {}, gain, voices = 8 } = {}) {
  const p = FAUST_INSTRUMENTS[id];
  if (!p) throw new Error(`unknown Faust instrument ${id}`);
  return {
    type: 'faust', preset: null,
    params: { name: p.name, code: p.code, url: '', values: { ...values }, gain: Math.round((gain ?? FAUST_GAIN[id] ?? 0.8) * 1000) / 1000, voices, plugin: `faust-${id}` },
    fallbackPreset,
  };
}

/** Effect (model) for a catalog Faust effect with a built-in fallback [type, params]. */
export function faustEffect(id, values, [fbType, fbParams], { mix = 1 } = {}) {
  const p = FAUST_EFFECTS[id];
  if (!p) throw new Error(`unknown Faust effect ${id}`);
  return createEffect('faust', { name: p.name, code: p.code, url: '', values: { ...values }, mix, plugin: `faust-${id}`, fallback: { type: fbType, params: { ...fbParams } } });
}

/** True for instrument defs that load a plugin (soundfont / faust / wam). */
export const isPluginInstrument = (inst) => ['soundfont', 'faust', 'wam'].includes(inst?.type);

// ------------------------------------------------------------------------------------------- instruments
// genre -> role -> [faust id, values]; the role's genre preset is the fallback (unless one is given as 3rd item)
const F = (id, values = {}, fallback) => ({ id, values, fallback });
const SUPERSAW_LEAD = F('supersaw', { Detune: 0.42, 'Side saws': 0.75, Cutoff: 9000, Attack: 0.005, Release: 0.35 });
const POLY_PAD = F('va-poly', { Detune: 0.22, Sub: 0.15, Cutoff: 1500, Resonance: 0.2, 'Filter env': 0.25, Attack: 0.35, Decay: 1.2, Sustain: 0.85, Release: 1.4 });
const WARM_PAD = F('warm-pad', { Cutoff: 1800, 'PWM depth': 0.3, Attack: 0.9, Release: 1.8, 'Chorus width': 0.7 });
const KS = (bright = 0.6, damp = 0.25) => F('pluck', { Brightness: bright, Damping: damp, 'Pick position': 0.22 });
const BELL = F('modal-bell', { Decay: 2.8, Hardness: 0.45, Inharmonicity: 1 });
const ORGAN = (perc = 0.3) => F('organ', { '16′': 0.5, '8′': 1, '5 1/3′': 0.5, '4′': 0.45, '2 2/3′': 0.15, '2′': 0.25, Percussion: perc, Click: 0.35, Chorus: 0.55 });
const FLUTE = F('flute', { Breath: 0.75, 'Breath noise': 0.07, Vibrato: 0.3, Embouchure: 0.5 });
const CLARINET = F('clarinet', { 'Reed stiffness': 0.5, 'Bell opening': 0.5, Breath: 0.8, Vibrato: 0.12 });

export const GENRE_FAUST = {
  trance: { lead: SUPERSAW_LEAD },
  psytrance: { pad: WARM_PAD },
  'progressive-house': { lead: SUPERSAW_LEAD, pad: WARM_PAD },
  eurobeat: { lead: SUPERSAW_LEAD },
  hardstyle: { lead: SUPERSAW_LEAD },
  'future-bass': { pad: POLY_PAD },
  house: { pad: WARM_PAD },
  'deep-house': { pad: WARM_PAD },
  'nu-disco': { pad: POLY_PAD },
  synthwave: { pad: POLY_PAD },
  chillwave: { pad: WARM_PAD },
  kpop: { pad: POLY_PAD },
  ambient: { lead: F('modal-bell', { Decay: 4.5, Hardness: 0.35, Inharmonicity: 0.85 }, 'bell'), pad: WARM_PAD },
  idm: { arp: F('modal-bell', { Decay: 1.6, Hardness: 0.7, Inharmonicity: 1.2 }, 'bell') },
  'lofi-hip-hop': { arp: KS(0.45, 0.35) },
  downtempo: { arp: KS(0.55, 0.3) },
  'trip-hop': { arp: KS(0.5, 0.3) },
  reggae: { chords: ORGAN(0.15) },
  dub: { chords: ORGAN(0.1) },
  rock: { pad: ORGAN(0.2) },
  blues: { pad: ORGAN(0.25) },
  'liquid-dnb': { pad: WARM_PAD },
};

/** Instruments of the extra orchestration roles that are Faust plugins (src/gen/orchestra.js asks here first). */
export const EXTRA_FAUST = {
  counter: {
    cinematic: F('flute', FLUTE.values, 'flute'), 'bossa-nova': F('flute', FLUTE.values, 'flute'),
    jazz: F('clarinet', CLARINET.values, 'flute'), 'neo-soul': F('clarinet', CLARINET.values, 'flute'),
    trap: F('modal-bell', { Decay: 2.2, Hardness: 0.55, Inharmonicity: 1 }, 'bell'), drill: F('modal-bell', { Decay: 2.2, Hardness: 0.55, Inharmonicity: 1 }, 'bell'),
    synthwave: F('va-poly', { Detune: 0.12, Sub: 0, Cutoff: 2600, Resonance: 0.3, 'Filter env': 0.4, Attack: 0.01, Decay: 0.5, Sustain: 0.6, Release: 0.4 }, 'square-lead'),
    'progressive-house': F('pluck', KS(0.75, 0.2).values, 'arp-pluck'), trance: F('pluck', KS(0.8, 0.2).values, 'arp-pluck'),
    chillwave: F('modal-bell', BELL.values, 'bell'), ambient: F('flute', { ...FLUTE.values, 'Breath noise': 0.12 }, 'flute'),
  },
  bells: { '*': F('modal-bell', BELL.values, 'celesta') },
  texture: { '*': F('warm-pad', { Cutoff: 900, 'PWM depth': 0.4, Attack: 2.5, Release: 3, 'Chorus width': 0.9 }, 'ambient-pad') },
  guitar: {
    afrobeat: F('pluck', KS(0.75, 0.15).values, 'guitar-clean'), 'lofi-hip-hop': F('pluck', KS(0.4, 0.35).values, 'guitar-clean'),
    'trip-hop': F('pluck', KS(0.45, 0.3).values, 'guitar-clean'), downtempo: F('pluck', KS(0.55, 0.3).values, 'guitar-clean'),
    amapiano: F('pluck', KS(0.7, 0.2).values, 'guitar-clean'),
  },
  organ: { '*': F('organ', ORGAN(0.3).values, 'organ-drawbar') },
  color: { folk: F('pluck', KS(0.85, 0.12).values, 'koto') },
};

/** The Faust def for a role in a genre (or null): base roles use GENRE_FAUST, extra roles EXTRA_FAUST. */
export function faustFor(role, genreId, fallbackPreset) {
  const e = GENRE_FAUST[genreId]?.[role] || EXTRA_FAUST[role]?.[genreId] || EXTRA_FAUST[role]?.['*'];
  if (!e || !(e.fallback || fallbackPreset)) return null;
  return faustInstrument(e.id, { values: e.values, fallbackPreset: e.fallback || fallbackPreset });
}

// ------------------------------------------------------------------------------------------- effects
const ZITA_GENRES = new Set(['cinematic', 'ambient', 'jazz', 'bossa-nova', 'neo-soul', 'gospel', 'rnb', 'trance', 'progressive-house', 'liquid-dnb', 'chillwave', 'folk', 'downtempo', 'soul', 'deep-house', 'psytrance']);
const FREEVERB_GENRES = new Set(['lofi-hip-hop', 'boom-bap', 'trip-hop', 'chiptune']);
const TAPE_ECHO_GENRES = new Set(['dub', 'reggae', 'dancehall', 'lofi-hip-hop', 'boom-bap', 'trip-hop', 'downtempo', 'blues', 'chillwave', 'synthwave']);
const LADDER_BASS = new Set(['acid-bass', 'moog-bass', 'synthwave-bass', 'saw-bass', 'fm-bass']);
const LADDER_GENRES = new Set(['techno', 'tech-house', 'minimal', 'industrial', 'synthwave', 'psytrance', 'acid', 'breakbeat', 'nu-disco']);
const PHASER_GENRES = { synthwave: 'pad', chillwave: 'pad', funk: 'chords', disco: 'chords', 'nu-disco': 'chords', dub: 'chords', 'trip-hop': 'pad', reggae: 'guitar' };
const SMASH_GENRES = new Set(['rock', 'punk', 'metal', 'indie', 'funk', 'boom-bap', 'breakbeat', 'jungle']);

const r2 = (x) => Math.round(x * 100) / 100;

/** Zita (or Freeverb) in place of the reverb bus's convolution reverb (same space as fallback). */
function reverbBusFx(rev, genreId) {
  const p = rev.params;
  const fb = ['reverb', { ...p }];
  if (FREEVERB_GENRES.has(genreId)) {
    return faustEffect('freeverb', { 'Room size': r2(Math.min(0.92, 0.35 + (p.decay || 2) / 8)), Damping: r2(0.3 + (p.damping ?? 0.5) * 0.5), Mix: 1 }, fb);
  }
  const decay = p.decay || 2.4;
  return faustEffect('zita-reverb', {
    'Pre-delay': Math.round(Math.max(1, (p.predelay ?? 0.02) * 1000)), 'Low RT60': r2(Math.min(12, decay * 1.25)), 'Mid RT60': r2(Math.min(12, decay)),
    'HF damping': Math.round(9000 - (p.damping ?? 0.5) * 6000), Mix: 1,
  }, fb);
}

/** Tape echo in place of the delay bus's digital delay (tempo-locked time, same division as fallback). */
function delayBusFx(dly, bpm) {
  const p = dly.params;
  const div = String(p.division || '1/8D');
  const m = /^(\d+)\/(\d+)([DT]?)$/.exec(div);
  let beats = m ? (4 * Number(m[1])) / Number(m[2]) : 0.75;
  if (m?.[3] === 'D') beats *= 1.5; else if (m?.[3] === 'T') beats *= 2 / 3;
  const ms = Math.round(Math.min(1500, Math.max(20, (beats * 60000) / (bpm || 120))));
  return faustEffect('tape-echo', { Time: ms, Feedback: r2(Math.min(0.75, (p.feedback ?? 0.35) + 0.08)), Tone: Math.round(Math.min(6000, p.highcut || 4500)), 'Wow & flutter': 0.35, Mix: 1, Dry: 0 }, ['delay', { ...p }]);
}

/**
 * Put the plugin effects into a finished song (mutates): bus reverbs / delays, character inserts.
 * Returns the names of what was placed, for reports. opts.plugins === false is a no-op.
 */
export function applyPluginEffects(song, { genre, bpm } = {}) {
  const g = getGenre(genre || song.genre);
  if (!g) return [];
  const id = g.id;
  const placed = [];
  const [revBus, dlyBus] = song.buses || [];
  const revIdx = revBus?.fx?.findIndex((f) => f.type === 'reverb') ?? -1;
  if (revIdx >= 0 && (ZITA_GENRES.has(id) || FREEVERB_GENRES.has(id))) {
    revBus.fx[revIdx] = reverbBusFx(revBus.fx[revIdx], id);
    placed.push(`${revBus.name}: ${revBus.fx[revIdx].params.name}`);
  }
  const dIdx = dlyBus?.fx?.findIndex((f) => f.type === 'delay') ?? -1;
  if (dIdx >= 0 && TAPE_ECHO_GENRES.has(id)) {
    dlyBus.fx[dIdx] = delayBusFx(dlyBus.fx[dIdx], bpm || song.bpm);
    placed.push(`${dlyBus.name}: Tape Echo`);
  }
  for (const t of song.tracks) {
    if (t.layerOf) continue;
    const inst = t.instrument || {};
    const presetish = inst.preset || inst.fallbackPreset || '';
    const firstMix = () => { const i = t.fx.findIndex((f) => ['eq8', 'compressor', 'ducker', 'pump', 'widener'].includes(f.type)); return i < 0 ? t.fx.length : i; };
    // analog / acid basses: a driven Moog ladder (the 303 / Minimoog growl)
    if (t.role === 'bass' && (LADDER_GENRES.has(id) || /acid/.test(presetish)) && LADDER_BASS.has(presetish)) {
      const cut = /acid/.test(presetish) ? 1400 : 2200;
      t.fx.splice(firstMix(), 0, faustEffect('moog-ladder', { Cutoff: cut, Resonance: /acid/.test(presetish) ? 0.55 : 0.3, Drive: 1.8, 'LFO rate': 0.25, 'LFO depth': 0 },
        ['filter', { type: 'lowpass', cutoff: cut, resonance: 2, slope: '24', depth: 0, mix: 1 }]));
      placed.push(`${t.name}: Moog Ladder`);
    }
    // swirl on pads / funk keys / reggae skank
    if (PHASER_GENRES[id] === t.role) {
      t.fx.splice(firstMix(), 0, faustEffect('phaser', { Rate: 0.25, Depth: 0.9, Feedback: 0.45, 'Notch width': 900 }, ['phaser', { rate: 0.25, stages: 4, frequency: 900, depth: 2, feedback: 0.45, mix: 0.5 }], { mix: 0.5 }));
      placed.push(`${t.name}: Phaser`);
    }
    // band drums: New-York style parallel smash (Faust compressor, 35 % wet)
    if (t.role === 'drums' && SMASH_GENRES.has(id)) {
      t.fx.push(faustEffect('compressor', { Threshold: -26, Ratio: 8, Attack: 3, Release: 90, 'Make-up': 9 }, ['compressor', { threshold: -26, ratio: 8, attack: 0.003, release: 0.09, knee: 3, makeup: 9, mix: 1 }], { mix: 0.3 }));
      placed.push(`${t.name}: Faust Compressor (parallel)`);
    }
  }
  return placed;
}
