// Instrument parameter metadata (drives the auto-generated UI). Pure data — Node-safe.
// ParamDef { key, label, type:'number'|'enum'|'bool'|'sample', min, max, step, default, unit?, curve?,
//            options?:[{value,label}], section, advanced? }
import { DRUM_KITS } from './kits.js';

const LFO_DIVS = ['4/1', '2/1', '1/1', '1/2', '1/2d', '1/4', '1/4d', '1/4t', '1/8', '1/8d', '1/8t', '1/16', '1/16t', '1/32'];
const opt = (list) => list.map((x) => (typeof x === 'object' ? x : { value: x, label: String(x) }));

function numP(key, label, min, max, def, o = {}) {
  return {
    key, label, type: 'number', min, max,
    step: o.step ?? (max - min <= 2 ? 0.01 : max - min <= 50 ? 0.1 : 1),
    default: def, unit: o.unit, curve: o.curve || 'lin', section: null, advanced: !!o.adv,
  };
}
function enumP(key, label, options, def, o = {}) {
  return { key, label, type: 'enum', options: opt(options), default: def, section: null, advanced: !!o.adv };
}
function boolP(key, label, def, o = {}) {
  return { key, label, type: 'bool', default: def, section: null, advanced: !!o.adv };
}
function section(name, defs) { return defs.map((d) => ({ ...d, section: name })); }

const time = (key, label, def, max = 10, adv = false) => numP(key, label, 0, max, def, { unit: 's', curve: 'exp', step: 0.001, adv });
const level = (key, label, def, adv = false) => numP(key, label, 0, 1, def, { step: 0.01, adv });

export const SYNTH_WAVES = opt([
  { value: 'saw', label: 'Saw' }, { value: 'square', label: 'Square' }, { value: 'pulse', label: 'Pulse' },
  { value: 'triangle', label: 'Triangle' }, { value: 'sine', label: 'Sine' }, { value: 'supersaw', label: 'Supersaw' },
]);
const FILTER_TYPES = opt([
  { value: 'lp24', label: 'Low-pass 24' }, { value: 'lp12', label: 'Low-pass 12' }, { value: 'hp24', label: 'High-pass 24' },
  { value: 'hp12', label: 'High-pass 12' }, { value: 'bp', label: 'Band-pass' }, { value: 'notch', label: 'Notch' }, { value: 'off', label: 'Off' },
]);
const LFO_TARGETS = opt([
  { value: 'none', label: 'Off' }, { value: 'pitch', label: 'Pitch' }, { value: 'filter', label: 'Filter' },
  { value: 'amp', label: 'Amp (tremolo)' }, { value: 'pan', label: 'Pan' }, { value: 'oscmix', label: 'Osc 1/2 mix' },
]);
const LFO_SHAPES = opt([
  { value: 'sine', label: 'Sine' }, { value: 'triangle', label: 'Triangle' }, { value: 'square', label: 'Square' },
  { value: 'sawtooth', label: 'Saw up' }, { value: 'ramp', label: 'Saw down' },
]);

const outputSection = (gain = 0.8) => section('Output', [
  numP('drive', 'Drive', 0, 1, 0, { step: 0.01 }),
  numP('toneCut', 'Tone', 200, 20000, 20000, { unit: 'Hz', curve: 'log', adv: true }),
  numP('gain', 'Volume', 0, 2, gain, { step: 0.01 }),
]);

function oscDefs(i, wave, lvl, oct = 0, fine = 0) {
  return [
    enumP(`osc${i}Wave`, `Osc ${i} wave`, SYNTH_WAVES, wave),
    numP(`osc${i}Level`, `Osc ${i} level`, 0, 1, lvl, { step: 0.01 }),
    numP(`osc${i}Octave`, `Osc ${i} octave`, -3, 3, oct, { step: 1 }),
    numP(`osc${i}Semi`, `Osc ${i} semi`, -12, 12, 0, { step: 1, unit: 'st', adv: true }),
    numP(`osc${i}Fine`, `Osc ${i} fine`, -100, 100, fine, { step: 1, unit: 'ct' }),
    numP(`osc${i}Width`, `Osc ${i} pulse width`, 0.05, 0.95, 0.5, { step: 0.01, adv: true }),
  ];
}
function lfoDefs(k) {
  return section(`LFO ${k}`, [
    enumP(`lfo${k}Target`, 'Target', LFO_TARGETS, 'none'),
    enumP(`lfo${k}Shape`, 'Shape', LFO_SHAPES, 'sine'),
    numP(`lfo${k}Rate`, 'Rate', 0.01, 30, k === 1 ? 5 : 0.5, { unit: 'Hz', curve: 'log', step: 0.01 }),
    boolP(`lfo${k}Sync`, 'Tempo sync', false),
    enumP(`lfo${k}Div`, 'Division', LFO_DIVS, '1/8'),
    numP(`lfo${k}Depth`, 'Depth', 0, 1, 0.2, { step: 0.001, curve: 'exp' }),
    time(`lfo${k}Fade`, 'Fade in', 0, 10, true),
  ]);
}

const SYNTH_PARAMS = [
  ...section('Oscillators', [
    ...oscDefs(1, 'saw', 0.8),
    ...oscDefs(2, 'saw', 0, 0, 7),
    ...oscDefs(3, 'square', 0, -1),
    numP('subLevel', 'Sub level', 0, 1, 0, { step: 0.01 }),
    enumP('subWave', 'Sub wave', ['sine', 'square', 'triangle'], 'sine', { adv: true }),
    numP('subOctave', 'Sub octave', -2, -1, -1, { step: 1, adv: true }),
    numP('noiseLevel', 'Noise', 0, 1, 0, { step: 0.01 }),
    enumP('noiseType', 'Noise color', ['white', 'pink'], 'white', { adv: true }),
  ]),
  ...section('Unison', [
    numP('unison', 'Voices', 1, 7, 1, { step: 1 }),
    numP('unisonDetune', 'Detune', 0, 100, 15, { step: 0.5, unit: 'ct' }),
    numP('unisonSpread', 'Stereo spread', 0, 1, 0.5, { step: 0.01 }),
    numP('superDetune', 'Supersaw detune', 0, 1, 0.4, { step: 0.01 }),
  ]),
  ...section('Filter', [
    enumP('filterType', 'Type', FILTER_TYPES, 'lp24'),
    numP('cutoff', 'Cutoff', 20, 20000, 8000, { unit: 'Hz', curve: 'log' }),
    numP('resonance', 'Resonance', 0, 1, 0.1, { step: 0.01 }),
    numP('keytrack', 'Key tracking', 0, 1, 0.3, { step: 0.01, adv: true }),
    numP('velToFilter', 'Velocity → filter', 0, 1, 0.3, { step: 0.01, adv: true }),
  ]),
  ...section('Filter Env', [
    numP('fEnvAmount', 'Amount', -8, 8, 2, { step: 0.01, unit: 'oct' }),
    time('fAttack', 'Attack', 0.005), time('fDecay', 'Decay', 0.3), level('fSustain', 'Sustain', 0.3), time('fRelease', 'Release', 0.3),
  ]),
  ...section('Amp Env', [
    time('attack', 'Attack', 0.005), time('decay', 'Decay', 0.3), level('sustain', 'Sustain', 0.8), time('release', 'Release', 0.2),
    numP('velToAmp', 'Velocity → amp', 0, 1, 0.6, { step: 0.01, adv: true }),
  ]),
  ...lfoDefs(1),
  ...lfoDefs(2),
  ...section('Voice', [
    boolP('mono', 'Mono', false),
    boolP('legato', 'Legato (no retrigger)', true, { adv: true }),
    time('glide', 'Glide', 0, 2),
    boolP('glideAlways', 'Always glide', false, { adv: true }),
    numP('polyphony', 'Polyphony', 1, 32, 8, { step: 1, adv: true }),
    numP('bendRange', 'Pitch-bend range', 0, 24, 2, { step: 1, unit: 'st', adv: true }),
    numP('transpose', 'Transpose', -24, 24, 0, { step: 1, unit: 'st', adv: true }),
    numP('pitchEnvAmt', 'Pitch env amount', -48, 48, 0, { step: 0.1, unit: 'st', adv: true }),
    time('pitchEnvDecay', 'Pitch env decay', 0.05, 5, true),
  ]),
  ...outputSection(0.8),
];

const FM_ALGOS = [
  [1, '1: Stack 1→2→3→4'], [2, '2: (1+2)→3→4'], [3, '3: 1→2→4 + 3→4'], [4, '4: (1+2+3)→4'], [5, '5: Pairs 1→2, 3→4'],
  [6, '6: 1→(2,3,4)'], [7, '7: 1→2→3 + 4'], [8, '8: 1→2 + 3 + 4'], [9, '9: Additive'], [10, '10: (1,2)→(3,4)'], [11, '11: 1→2→3, 1→4'],
].map(([value, label]) => ({ value, label }));

function opDefs(i, o) {
  return section(`Op ${i}`, [
    numP(`op${i}Ratio`, 'Ratio', 0, 32, o.ratio, { step: 0.01 }),
    numP(`op${i}Fine`, 'Fine', -100, 100, 0, { step: 1, unit: 'ct', adv: true }),
    numP(`op${i}Level`, i === 4 ? 'Level' : 'Level / index', 0, 1, o.level, { step: 0.001 }),
    time(`op${i}Attack`, 'Attack', o.a ?? 0.003),
    time(`op${i}Decay`, 'Decay', o.d ?? 0.8, 20),
    level(`op${i}Sustain`, 'Sustain', o.s ?? 0.5),
    time(`op${i}Release`, 'Release', o.r ?? 0.4),
    numP(`op${i}Vel`, 'Velocity sens', 0, 1, o.vel ?? 0.5, { step: 0.01, adv: true }),
  ]);
}
const FM_PARAMS = [
  ...section('Algorithm', [
    enumP('algorithm', 'Algorithm', FM_ALGOS, 5),
    numP('feedback', 'Op 1 feedback', 0, 1, 0, { step: 0.01 }),
    numP('keyScale', 'Key scaling', 0, 1, 0.3, { step: 0.01, adv: true }),
  ]),
  ...opDefs(1, { ratio: 1, level: 0.35, d: 0.6, s: 0.2 }),
  ...opDefs(2, { ratio: 1, level: 0.9, d: 1.5, s: 0.4 }),
  ...opDefs(3, { ratio: 2, level: 0.25, d: 0.5, s: 0.2 }),
  ...opDefs(4, { ratio: 1, level: 0.9, d: 1.5, s: 0.4 }),
  ...section('Voice', [
    numP('vibDepth', 'Vibrato depth', 0, 1, 0, { step: 0.01 }),
    numP('vibRate', 'Vibrato rate', 0.1, 20, 5.5, { unit: 'Hz', step: 0.1, adv: true }),
    time('vibDelay', 'Vibrato delay', 0.2, 5, true),
    numP('tremDepth', 'Tremolo depth', 0, 1, 0, { step: 0.01 }),
    numP('tremRate', 'Tremolo rate', 0.1, 20, 4.5, { unit: 'Hz', step: 0.1, adv: true }),
    numP('polyphony', 'Polyphony', 1, 32, 12, { step: 1, adv: true }),
    numP('transpose', 'Transpose', -24, 24, 0, { step: 1, unit: 'st', adv: true }),
  ]),
  ...outputSection(0.8),
];

const DRAWBAR_LABELS = ["16'", "5⅓'", "8'", "4'", "2⅔'", "2'", "1⅗'", "1⅓'", "1'"];
const ORGAN_PARAMS = [
  ...section('Drawbars', DRAWBAR_LABELS.map((l, i) => numP(`db${i + 1}`, l, 0, 8, [8, 8, 8, 0, 0, 0, 0, 0, 0][i], { step: 1 }))),
  ...section('Percussion', [
    boolP('perc', 'Percussion', false),
    enumP('percHarmonic', 'Harmonic', [{ value: 'second', label: '2nd' }, { value: 'third', label: '3rd' }], 'third'),
    numP('percDecay', 'Decay', 0.05, 2, 0.35, { unit: 's', step: 0.01 }),
    numP('percLevel', 'Level', 0, 1, 0.6, { step: 0.01 }),
  ]),
  ...section('Vibrato & Rotary', [
    enumP('vibrato', 'Vibrato / chorus', ['off', 'v1', 'v2', 'v3', 'c1', 'c2', 'c3'].map((v) => ({ value: v, label: v.toUpperCase() })), 'c3'),
    enumP('rotary', 'Rotary speed', [{ value: 'off', label: 'Off' }, { value: 'slow', label: 'Slow' }, { value: 'fast', label: 'Fast' }], 'slow'),
    numP('rotaryDepth', 'Rotary depth', 0, 1, 0.7, { step: 0.01, adv: true }),
    numP('click', 'Key click', 0, 1, 0.3, { step: 0.01 }),
  ]),
  ...section('Voice', [
    time('attack', 'Attack', 0.004, 5, true),
    time('release', 'Release', 0.03, 5, true),
    numP('velSens', 'Velocity sens', 0, 1, 0, { step: 0.01, adv: true }),
    numP('polyphony', 'Polyphony', 1, 32, 16, { step: 1, adv: true }),
    numP('transpose', 'Transpose', -24, 24, 0, { step: 1, unit: 'st', adv: true }),
  ]),
  ...outputSection(0.7),
];

const DRUM_PARAMS = [
  ...section('Kit', [
    enumP('kit', 'Kit', Object.entries(DRUM_KITS).map(([value, k]) => ({ value, label: k.name })), '808'),
    numP('pitch', 'Pitch', -24, 24, 0, { step: 0.1, unit: 'st' }),
    numP('decay', 'Decay', 0.1, 4, 1, { step: 0.01, unit: '×', curve: 'exp' }),
    numP('tone', 'Tone', -1, 1, 0, { step: 0.01 }),
  ]),
  ...outputSection(0.8),
];
/** Per-pad params (instrument.params.pads[padKey] = {...}). */
export const DRUM_PAD_PARAM_DEFS = section('Pad', [
  numP('tune', 'Tune', -24, 24, 0, { step: 0.1, unit: 'st' }),
  numP('decay', 'Decay', 0.1, 4, 1, { step: 0.01, unit: '×', curve: 'exp' }),
  numP('tone', 'Tone', -1, 1, 0, { step: 0.01 }),
  numP('gain', 'Level', 0, 2, 1, { step: 0.01 }),
  numP('pan', 'Pan', -1, 1, 0, { step: 0.01 }),
  boolP('mute', 'Mute', false),
  { key: 'sampleId', label: 'Sample', type: 'sample', default: null, section: 'Pad', advanced: true },
]);

const SAMPLER_PARAMS = [
  ...section('Sample', [
    { key: 'sampleId', label: 'Sample', type: 'sample', default: null, section: null, advanced: false },
    numP('rootNote', 'Root note', 0, 127, 60, { step: 1 }),
    numP('tune', 'Tune', -24, 24, 0, { step: 1, unit: 'st' }),
    numP('fine', 'Fine', -100, 100, 0, { step: 1, unit: 'ct', adv: true }),
    numP('start', 'Start', 0, 1, 0, { step: 0.001 }),
    numP('end', 'End', 0, 1, 1, { step: 0.001 }),
    boolP('reverse', 'Reverse', false),
    boolP('oneShot', 'One-shot', false),
    numP('slices', 'Slices', 0, 64, 0, { step: 1, adv: true }),
  ]),
  ...section('Loop', [
    boolP('loop', 'Loop', false),
    numP('loopStart', 'Loop start', 0, 1, 0, { step: 0.001, adv: true }),
    numP('loopEnd', 'Loop end', 0, 1, 1, { step: 0.001, adv: true }),
  ]),
  ...section('Amp Env', [
    time('attack', 'Attack', 0.002), time('decay', 'Decay', 0.3), level('sustain', 'Sustain', 1), time('release', 'Release', 0.08),
    numP('velSens', 'Velocity sens', 0, 1, 0.6, { step: 0.01, adv: true }),
  ]),
  ...section('Filter', [
    numP('cutoff', 'Cutoff', 20, 20000, 20000, { unit: 'Hz', curve: 'log' }),
    numP('resonance', 'Resonance', 0, 1, 0, { step: 0.01 }),
  ]),
  ...section('Voice', [numP('polyphony', 'Polyphony', 1, 32, 16, { step: 1, adv: true })]),
  ...outputSection(0.8),
];

export const INSTRUMENT_DEFS = {
  synth: { name: 'Subtractive Synth', params: SYNTH_PARAMS },
  fm: { name: 'FM Synth', params: FM_PARAMS },
  organ: { name: 'Drawbar Organ', params: ORGAN_PARAMS },
  drums: { name: 'Drum Machine', params: DRUM_PARAMS, padParams: DRUM_PAD_PARAM_DEFS },
  sampler: { name: 'Sampler', params: SAMPLER_PARAMS },
};

/** { key: default } for an instrument type (drums also gets `pads: {}`). */
export function getParamDefaults(type) {
  const def = INSTRUMENT_DEFS[type] || INSTRUMENT_DEFS.synth;
  const out = {};
  for (const p of def.params) out[p.key] = p.default;
  if (type === 'drums') out.pads = {};
  return out;
}

/** Clamp numbers / validate enums against the defs; unknown keys pass through untouched. */
export function sanitizeParams(type, params) {
  const def = INSTRUMENT_DEFS[type] || INSTRUMENT_DEFS.synth;
  const out = { ...params };
  for (const p of def.params) {
    const v = out[p.key];
    if (p.type === 'number') {
      const n = typeof v === 'number' ? v : Number(v);
      out[p.key] = Number.isFinite(n) ? Math.min(p.max, Math.max(p.min, n)) : p.default;
    } else if (p.type === 'bool') {
      out[p.key] = v === undefined || v === null ? p.default : !!v;
    } else if (p.type === 'enum') {
      // eslint-disable-next-line eqeqeq
      const hit = p.options.find((o) => o.value === v || String(o.value) === String(v));
      out[p.key] = hit ? hit.value : p.default;
    } else if (p.type === 'sample') {
      out[p.key] = v || null;
    }
  }
  if (type === 'drums') {
    const pads = {};
    for (const [k, pv] of Object.entries(out.pads || {})) {
      if (!pv || typeof pv !== 'object') continue;
      const o = { ...pv };
      for (const p of DRUM_PAD_PARAM_DEFS) {
        if (o[p.key] === undefined) continue;
        if (p.type === 'number') { const n = Number(o[p.key]); o[p.key] = Number.isFinite(n) ? Math.min(p.max, Math.max(p.min, n)) : p.default; }
        if (p.type === 'bool') o[p.key] = !!o[p.key];
      }
      pads[k] = o;
    }
    out.pads = pads;
  }
  return out;
}
