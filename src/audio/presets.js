// Instrument presets (pure data, Node-safe) + preset/def resolution.
// PRESETS[id] = { name, category, roles[], genres[], instrument:{type, params} }
import { getParamDefaults, sanitizeParams, INSTRUMENT_DEFS } from './defs.js';
import { DRUM_KITS } from './kits.js';
import { STRUDEL_PATCHES } from './strudel-patches.js';
import { EXTRA_PRESETS, EXTRA_LEVEL_DB } from './presets-extra.js';
import { WAVETABLE_PRESETS } from './wavetable/presets.js';

// osc 2's def default is +7 ct (a detuned layer for the init patch); presets state their tuning explicitly
const synth = (params) => ({ type: 'synth', params: { osc2Fine: 0, ...params } });
const fm = (params) => ({ type: 'fm', params });
const organ = (params) => ({ type: 'organ', params });
const P = (name, category, roles, genres, instrument) => ({ name, category, roles, genres, instrument });

// common building blocks
const vib = (depth = 0.01, rate = 5.5, fade = 0.4, k = 1) => ({
  [`lfo${k}Target`]: 'pitch', [`lfo${k}Shape`]: 'sine', [`lfo${k}Rate`]: rate, [`lfo${k}Depth`]: depth, [`lfo${k}Fade`]: fade,
});
const pwm = (depth = 0.3, rate = 0.6, k = 2) => ({ [`lfo${k}Target`]: 'pwm', [`lfo${k}Shape`]: 'triangle', [`lfo${k}Rate`]: rate, [`lfo${k}Depth`]: depth });
const env = (attack, decay, sustain, release) => ({ attack, decay, sustain, release });
const fenv = (fEnvAmount, fAttack, fDecay, fSustain, fRelease = 0.3) => ({ fEnvAmount, fAttack, fDecay, fSustain, fRelease });
const op = (i, ratio, level, a, d, s, r, extra = {}) => ({
  [`op${i}Ratio`]: ratio, [`op${i}Level`]: level, [`op${i}Attack`]: a, [`op${i}Decay`]: d, [`op${i}Sustain`]: s, [`op${i}Release`]: r,
  ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`op${i}${k[0].toUpperCase()}${k.slice(1)}`, v])),
});

/* ---- Yamaha DX7 operator -> 4-op FM params (envelope maths from MSFA / Dexed: env.cc) ----
 * levels: 0.75 dB per step (scaleoutlevel), full-level modulator = ±4π rad of phase deviation;
 * rates:  qrate = R*41/64 + rate scaling(C4); speed = (4 + (q&3)) * 2^(q>>2) * 0.010514 octaves/s.
 * The attack is the log-domain "jump" curve (~1.64 / speed s). Decay 1 goes to L2 dB-linearly,
 * Decay 2 approaches L3 exponentially, release is exponential.  o = { r:[R1..R4], l:[L1..L4],
 * ol, ratio, det (−7..7), kvs (0..7), rs (0..7) }, carrier = audible operator. */
const DX_LUT = [0, 5, 9, 13, 17, 20, 23, 25, 27, 29, 31, 33, 35, 37, 39, 41, 42, 43, 45, 46];
const dxSo = (L) => (L >= 20 ? 28 + L : DX_LUT[Math.max(0, L)]);
const dxSpeed = (R, rs) => { const x = Math.min(31, Math.max(0, Math.floor(60 / 3) - 7)); const q = Math.min(63, ((R * 41) >> 6) + ((rs * x) >> 3)); return (4 + (q & 3)) * 2 ** (q >> 2) * 0.010514; };
const r3 = (x) => Math.round(x * 1000) / 1000;
function dx(i, o, carrier) {
  const rs = o.rs ?? 0;
  const [s1, s2, s3, s4] = o.r.map((R) => dxSpeed(R, rs));
  const [L1, L2, L3] = o.l.map(dxSo);
  const steps = 127 - dxSo(o.ol) + (127 - L1);
  const level = carrier ? 2 ** (-steps / 8) : 2 ** (-steps / 16); // modulators: index = level² · 4π
  const tau = (sp) => 1 / (sp * Math.LN2);
  const sus = o.l[2] === 0 ? 0 : 2 ** (-(L1 - L3) / 8);
  const out = { ratio: o.ratio, level: r3(Math.min(1, level)), a: r3(Math.max(0.001, Math.min(20, 1.64 / s1))), r: r3(Math.min(10, 6 * tau(s4))) };
  if (L1 - L2 > 1) {
    out.d = r3(Math.min(20, Math.max(0.002, ((L1 - L2) * 0.125) / s2)));
    out.extra = { break: r3(2 ** (-(L1 - L2) / 8)), decay2: r3(Math.min(30, 4 * tau(s3))) };
    out.s = r3(sus);
  } else {
    out.d = r3(Math.min(20, 4 * tau(s3)));
    out.s = r3(sus);
    out.extra = {};
  }
  if (o.det) out.extra.fine = o.det;
  out.extra.vel = r3((o.kvs ?? 0) / 7);
  return op(i, out.ratio, out.level, out.a, out.d, out.s, out.r, out.extra);
}

export const PRESETS = {
  /* ------------------------------ BASS ------------------------------ */
  'sub-bass': P('Sub Bass', 'Bass', ['bass'], ['trap', 'dubstep', 'dnb', 'hiphop', 'edm', 'garage', 'house', 'drill'], synth({
    osc1Wave: 'sine', osc1Level: 0.95, osc2Wave: 'triangle', osc2Level: 0.08, filterType: 'off',
    ...env(0.006, 0.5, 1, 0.12), velToAmp: 0.25, mono: true, glide: 0.03, analog: 0, drive: 0.15, driveType: 'tube', gain: 1.05,
  })),
  '808-bass': P('808 Bass', 'Bass', ['bass'], ['trap', 'hiphop', 'drill', 'phonk', 'reggaeton', 'rnb'], synth({
    osc1Wave: 'sine', osc1Level: 0.95, filterType: 'off', pitchEnvAmt: 7, pitchEnvDecay: 0.06,
    ...env(0.002, 1.8, 0.35, 0.35), velToAmp: 0.3, mono: true, legato: true, glide: 0.09, analog: 0,
    drive: 0.45, driveType: 'tube', toneCut: 7000, gain: 0.95,
  })),
  // Reese: two saws a few cents apart through a ladder low-pass (Surge "Reese" init recipe)
  'reese-bass': P('Reese Bass', 'Bass', ['bass'], ['dnb', 'jungle', 'dubstep', 'garage', 'techno'], synth({
    osc1Wave: 'saw', osc1Level: 0.75, osc2Wave: 'saw', osc2Level: 0.75, osc1Fine: -14, osc2Fine: 14,
    unison: 2, unisonDetune: 10, unisonSpread: 0.35, subLevel: 0.5,
    filterType: 'lp24', cutoff: 950, resonance: 0.2, keytrack: 0.2, filterDrive: 0.35, ...fenv(0.6, 0.01, 0.4, 0.6),
    ...env(0.01, 0.5, 1, 0.18), lfo1Target: 'filter', lfo1Rate: 0.3, lfo1Depth: 0.07,
    mono: true, glide: 0.04, analog: 0.3, drive: 0.25, gain: 0.8,
  })),
  // TB-303: one saw, resonant 24 dB ladder, short accent-y filter env, slide (glide) on legato notes
  'acid-bass': P('Acid Bass', 'Bass', ['bass'], ['acid', 'techno', 'house', 'trance', 'breaks'], synth({
    osc1Wave: 'saw', osc1Level: 0.9, filterType: 'lp24', cutoff: 300, resonance: 0.86, keytrack: 0.25, velToFilter: 0.7, filterDrive: 0.45,
    ...fenv(4.5, 0.002, 0.22, 0, 0.1), ...env(0.002, 0.3, 0.9, 0.06), velToAmp: 0.4,
    mono: true, legato: true, glide: 0.07, analog: 0.15, drive: 0.35, driveType: 'tube', gain: 0.8,
  })),
  'pluck-bass': P('Pluck Bass', 'Bass', ['bass'], ['house', 'deep-house', 'pop', 'future-bass', 'garage', 'funk'], synth({
    osc1Wave: 'saw', osc1Level: 0.7, osc1Fine: -3, osc2Wave: 'square', osc2Level: 0.45, osc2Fine: 3, subLevel: 0.35,
    filterType: 'lp24', cutoff: 280, resonance: 0.3, filterDrive: 0.25, ...fenv(3.6, 0.001, 0.16, 0, 0.1),
    ...env(0.002, 0.38, 0, 0.1), mono: true, analog: 0.2, drive: 0.1, gain: 0.9,
  })),
  // DX7 ROM1A "BASS 1" folded to 4 operators (op4←op3←op2 chain + op1 click), voiced at key pitch
  'fm-bass': P('FM Bass', 'Bass', ['bass'], ['funk', 'synthwave', 'pop', 'house', 'dubstep', 'electro'], fm({
    algorithm: 3, feedback: 0.55,
    ...dx(1, { r: [90, 42, 7, 55], l: [90, 30, 0, 0], ol: 93, ratio: 10, kvs: 5, rs: 5 }),
    ...dx(2, { r: [88, 96, 32, 30], l: [79, 65, 0, 0], ol: 99, ratio: 1, kvs: 3, rs: 6 }),
    ...dx(3, { r: [99, 20, 0, 0], l: [99, 0, 0, 0], ol: 80, ratio: 1, kvs: 0, rs: 7 }),
    ...dx(4, { r: [95, 62, 17, 58], l: [99, 95, 32, 0], ol: 99, ratio: 1, kvs: 0, rs: 7 }, true),
    keyScale: 0.6, polyphony: 2, drive: 0.1, gain: 0.85,
  })),
  'wobble-bass': P('Wobble Bass', 'Bass', ['bass'], ['dubstep', 'riddim', 'brostep', 'edm'], synth({
    osc1Wave: 'saw', osc1Level: 0.8, osc1Fine: -5, osc2Wave: 'square', osc2Level: 0.6, osc2Fine: 5, subLevel: 0.6,
    unison: 2, unisonDetune: 12, unisonSpread: 0.3,
    filterType: 'lp24', cutoff: 230, resonance: 0.55, keytrack: 0.2, fEnvAmount: 0, filterDrive: 0.5,
    ...env(0.005, 0.4, 1, 0.12),
    lfo1Target: 'filter', lfo1Shape: 'sine', lfo1Sync: true, lfo1Div: '1/8', lfo1Depth: 0.55,
    mono: true, glide: 0.05, analog: 0.1, drive: 0.5, gain: 0.75,
  })),
  // Minimoog: 3 VCOs (saw, square, saw −1 oct) into an overdriven 24 dB ladder
  'moog-bass': P('Moog Bass', 'Bass', ['bass'], ['funk', 'synthwave', 'disco', 'pop', 'rock', 'electro'], synth({
    osc1Wave: 'saw', osc1Level: 0.8, osc1Fine: 3, osc2Wave: 'square', osc2Level: 0.6, osc2Fine: -3, osc3Wave: 'saw', osc3Level: 0.5, osc3Octave: -1,
    filterType: 'lp24', cutoff: 480, resonance: 0.35, filterDrive: 0.45, ...fenv(2.6, 0.001, 0.25, 0.2, 0.1),
    ...env(0.002, 0.4, 0.7, 0.08), mono: true, legato: false, glide: 0.02, analog: 0.35, drive: 0.2, driveType: 'tube', gain: 0.75,
  })),
  // plucked-string model (Karplus-Strong) with a dark, short ring + a little triangle body
  'finger-bass': P('Finger Bass', 'Bass', ['bass'], ['funk', 'rock', 'pop', 'soul', 'rnb', 'disco', 'reggae', 'country', 'blues'], synth({
    osc1Wave: 'pluck', osc1Level: 0.9, osc2Wave: 'triangle', osc2Level: 0.35, modelTone: -0.45, modelDecay: 0.7,
    filterType: 'lp12', cutoff: 900, resonance: 0.1, keytrack: 0.5, velToFilter: 0.5, ...fenv(1.2, 0.001, 0.12, 0.2, 0.1),
    ...env(0.002, 1.5, 0.3, 0.08), velToAmp: 0.5, mono: true, legato: false, analog: 0, gain: 1.0,
  })),
  'saw-bass': P('Saw Bass', 'Bass', ['bass'], ['house', 'techno', 'electro', 'edm', 'synthwave'], synth({
    osc1Wave: 'saw', osc1Level: 0.85, subLevel: 0.5, filterType: 'lp24', cutoff: 700, resonance: 0.25, filterDrive: 0.25,
    ...fenv(2, 0.002, 0.25, 0.4, 0.1), ...env(0.003, 0.3, 0.85, 0.08), mono: true, analog: 0.25, drive: 0.15, gain: 0.8,
  })),
  'dub-bass': P('Dub Bass', 'Bass', ['bass'], ['dub', 'reggae', 'dubstep', 'dancehall', 'lofi'], synth({
    osc1Wave: 'sine', osc1Level: 0.9, osc2Wave: 'triangle', osc2Level: 0.45, filterType: 'lp24', cutoff: 420, resonance: 0.1,
    ...fenv(0.6, 0.005, 0.2, 0.5), ...env(0.012, 0.6, 0.9, 0.15), mono: true, glide: 0.04, analog: 0.05, drive: 0.18, driveType: 'tube', gain: 1.0,
  })),
  'upright-bass': P('Upright Bass', 'Bass', ['bass'], ['jazz', 'blues', 'swing', 'lofi', 'country', 'soul'], synth({
    osc1Wave: 'pluck', osc1Level: 0.95, osc2Wave: 'sine', osc2Level: 0.3, modelTone: -0.7, modelDecay: 1.1,
    filterType: 'lp12', cutoff: 650, resonance: 0.05, keytrack: 0.6, velToFilter: 0.5, ...fenv(1.0, 0.001, 0.08, 0.3, 0.1),
    ...env(0.003, 2.2, 0.25, 0.14), pitchEnvAmt: 0.25, pitchEnvDecay: 0.03, polyphony: 2, analog: 0, gain: 1.05,
  })),
  'chip-bass': P('Chip Bass', 'Bass', ['bass'], ['chiptune', 'video-game', 'electro'], synth({
    osc1Wave: 'triangle', osc1Level: 0.9, osc2Wave: 'pulse', osc2Width: 0.25, osc2Level: 0.15, filterType: 'off',
    ...env(0.001, 0.1, 0.85, 0.03), velToAmp: 0.1, mono: true, analog: 0, gain: 0.9,
  })),
  'synthwave-bass': P('Synthwave Bass', 'Bass', ['bass'], ['synthwave', 'retrowave', 'outrun', 'darksynth', 'pop'], synth({
    osc1Wave: 'saw', osc1Level: 0.8, osc1Fine: -4, osc2Wave: 'saw', osc2Level: 0.6, osc2Fine: 4, subLevel: 0.3,
    filterType: 'lp24', cutoff: 600, resonance: 0.3, filterDrive: 0.3, ...fenv(2.5, 0.001, 0.2, 0.25, 0.1),
    ...env(0.002, 0.25, 0.6, 0.08), polyphony: 4, analog: 0.3, gain: 0.8,
  })),

  /* ------------------------------ LEADS ----------------------------- */
  // JP-8000 supersaw (Szabo detune/mix curves, pitch-tracked HPF) + an octave saw on top
  'supersaw-lead': P('Supersaw Lead', 'Lead', ['lead'], ['trance', 'edm', 'progressive-house', 'big-room', 'future-bass', 'hardstyle'], synth({
    osc1Wave: 'supersaw', osc1Level: 0.9, superDetune: 0.62, superMix: 0.8, unisonSpread: 0.8, osc2Wave: 'saw', osc2Level: 0.2, osc2Octave: 1,
    filterType: 'lp24', cutoff: 6000, resonance: 0.15, ...fenv(1, 0.005, 0.4, 0.6), ...env(0.005, 0.3, 0.9, 0.3),
    ...vib(0.008, 5.5, 0.4), polyphony: 6, analog: 0.15, gain: 0.6,
  })),
  'square-lead': P('Square Lead', 'Lead', ['lead'], ['synthwave', 'pop', 'electro', 'chiptune', 'house'], synth({
    osc1Wave: 'square', osc1Level: 0.75, osc2Wave: 'square', osc2Level: 0.35, osc2Octave: 1, osc2Fine: 4,
    filterType: 'lp24', cutoff: 4000, resonance: 0.2, ...fenv(1.5, 0.003, 0.3, 0.5), ...env(0.004, 0.3, 0.85, 0.15),
    ...vib(0.008, 5.5, 0.5), ...pwm(0.18, 0.5), mono: true, glide: 0.05, analog: 0.2, gain: 0.65,
  })),
  'saw-lead': P('Saw Lead', 'Lead', ['lead'], ['edm', 'electro', 'synthwave', 'house', 'pop', 'trance'], synth({
    osc1Wave: 'saw', osc1Level: 0.8, osc1Fine: -5, osc2Wave: 'saw', osc2Level: 0.6, osc2Fine: 5,
    filterType: 'lp24', cutoff: 3000, resonance: 0.3, filterDrive: 0.3, ...fenv(2, 0.003, 0.4, 0.5), ...env(0.004, 0.3, 0.85, 0.15),
    ...vib(0.008, 5.6, 0.45), mono: true, glide: 0.06, analog: 0.3, drive: 0.15, gain: 0.6,
  })),
  'fm-bell-lead': P('FM Bell Lead', 'Lead', ['lead', 'arp'], ['pop', 'synthwave', 'future-bass', 'ambient', 'kpop', 'lofi'], fm({
    algorithm: 5, ...op(1, 3.5, 0.32, 0.001, 1.0, 0.1, 0.5), ...op(2, 1, 0.9, 0.001, 2.0, 0.2, 0.6),
    ...op(3, 7, 0.18, 0.001, 0.6, 0, 0.4), ...op(4, 2, 0.35, 0.001, 1.2, 0, 0.5),
    vibDepth: 0.08, vibDelay: 0.3, keyScale: 0.4, gain: 0.8,
  })),
  'chip-lead': P('Chip Lead', 'Lead', ['lead', 'arp'], ['chiptune', 'video-game', 'electro', 'pop'], synth({
    osc1Wave: 'pulse', osc1Width: 0.25, osc1Level: 0.8, filterType: 'off', ...env(0.001, 0.2, 0.7, 0.05), velToAmp: 0.1,
    ...vib(0.012, 6, 0.25), polyphony: 4, analog: 0, gain: 0.6,
  })),
  'acid-lead': P('Acid Lead', 'Lead', ['lead'], ['acid', 'techno', 'trance', 'breaks'], synth({
    osc1Wave: 'saw', osc1Level: 0.85, osc2Wave: 'square', osc2Level: 0.3, osc2Octave: -1,
    filterType: 'lp24', cutoff: 650, resonance: 0.72, velToFilter: 0.7, filterDrive: 0.25, ...fenv(4.2, 0.002, 0.18, 0.08, 0.1),
    ...env(0.002, 0.3, 0.7, 0.07), mono: true, glide: 0.07, analog: 0.15, drive: 0.3, driveType: 'tube', gain: 0.6,
  })),
  // hard-synced saw (Prophet-5 / OB-Xd style) with an envelope-opened filter
  'sync-lead': P('Sync Lead', 'Lead', ['lead'], ['electro', 'synthwave', 'rock', 'edm', 'french-house'], synth({
    osc1Wave: 'sync', osc1Width: 0.5, osc1Level: 0.8, osc2Wave: 'saw', osc2Level: 0.4, osc2Fine: 4,
    filterType: 'lp24', cutoff: 1800, resonance: 0.35, ...fenv(2.5, 0.003, 0.5, 0.4, 0.2), ...env(0.003, 0.3, 0.9, 0.15),
    lfo2Target: 'pitch', lfo2Rate: 5.8, lfo2Depth: 0.007, lfo2Fade: 0.5, mono: true, glide: 0.04, analog: 0.2, drive: 0.3, gain: 0.55,
  })),
  'whistle-lead': P('Whistle Lead', 'Lead', ['lead'], ['pop', 'indie', 'lofi', 'tropical-house', 'western'], synth({
    osc1Wave: 'sine', osc1Level: 0.9, noiseLevel: 0.04, noiseType: 'pink', filterType: 'lp12', cutoff: 6000, fEnvAmount: 0,
    ...env(0.05, 0.2, 0.9, 0.2), ...vib(0.01, 5.5, 0.35), mono: true, glide: 0.08, transpose: 12, analog: 0.1, gain: 0.7,
  })),
  // plucked string + a sustaining saw through the guitar amp/cab model
  'guitar-lead': P('Guitar Lead', 'Guitar', ['lead'], ['rock', 'metal', 'blues', 'synthwave', 'pop'], synth({
    osc1Wave: 'pluck', osc1Level: 0.9, modelDecay: 4, modelTone: 0.3, osc2Wave: 'saw', osc2Level: 0.22,
    filterType: 'lp12', cutoff: 4500, resonance: 0.1, keytrack: 0.3, ...fenv(0.6, 0.002, 0.5, 0.6),
    ...env(0.002, 3, 0.75, 0.15), ...vib(0.012, 5.5, 0.6), mono: true, glide: 0.03, analog: 0.15,
    drive: 0.7, driveType: 'amp', toneCut: 7000, gain: 0.45,
  })),
  // analog brass: two saws, slow-attack filter envelope "blat" (OB-Xd / Jupiter brass)
  'brass-lead': P('Brass Lead', 'Lead', ['lead'], ['funk', 'pop', 'soul', 'synthwave', 'cinematic', 'jazz'], synth({
    osc1Wave: 'saw', osc1Level: 0.8, osc1Fine: -3, osc2Wave: 'saw', osc2Level: 0.7, osc2Fine: 3,
    filterType: 'lp24', cutoff: 650, resonance: 0.1, velToFilter: 0.6, filterDrive: 0.2, ...fenv(3, 0.07, 0.35, 0.55, 0.2),
    ...env(0.03, 0.3, 0.85, 0.15), ...vib(0.008, 5.2, 0.5), mono: true, glide: 0.02, analog: 0.35, gain: 0.6,
  })),
  flute: P('Flute', 'Lead', ['lead'], ['cinematic', 'lofi', 'world', 'pop', 'trap', 'ambient', 'classical'], synth({
    osc1Wave: 'triangle', osc1Level: 0.7, osc2Wave: 'sine', osc2Level: 0.15, osc2Octave: 1, noiseLevel: 0.08, noiseType: 'pink',
    filterType: 'lp12', cutoff: 3500, resonance: 0, keytrack: 0.5, ...fenv(0.5, 0.08, 0.3, 0.8), ...env(0.07, 0.2, 0.9, 0.15),
    ...vib(0.009, 5, 0.35), mono: true, glide: 0.03, analog: 0.1, gain: 0.8,
  })),
  'trance-lead': P('Trance Lead', 'Lead', ['lead', 'chords'], ['trance', 'progressive-house', 'edm', 'psytrance'], synth({
    osc1Wave: 'supersaw', osc1Level: 0.85, superDetune: 0.55, superMix: 0.75, unisonSpread: 0.9, osc2Wave: 'saw', osc2Level: 0.3, osc2Octave: 1,
    filterType: 'lp24', cutoff: 7000, resonance: 0.1, ...fenv(0.8, 0.002, 0.3, 0.6), ...env(0.003, 0.2, 0.8, 0.35),
    polyphony: 8, analog: 0.15, gain: 0.55,
  })),
  hoover: P('Hoover', 'Lead', ['lead', 'bass'], ['rave', 'hardcore', 'techno', 'jungle', 'hardstyle', 'gabber'], synth({
    osc1Wave: 'pulse', osc1Width: 0.3, osc1Level: 0.7, osc2Wave: 'saw', osc2Level: 0.6, osc2Octave: -1,
    unison: 3, unisonDetune: 40, unisonSpread: 0.7, filterType: 'lp24', cutoff: 3500, resonance: 0.1, fEnvAmount: 0.5,
    pitchEnvAmt: -7, pitchEnvDecay: 0.3, ...env(0.01, 0.3, 0.9, 0.3), ...pwm(0.35, 0.8, 1),
    mono: true, glide: 0.15, glideAlways: true, analog: 0.2, drive: 0.3, gain: 0.55,
  })),

  /* ------------------------------ KEYS ------------------------------ */
  // DX7 ROM1A "E.PIANO 1": the 14:1 tine pair + the 1:1 body pair (algorithm 5), rate scaling 3
  'electric-piano': P('Electric Piano', 'Keys', ['chords', 'keys'], ['soul', 'rnb', 'jazz', 'neo-soul', 'funk', 'lofi', 'pop', 'gospel'], fm({
    algorithm: 5,
    ...dx(1, { r: [95, 50, 35, 78], l: [99, 75, 0, 0], ol: 58, ratio: 14, kvs: 7, rs: 3 }),
    ...dx(2, { r: [96, 25, 25, 67], l: [99, 75, 0, 0], ol: 99, ratio: 1, det: 3, kvs: 2, rs: 3 }, true),
    ...dx(3, { r: [95, 29, 20, 50], l: [99, 95, 0, 0], ol: 89, ratio: 1, kvs: 6, rs: 3 }),
    ...dx(4, { r: [95, 20, 20, 50], l: [99, 95, 0, 0], ol: 99, ratio: 1, det: -3, kvs: 2, rs: 3 }, true),
    keyScale: 0.6, tremDepth: 0.12, tremRate: 4.2, gain: 0.85,
  })),
  // brighter TX81Z-style variant: more tine, a touch of feedback on the tine modulator
  'fm-epiano': P('FM E-Piano', 'Keys', ['chords', 'keys'], ['pop', 'rnb', 'city-pop', 'synthwave', 'house', 'kpop'], fm({
    algorithm: 5, feedback: 0.15,
    ...dx(1, { r: [95, 50, 35, 78], l: [99, 75, 0, 0], ol: 68, ratio: 14, kvs: 7, rs: 3 }),
    ...dx(2, { r: [96, 25, 25, 67], l: [99, 75, 0, 0], ol: 99, ratio: 1, det: 2, kvs: 2, rs: 3 }, true),
    ...dx(3, { r: [95, 29, 20, 50], l: [99, 95, 0, 0], ol: 84, ratio: 1, kvs: 6, rs: 3 }),
    ...dx(4, { r: [95, 20, 20, 50], l: [99, 95, 0, 0], ol: 99, ratio: 1, det: -2, kvs: 2, rs: 3 }, true),
    keyScale: 0.6, gain: 0.85,
  })),
  // modal piano: inharmonic stiff-string partials, 3-string beating / two-stage decay, hammer
  // felt that brightens with velocity, damper on release (src/audio/dsp/piano.js)
  'grand-piano': P('Grand Piano', 'Keys', ['chords', 'keys'], ['pop', 'classical', 'jazz', 'ballad', 'cinematic', 'gospel', 'rock', 'house'], synth({
    osc1Wave: 'piano', osc1Level: 1, modelTone: 0, modelDecay: 1,
    filterType: 'lp12', cutoff: 5200, resonance: 0, keytrack: 0.55, velToFilter: 0.6, fEnvAmount: 0,
    ...env(0.001, 1, 1, 0.32), velToAmp: 0.75, polyphony: 16, analog: 0, gain: 0.9,
  })),
  'organ-drawbar': P('Drawbar Organ', 'Keys', ['chords', 'keys'], ['gospel', 'jazz', 'soul', 'blues', 'funk', 'reggae', 'house'], organ({
    db1: 8, db2: 8, db3: 8, db4: 0, db5: 0, db6: 0, db7: 0, db8: 0, db9: 0, perc: true, percHarmonic: 'third', percDecay: 0.3,
    vibrato: 'c3', rotary: 'slow', click: 0.35, gain: 0.7,
  })),
  'organ-rock': P('Rock Organ', 'Keys', ['chords', 'keys', 'lead'], ['rock', 'blues', 'psychedelic', 'metal', 'funk'], organ({
    db1: 8, db2: 8, db3: 8, db4: 6, db5: 0, db6: 0, db7: 0, db8: 0, db9: 4, perc: true, percHarmonic: 'third', percDecay: 0.22, percLevel: 0.7,
    vibrato: 'c3', rotary: 'fast', click: 0.5, drive: 0.55, driveType: 'tube', toneCut: 7000, gain: 0.55,
  })),
  // Clavinet: a short, bright struck/plucked string into a resonant "wah"-ish filter envelope
  clav: P('Clavinet', 'Keys', ['chords', 'keys'], ['funk', 'soul', 'disco', 'rock'], synth({
    osc1Wave: 'pluck', osc1Level: 0.9, modelTone: 0.9, modelDecay: 0.45, osc2Wave: 'pulse', osc2Width: 0.12, osc2Level: 0.25,
    filterType: 'lp24', cutoff: 1700, resonance: 0.45, keytrack: 0.6, velToFilter: 0.7, ...fenv(2.5, 0.001, 0.15, 0.25, 0.05),
    ...env(0.001, 0.6, 0.35, 0.05), velToAmp: 0.7, analog: 0, gain: 0.7,
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
  // DX7 ROM1A "TUB BELLS": two 3.5:1 pairs, slightly detuned against each other
  bell: P('Bell', 'Keys', ['lead', 'fx', 'chords'], ['cinematic', 'ambient', 'christmas', 'trap', 'pop', 'classical'], fm({
    algorithm: 5,
    ...dx(1, { r: [98, 12, 71, 28], l: [99, 0, 32, 0], ol: 78, ratio: 3.5, det: 3, rs: 2 }),
    ...dx(2, { r: [95, 33, 71, 25], l: [99, 0, 32, 0], ol: 95, ratio: 1, det: 2, rs: 2 }, true),
    ...dx(3, { r: [98, 12, 71, 28], l: [99, 0, 32, 0], ol: 75, ratio: 3.5, det: -2, rs: 2 }),
    ...dx(4, { r: [95, 33, 71, 25], l: [99, 0, 32, 0], ol: 99, ratio: 1, det: -5, rs: 2 }, true),
    keyScale: 0.45, gain: 0.75,
  })),
  celesta: P('Celesta', 'Keys', ['lead', 'arp', 'chords'], ['cinematic', 'christmas', 'classical', 'ambient', 'lofi'], fm({
    algorithm: 5, ...op(1, 4, 0.2, 0.001, 0.3, 0, 0.2), ...op(2, 1, 0.85, 0.001, 1.3, 0, 0.6),
    ...op(3, 7, 0.1, 0.001, 0.2, 0, 0.2), ...op(4, 2, 0.3, 0.001, 0.8, 0, 0.4),
    keyScale: 0.4, transpose: 12, gain: 0.8,
  })),
  // 8' + 4' plucked registers (bright Karplus-Strong strings, quill-like attack)
  harpsichord: P('Harpsichord', 'Keys', ['chords', 'arp'], ['baroque', 'classical', 'cinematic', 'pop'], synth({
    osc1Wave: 'pluck', osc1Level: 0.85, osc2Wave: 'pluck', osc2Level: 0.45, osc2Octave: 1, modelTone: 1, modelDecay: 0.8,
    filterType: 'hp12', cutoff: 120, resonance: 0, keytrack: 0, fEnvAmount: 0,
    ...env(0.001, 1, 1, 0.12), velToAmp: 0.15, polyphony: 12, analog: 0, gain: 0.55,
  })),
  'music-box': P('Music Box', 'Keys', ['lead', 'arp'], ['lofi', 'ambient', 'cinematic', 'christmas', 'lullaby'], fm({
    algorithm: 5, ...op(1, 5, 0.15, 0.001, 0.2, 0, 0.2), ...op(2, 1, 0.85, 0.001, 1.6, 0, 0.6),
    ...op(3, 1, 0, 0.001, 0.2, 0, 0.2), ...op(4, 4, 0.22, 0.001, 0.6, 0, 0.4),
    keyScale: 0.5, transpose: 12, gain: 0.8,
  })),
  'lofi-keys': P('Lo-Fi Keys', 'Keys', ['chords', 'keys'], ['lofi', 'chillhop', 'hiphop', 'jazz', 'neo-soul'], fm({
    algorithm: 5,
    ...dx(1, { r: [95, 50, 35, 78], l: [99, 75, 0, 0], ol: 50, ratio: 14, kvs: 7, rs: 3 }),
    ...dx(2, { r: [96, 25, 25, 67], l: [99, 75, 0, 0], ol: 99, ratio: 1, det: 3, kvs: 2, rs: 3 }, true),
    ...dx(3, { r: [95, 29, 20, 50], l: [99, 95, 0, 0], ol: 82, ratio: 1, kvs: 6, rs: 3 }),
    ...dx(4, { r: [95, 20, 20, 50], l: [99, 95, 0, 0], ol: 99, ratio: 1, det: -3, kvs: 2, rs: 3 }, true),
    keyScale: 0.6, vibDepth: 0.07, vibRate: 0.9, vibDelay: 0, toneCut: 3200, drive: 0.2, driveType: 'tube', gain: 0.9,
  })),

  /* ------------------------------ PADS ------------------------------ */
  // PADsynth table (ZynAddSubFX) + a quiet detuned saw pair for analog movement
  'warm-pad': P('Warm Pad', 'Pad', ['pad', 'chords'], ['ambient', 'pop', 'lofi', 'house', 'rnb', 'cinematic', 'chillout'], synth({
    osc1Wave: 'pad', osc1Level: 0.9, osc2Wave: 'saw', osc2Level: 0.3, unison: 2, unisonDetune: 12, unisonSpread: 0.7,
    modelTone: 0.25, filterType: 'lp24', cutoff: 3400, resonance: 0.1, keytrack: 0.4, ...fenv(1, 0.8, 1.5, 0.5, 1.2), ...env(0.8, 1, 0.85, 1.4),
    lfo1Target: 'filter', lfo1Rate: 0.25, lfo1Depth: 0.05, polyphony: 8, analog: 0.4, gain: 0.55,
  })),
  // string machine / ensemble: PADsynth "ensemble" table + PWM'd pulse (Juno-ish) + delayed vibrato
  'string-pad': P('String Pad', 'Pad', ['pad', 'chords'], ['cinematic', 'pop', 'ambient', 'trance', 'disco', 'ballad'], synth({
    osc1Wave: 'ensemble', osc1Level: 0.9, osc2Wave: 'pulse', osc2Width: 0.4, osc2Level: 0.35, osc3Wave: 'saw', osc3Level: 0.2, osc3Octave: 1,
    unisonSpread: 0.9, filterType: 'lp24', cutoff: 4500, resonance: 0.05, keytrack: 0.3, ...fenv(0.5, 0.4, 1, 0.6, 0.8),
    ...env(0.45, 0.5, 0.9, 0.9), ...vib(0.005, 5, 0.8), ...pwm(0.35, 0.45), polyphony: 8, analog: 0.3, gain: 0.45,
  })),
  // PADsynth "aah" vowel formants, a touch of delayed vibrato
  'choir-pad': P('Choir Pad', 'Pad', ['pad', 'chords'], ['cinematic', 'gospel', 'ambient', 'trance', 'epic'], synth({
    osc1Wave: 'choir', osc1Level: 1, osc2Wave: 'triangle', osc2Level: 0.12, padWidth: 1.2, unisonSpread: 0.8,
    filterType: 'lp12', cutoff: 5000, resonance: 0, keytrack: 0.3, fEnvAmount: 0, ...env(0.6, 0.5, 0.9, 1.2),
    ...vib(0.005, 4.8, 0.6, 2), polyphony: 8, analog: 0.2, gain: 0.95,
  })),
  'ambient-pad': P('Ambient Pad', 'Pad', ['pad'], ['ambient', 'chillout', 'cinematic', 'downtempo', 'lofi'], synth({
    osc1Wave: 'pad', osc1Level: 0.8, padWidth: 2, modelTone: 0.3, osc2Wave: 'triangle', osc2Level: 0.35, osc2Octave: 1, noiseLevel: 0.04, noiseType: 'pink',
    unisonSpread: 1, filterType: 'lp24', cutoff: 2200, resonance: 0.25, ...fenv(1.5, 3, 3, 0.4, 2),
    ...env(2.5, 2, 0.9, 3), lfo1Target: 'filter', lfo1Rate: 0.1, lfo1Depth: 0.15, lfo2Target: 'pan', lfo2Rate: 0.15, lfo2Depth: 0.5,
    polyphony: 8, analog: 0.3, gain: 0.55,
  })),
  'dark-pad': P('Dark Pad', 'Pad', ['pad'], ['cinematic', 'techno', 'darksynth', 'ambient', 'trap', 'horror'], synth({
    osc1Wave: 'pad', osc1Level: 0.8, modelTone: -0.6, osc2Wave: 'square', osc2Level: 0.4, osc2Octave: -1, unisonSpread: 0.6,
    filterType: 'lp24', cutoff: 900, resonance: 0.25, filterDrive: 0.2, ...fenv(1, 1.5, 2, 0.4, 1.5), ...env(1.2, 1, 0.9, 2),
    lfo1Target: 'filter', lfo1Rate: 0.08, lfo1Depth: 0.1, polyphony: 8, analog: 0.4, gain: 0.65,
  })),
  'glass-pad': P('Glass Pad', 'Pad', ['pad', 'chords'], ['ambient', 'pop', 'future-garage', 'chillout', 'cinematic'], synth({
    osc1Wave: 'triangle', osc1Level: 0.6, osc2Wave: 'sine', osc2Level: 0.35, osc2Octave: 2, osc3Wave: 'pulse', osc3Width: 0.1, osc3Level: 0.15, osc3Octave: 1,
    filterType: 'hp12', cutoff: 300, resonance: 0.1, fEnvAmount: 0, ...env(0.3, 1, 0.8, 1.5),
    lfo1Target: 'oscmix', lfo1Rate: 0.3, lfo1Depth: 0.5, ...vib(0.004, 4.5, 0.5, 2), polyphony: 8, analog: 0.2, gain: 0.6,
  })),
  'supersaw-pad': P('Supersaw Pad', 'Pad', ['pad', 'chords'], ['trance', 'edm', 'future-bass', 'progressive-house', 'synthwave'], synth({
    osc1Wave: 'supersaw', osc1Level: 0.8, superDetune: 0.7, superMix: 0.85, unisonSpread: 1, filterType: 'lp24', cutoff: 4000, resonance: 0.1, keytrack: 0.3,
    ...fenv(0.6, 0.5, 1.2, 0.6, 1), ...env(0.6, 1, 0.9, 1.5), polyphony: 8, analog: 0.2, gain: 0.45,
  })),
  strings: P('Strings', 'Orchestral', ['pad', 'chords', 'lead'], ['cinematic', 'classical', 'pop', 'ballad', 'disco', 'rnb'], synth({
    osc1Wave: 'ensemble', osc1Level: 0.9, osc2Wave: 'saw', osc2Level: 0.35, unison: 3, unisonDetune: 14, unisonSpread: 0.8,
    filterType: 'lp24', cutoff: 4200, resonance: 0.05, keytrack: 0.3, velToFilter: 0.5, ...fenv(0.6, 0.3, 0.6, 0.7, 0.5),
    ...env(0.25, 0.4, 0.9, 0.6), ...vib(0.006, 5.2, 0.5), polyphony: 10, analog: 0.3, gain: 0.48,
  })),
  'brass-section': P('Brass Section', 'Orchestral', ['chords', 'lead'], ['funk', 'soul', 'cinematic', 'disco', 'pop', 'jazz', 'latin'], synth({
    osc1Wave: 'saw', osc1Level: 0.8, osc1Fine: -4, osc2Wave: 'saw', osc2Level: 0.7, osc2Fine: 4, unison: 2, unisonDetune: 10, unisonSpread: 0.6,
    filterType: 'lp24', cutoff: 850, resonance: 0.1, keytrack: 0.4, velToFilter: 0.6, filterDrive: 0.2, ...fenv(3.2, 0.08, 0.35, 0.5, 0.2),
    ...env(0.05, 0.3, 0.85, 0.2), ...vib(0.005, 5.2, 0.6), polyphony: 8, analog: 0.35, gain: 0.52,
  })),
  'synthwave-pad': P('Synthwave Pad', 'Pad', ['pad', 'chords'], ['synthwave', 'retrowave', 'outrun', '80s', 'pop'], synth({
    osc1Wave: 'saw', osc1Level: 0.7, osc1Fine: -6, osc2Wave: 'saw', osc2Level: 0.7, osc2Fine: 6, osc3Wave: 'pulse', osc3Width: 0.45, osc3Level: 0.25, osc3Octave: -1,
    unison: 2, unisonDetune: 8, unisonSpread: 0.8, filterType: 'lp24', cutoff: 3400, resonance: 0.2, keytrack: 0.3, ...fenv(1.2, 0.5, 1.5, 0.5, 1),
    ...env(0.4, 1, 0.85, 1.5), ...pwm(0.3, 0.35), lfo1Target: 'pitch', lfo1Rate: 0.3, lfo1Depth: 0.003, polyphony: 8, analog: 0.35, gain: 0.5,
  })),

  /* --------------------------- CHORDS / PLUCK ----------------------- */
  pluck: P('Pluck', 'Pluck', ['chords', 'arp', 'lead'], ['house', 'edm', 'future-bass', 'tropical-house', 'pop', 'trance'], synth({
    osc1Wave: 'saw', osc1Level: 0.7, osc1Fine: -2, osc2Wave: 'square', osc2Level: 0.4, osc2Fine: 2, unison: 2, unisonDetune: 8, unisonSpread: 0.6,
    filterType: 'lp24', cutoff: 1000, resonance: 0.3, keytrack: 0.4,
    ...fenv(2.8, 0.001, 0.22, 0.1, 0.2), ...env(0.001, 0.5, 0.12, 0.3), polyphony: 8, analog: 0.2, gain: 0.7,
  })),
  'house-stab': P('House Stab', 'Pluck', ['chords'], ['house', 'deep-house', 'garage', 'techno', 'disco'], synth({
    osc1Wave: 'saw', osc1Level: 0.7, osc1Fine: -5, osc2Wave: 'saw', osc2Level: 0.7, osc2Fine: 5, unison: 2, unisonDetune: 12, unisonSpread: 0.6,
    filterType: 'lp24', cutoff: 2200, resonance: 0.25, keytrack: 0.4, ...fenv(2.2, 0.001, 0.18, 0.25, 0.15), ...env(0.002, 0.35, 0.35, 0.16),
    polyphony: 8, analog: 0.2, gain: 0.6,
  })),
  'future-chords': P('Future Chords', 'Pluck', ['chords'], ['future-bass', 'edm', 'pop', 'kpop', 'melodic-dubstep'], synth({
    osc1Wave: 'supersaw', osc1Level: 0.8, superDetune: 0.5, superMix: 0.7, unisonSpread: 0.9, osc2Wave: 'square', osc2Level: 0.3, osc2Octave: -1,
    filterType: 'lp24', cutoff: 2000, resonance: 0.2, keytrack: 0.3, ...fenv(2.5, 0.002, 0.35, 0.3, 0.3), ...env(0.003, 0.5, 0.6, 0.3),
    lfo1Target: 'pitch', lfo1Rate: 5.5, lfo1Depth: 0.005, lfo1Fade: 0.3, polyphony: 8, analog: 0.15, gain: 0.5,
  })),
  // Karplus-Strong steel string into a clean amp + cab
  'guitar-clean': P('Clean Guitar', 'Guitar', ['chords', 'arp', 'lead'], ['pop', 'indie', 'funk', 'rnb', 'country', 'reggae', 'lofi', 'rock'], synth({
    osc1Wave: 'pluck', osc1Level: 1, modelTone: 0.25, modelDecay: 1.2,
    filterType: 'lp12', cutoff: 5000, resonance: 0.05, keytrack: 0.4, velToFilter: 0.4, fEnvAmount: 0,
    ...env(0.001, 1, 1, 0.12), velToAmp: 0.6, polyphony: 8, analog: 0, drive: 0.12, driveType: 'amp', gain: 0.75,
  })),
  // string model with long sustain into a high-gain amp: pre-EQ, asymmetric clipping, 4x12 cab
  'guitar-dist': P('Distorted Guitar', 'Guitar', ['chords', 'lead'], ['rock', 'metal', 'punk', 'grunge', 'synthwave', 'industrial'], synth({
    osc1Wave: 'pluck', osc1Level: 1, modelTone: 0.4, modelDecay: 3, osc2Wave: 'saw', osc2Level: 0.15,
    filterType: 'lp12', cutoff: 6000, resonance: 0, keytrack: 0.2, fEnvAmount: 0,
    ...env(0.002, 3, 0.8, 0.12), ...vib(0.006, 5.5, 0.8), polyphony: 6, analog: 0.1, drive: 0.85, driveType: 'amp', gain: 0.42,
  })),
  'power-chord': P('Power Chord', 'Guitar', ['chords'], ['rock', 'metal', 'punk', 'grunge'], synth({
    osc1Wave: 'pluck', osc1Level: 0.9, osc2Wave: 'pluck', osc2Level: 0.7, osc2Semi: 7, osc3Wave: 'pluck', osc3Level: 0.5, osc3Octave: -1,
    modelTone: 0.3, modelDecay: 3, filterType: 'off', ...env(0.002, 2, 0.85, 0.12),
    polyphony: 4, analog: 0.1, drive: 0.9, driveType: 'amp', gain: 0.4,
  })),
  harp: P('Harp', 'Orchestral', ['arp', 'chords'], ['cinematic', 'classical', 'ambient', 'pop', 'fantasy'], synth({
    osc1Wave: 'pluck', osc1Level: 1, modelTone: -0.2, modelDecay: 1.8, osc2Wave: 'sine', osc2Level: 0.15,
    filterType: 'lp12', cutoff: 3500, resonance: 0, keytrack: 0.6, velToFilter: 0.4, fEnvAmount: 0,
    ...env(0.001, 1, 1, 1.0), velToAmp: 0.7, polyphony: 12, analog: 0, gain: 0.75,
  })),
  koto: P('Koto', 'Pluck', ['lead', 'arp'], ['world', 'japanese', 'lofi', 'cinematic', 'trap'], synth({
    osc1Wave: 'pluck', osc1Level: 1, modelTone: 0.7, modelDecay: 1, osc2Wave: 'pulse', osc2Width: 0.15, osc2Level: 0.15,
    filterType: 'lp24', cutoff: 2500, resonance: 0.3, keytrack: 0.7, ...fenv(2, 0.001, 0.12, 0.2, 0.3),
    ...env(0.001, 1.5, 0.6, 0.4), pitchEnvAmt: 0.3, pitchEnvDecay: 0.05, polyphony: 8, analog: 0, gain: 0.65,
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
    osc1Wave: 'square', osc1Level: 0.6, osc1Fine: -2, osc2Wave: 'saw', osc2Level: 0.55, osc2Fine: 2, unison: 2, unisonDetune: 9, unisonSpread: 0.6,
    filterType: 'lp24', cutoff: 2000, resonance: 0.3, keytrack: 0.5, filterDrive: 0.15,
    ...fenv(2.2, 0.001, 0.18, 0.1, 0.15), ...env(0.001, 0.35, 0.12, 0.18), polyphony: 8, analog: 0.15, gain: 0.7,
  })),
  'arp-saw': P('Arp Saw', 'Arp', ['arp'], ['synthwave', 'trance', 'electro', 'edm', 'techno'], synth({
    osc1Wave: 'saw', osc1Level: 0.8, unison: 3, unisonDetune: 12, unisonSpread: 0.7, filterType: 'lp24', cutoff: 3200, resonance: 0.25, keytrack: 0.4,
    ...fenv(1.5, 0.001, 0.2, 0.3, 0.1), ...env(0.002, 0.2, 0.5, 0.1), polyphony: 8, analog: 0.2, gain: 0.6,
  })),

  /* ------------------------------ FX --------------------------------- */
  riser: P('Riser', 'FX', ['fx'], ['edm', 'trance', 'house', 'dubstep', 'future-bass', 'cinematic'], synth({
    osc1Wave: 'supersaw', osc1Level: 0.6, superDetune: 0.75, noiseLevel: 0.4, filterType: 'lp24', cutoff: 300, resonance: 0.5,
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
    osc1Wave: 'saw', osc1Level: 0.6, osc1Fine: 7, osc2Wave: 'triangle', osc2Level: 0.6, osc2Fine: -7, filterType: 'lp12', cutoff: 1100, resonance: 0.1,
    fEnvAmount: 0.4, ...env(0.9, 1, 0.9, 1.6), lfo1Target: 'pitch', lfo1Rate: 0.6, lfo1Depth: 0.005, polyphony: 8, analog: 0.5, toneCut: 5000, gain: 0.6,
  })),
  'rave-stab': P('Rave Stab', 'Pluck', ['chords'], ['rave', 'breakbeat', 'hardcore', 'jungle', 'techno'], organ({
    db1: 0, db2: 0, db3: 8, db4: 8, db5: 6, db6: 8, db7: 0, db8: 4, db9: 6, perc: true, percHarmonic: 'second', percDecay: 0.18,
    vibrato: 'off', rotary: 'off', click: 0.6, attack: 0.002, release: 0.12, drive: 0.4, gain: 0.55,
  })),
  'tine-bass': P('Tine Bass', 'Bass', ['bass'], ['house', 'deep-house', 'garage', 'rnb'], fm({
    algorithm: 1, feedback: 0.15, ...op(1, 1, 0.1, 0.001, 0.2, 0, 0.1), ...op(2, 2, 0.15, 0.001, 0.3, 0.1, 0.1),
    ...op(3, 1, 0.35, 0.001, 0.25, 0.15, 0.1), ...op(4, 1, 1, 0.001, 0.8, 0.5, 0.08), polyphony: 2, gain: 0.95,
  })),
  // DX7 ROM1A "BRASS 1" (algorithm 22) reduced to 1 feedback modulator -> 3 detuned carriers
  'fm-brass': P('FM Brass', 'Orchestral', ['chords', 'lead'], ['synthwave', 'pop', '80s', 'funk', 'cinematic', 'city-pop'], fm({
    algorithm: 6, feedback: 0.85,
    ...dx(1, { r: [49, 99, 28, 68], l: [98, 98, 91, 0], ol: 82, ratio: 1, kvs: 2, rs: 4 }),
    ...dx(2, { r: [77, 36, 41, 71], l: [99, 98, 98, 0], ol: 98, ratio: 1, det: 1, kvs: 2 }, true),
    ...dx(3, { r: [77, 36, 41, 71], l: [99, 98, 98, 0], ol: 99, ratio: 1, kvs: 2 }, true),
    ...dx(4, { r: [77, 76, 82, 71], l: [99, 98, 98, 0], ol: 99, ratio: 1, det: -2, kvs: 2 }, true),
    vibDepth: 0.05, vibRate: 5.2, vibDelay: 0.4, keyScale: 0.3, polyphony: 8, gain: 0.7,
  })),
  // Juno-106 style strings: one PWM'd pulse per voice, slow attack, chorus-like analog drift
  'juno-strings': P('Juno Strings', 'Pad', ['pad', 'chords'], ['synthwave', '80s', 'house', 'pop', 'ambient', 'deep-house'], synth({
    osc1Wave: 'pulse', osc1Width: 0.5, osc1Level: 0.8, osc1Fine: -2, osc2Wave: 'saw', osc2Level: 0.25, osc2Fine: 3, subLevel: 0.2, unisonSpread: 0.6,
    filterType: 'lp24', cutoff: 3000, resonance: 0.1, keytrack: 0.5, fEnvAmount: 0, ...env(0.35, 1, 0.9, 0.8),
    ...pwm(0.55, 0.7, 1), ...vib(0.004, 5, 0.6, 2), polyphony: 8, analog: 0.5, gain: 0.55,
  })),
};

/* ------------------------------------------------------------------ */
/* Mix trims: low cut for everything that isn't a bass (keeps the low end for kick & bass),     */
/* tamed top end on bright stacks, and loudness normalisation (dB, measured with the QA harness: */
/* K-weighted, gated loudness of a C2..C6 single-note phrase + chords; target -16 LUFS, pads -17.5) */
/* ------------------------------------------------------------------ */
const MIX = {
  'arp-pluck': { lowCut: 150 }, 'arp-saw': { lowCut: 150 }, pluck: { lowCut: 140 }, 'house-stab': { lowCut: 150 },
  'future-chords': { lowCut: 140, toneCut: 14000 }, 'warm-pad': { lowCut: 110 }, 'dark-pad': { lowCut: 90 }, 'ambient-pad': { lowCut: 120 },
  'string-pad': { lowCut: 120 }, 'choir-pad': { lowCut: 140 }, 'glass-pad': { lowCut: 200 }, 'supersaw-pad': { lowCut: 150, toneCut: 13000 },
  'synthwave-pad': { lowCut: 120 }, 'detuned-pad': { lowCut: 120 }, 'juno-strings': { lowCut: 110 }, strings: { lowCut: 110 },
  'brass-section': { lowCut: 100 }, 'fm-brass': { lowCut: 100 }, 'electric-piano': { lowCut: 70 }, 'fm-epiano': { lowCut: 80 },
  'lofi-keys': { lowCut: 90 }, 'grand-piano': { lowCut: 35 }, 'organ-drawbar': { lowCut: 60 }, 'organ-rock': { lowCut: 70 },
  clav: { lowCut: 100 }, vibraphone: { lowCut: 120 }, marimba: { lowCut: 100 }, bell: { lowCut: 150 }, celesta: { lowCut: 150 },
  'music-box': { lowCut: 180 }, harp: { lowCut: 70 }, koto: { lowCut: 120 }, 'steel-drum': { lowCut: 120 }, kalimba: { lowCut: 120 },
  'guitar-clean': { lowCut: 90 }, 'guitar-dist': { lowCut: 90 }, 'power-chord': { lowCut: 80 }, 'guitar-lead': { lowCut: 110 },
  'supersaw-lead': { lowCut: 150, toneCut: 14000 }, 'trance-lead': { lowCut: 150, toneCut: 14000 }, 'square-lead': { lowCut: 140 },
  'saw-lead': { lowCut: 120 }, 'fm-bell-lead': { lowCut: 150 }, 'chip-lead': { lowCut: 150 }, 'acid-lead': { lowCut: 100 },
  'sync-lead': { lowCut: 120 }, 'whistle-lead': { lowCut: 200 }, 'brass-lead': { lowCut: 110 }, flute: { lowCut: 160 },
  hoover: { lowCut: 60 }, 'rave-stab': { lowCut: 120 }, riser: { lowCut: 150 }, 'noise-sweep': { lowCut: 150 }, laser: { lowCut: 120 },
};
/** Loudness trims in dB (generated by the QA harness, see docs/SOUND.md). */
const LEVEL_DB = {
  'sub-bass': -1.6, '808-bass': -3, 'reese-bass': -4.8, 'acid-bass': -1.4, 'pluck-bass': 9.7, 'fm-bass': 3.2, 'wobble-bass': -2.4, 'moog-bass': 3.2, 'finger-bass': 13.4, 'saw-bass': -1.1, 'dub-bass': 3.4, 'upright-bass': 21.7, 'chip-bass': 5.3, 'synthwave-bass': 7, 'supersaw-lead': -1.2, 'square-lead': 6.5, 'saw-lead': -3.2, 'fm-bell-lead': 0.5, 'chip-lead': 3.5, 'acid-lead': -3.7, 'sync-lead': -5.4, 'whistle-lead': 1.8, 'guitar-lead': -4.8, 'brass-lead': 2.2, 'flute': 5.2, 'trance-lead': 0.8, 'hoover': -2.5, 'electric-piano': -3.6, 'fm-epiano': -4.1, 'grand-piano': -6.1, 'organ-drawbar': 0.6, 'organ-rock': -1.3, 'clav': -9.1, 'vibraphone': 1.9, 'marimba': 1, 'bell': -1.9, 'celesta': 1.7, 'harpsichord': -7.1, 'music-box': 2.9, 'lofi-keys': -4.5, 'warm-pad': 7.4, 'string-pad': 5.4, 'choir-pad': 2.4, 'ambient-pad': 5.9, 'dark-pad': -5.8, 'glass-pad': -0.7, 'supersaw-pad': 1, 'strings': 8.4, 'brass-section': -1.4, 'synthwave-pad': 2.2, 'pluck': 3.3, 'house-stab': 4.3, 'future-chords': 3.5, 'guitar-clean': -7.6, 'guitar-dist': -4, 'power-chord': -3.5, 'harp': -6, 'koto': -6.8, 'steel-drum': 3.5, 'kalimba': 1.1, 'arp-pluck': -3, 'arp-saw': 7, 'riser': 5.4, 'noise-sweep': 31, 'laser': 4.2, 'detuned-pad': -0.6, 'rave-stab': -7.2, 'tine-bass': 3.6, 'fm-brass': -6, 'juno-strings': -1.3,
};
for (const [id, m] of Object.entries(MIX)) if (PRESETS[id]) Object.assign(PRESETS[id].instrument.params, m);
// more built-in presets (src/audio/presets-extra.js: their own mix trims; loudness trims below)
for (const [id, pr] of Object.entries(EXTRA_PRESETS)) if (!PRESETS[id]) PRESETS[id] = pr;
for (const [id, db] of [...Object.entries(LEVEL_DB), ...Object.entries(EXTRA_LEVEL_DB)]) {
  const pp = PRESETS[id]?.instrument.params;
  if (pp) pp.gain = Math.round(Math.min(2, Math.max(0.02, (pp.gain ?? 0.8) * 10 ** (db / 20))) * 1000) / 1000;
}

/* Wavetable synth presets (src/audio/wavetable/presets.js) */
Object.assign(PRESETS, WAVETABLE_PRESETS);

/* Strudel patches (src/audio/strudel-patches.js): type 'strudel' presets in the 'Strudel' category; each carries
   the built-in preset that plays when superdough can't (fallbackPreset). */
for (const sp of STRUDEL_PATCHES) {
  PRESETS[sp.id] = {
    name: sp.name, category: 'Strudel', roles: sp.roles, genres: sp.genres, fallbackPreset: sp.fallbackPreset, strudel: true,
    description: `Strudel sound (superdough): ${sp.patch.s}`, instrument: { type: 'strudel', params: { ...sp.patch } },
  };
}

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

export const PRESET_CATEGORIES = ['Bass', 'Lead', 'Keys', 'Pad', 'Pluck', 'Arp', 'FX', 'Orchestral', 'Guitar', 'Strudel'];

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
