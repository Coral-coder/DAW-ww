// Instrument presets (pure data, Node-safe) + preset/def resolution.
// PRESETS[id] = { name, category, roles[], genres[], instrument:{type, params} }
import { getParamDefaults, sanitizeParams, INSTRUMENT_DEFS } from './defs.js';
import { DRUM_KITS } from './kits.js';

const synth = (params) => ({ type: 'synth', params });
const fm = (params) => ({ type: 'fm', params });
const organ = (params) => ({ type: 'organ', params });
const P = (name, category, roles, genres, instrument) => ({ name, category, roles, genres, instrument });

// common building blocks
const vib = (depth = 0.012, rate = 5.5, fade = 0.4, k = 1) => ({
  [`lfo${k}Target`]: 'pitch', [`lfo${k}Shape`]: 'sine', [`lfo${k}Rate`]: rate, [`lfo${k}Depth`]: depth, [`lfo${k}Fade`]: fade,
});
const env = (attack, decay, sustain, release) => ({ attack, decay, sustain, release });
const fenv = (fEnvAmount, fAttack, fDecay, fSustain, fRelease = 0.3) => ({ fEnvAmount, fAttack, fDecay, fSustain, fRelease });
const op = (i, ratio, level, a, d, s, r, extra = {}) => ({
  [`op${i}Ratio`]: ratio, [`op${i}Level`]: level, [`op${i}Attack`]: a, [`op${i}Decay`]: d, [`op${i}Sustain`]: s, [`op${i}Release`]: r,
  ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`op${i}${k[0].toUpperCase()}${k.slice(1)}`, v])),
});

export const PRESETS = {
  /* ------------------------------ BASS ------------------------------ */
  'sub-bass': P('Sub Bass', 'Bass', ['bass'], ['trap', 'dubstep', 'dnb', 'hiphop', 'edm', 'garage', 'house', 'drill'], synth({
    osc1Wave: 'sine', osc1Level: 0.95, osc2Wave: 'triangle', osc2Level: 0.08, filterType: 'off',
    ...env(0.006, 0.5, 1, 0.12), velToAmp: 0.25, mono: true, glide: 0.03, drive: 0.12, gain: 1.05,
  })),
  '808-bass': P('808 Bass', 'Bass', ['bass'], ['trap', 'hiphop', 'drill', 'phonk', 'reggaeton', 'rnb'], synth({
    osc1Wave: 'sine', osc1Level: 0.95, filterType: 'off', pitchEnvAmt: 7, pitchEnvDecay: 0.06,
    ...env(0.002, 1.8, 0.35, 0.35), velToAmp: 0.3, mono: true, legato: true, glide: 0.09,
    drive: 0.45, toneCut: 7000, gain: 0.95,
  })),
  'reese-bass': P('Reese Bass', 'Bass', ['bass'], ['dnb', 'jungle', 'dubstep', 'garage', 'techno'], synth({
    osc1Wave: 'saw', osc1Level: 0.75, osc2Wave: 'saw', osc2Level: 0.75, osc2Fine: -18, osc1Fine: 12,
    unison: 2, unisonDetune: 22, unisonSpread: 0.35, subLevel: 0.55,
    filterType: 'lp24', cutoff: 950, resonance: 0.2, keytrack: 0.2, ...fenv(0.6, 0.01, 0.4, 0.6),
    ...env(0.01, 0.5, 1, 0.18), lfo1Target: 'filter', lfo1Rate: 0.3, lfo1Depth: 0.07,
    mono: true, glide: 0.04, drive: 0.25, gain: 0.8,
  })),
  'acid-bass': P('Acid Bass', 'Bass', ['bass'], ['acid', 'techno', 'house', 'trance', 'breaks'], synth({
    osc1Wave: 'saw', osc1Level: 0.9, filterType: 'lp24', cutoff: 320, resonance: 0.8, keytrack: 0.25, velToFilter: 0.7,
    ...fenv(4.5, 0.002, 0.2, 0, 0.1), ...env(0.002, 0.3, 0.9, 0.06), velToAmp: 0.4,
    mono: true, legato: true, glide: 0.07, drive: 0.35, gain: 0.8,
  })),
  'pluck-bass': P('Pluck Bass', 'Bass', ['bass'], ['house', 'deep-house', 'pop', 'future-bass', 'garage', 'funk'], synth({
    osc1Wave: 'saw', osc1Level: 0.7, osc2Wave: 'square', osc2Level: 0.45, osc2Fine: 6, subLevel: 0.35,
    filterType: 'lp24', cutoff: 280, resonance: 0.3, ...fenv(3.6, 0.001, 0.16, 0, 0.1),
    ...env(0.002, 0.38, 0, 0.1), mono: true, drive: 0.1, gain: 0.9,
  })),
  'fm-bass': P('FM Bass', 'Bass', ['bass'], ['funk', 'synthwave', 'pop', 'house', 'dubstep', 'electro'], fm({
    algorithm: 5, feedback: 0.35,
    ...op(1, 1, 0.55, 0.001, 0.25, 0.12, 0.1, { vel: 0.8 }), ...op(2, 1, 1, 0.001, 0.9, 0.6, 0.08),
    ...op(3, 1, 0.3, 0.001, 0.4, 0.2, 0.1), ...op(4, 0.5, 0.7, 0.001, 1.2, 0.7, 0.08),
    keyScale: 0.2, polyphony: 2, drive: 0.1, gain: 0.85,
  })),
  'wobble-bass': P('Wobble Bass', 'Bass', ['bass'], ['dubstep', 'riddim', 'brostep', 'edm'], synth({
    osc1Wave: 'saw', osc1Level: 0.8, osc2Wave: 'square', osc2Level: 0.6, osc2Fine: 10, subLevel: 0.6,
    unison: 2, unisonDetune: 12, unisonSpread: 0.3,
    filterType: 'lp24', cutoff: 230, resonance: 0.55, keytrack: 0.2, fEnvAmount: 0,
    ...env(0.005, 0.4, 1, 0.12),
    lfo1Target: 'filter', lfo1Shape: 'sine', lfo1Sync: true, lfo1Div: '1/8', lfo1Depth: 0.55,
    mono: true, glide: 0.05, drive: 0.5, gain: 0.75,
  })),
  'moog-bass': P('Moog Bass', 'Bass', ['bass'], ['funk', 'synthwave', 'disco', 'pop', 'rock', 'electro'], synth({
    osc1Wave: 'saw', osc1Level: 0.8, osc2Wave: 'square', osc2Level: 0.6, osc2Fine: -6, osc3Wave: 'saw', osc3Level: 0.5, osc3Octave: -1,
    filterType: 'lp24', cutoff: 480, resonance: 0.35, ...fenv(2.6, 0.001, 0.25, 0.2, 0.1),
    ...env(0.002, 0.4, 0.7, 0.08), mono: true, legato: false, glide: 0.02, drive: 0.2, gain: 0.75,
  })),
  'finger-bass': P('Finger Bass', 'Bass', ['bass'], ['funk', 'rock', 'pop', 'soul', 'rnb', 'disco', 'reggae', 'country', 'blues'], synth({
    osc1Wave: 'saw', osc1Level: 0.45, osc2Wave: 'triangle', osc2Level: 0.85, filterType: 'lp12', cutoff: 520, resonance: 0.15,
    keytrack: 0.5, velToFilter: 0.5, ...fenv(2.2, 0.001, 0.12, 0.1, 0.1), ...env(0.003, 1.3, 0.22, 0.09),
    pitchEnvAmt: 0.3, pitchEnvDecay: 0.025, mono: true, legato: false, gain: 1.0,
  })),
  'saw-bass': P('Saw Bass', 'Bass', ['bass'], ['house', 'techno', 'electro', 'edm', 'synthwave'], synth({
    osc1Wave: 'saw', osc1Level: 0.85, subLevel: 0.5, filterType: 'lp24', cutoff: 700, resonance: 0.25,
    ...fenv(2, 0.002, 0.25, 0.4, 0.1), ...env(0.003, 0.3, 0.85, 0.08), mono: true, drive: 0.15, gain: 0.8,
  })),
  'dub-bass': P('Dub Bass', 'Bass', ['bass'], ['dub', 'reggae', 'dubstep', 'dancehall', 'lofi'], synth({
    osc1Wave: 'sine', osc1Level: 0.9, osc2Wave: 'triangle', osc2Level: 0.45, filterType: 'lp24', cutoff: 420, resonance: 0.1,
    ...fenv(0.6, 0.005, 0.2, 0.5), ...env(0.012, 0.6, 0.9, 0.15), mono: true, glide: 0.04, drive: 0.18, gain: 1.0,
  })),
  'upright-bass': P('Upright Bass', 'Bass', ['bass'], ['jazz', 'blues', 'swing', 'lofi', 'country', 'soul'], synth({
    osc1Wave: 'triangle', osc1Level: 0.85, osc2Wave: 'saw', osc2Level: 0.22, noiseLevel: 0.05, noiseType: 'pink',
    filterType: 'lp12', cutoff: 420, resonance: 0.1, keytrack: 0.6, velToFilter: 0.5, ...fenv(2.3, 0.001, 0.08, 0.05, 0.1),
    ...env(0.006, 1.1, 0, 0.16), pitchEnvAmt: 0.5, pitchEnvDecay: 0.03, polyphony: 2, gain: 1.05,
  })),
  'chip-bass': P('Chip Bass', 'Bass', ['bass'], ['chiptune', 'video-game', 'electro'], synth({
    osc1Wave: 'triangle', osc1Level: 0.9, osc2Wave: 'pulse', osc2Width: 0.25, osc2Level: 0.15, filterType: 'off',
    ...env(0.001, 0.1, 0.85, 0.03), velToAmp: 0.1, mono: true, gain: 0.9,
  })),
  'synthwave-bass': P('Synthwave Bass', 'Bass', ['bass'], ['synthwave', 'retrowave', 'outrun', 'darksynth', 'pop'], synth({
    osc1Wave: 'saw', osc1Level: 0.8, osc2Wave: 'saw', osc2Level: 0.6, osc2Fine: 8, subLevel: 0.3,
    filterType: 'lp24', cutoff: 600, resonance: 0.3, ...fenv(2.5, 0.001, 0.2, 0.25, 0.1),
    ...env(0.002, 0.25, 0.6, 0.08), polyphony: 4, gain: 0.8,
  })),

  /* ------------------------------ LEADS ----------------------------- */
  'supersaw-lead': P('Supersaw Lead', 'Lead', ['lead'], ['trance', 'edm', 'progressive-house', 'big-room', 'future-bass', 'hardstyle'], synth({
    osc1Wave: 'supersaw', osc1Level: 0.9, superDetune: 0.45, unisonSpread: 0.8, osc2Wave: 'saw', osc2Level: 0.22, osc2Octave: 1,
    filterType: 'lp24', cutoff: 6000, resonance: 0.15, ...fenv(1, 0.005, 0.4, 0.6), ...env(0.005, 0.3, 0.9, 0.3),
    ...vib(0.012, 5.5, 0.4), polyphony: 6, gain: 0.6,
  })),
  'square-lead': P('Square Lead', 'Lead', ['lead'], ['synthwave', 'pop', 'electro', 'chiptune', 'house'], synth({
    osc1Wave: 'square', osc1Level: 0.75, osc2Wave: 'square', osc2Level: 0.35, osc2Octave: 1, osc2Fine: 6,
    filterType: 'lp24', cutoff: 4000, resonance: 0.2, ...fenv(1.5, 0.003, 0.3, 0.5), ...env(0.004, 0.3, 0.85, 0.15),
    ...vib(0.012, 5.5, 0.5), mono: true, glide: 0.05, gain: 0.65,
  })),
  'saw-lead': P('Saw Lead', 'Lead', ['lead'], ['edm', 'electro', 'synthwave', 'house', 'pop', 'trance'], synth({
    osc1Wave: 'saw', osc1Level: 0.8, osc2Wave: 'saw', osc2Level: 0.6, osc2Fine: 10,
    filterType: 'lp24', cutoff: 3000, resonance: 0.3, ...fenv(2, 0.003, 0.4, 0.5), ...env(0.004, 0.3, 0.85, 0.15),
    ...vib(0.012, 5.6, 0.45), mono: true, glide: 0.06, drive: 0.15, gain: 0.6,
  })),
  'fm-bell-lead': P('FM Bell Lead', 'Lead', ['lead', 'arp'], ['pop', 'synthwave', 'future-bass', 'ambient', 'kpop', 'lofi'], fm({
    algorithm: 5, ...op(1, 3.5, 0.35, 0.001, 1.0, 0.1, 0.5), ...op(2, 1, 0.9, 0.001, 2.0, 0.2, 0.6),
    ...op(3, 7, 0.2, 0.001, 0.6, 0, 0.4), ...op(4, 2, 0.35, 0.001, 1.2, 0, 0.5),
    vibDepth: 0.1, vibDelay: 0.3, keyScale: 0.4, gain: 0.8,
  })),
  'chip-lead': P('Chip Lead', 'Lead', ['lead', 'arp'], ['chiptune', 'video-game', 'electro', 'pop'], synth({
    osc1Wave: 'pulse', osc1Width: 0.25, osc1Level: 0.8, filterType: 'off', ...env(0.001, 0.2, 0.7, 0.05), velToAmp: 0.1,
    ...vib(0.02, 6, 0.25), polyphony: 4, gain: 0.6,
  })),
  'acid-lead': P('Acid Lead', 'Lead', ['lead'], ['acid', 'techno', 'trance', 'breaks'], synth({
    osc1Wave: 'saw', osc1Level: 0.85, osc2Wave: 'square', osc2Level: 0.3, osc2Octave: -1,
    filterType: 'lp24', cutoff: 800, resonance: 0.78, velToFilter: 0.6, ...fenv(4, 0.002, 0.25, 0.1, 0.12),
    ...env(0.002, 0.3, 0.85, 0.08), mono: true, glide: 0.07, drive: 0.45, gain: 0.6,
  })),
  'sync-lead': P('Sync Lead', 'Lead', ['lead'], ['electro', 'synthwave', 'rock', 'edm', 'french-house'], synth({
    osc1Wave: 'saw', osc1Level: 0.8, osc2Wave: 'square', osc2Level: 0.5, osc2Octave: 1, osc2Fine: 5,
    filterType: 'lp24', cutoff: 1500, resonance: 0.55, ...fenv(3, 0.003, 0.5, 0.3, 0.2), ...env(0.003, 0.3, 0.9, 0.15),
    lfo2Target: 'pitch', lfo2Rate: 5.8, lfo2Depth: 0.01, lfo2Fade: 0.5, mono: true, glide: 0.04, drive: 0.3, gain: 0.55,
  })),
  'whistle-lead': P('Whistle Lead', 'Lead', ['lead'], ['pop', 'indie', 'lofi', 'tropical-house', 'western'], synth({
    osc1Wave: 'sine', osc1Level: 0.9, noiseLevel: 0.04, noiseType: 'pink', filterType: 'lp12', cutoff: 6000, fEnvAmount: 0,
    ...env(0.05, 0.2, 0.9, 0.2), ...vib(0.02, 5.5, 0.3), mono: true, glide: 0.08, transpose: 12, gain: 0.7,
  })),
  'guitar-lead': P('Guitar Lead', 'Guitar', ['lead'], ['rock', 'metal', 'blues', 'synthwave', 'pop'], synth({
    osc1Wave: 'saw', osc1Level: 0.8, osc2Wave: 'square', osc2Level: 0.5, osc2Fine: 6,
    filterType: 'lp24', cutoff: 3000, resonance: 0.2, ...fenv(1, 0.002, 0.5, 0.6), ...env(0.002, 2, 0.6, 0.2),
    ...vib(0.015, 5.5, 0.6), mono: true, glide: 0.03, drive: 0.85, toneCut: 4500, gain: 0.45,
  })),
  'brass-lead': P('Brass Lead', 'Lead', ['lead'], ['funk', 'pop', 'soul', 'synthwave', 'cinematic', 'jazz'], synth({
    osc1Wave: 'saw', osc1Level: 0.8, osc2Wave: 'saw', osc2Level: 0.7, osc2Fine: 6,
    filterType: 'lp24', cutoff: 700, resonance: 0.1, velToFilter: 0.6, ...fenv(3, 0.06, 0.3, 0.55, 0.2),
    ...env(0.03, 0.3, 0.85, 0.15), ...vib(0.01, 5.2, 0.5), mono: true, glide: 0.02, gain: 0.6,
  })),
  flute: P('Flute', 'Lead', ['lead'], ['cinematic', 'lofi', 'world', 'pop', 'trap', 'ambient', 'classical'], synth({
    osc1Wave: 'triangle', osc1Level: 0.7, osc2Wave: 'sine', osc2Level: 0.15, osc2Octave: 1, noiseLevel: 0.08, noiseType: 'pink',
    filterType: 'lp12', cutoff: 3500, resonance: 0, keytrack: 0.5, ...fenv(0.5, 0.08, 0.3, 0.8), ...env(0.07, 0.2, 0.9, 0.15),
    ...vib(0.012, 5, 0.35), mono: true, glide: 0.03, gain: 0.8,
  })),
  'trance-lead': P('Trance Lead', 'Lead', ['lead', 'chords'], ['trance', 'progressive-house', 'edm', 'psytrance'], synth({
    osc1Wave: 'supersaw', osc1Level: 0.85, superDetune: 0.35, unisonSpread: 0.9, osc2Wave: 'saw', osc2Level: 0.35, osc2Octave: 1,
    filterType: 'lp24', cutoff: 7000, resonance: 0.1, ...fenv(0.8, 0.002, 0.3, 0.6), ...env(0.003, 0.2, 0.8, 0.35),
    polyphony: 8, gain: 0.55,
  })),
  hoover: P('Hoover', 'Lead', ['lead', 'bass'], ['rave', 'hardcore', 'techno', 'jungle', 'hardstyle', 'gabber'], synth({
    osc1Wave: 'pulse', osc1Width: 0.3, osc1Level: 0.7, osc2Wave: 'saw', osc2Level: 0.6, osc2Octave: -1,
    unison: 3, unisonDetune: 40, unisonSpread: 0.7, filterType: 'lp24', cutoff: 3500, resonance: 0.1, fEnvAmount: 0.5,
    pitchEnvAmt: -7, pitchEnvDecay: 0.3, ...env(0.01, 0.3, 0.9, 0.3),
    lfo1Target: 'pitch', lfo1Rate: 4.5, lfo1Depth: 0.01, mono: true, glide: 0.15, glideAlways: true, drive: 0.3, gain: 0.55,
  })),

  /* ------------------------------ KEYS ------------------------------ */
  'electric-piano': P('Electric Piano', 'Keys', ['chords', 'keys'], ['soul', 'rnb', 'jazz', 'neo-soul', 'funk', 'lofi', 'pop', 'gospel'], fm({
    algorithm: 5, ...op(1, 1, 0.32, 0.001, 1.2, 0.15, 0.3, { vel: 0.9 }), ...op(2, 1, 0.9, 0.001, 2.8, 0.25, 0.4),
    ...op(3, 14, 0.1, 0.001, 0.15, 0, 0.1, { vel: 0.9 }), ...op(4, 1, 0.55, 0.001, 1.6, 0.1, 0.35, { fine: 3 }),
    keyScale: 0.45, tremDepth: 0.18, tremRate: 4.5, toneCut: 9000, gain: 0.85,
  })),
  'fm-epiano': P('FM E-Piano', 'Keys', ['chords', 'keys'], ['pop', 'rnb', 'city-pop', 'synthwave', 'house', 'kpop'], fm({
    algorithm: 5, feedback: 0.12, ...op(1, 1, 0.42, 0.001, 0.9, 0.12, 0.3, { vel: 0.9 }), ...op(2, 1, 0.9, 0.001, 2.4, 0.2, 0.4),
    ...op(3, 14, 0.24, 0.001, 0.22, 0, 0.1, { vel: 1 }), ...op(4, 1, 0.6, 0.001, 1.4, 0.1, 0.35, { fine: -4 }),
    keyScale: 0.5, gain: 0.85,
  })),
  'grand-piano': P('Grand Piano', 'Keys', ['chords', 'keys'], ['pop', 'classical', 'jazz', 'ballad', 'cinematic', 'gospel', 'rock', 'house'], fm({
    algorithm: 5, feedback: 0.08, ...op(1, 1, 0.42, 0.001, 0.7, 0, 0.3, { vel: 1 }), ...op(2, 1, 0.85, 0.001, 3.5, 0, 0.45, { vel: 0.8 }),
    ...op(3, 3, 0.18, 0.001, 0.35, 0, 0.3, { vel: 1 }), ...op(4, 2, 0.35, 0.001, 2.2, 0, 0.4, { fine: 2, vel: 0.8 }),
    keyScale: 0.65, toneCut: 8000, gain: 0.9,
  })),
  'organ-drawbar': P('Drawbar Organ', 'Keys', ['chords', 'keys'], ['gospel', 'jazz', 'soul', 'blues', 'funk', 'reggae', 'house'], organ({
    db1: 8, db2: 8, db3: 8, db4: 0, db5: 0, db6: 0, db7: 0, db8: 0, db9: 0, perc: true, percHarmonic: 'third', percDecay: 0.3,
    vibrato: 'c3', rotary: 'slow', click: 0.3, gain: 0.7,
  })),
  'organ-rock': P('Rock Organ', 'Keys', ['chords', 'keys', 'lead'], ['rock', 'blues', 'psychedelic', 'metal', 'funk'], organ({
    db1: 8, db2: 8, db3: 8, db4: 6, db5: 0, db6: 0, db7: 0, db8: 0, db9: 4, perc: true, percHarmonic: 'third', percDecay: 0.22, percLevel: 0.7,
    vibrato: 'c3', rotary: 'fast', click: 0.5, drive: 0.55, toneCut: 7000, gain: 0.55,
  })),
  clav: P('Clavinet', 'Keys', ['chords', 'keys'], ['funk', 'soul', 'disco', 'rock'], synth({
    osc1Wave: 'pulse', osc1Width: 0.18, osc1Level: 0.8, osc2Wave: 'saw', osc2Level: 0.3, osc2Fine: 3,
    filterType: 'lp24', cutoff: 1500, resonance: 0.45, keytrack: 0.6, velToFilter: 0.7, ...fenv(3, 0.001, 0.15, 0.2, 0.05),
    ...env(0.001, 0.5, 0.3, 0.05), velToAmp: 0.7, gain: 0.7,
  })),
  vibraphone: P('Vibraphone', 'Keys', ['chords', 'keys', 'lead'], ['jazz', 'lofi', 'lounge', 'soul', 'ambient'], fm({
    algorithm: 5, ...op(1, 4, 0.18, 0.001, 0.3, 0, 0.3), ...op(2, 1, 0.9, 0.001, 3.2, 0, 0.9),
    ...op(3, 10, 0.06, 0.001, 0.08, 0, 0.1), ...op(4, 4, 0.12, 0.001, 0.6, 0, 0.3),
    keyScale: 0.4, tremDepth: 0.4, tremRate: 5, gain: 0.85,
  })),
  marimba: P('Marimba', 'Keys', ['chords', 'arp', 'lead'], ['world', 'tropical-house', 'pop', 'afrobeat', 'cinematic', 'minimal'], fm({
    algorithm: 5, ...op(1, 4, 0.22, 0.001, 0.07, 0, 0.05, { vel: 0.9 }), ...op(2, 1, 0.9, 0.001, 0.55, 0, 0.25),
    ...op(3, 10, 0.12, 0.001, 0.03, 0, 0.03), ...op(4, 3.9, 0.12, 0.001, 0.12, 0, 0.08),
    keyScale: 0.6, gain: 0.95,
  })),
  bell: P('Bell', 'Keys', ['lead', 'fx', 'chords'], ['cinematic', 'ambient', 'christmas', 'trap', 'pop', 'classical'], fm({
    algorithm: 5, ...op(1, 3.5, 0.45, 0.001, 3, 0, 1.5), ...op(2, 1, 0.8, 0.001, 4.5, 0, 2.5),
    ...op(3, 1.41, 0.32, 0.001, 2.0, 0, 1.2), ...op(4, 2.76, 0.4, 0.001, 2.8, 0, 1.8),
    keyScale: 0.35, gain: 0.75,
  })),
  celesta: P('Celesta', 'Keys', ['lead', 'arp', 'chords'], ['cinematic', 'christmas', 'classical', 'ambient', 'lofi'], fm({
    algorithm: 5, ...op(1, 4, 0.2, 0.001, 0.3, 0, 0.2), ...op(2, 1, 0.85, 0.001, 1.3, 0, 0.6),
    ...op(3, 7, 0.1, 0.001, 0.2, 0, 0.2), ...op(4, 2, 0.3, 0.001, 0.8, 0, 0.4),
    keyScale: 0.4, transpose: 12, gain: 0.8,
  })),
  harpsichord: P('Harpsichord', 'Keys', ['chords', 'arp'], ['baroque', 'classical', 'cinematic', 'pop'], synth({
    osc1Wave: 'pulse', osc1Width: 0.15, osc1Level: 0.7, osc2Wave: 'saw', osc2Level: 0.35, osc2Octave: 1,
    filterType: 'lp24', cutoff: 4500, resonance: 0.1, keytrack: 0.5, ...fenv(1.5, 0.001, 0.5, 0.3, 0.1),
    ...env(0.001, 1.5, 0, 0.15), velToAmp: 0.2, polyphony: 12, gain: 0.55,
  })),
  'music-box': P('Music Box', 'Keys', ['lead', 'arp'], ['lofi', 'ambient', 'cinematic', 'christmas', 'lullaby'], fm({
    algorithm: 5, ...op(1, 5, 0.15, 0.001, 0.2, 0, 0.2), ...op(2, 1, 0.85, 0.001, 1.6, 0, 0.6),
    ...op(3, 1, 0, 0.001, 0.2, 0, 0.2), ...op(4, 4, 0.22, 0.001, 0.6, 0, 0.4),
    keyScale: 0.5, transpose: 12, gain: 0.8,
  })),
  'lofi-keys': P('Lo-Fi Keys', 'Keys', ['chords', 'keys'], ['lofi', 'chillhop', 'hiphop', 'jazz', 'neo-soul'], fm({
    algorithm: 5, ...op(1, 1, 0.28, 0.001, 1.1, 0.15, 0.3, { vel: 0.8 }), ...op(2, 1, 0.9, 0.003, 2.5, 0.25, 0.4),
    ...op(3, 14, 0.06, 0.001, 0.12, 0, 0.1), ...op(4, 1, 0.5, 0.003, 1.5, 0.1, 0.35, { fine: 6 }),
    keyScale: 0.45, vibDepth: 0.12, vibRate: 0.9, vibDelay: 0, toneCut: 2600, drive: 0.2, gain: 0.9,
  })),

  /* ------------------------------ PADS ------------------------------ */
  'warm-pad': P('Warm Pad', 'Pad', ['pad', 'chords'], ['ambient', 'pop', 'lofi', 'house', 'rnb', 'cinematic', 'chillout'], synth({
    osc1Wave: 'saw', osc1Level: 0.7, osc2Wave: 'saw', osc2Level: 0.7, osc2Fine: 9, unison: 2, unisonDetune: 14, unisonSpread: 0.7,
    filterType: 'lp24', cutoff: 1400, resonance: 0.15, ...fenv(1, 0.8, 1.5, 0.5, 1.2), ...env(0.8, 1, 0.85, 1.4),
    lfo1Target: 'filter', lfo1Rate: 0.25, lfo1Depth: 0.05, polyphony: 8, gain: 0.55,
  })),
  'string-pad': P('String Pad', 'Pad', ['pad', 'chords'], ['cinematic', 'pop', 'ambient', 'trance', 'disco', 'ballad'], synth({
    osc1Wave: 'saw', osc1Level: 0.7, osc2Wave: 'saw', osc2Level: 0.7, osc2Fine: -8, osc3Wave: 'saw', osc3Level: 0.25, osc3Octave: 1,
    unison: 3, unisonDetune: 18, unisonSpread: 0.9, filterType: 'lp24', cutoff: 3000, resonance: 0.05, ...fenv(0.5, 0.4, 1, 0.6, 0.8),
    ...env(0.45, 0.5, 0.9, 0.9), ...vib(0.006, 5, 0.8), polyphony: 8, gain: 0.45,
  })),
  'choir-pad': P('Choir Pad', 'Pad', ['pad', 'chords'], ['cinematic', 'gospel', 'ambient', 'trance', 'epic'], synth({
    osc1Wave: 'saw', osc1Level: 0.7, osc2Wave: 'saw', osc2Level: 0.7, osc2Fine: 10, unison: 3, unisonDetune: 22, unisonSpread: 0.8,
    filterType: 'bp', cutoff: 950, resonance: 0.25, keytrack: 0.4, fEnvAmount: 0, ...env(0.6, 0.5, 0.9, 1.2),
    lfo1Target: 'filter', lfo1Rate: 0.2, lfo1Depth: 0.04, ...vib(0.005, 4.8, 0.6, 2), polyphony: 8, gain: 0.95,
  })),
  'ambient-pad': P('Ambient Pad', 'Pad', ['pad'], ['ambient', 'chillout', 'cinematic', 'downtempo', 'lofi'], synth({
    osc1Wave: 'triangle', osc1Level: 0.6, osc2Wave: 'saw', osc2Level: 0.3, osc2Octave: 1, osc2Fine: 7, noiseLevel: 0.05, noiseType: 'pink',
    unison: 3, unisonDetune: 25, unisonSpread: 1, filterType: 'lp24', cutoff: 2000, resonance: 0.3, ...fenv(1.5, 3, 3, 0.4, 2),
    ...env(2.5, 2, 0.9, 3), lfo1Target: 'filter', lfo1Rate: 0.1, lfo1Depth: 0.15, lfo2Target: 'pan', lfo2Rate: 0.15, lfo2Depth: 0.5,
    polyphony: 8, gain: 0.55,
  })),
  'dark-pad': P('Dark Pad', 'Pad', ['pad'], ['cinematic', 'techno', 'darksynth', 'ambient', 'trap', 'horror'], synth({
    osc1Wave: 'saw', osc1Level: 0.7, osc2Wave: 'square', osc2Level: 0.5, osc2Octave: -1, unison: 2, unisonDetune: 10, unisonSpread: 0.6,
    filterType: 'lp24', cutoff: 500, resonance: 0.3, ...fenv(1, 1.5, 2, 0.4, 1.5), ...env(1.2, 1, 0.9, 2),
    lfo1Target: 'filter', lfo1Rate: 0.08, lfo1Depth: 0.1, polyphony: 8, gain: 0.65,
  })),
  'glass-pad': P('Glass Pad', 'Pad', ['pad', 'chords'], ['ambient', 'pop', 'future-garage', 'chillout', 'cinematic'], synth({
    osc1Wave: 'triangle', osc1Level: 0.6, osc2Wave: 'sine', osc2Level: 0.35, osc2Octave: 2, osc3Wave: 'pulse', osc3Width: 0.1, osc3Level: 0.15, osc3Octave: 1,
    filterType: 'hp12', cutoff: 300, resonance: 0.1, fEnvAmount: 0, ...env(0.3, 1, 0.8, 1.5),
    lfo1Target: 'oscmix', lfo1Rate: 0.3, lfo1Depth: 0.5, ...vib(0.004, 4.5, 0.5, 2), polyphony: 8, gain: 0.6,
  })),
  'supersaw-pad': P('Supersaw Pad', 'Pad', ['pad', 'chords'], ['trance', 'edm', 'future-bass', 'progressive-house', 'synthwave'], synth({
    osc1Wave: 'supersaw', osc1Level: 0.8, superDetune: 0.55, unisonSpread: 1, filterType: 'lp24', cutoff: 2500, resonance: 0.1,
    ...fenv(0.6, 0.5, 1.2, 0.6, 1), ...env(0.6, 1, 0.9, 1.5), polyphony: 8, gain: 0.45,
  })),
  strings: P('Strings', 'Orchestral', ['pad', 'chords', 'lead'], ['cinematic', 'classical', 'pop', 'ballad', 'disco', 'rnb'], synth({
    osc1Wave: 'saw', osc1Level: 0.7, osc2Wave: 'saw', osc2Level: 0.6, osc2Fine: 6, unison: 3, unisonDetune: 15, unisonSpread: 0.8,
    filterType: 'lp24', cutoff: 2400, resonance: 0.05, velToFilter: 0.5, ...fenv(0.6, 0.3, 0.6, 0.7, 0.5),
    ...env(0.25, 0.4, 0.9, 0.6), ...vib(0.006, 5.2, 0.5), polyphony: 10, gain: 0.48,
  })),
  'brass-section': P('Brass Section', 'Orchestral', ['chords', 'lead'], ['funk', 'soul', 'cinematic', 'disco', 'pop', 'jazz', 'latin'], synth({
    osc1Wave: 'saw', osc1Level: 0.8, osc2Wave: 'saw', osc2Level: 0.7, osc2Fine: 9, unison: 2, unisonDetune: 12, unisonSpread: 0.6,
    filterType: 'lp24', cutoff: 600, resonance: 0.1, velToFilter: 0.6, ...fenv(3.2, 0.08, 0.35, 0.5, 0.2),
    ...env(0.05, 0.3, 0.85, 0.2), polyphony: 8, gain: 0.52,
  })),
  'synthwave-pad': P('Synthwave Pad', 'Pad', ['pad', 'chords'], ['synthwave', 'retrowave', 'outrun', '80s', 'pop'], synth({
    osc1Wave: 'saw', osc1Level: 0.7, osc2Wave: 'saw', osc2Level: 0.7, osc2Fine: 12, osc3Wave: 'square', osc3Level: 0.2, osc3Octave: -1,
    unison: 2, unisonDetune: 10, unisonSpread: 0.8, filterType: 'lp24', cutoff: 1800, resonance: 0.25, ...fenv(1.2, 0.5, 1.5, 0.5, 1),
    ...env(0.4, 1, 0.85, 1.5), lfo1Target: 'pitch', lfo1Rate: 0.3, lfo1Depth: 0.004, polyphony: 8, gain: 0.5,
  })),

  /* --------------------------- CHORDS / PLUCK ----------------------- */
  pluck: P('Pluck', 'Pluck', ['chords', 'arp', 'lead'], ['house', 'edm', 'future-bass', 'tropical-house', 'pop', 'trance'], synth({
    osc1Wave: 'saw', osc1Level: 0.7, osc2Wave: 'square', osc2Level: 0.4, osc2Fine: 7, filterType: 'lp24', cutoff: 600, resonance: 0.3,
    ...fenv(4, 0.001, 0.2, 0, 0.2), ...env(0.001, 0.4, 0, 0.3), polyphony: 8, gain: 0.7,
  })),
  'house-stab': P('House Stab', 'Pluck', ['chords'], ['house', 'deep-house', 'garage', 'techno', 'disco'], synth({
    osc1Wave: 'saw', osc1Level: 0.7, osc2Wave: 'saw', osc2Level: 0.7, osc2Fine: 10, unison: 2, unisonDetune: 12, unisonSpread: 0.6,
    filterType: 'lp24', cutoff: 900, resonance: 0.35, ...fenv(3, 0.001, 0.15, 0.1, 0.15), ...env(0.002, 0.25, 0.1, 0.15),
    polyphony: 8, gain: 0.6,
  })),
  'future-chords': P('Future Chords', 'Pluck', ['chords'], ['future-bass', 'edm', 'pop', 'kpop', 'melodic-dubstep'], synth({
    osc1Wave: 'supersaw', osc1Level: 0.8, superDetune: 0.3, unisonSpread: 0.9, osc2Wave: 'square', osc2Level: 0.3, osc2Octave: -1,
    filterType: 'lp24', cutoff: 1200, resonance: 0.25, ...fenv(2.5, 0.002, 0.35, 0.3, 0.3), ...env(0.003, 0.5, 0.6, 0.3),
    lfo1Target: 'pitch', lfo1Rate: 5.5, lfo1Depth: 0.006, lfo1Fade: 0.3, polyphony: 8, gain: 0.5,
  })),
  'guitar-clean': P('Clean Guitar', 'Guitar', ['chords', 'arp', 'lead'], ['pop', 'indie', 'funk', 'rnb', 'country', 'reggae', 'lofi', 'rock'], synth({
    osc1Wave: 'saw', osc1Level: 0.5, osc2Wave: 'pulse', osc2Width: 0.3, osc2Level: 0.4, osc2Fine: 4,
    filterType: 'lp12', cutoff: 1800, resonance: 0.2, keytrack: 0.7, velToFilter: 0.6, ...fenv(2, 0.001, 0.3, 0.1, 0.2),
    ...env(0.002, 2.0, 0, 0.25), pitchEnvAmt: 0.15, pitchEnvDecay: 0.02, polyphony: 8, toneCut: 5000, gain: 0.75,
  })),
  'guitar-dist': P('Distorted Guitar', 'Guitar', ['chords', 'lead'], ['rock', 'metal', 'punk', 'grunge', 'synthwave', 'industrial'], synth({
    osc1Wave: 'saw', osc1Level: 0.7, osc2Wave: 'pulse', osc2Width: 0.35, osc2Level: 0.5, osc2Fine: 8, osc3Wave: 'saw', osc3Level: 0.3, osc3Octave: -1,
    filterType: 'lp12', cutoff: 2200, resonance: 0.45, keytrack: 0.3, ...fenv(0.8, 0.002, 0.4, 0.6, 0.2),
    ...env(0.003, 3, 0.7, 0.15), ...vib(0.01, 5.5, 0.8), polyphony: 6, drive: 0.9, toneCut: 3800, gain: 0.42,
  })),
  'power-chord': P('Power Chord', 'Guitar', ['chords'], ['rock', 'metal', 'punk', 'grunge'], synth({
    osc1Wave: 'saw', osc1Level: 0.7, osc2Wave: 'saw', osc2Level: 0.6, osc2Semi: 7, osc2Fine: 3, osc3Wave: 'saw', osc3Level: 0.4, osc3Octave: -1,
    filterType: 'lp24', cutoff: 2500, resonance: 0.2, fEnvAmount: 0.6, ...env(0.003, 2, 0.8, 0.2),
    polyphony: 4, drive: 0.85, toneCut: 3500, gain: 0.4,
  })),
  harp: P('Harp', 'Orchestral', ['arp', 'chords'], ['cinematic', 'classical', 'ambient', 'pop', 'fantasy'], synth({
    osc1Wave: 'triangle', osc1Level: 0.8, osc2Wave: 'sine', osc2Level: 0.3, osc2Octave: 1, filterType: 'lp12', cutoff: 2500, resonance: 0.1,
    keytrack: 0.6, ...fenv(1.5, 0.001, 0.3, 0, 0.5), ...env(0.002, 2.5, 0, 1.2), velToAmp: 0.7, polyphony: 12, gain: 0.75,
  })),
  koto: P('Koto', 'Pluck', ['lead', 'arp'], ['world', 'japanese', 'lofi', 'cinematic', 'trap'], synth({
    osc1Wave: 'saw', osc1Level: 0.5, osc2Wave: 'pulse', osc2Width: 0.15, osc2Level: 0.5, filterType: 'lp24', cutoff: 1500, resonance: 0.4,
    keytrack: 0.7, ...fenv(3, 0.001, 0.12, 0.05, 0.3), ...env(0.001, 1.2, 0, 0.5), pitchEnvAmt: 0.4, pitchEnvDecay: 0.05,
    polyphony: 8, gain: 0.65,
  })),
  'steel-drum': P('Steel Drum', 'Pluck', ['lead', 'arp'], ['caribbean', 'tropical-house', 'calypso', 'pop', 'reggae'], fm({
    algorithm: 5, ...op(1, 2, 0.3, 0.001, 0.25, 0, 0.2), ...op(2, 1, 0.9, 0.001, 0.9, 0, 0.3),
    ...op(3, 3.01, 0.15, 0.001, 0.3, 0, 0.2), ...op(4, 2.01, 0.25, 0.001, 0.6, 0, 0.3),
    keyScale: 0.4, gain: 0.85,
  })),
  kalimba: P('Kalimba', 'Pluck', ['arp', 'lead'], ['afrobeat', 'world', 'lofi', 'ambient', 'tropical-house', 'pop'], fm({
    algorithm: 5, ...op(1, 7, 0.2, 0.001, 0.05, 0, 0.05), ...op(2, 1, 0.9, 0.001, 1.4, 0, 0.5),
    ...op(3, 1, 0, 0.001, 0.1, 0, 0.1), ...op(4, 5.4, 0.1, 0.001, 0.15, 0, 0.1),
    keyScale: 0.5, gain: 0.95,
  })),

  /* ------------------------------ ARP -------------------------------- */
  'arp-pluck': P('Arp Pluck', 'Arp', ['arp'], ['trance', 'synthwave', 'edm', 'house', 'techno', 'pop'], synth({
    osc1Wave: 'square', osc1Level: 0.6, osc2Wave: 'saw', osc2Level: 0.5, osc2Fine: 8, filterType: 'lp24', cutoff: 900, resonance: 0.35,
    ...fenv(3, 0.001, 0.15, 0, 0.15), ...env(0.001, 0.25, 0, 0.15), polyphony: 8, gain: 0.7,
  })),
  'arp-saw': P('Arp Saw', 'Arp', ['arp'], ['synthwave', 'trance', 'electro', 'edm', 'techno'], synth({
    osc1Wave: 'saw', osc1Level: 0.8, unison: 2, unisonDetune: 10, unisonSpread: 0.6, filterType: 'lp24', cutoff: 2500, resonance: 0.3,
    ...fenv(1.5, 0.001, 0.2, 0.3, 0.1), ...env(0.002, 0.2, 0.5, 0.1), polyphony: 8, gain: 0.6,
  })),

  /* ------------------------------ FX --------------------------------- */
  riser: P('Riser', 'FX', ['fx'], ['edm', 'trance', 'house', 'dubstep', 'future-bass', 'cinematic'], synth({
    osc1Wave: 'supersaw', osc1Level: 0.6, superDetune: 0.6, noiseLevel: 0.4, filterType: 'lp24', cutoff: 300, resonance: 0.5,
    ...fenv(6, 4, 0.1, 1, 0.5), ...env(3, 0.1, 1, 0.5), pitchEnvAmt: -12, pitchEnvDecay: 5, polyphony: 4, gain: 0.5,
  })),
  'noise-sweep': P('Noise Sweep', 'FX', ['fx'], ['edm', 'house', 'techno', 'trance', 'dubstep'], synth({
    osc1Level: 0, noiseLevel: 1, filterType: 'bp', cutoff: 400, resonance: 0.45, keytrack: 0, ...fenv(5, 2, 2, 0, 1),
    ...env(1, 2, 0.3, 1), lfo1Target: 'pan', lfo1Rate: 0.5, lfo1Depth: 0.6, polyphony: 2, gain: 1.8,
  })),
  laser: P('Laser', 'FX', ['fx'], ['electro', 'dubstep', 'chiptune', 'edm', 'dancehall'], synth({
    osc1Wave: 'square', osc1Level: 0.7, filterType: 'lp24', cutoff: 5000, resonance: 0.4, ...fenv(-2, 0.001, 0.2, 0, 0.1),
    pitchEnvAmt: 36, pitchEnvDecay: 0.25, ...env(0.001, 0.35, 0, 0.1), polyphony: 4, gain: 0.5,
  })),

  /* ------------------------------ EXTRAS ----------------------------- */
  'detuned-pad': P('Detuned Pad', 'Pad', ['pad'], ['lofi', 'ambient', 'vaporwave', 'chillout'], synth({
    osc1Wave: 'saw', osc1Level: 0.6, osc2Wave: 'triangle', osc2Level: 0.6, osc2Fine: -14, filterType: 'lp12', cutoff: 1100, resonance: 0.1,
    fEnvAmount: 0.4, ...env(0.9, 1, 0.9, 1.6), lfo1Target: 'pitch', lfo1Rate: 0.6, lfo1Depth: 0.006, polyphony: 8, toneCut: 5000, gain: 0.6,
  })),
  'rave-stab': P('Rave Stab', 'Pluck', ['chords'], ['rave', 'breakbeat', 'hardcore', 'jungle', 'techno'], organ({
    db1: 0, db2: 0, db3: 8, db4: 8, db5: 6, db6: 8, db7: 0, db8: 4, db9: 6, perc: true, percHarmonic: 'second', percDecay: 0.18,
    vibrato: 'off', rotary: 'off', click: 0.6, attack: 0.002, release: 0.12, drive: 0.4, gain: 0.55,
  })),
  'tine-bass': P('Tine Bass', 'Bass', ['bass'], ['house', 'deep-house', 'garage', 'rnb'], fm({
    algorithm: 1, feedback: 0.15, ...op(1, 1, 0.1, 0.001, 0.2, 0, 0.1), ...op(2, 2, 0.15, 0.001, 0.3, 0.1, 0.1),
    ...op(3, 1, 0.35, 0.001, 0.25, 0.15, 0.1), ...op(4, 1, 1, 0.001, 0.8, 0.5, 0.08), polyphony: 2, gain: 0.95,
  })),
};

/* ------------------------------------------------------------------ */
/* Resolution                                                           */
/* ------------------------------------------------------------------ */

function mergeParams(type, ...layers) {
  const out = {};
  for (const l of layers) {
    if (!l || typeof l !== 'object') continue;
    for (const [k, v] of Object.entries(l)) {
      if (v === undefined) continue;
      if (k === 'pads' && type === 'drums' && v && typeof v === 'object') {
        const pads = { ...(out.pads || {}) };
        for (const [pk, pv] of Object.entries(v)) pads[pk] = { ...(pads[pk] || {}), ...(pv || {}) };
        out.pads = pads;
      } else out[k] = v;
    }
  }
  return out;
}

/**
 * Merge defaults ← preset ← def.params. If def.type mismatches the preset's type, the preset wins.
 * Returns { type, params } with all params sanitized (numbers clamped, enums validated).
 */
export function resolveInstrumentDef(def) {
  const d = def || {};
  const preset = d.preset ? PRESETS[d.preset] : null;
  let type = preset ? preset.instrument.type : d.type;
  if (!INSTRUMENT_DEFS[type]) type = 'synth';
  let params = mergeParams(type, getParamDefaults(type), preset?.instrument.params, d.params);
  // Drum tracks store their kit id in `preset`; an explicit params.kit still wins.
  if (type === 'drums' && !d.params?.kit && d.preset && DRUM_KITS[d.preset]) params = { ...params, kit: d.preset };
  return { type, params: sanitizeParams(type, params) };
}

export const PRESET_CATEGORIES = ['Bass', 'Lead', 'Keys', 'Pad', 'Pluck', 'Arp', 'FX', 'Orchestral', 'Guitar'];

/** Filter presets: listPresets({category, role, genre, type}) -> [{id, ...preset}] */
export function listPresets(filter = {}) {
  const { category, role, genre, type } = filter || {};
  return Object.entries(PRESETS)
    .filter(([, p]) => (!category || p.category === category)
      && (!role || p.roles.includes(role))
      && (!genre || p.genres.includes(genre))
      && (!type || p.instrument.type === type))
    .map(([id, p]) => ({ id, ...p }));
}
