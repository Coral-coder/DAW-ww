// Dynamics effect definitions. Receives the ParamDef helpers from effect-defs.js and returns
// { type: { name, category, description, params, presets? } } entries merged into EFFECT_DEFS.
// presets (optional) = { 'Preset name': { paramKey: value, ... } } — same shape as EFFECT_PRESETS.
//
// multiband, transient, deesser, expander, dyneq run in AudioWorklets (src/audio/fx/dynamics-worklet.js);
// lineq and matcheq are linear-phase FIR EQs (ConvolverNode + a kernel designed in src/audio/fx/dsp/fir.js).
// Match EQ keeps its captured spectra in params.refSpectrum / params.curSpectrum (dB on MATCH_FREQS) — extra keys
// outside the ParamDefs, written by its effect card.
import { LATENCY_DEFAULTS } from '../dynamics-latency.js';

// eslint-disable-next-line no-unused-vars
export default function dynamicsDefs({ num, enm, bool, lfoParams, DIVISION_OPTIONS }) {
  const outDb = (o = {}) => num('output', 'Output', -24, 24, 0, { step: 0.1, unit: 'dB', section: 'Output', ...o });
  const mix = (key = 'mix', def = 1) => num(key, 'Mix', 0, 1, def, { step: 0.01, section: 'Output' });
  const hz = (key, label, min, max, def, o = {}) => num(key, label, min, max, def, { step: 1, unit: 'Hz', curve: 'log', ...o });
  const sec = (key, label, min, max, def, o = {}) => num(key, label, min, max, def, { step: 0.0001, unit: 's', curve: 'log', ...o });
  const db = (key, label, min, max, def, o = {}) => num(key, label, min, max, def, { step: 0.1, unit: 'dB', ...o });
  const keyTrack = (label, description) => ({ key: 'sourceTrackId', label, type: 'track', default: '', section: 'Sidechain', description });
  const quality = () => enm('quality', 'Quality', [
    { value: 'low', label: 'Low latency (~21 ms)' }, { value: 'medium', label: 'Medium (~43 ms)' },
    { value: 'high', label: 'High (~85 ms)' }, { value: 'max', label: 'Maximum (~171 ms)' },
  ], LATENCY_DEFAULTS.firQuality, { section: 'Quality' });

  // ------------------------------------------------------------------ multiband compressor
  const MB_THR = [-20, -18, -16, -18], MB_ATT = [0.02, 0.01, 0.005, 0.003], MB_REL = [0.2, 0.15, 0.1, 0.08];
  const mbParams = [
    enm('bands', 'Bands', [{ value: 3, label: '3 bands' }, { value: 4, label: '4 bands' }], 3, { section: 'Crossover' }),
    hz('x1', 'Low / Mid', 40, 1000, 120, { section: 'Crossover' }),
    hz('x2', 'Mid / High', 300, 8000, 2500, { section: 'Crossover' }),
    hz('x3', 'High / Air', 2000, 16000, 8000, { section: 'Crossover' }),
    enm('mode', 'Mode', [
      { value: 'down', label: 'Downward' }, { value: 'up', label: 'Upward' }, { value: 'both', label: 'Up + Down (OTT)' },
    ], 'down', { section: 'Global' }),
    num('depth', 'Depth', 0, 1, 1, { step: 0.01, section: 'Global' }),
    db('input', 'Input', -24, 24, 0, { section: 'Global', advanced: true }),
    num('lookahead', 'Look-ahead', 0, 0.01, LATENCY_DEFAULTS.multibandLookahead, { step: 0.0005, unit: 's', section: 'Global', advanced: true }),
  ];
  for (let k = 1; k <= 4; k++) {
    const section = `Band ${k}`;
    mbParams.push(
      db(`b${k}Thresh`, 'Threshold', -60, 0, MB_THR[k - 1], { section }),
      num(`b${k}Ratio`, 'Ratio', 1, 20, 3, { step: 0.1, curve: 'log', section }),
      db(`b${k}UpThresh`, 'Up Threshold', -80, 0, -40, { section, advanced: true }),
      num(`b${k}UpRatio`, 'Up Ratio', 1, 10, 3, { step: 0.1, curve: 'log', section, advanced: true }),
      sec(`b${k}Attack`, 'Attack', 0.0002, 0.3, MB_ATT[k - 1], { section }),
      sec(`b${k}Release`, 'Release', 0.01, 2, MB_REL[k - 1], { section }),
      db(`b${k}Makeup`, 'Makeup', -12, 24, 0, { section }),
      bool(`b${k}Solo`, 'Solo', false, { section }),
      bool(`b${k}Bypass`, 'Bypass', false, { section, advanced: true }),
    );
  }
  mbParams.push(mix('wetMix', 1), outDb());

  // ------------------------------------------------------------------ dynamic EQ
  const DQ_ON = [false, true, true, false], DQ_TYPE = ['lowshelf', 'peaking', 'peaking', 'highshelf'], DQ_F = [120, 350, 3000, 8000];
  const dqParams = [];
  for (let k = 1; k <= 4; k++) {
    const section = `Band ${k}`;
    dqParams.push(
      bool(`b${k}On`, 'On', DQ_ON[k - 1], { section }),
      enm(`b${k}Type`, 'Type', [{ value: 'peaking', label: 'Bell' }, { value: 'lowshelf', label: 'Low Shelf' }, { value: 'highshelf', label: 'High Shelf' }], DQ_TYPE[k - 1], { section }),
      hz(`b${k}Freq`, 'Freq', 20, 20000, DQ_F[k - 1], { section }),
      db(`b${k}Gain`, 'Static Gain', -24, 24, 0, { section, advanced: true }),
      num(`b${k}Q`, 'Q', 0.1, 18, 1, { step: 0.01, curve: 'log', section }),
      db(`b${k}Thresh`, 'Threshold', -60, 0, -24, { section }),
      num(`b${k}Ratio`, 'Ratio', 1, 20, 3, { step: 0.1, curve: 'log', section }),
      db(`b${k}Range`, 'Range', -24, 24, -6, { section }),
      sec(`b${k}Attack`, 'Attack', 0.0005, 0.2, 0.005, { section, advanced: true }),
      sec(`b${k}Release`, 'Release', 0.01, 1, 0.12, { section, advanced: true }),
      enm(`b${k}Mode`, 'Mode', [{ value: 'above', label: 'Above threshold' }, { value: 'below', label: 'Below threshold' }], 'above', { section }),
    );
  }
  dqParams.push(outDb());

  // ------------------------------------------------------------------ linear-phase EQ
  const LP_TYPES = [
    { value: 'peaking', label: 'Bell' }, { value: 'lowshelf', label: 'Low Shelf' }, { value: 'highshelf', label: 'High Shelf' },
    { value: 'highpass', label: 'Low Cut 12' }, { value: 'highpass24', label: 'Low Cut 24' }, { value: 'highpass48', label: 'Low Cut 48' },
    { value: 'lowpass', label: 'High Cut 12' }, { value: 'lowpass24', label: 'High Cut 24' }, { value: 'lowpass48', label: 'High Cut 48' },
    { value: 'bandpass', label: 'Band-pass' }, { value: 'notch', label: 'Notch' },
  ];
  const LE_F = [30, 100, 250, 700, 1600, 4000, 9000, 18000];
  const LE_T = ['highpass24', 'lowshelf', 'peaking', 'peaking', 'peaking', 'peaking', 'highshelf', 'lowpass24'];
  const LE_ON = [false, true, true, true, true, true, true, false];
  const leParams = [];
  for (let k = 1; k <= 8; k++) {
    const section = `Band ${k}`;
    leParams.push(
      bool(`b${k}On`, 'On', LE_ON[k - 1], { section }),
      enm(`b${k}Type`, 'Type', LP_TYPES, LE_T[k - 1], { section, advanced: true }),
      hz(`b${k}Freq`, 'Freq', 20, 20000, LE_F[k - 1], { section }),
      db(`b${k}Gain`, 'Gain', -24, 24, 0, { section }),
      num(`b${k}Q`, 'Q', 0.1, 18, k === 1 || k === 8 ? 0.71 : 0.9, { step: 0.01, curve: 'log', section, advanced: true }),
    );
  }
  leParams.push(quality(), outDb());

  // ------------------------------------------------------------------ presets
  const mb = (o) => o; // (readability)
  const mbBands = (thr, ratio, att, rel, makeup = [0, 0, 0, 0]) => {
    const o = {};
    for (let k = 1; k <= 4; k++) {
      o[`b${k}Thresh`] = thr[k - 1]; o[`b${k}Ratio`] = ratio[k - 1]; o[`b${k}Attack`] = att[k - 1]; o[`b${k}Release`] = rel[k - 1]; o[`b${k}Makeup`] = makeup[k - 1];
    }
    return o;
  };
  const leBand = (k, on, type, freq, gain = 0, q = 0.9) => ({ [`b${k}On`]: on, [`b${k}Type`]: type, [`b${k}Freq`]: freq, [`b${k}Gain`]: gain, [`b${k}Q`]: q });
  const dqBand = (k, o) => Object.fromEntries(Object.entries({ On: true, Type: 'peaking', Q: 1, Gain: 0, Ratio: 3, Mode: 'above', Attack: 0.005, Release: 0.12, ...o }).map(([kk, v]) => [`b${k}${kk}`, v]));
  const allOff = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`b${i + 1}On`, false]));

  return {
    multiband: {
      name: 'Multiband Compressor', category: 'Dynamics',
      description: 'Splits the signal into 3 or 4 bands (phase-coherent Linkwitz-Riley crossovers) and compresses each on its own. Up + Down mode with Depth gives the aggressive OTT sound.',
      params: mbParams,
      presets: {
        'Gentle Glue (Mix Bus)': mb({ bands: 3, x1: 150, x2: 3000, mode: 'down', depth: 1, ...mbBands([-22, -20, -20, -20], [1.8, 1.6, 1.8, 1.8], [0.03, 0.02, 0.01, 0.01], [0.3, 0.25, 0.2, 0.2], [1, 1, 1, 1]) }),
        'Mastering 4-Band': mb({ bands: 4, x1: 120, x2: 1500, x3: 7000, mode: 'down', depth: 1, lookahead: 0.003, ...mbBands([-18, -16, -16, -18], [2, 1.7, 1.7, 2], [0.03, 0.015, 0.008, 0.004], [0.25, 0.2, 0.15, 0.12], [1, 0.5, 0.5, 1]) }),
        'OTT Classic': mb({ bands: 3, x1: 88, x2: 2500, mode: 'both', depth: 1, wetMix: 1, output: -3, b1UpThresh: -40, b2UpThresh: -40, b3UpThresh: -40, b1UpRatio: 4, b2UpRatio: 4, b3UpRatio: 4, ...mbBands([-32, -32, -32, -32], [6.6, 6.6, 6.6, 6.6], [0.0135, 0.0135, 0.0135, 0.0135], [0.132, 0.132, 0.132, 0.132], [6, 4, 6, 6]) }),
        'OTT Subtle (30%)': mb({ bands: 3, x1: 88, x2: 2500, mode: 'both', depth: 0.3, b1UpRatio: 4, b2UpRatio: 4, b3UpRatio: 4, ...mbBands([-30, -30, -30, -30], [6, 6, 6, 6], [0.0135, 0.0135, 0.0135, 0.0135], [0.132, 0.132, 0.132, 0.132], [3, 2, 3, 3]) }),
        'Upward Detail': mb({ bands: 3, x1: 200, x2: 4000, mode: 'up', depth: 0.6, b1UpThresh: -36, b2UpThresh: -34, b3UpThresh: -32, b1UpRatio: 2, b2UpRatio: 2.5, b3UpRatio: 3 }),
        'Vocal Control': mb({ bands: 4, x1: 200, x2: 1200, x3: 5000, mode: 'down', ...mbBands([-24, -22, -26, -28], [2.5, 2, 3, 4], [0.01, 0.008, 0.004, 0.002], [0.15, 0.12, 0.08, 0.06], [0, 1, 0, 0]) }),
        'Tame Harsh Highs': mb({ bands: 3, x1: 300, x2: 3500, mode: 'down', ...mbBands([0, 0, -30, 0], [1, 1, 4, 1], [0.01, 0.01, 0.002, 0.002], [0.1, 0.1, 0.07, 0.07]) }),
        'Bass Tightener': mb({ bands: 3, x1: 90, x2: 400, mode: 'down', ...mbBands([-26, -22, -14, -14], [4, 3, 1.5, 1.5], [0.02, 0.01, 0.01, 0.01], [0.15, 0.12, 0.1, 0.1], [2, 1, 0, 0]) }),
        'Drum Bus Punch': mb({ bands: 3, x1: 120, x2: 4000, mode: 'down', ...mbBands([-20, -24, -22, -22], [3, 4, 2.5, 2.5], [0.025, 0.015, 0.005, 0.005], [0.12, 0.09, 0.07, 0.07], [2, 2.5, 1.5, 1.5]) }),
        'Podcast Leveler': mb({ bands: 3, x1: 180, x2: 3500, mode: 'both', depth: 0.7, b1UpThresh: -50, b2UpThresh: -42, b3UpThresh: -48, b1UpRatio: 1.5, b2UpRatio: 2.5, b3UpRatio: 1.5, ...mbBands([-26, -20, -26, -26], [3, 3, 4, 4], [0.01, 0.008, 0.003, 0.003], [0.2, 0.18, 0.12, 0.12], [0, 2, 0, 0]) }),
        'De-Mud (Low Mids)': mb({ bands: 4, x1: 150, x2: 500, x3: 4000, mode: 'down', ...mbBands([0, -28, 0, 0], [1, 3, 1, 1], [0.01, 0.01, 0.01, 0.01], [0.15, 0.15, 0.1, 0.1]) }),
        'EDM Squash': mb({ bands: 3, x1: 100, x2: 3000, mode: 'both', depth: 0.75, output: -2, b1UpThresh: -38, b2UpThresh: -38, b3UpThresh: -38, b1UpRatio: 5, b2UpRatio: 5, b3UpRatio: 5, ...mbBands([-28, -30, -30, -30], [8, 8, 8, 8], [0.008, 0.008, 0.005, 0.005], [0.09, 0.09, 0.08, 0.08], [4, 3, 4, 4]) }),
        'Parallel Multiband (50%)': mb({ bands: 3, x1: 120, x2: 3000, mode: 'down', wetMix: 0.5, ...mbBands([-34, -34, -34, -34], [8, 8, 8, 8], [0.005, 0.005, 0.003, 0.003], [0.08, 0.08, 0.06, 0.06], [8, 8, 8, 8]) }),
        'Acoustic Guitar': mb({ bands: 3, x1: 200, x2: 2500, mode: 'down', ...mbBands([-26, -20, -24, -24], [3, 1.8, 2.5, 2.5], [0.015, 0.01, 0.005, 0.005], [0.15, 0.15, 0.1, 0.1], [0, 1, 1, 1]) }),
      },
    },

    transient: {
      name: 'Transient Shaper', category: 'Dynamics',
      description: 'Boosts or softens the attack and the sustain of every hit, independent of level (envelope-follower difference). Punchier drums, tighter rooms, longer tails.',
      params: [
        num('attack', 'Attack', -100, 100, 0, { step: 1, unit: '%', section: 'Shape' }),
        num('sustain', 'Sustain', -100, 100, 0, { step: 1, unit: '%', section: 'Shape' }),
        sec('speed', 'Speed', 0.002, 0.2, 0.025, { section: 'Shape' }),
        bool('clip', 'Soft Clip', false, { section: 'Output' }),
        outDb(),
        mix('mix', 1),
      ],
      presets: {
        'Punchy Kick': { attack: 60, sustain: -15, speed: 0.02 },
        'Snare Crack': { attack: 70, sustain: 0, speed: 0.012, clip: true },
        'Tight Drums (Less Room)': { attack: 20, sustain: -60, speed: 0.03 },
        'Big Room Drums': { attack: 0, sustain: 60, speed: 0.04 },
        'Soften Attack': { attack: -60, sustain: 0, speed: 0.03 },
        'Snappy Percussion': { attack: 50, sustain: -30, speed: 0.008 },
        'Plucky Bass': { attack: 40, sustain: -20, speed: 0.025 },
        'Long Bass Sustain': { attack: 0, sustain: 45, speed: 0.06 },
        'Acoustic Guitar Pick': { attack: 35, sustain: 0, speed: 0.01 },
        'Piano Body': { attack: -20, sustain: 35, speed: 0.05 },
        'Drum Bus Snap (Parallel)': { attack: 80, sustain: -10, speed: 0.015, clip: true, mix: 0.5 },
        'Dry Up a Loop': { attack: 10, sustain: -80, speed: 0.04 },
      },
    },

    deesser: {
      name: 'De-esser', category: 'Dynamics',
      description: 'Turns down harsh "s", "sh" and "t" sounds. Split-band only touches the highs; wideband turns the whole voice down. Listen solos what the detector hears.',
      params: [
        hz('freq', 'Frequency', 2000, 12000, 6500, { section: 'Detector' }),
        db('threshold', 'Threshold', -60, 0, -30, { section: 'Detector' }),
        num('range', 'Range', 0, 24, 10, { step: 0.1, unit: 'dB', section: 'Detector' }),
        enm('mode', 'Mode', [{ value: 'split', label: 'Split-band' }, { value: 'wide', label: 'Wideband' }], 'split', { section: 'Detector' }),
        enm('detector', 'Detector', [{ value: 'hp', label: 'High-pass' }, { value: 'bp', label: 'Band-pass' }], 'hp', { section: 'Detector', advanced: true }),
        sec('release', 'Release', 0.01, 0.3, 0.06, { section: 'Detector', advanced: true }),
        bool('listen', 'Listen', false, { section: 'Monitor' }),
      ],
      presets: {
        'Male Vocal': { freq: 5500, threshold: -30, range: 8, mode: 'split', detector: 'hp' },
        'Female Vocal': { freq: 7500, threshold: -30, range: 8, mode: 'split', detector: 'hp' },
        'Gentle (Broadcast)': { freq: 6500, threshold: -26, range: 5, mode: 'split' },
        'Aggressive': { freq: 6000, threshold: -38, range: 14, mode: 'split', release: 0.04 },
        'Narrow Lisp Fix': { freq: 6800, threshold: -34, range: 10, detector: 'bp' },
        'Podcast Voice': { freq: 6000, threshold: -32, range: 8, mode: 'wide', release: 0.08 },
        'Rap Vocal': { freq: 6200, threshold: -28, range: 9, mode: 'split', release: 0.05 },
        'Backing Vocals': { freq: 7000, threshold: -36, range: 12, mode: 'split' },
        'Hi-Hat Tamer': { freq: 9000, threshold: -30, range: 8, detector: 'bp', release: 0.03 },
        'Acoustic Guitar Squeak': { freq: 3500, threshold: -34, range: 8, detector: 'bp', release: 0.05 },
        'Harsh Cymbals': { freq: 10000, threshold: -32, range: 6, mode: 'split' },
        'Mix Bus Air Control': { freq: 8000, threshold: -24, range: 3, mode: 'split', release: 0.1 },
      },
    },

    expander: {
      name: 'Expander / Gate', category: 'Dynamics',
      description: 'Downward expander and gate with hysteresis, hold, look-ahead and a filtered sidechain (or another track as the key). High ratios gate, low ratios gently clean up bleed and noise.',
      params: [
        db('threshold', 'Threshold', -80, 0, -45, { section: 'Expander' }),
        num('ratio', 'Ratio', 1, 50, 4, { step: 0.1, curve: 'log', section: 'Expander' }),
        db('range', 'Range', -80, 0, -40, { section: 'Expander' }),
        num('hysteresis', 'Hysteresis', 0, 12, 3, { step: 0.1, unit: 'dB', section: 'Expander' }),
        num('knee', 'Knee', 0, 12, 2, { step: 0.1, unit: 'dB', section: 'Expander', advanced: true }),
        sec('attack', 'Attack', 0.0001, 0.05, 0.001, { section: 'Envelope' }),
        num('hold', 'Hold', 0, 0.5, 0.02, { step: 0.001, unit: 's', section: 'Envelope' }),
        sec('release', 'Release', 0.005, 2, 0.15, { section: 'Envelope' }),
        num('lookahead', 'Look-ahead', 0, 0.01, LATENCY_DEFAULTS.expanderLookahead, { step: 0.0005, unit: 's', section: 'Envelope', advanced: true }),
        hz('scHighpass', 'SC High-pass', 20, 2000, 20, { section: 'Sidechain' }),
        hz('scLowpass', 'SC Low-pass', 100, 20000, 20000, { section: 'Sidechain' }),
        bool('listen', 'SC Listen', false, { section: 'Sidechain' }),
        keyTrack('Key Track', 'External key: open the expander from another track / bus (none = its own signal)'),
      ],
      presets: {
        'Gentle Noise Cleanup': { threshold: -55, ratio: 2, range: -12, hysteresis: 2, attack: 0.002, hold: 0.05, release: 0.25 },
        'Hard Gate': { threshold: -40, ratio: 50, range: -80, hysteresis: 4, attack: 0.0005, hold: 0.01, release: 0.08 },
        'Kick Drum Gate': { threshold: -30, ratio: 20, range: -60, hysteresis: 6, attack: 0.0002, hold: 0.04, release: 0.1, scLowpass: 200, lookahead: 0.002 },
        'Snare Gate': { threshold: -28, ratio: 20, range: -40, hysteresis: 5, attack: 0.0002, hold: 0.03, release: 0.12, scHighpass: 150, scLowpass: 6000, lookahead: 0.002 },
        'Tom Gate': { threshold: -32, ratio: 10, range: -30, hysteresis: 6, attack: 0.0005, hold: 0.08, release: 0.3, scHighpass: 60, scLowpass: 2000 },
        'Hi-Hat Cleanup': { threshold: -36, ratio: 6, range: -24, hysteresis: 3, attack: 0.0002, hold: 0.01, release: 0.05, scHighpass: 2000 },
        'Vocal Breaths': { threshold: -48, ratio: 3, range: -14, hysteresis: 4, attack: 0.003, hold: 0.06, release: 0.2, scHighpass: 120 },
        'Podcast Room Tone': { threshold: -50, ratio: 2.5, range: -15, hysteresis: 3, attack: 0.003, hold: 0.1, release: 0.3, scHighpass: 100 },
        'Guitar Amp Hiss': { threshold: -56, ratio: 4, range: -30, hysteresis: 3, attack: 0.001, hold: 0.05, release: 0.2 },
        'Gated Reverb Tail': { threshold: -30, ratio: 50, range: -80, hysteresis: 2, attack: 0.0005, hold: 0.18, release: 0.03 },
        'Choppy Trance Gate (keyed)': { threshold: -30, ratio: 50, range: -60, hysteresis: 4, attack: 0.001, hold: 0, release: 0.04 },
        'Bass Tightener': { threshold: -38, ratio: 3, range: -18, hysteresis: 3, attack: 0.001, hold: 0.02, release: 0.08, scLowpass: 400 },
      },
    },

    dyneq: {
      name: 'Dynamic EQ', category: 'EQ & Filter',
      description: '4-band EQ whose bands only cut (or boost) when the band crosses its threshold — tame resonances, harshness or boominess only when they happen.',
      params: dqParams,
      presets: {
        'Vocal Harshness Tamer': { ...allOff(4), ...dqBand(3, { Freq: 3200, Q: 2, Thresh: -30, Ratio: 4, Range: -6 }) },
        'De-Boom (Low Mids)': { ...allOff(4), ...dqBand(2, { Freq: 250, Q: 1.2, Thresh: -24, Ratio: 3, Range: -6, Release: 0.15 }) },
        'Proximity Effect Fix': { ...allOff(4), ...dqBand(1, { Type: 'lowshelf', Freq: 180, Q: 0.7, Thresh: -24, Ratio: 3, Range: -6, Release: 0.2 }) },
        'Dynamic De-esser': { ...allOff(4), ...dqBand(4, { Type: 'peaking', Freq: 7000, Q: 3, Thresh: -34, Ratio: 6, Range: -10, Attack: 0.001, Release: 0.06 }) },
        'Kick / Bass Unmask': { ...allOff(4), ...dqBand(1, { Freq: 60, Q: 1.4, Thresh: -18, Ratio: 3, Range: -4, Attack: 0.002, Release: 0.09 }) },
        'Bring Up Quiet Air': { ...allOff(4), ...dqBand(4, { Type: 'highshelf', Freq: 9000, Q: 0.7, Thresh: -40, Ratio: 2, Range: 4, Mode: 'below', Release: 0.2 }) },
        'Fullness When Thin': { ...allOff(4), ...dqBand(1, { Type: 'lowshelf', Freq: 150, Q: 0.7, Thresh: -30, Ratio: 2, Range: 3, Mode: 'below', Release: 0.3 }) },
        'Guitar Resonance Control': { ...allOff(4), ...dqBand(2, { Freq: 450, Q: 3, Thresh: -28, Ratio: 4, Range: -6 }), ...dqBand(3, { Freq: 2500, Q: 3, Thresh: -30, Ratio: 4, Range: -5 }) },
        'Mastering Smoothness': { ...allOff(4), ...dqBand(2, { Freq: 300, Q: 1, Thresh: -22, Ratio: 2, Range: -2, Release: 0.2 }), ...dqBand(3, { Freq: 3500, Q: 1.4, Thresh: -26, Ratio: 2, Range: -2.5 }), ...dqBand(4, { Type: 'highshelf', Freq: 9000, Q: 0.7, Thresh: -30, Ratio: 2, Range: -2 }) },
        'Podcast Voice Clean': { ...allOff(4), ...dqBand(1, { Type: 'lowshelf', Freq: 160, Q: 0.7, Thresh: -26, Ratio: 3, Range: -5 }), ...dqBand(3, { Freq: 3000, Q: 1.8, Thresh: -30, Ratio: 3, Range: -4 }), ...dqBand(4, { Freq: 6500, Q: 3, Thresh: -34, Ratio: 5, Range: -8, Attack: 0.001, Release: 0.06 }) },
        'Snare Ring Control': { ...allOff(4), ...dqBand(2, { Freq: 220, Q: 6, Thresh: -30, Ratio: 5, Range: -9, Mode: 'above', Attack: 0.01, Release: 0.1 }) },
        'Cymbal Wash Control': { ...allOff(4), ...dqBand(4, { Type: 'highshelf', Freq: 6000, Q: 0.7, Thresh: -32, Ratio: 3, Range: -5, Release: 0.2 }) },
      },
    },

    lineq: {
      name: 'Linear-Phase EQ', category: 'EQ & Filter',
      description: '8-band EQ with zero phase shift (FIR convolution): no smearing, perfect for mastering and parallel processing. Higher quality = more low-end precision and more latency (compensated).',
      params: leParams,
      presets: {
        'Mastering Gentle Smile': { ...leBand(1, true, 'highpass24', 25, 0, 0.71), ...leBand(2, true, 'lowshelf', 90, 1.5, 0.7), ...leBand(4, true, 'peaking', 400, -1, 0.8), ...leBand(7, true, 'highshelf', 10000, 1.5, 0.7) },
        'Low-End Cleanup': { ...leBand(1, true, 'highpass48', 30, 0, 0.71) },
        'Air Lift': { ...leBand(7, true, 'highshelf', 12000, 3, 0.7) },
        'Mud Cut': { ...leBand(3, true, 'peaking', 300, -3, 1.2) },
        'Vocal Presence': { ...leBand(1, true, 'highpass24', 90, 0, 0.71), ...leBand(3, true, 'peaking', 250, -2, 1.2), ...leBand(5, true, 'peaking', 3000, 2.5, 1), ...leBand(7, true, 'highshelf', 10000, 2, 0.7) },
        'Kick Weight': { ...leBand(2, true, 'peaking', 60, 3, 1.4), ...leBand(4, true, 'peaking', 350, -3, 1.4), ...leBand(6, true, 'peaking', 4000, 2, 1.2) },
        'Bass Focus': { ...leBand(1, true, 'highpass24', 35, 0, 0.71), ...leBand(2, true, 'peaking', 80, 2, 1), ...leBand(3, true, 'peaking', 220, -2, 1.4), ...leBand(8, true, 'lowpass24', 6000, 0, 0.71) },
        'Bright Master': { ...leBand(5, true, 'peaking', 2500, 1, 0.7), ...leBand(7, true, 'highshelf', 8000, 2, 0.7) },
        'Warm Master': { ...leBand(2, true, 'lowshelf', 150, 1.5, 0.7), ...leBand(7, true, 'highshelf', 8000, -1.5, 0.7) },
        'Telephone': { ...leBand(1, true, 'highpass48', 400, 0, 0.71), ...leBand(5, true, 'peaking', 1500, 4, 1), ...leBand(8, true, 'lowpass48', 3400, 0, 0.71) },
        'Tilt Brighter': { ...leBand(2, true, 'lowshelf', 300, -1.5, 0.6), ...leBand(7, true, 'highshelf', 3000, 1.5, 0.6) },
        'Podcast Voice': { ...leBand(1, true, 'highpass48', 70, 0, 0.71), ...leBand(3, true, 'peaking', 200, -2, 1), ...leBand(5, true, 'peaking', 2500, 2, 1), ...leBand(7, true, 'highshelf', 9000, 1, 0.7), quality: 'low' },
      },
    },

    matcheq: {
      name: 'Match EQ', category: 'EQ & Filter',
      description: 'Captures the spectrum of a reference (another track, an audio file or a clip) and of this channel, then applies a smoothed linear-phase correction so this channel takes on the reference’s tonal balance.',
      params: [
        keyTrack('Reference Track', 'Track / bus whose spectrum is captured as the reference (press Capture Reference while it plays)'),
        num('amount', 'Amount', 0, 1, 0.75, { step: 0.01, section: 'Match' }),
        enm('smoothing', 'Smoothing', [
          { value: '1/24', label: '1/24 octave' }, { value: '1/12', label: '1/12 octave' }, { value: '1/6', label: '1/6 octave' },
          { value: '1/3', label: '1/3 octave' }, { value: '1/1', label: '1 octave' },
        ], '1/6', { section: 'Match' }),
        num('maxBoost', 'Max Boost', 0, 24, 9, { step: 0.1, unit: 'dB', section: 'Match' }),
        num('maxCut', 'Max Cut', 0, 24, 12, { step: 0.1, unit: 'dB', section: 'Match' }),
        hz('lowLimit', 'Low Limit', 20, 1000, 30, { section: 'Limits' }),
        hz('highLimit', 'High Limit', 1000, 20000, 16000, { section: 'Limits' }),
        quality(),
        outDb(),
      ],
      presets: {
        'Full Match': { amount: 1, smoothing: '1/6', maxBoost: 12, maxCut: 12 },
        'Subtle Match (50%)': { amount: 0.5, smoothing: '1/3', maxBoost: 6, maxCut: 6 },
        'Broad Tonal Balance': { amount: 0.8, smoothing: '1/1', maxBoost: 6, maxCut: 6 },
        'Detailed (1/12 oct)': { amount: 0.75, smoothing: '1/12', maxBoost: 9, maxCut: 12 },
        'Mastering Reference': { amount: 0.6, smoothing: '1/3', maxBoost: 4, maxCut: 4, lowLimit: 25, highLimit: 18000, quality: 'high' },
        'Cut Only': { amount: 0.8, smoothing: '1/6', maxBoost: 0, maxCut: 12 },
        'Boost Only': { amount: 0.8, smoothing: '1/6', maxBoost: 9, maxCut: 0 },
        'Vocal Matching': { amount: 0.7, smoothing: '1/6', maxBoost: 8, maxCut: 10, lowLimit: 80, highLimit: 16000 },
        'Mids Only': { amount: 0.75, smoothing: '1/3', lowLimit: 200, highLimit: 5000 },
        'Podcast Mic Match': { amount: 0.8, smoothing: '1/3', maxBoost: 8, maxCut: 10, lowLimit: 70, highLimit: 12000, quality: 'low' },
      },
    },
  };
}
