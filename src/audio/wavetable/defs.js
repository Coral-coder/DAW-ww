// Parameter metadata of the wavetable synth (pure data, Node-safe). Same ParamDef format as src/audio/defs.js.
// Table params use type 'wavetable' (a factory id from factory.js or a project table id 'u_<hash>').
import { WARP_MODES, WARP_LABELS } from './warp.js';

const LFO_DIVS = ['8/1', '4/1', '2/1', '1/1', '1/2', '1/2d', '1/4', '1/4d', '1/4t', '1/8', '1/8d', '1/8t', '1/16', '1/16t', '1/32'];
const opt = (list) => list.map((x) => (typeof x === 'object' ? x : { value: x, label: String(x) }));
const num = (key, label, min, max, def, o = {}) => ({
  key, label, type: 'number', min, max, step: o.step ?? (max - min <= 2 ? 0.01 : max - min <= 50 ? 0.1 : 1),
  default: def, unit: o.unit, curve: o.curve || 'lin', section: null, advanced: !!o.adv,
});
const enm = (key, label, options, def, o = {}) => ({ key, label, type: 'enum', options: opt(options), default: def, section: null, advanced: !!o.adv });
const bool = (key, label, def, o = {}) => ({ key, label, type: 'bool', default: def, section: null, advanced: !!o.adv });
const sec = (name, defs) => defs.map((d) => ({ ...d, section: name }));
const time = (key, label, def, max = 10, adv = false) => num(key, label, 0, max, def, { unit: 's', curve: 'exp', step: 0.001, adv });

export const WT_WARPS = WARP_MODES.map((value) => ({ value, label: WARP_LABELS[value] }));
export const WT_FILTERS = opt([
  { value: 'lp', label: 'Low-pass' }, { value: 'bp', label: 'Band-pass' }, { value: 'hp', label: 'High-pass' },
  { value: 'notch', label: 'Notch' }, { value: 'comb', label: 'Comb +' }, { value: 'combneg', label: 'Comb −' }, { value: 'off', label: 'Off' },
]);
export const WT_LFO_SHAPES = opt([
  { value: 'sine', label: 'Sine' }, { value: 'triangle', label: 'Triangle' }, { value: 'saw', label: 'Saw up' }, { value: 'ramp', label: 'Saw down' },
  { value: 'square', label: 'Square' }, { value: 'random', label: 'Sample & hold' }, { value: 'smooth', label: 'Smooth random' },
]);
/** Mod-matrix sources / destinations (processor.js uses the same order). */
export const WT_MOD_SOURCES = opt([
  { value: 'off', label: 'Off' }, { value: 'env1', label: 'Env 1 (amp)' }, { value: 'env2', label: 'Env 2' }, { value: 'env3', label: 'Env 3' },
  { value: 'lfo1', label: 'LFO 1' }, { value: 'lfo2', label: 'LFO 2' }, { value: 'lfo3', label: 'LFO 3' }, { value: 'lfo4', label: 'LFO 4' },
  { value: 'vel', label: 'Velocity' }, { value: 'note', label: 'Note (key)' }, { value: 'rand', label: 'Random (per note)' },
]);
export const WT_MOD_DESTS = opt([
  { value: 'none', label: '—' }, { value: 'pos1', label: 'Osc A position' }, { value: 'pos2', label: 'Osc B position' },
  { value: 'warp1', label: 'Osc A warp' }, { value: 'warp2', label: 'Osc B warp' }, { value: 'pitch', label: 'Pitch (both, ±12 st)' },
  { value: 'pitch1', label: 'Osc A pitch' }, { value: 'pitch2', label: 'Osc B pitch' }, { value: 'level1', label: 'Osc A level' },
  { value: 'level2', label: 'Osc B level' }, { value: 'cutoff', label: 'Filter cutoff (±6 oct)' }, { value: 'res', label: 'Resonance' },
  { value: 'drive', label: 'Filter drive' }, { value: 'pan', label: 'Pan' }, { value: 'amp', label: 'Amp' }, { value: 'sub', label: 'Sub level' },
  { value: 'noise', label: 'Noise level' }, { value: 'detune1', label: 'Osc A detune' }, { value: 'detune2', label: 'Osc B detune' },
]);
export const WT_MATRIX_SLOTS = 8;

function oscDefs(i, o) {
  const p = `osc${i}`;
  const name = i === 1 ? 'Osc A' : 'Osc B';
  return sec(name, [
    bool(`${p}On`, 'On', o.on),
    { key: `${p}Table`, label: 'Wavetable', type: 'wavetable', default: o.table, section: null, advanced: false },
    num(`${p}Pos`, 'Position', 0, 1, o.pos ?? 0, { step: 0.001 }),
    enm(`${p}Warp`, 'Warp', WT_WARPS, 'none'),
    num(`${p}WarpAmt`, 'Warp amount', 0, 1, 0, { step: 0.001 }),
    num(`${p}Level`, 'Level', 0, 1, o.level, { step: 0.01 }),
    num(`${p}Unison`, 'Unison', 1, 16, 1, { step: 1 }),
    num(`${p}Detune`, 'Detune', 0, 1, 0.2, { step: 0.001, curve: 'exp' }),
    num(`${p}Blend`, 'Blend', 0, 1, 0.75, { step: 0.01, adv: true }),
    num(`${p}Spread`, 'Stereo spread', 0, 1, 0.7, { step: 0.01, adv: true }),
    num(`${p}Octave`, 'Octave', -4, 4, o.oct ?? 0, { step: 1 }),
    num(`${p}Semi`, 'Semi', -12, 12, 0, { step: 1, unit: 'st', adv: true }),
    num(`${p}Fine`, 'Fine', -100, 100, o.fine ?? 0, { step: 1, unit: 'ct', adv: true }),
    num(`${p}Pan`, 'Pan', -1, 1, 0, { step: 0.01, adv: true }),
    num(`${p}Phase`, 'Phase', 0, 1, 0, { step: 0.01, adv: true }),
    num(`${p}Rand`, 'Random phase', 0, 1, 1, { step: 0.01, adv: true }),
  ]);
}
function envDefs(k, name, d) {
  return sec(name, [time(`env${k}Attack`, 'Attack', d[0]), time(`env${k}Decay`, 'Decay', d[1]), num(`env${k}Sustain`, 'Sustain', 0, 1, d[2], { step: 0.01 }), time(`env${k}Release`, 'Release', d[3])]);
}
function lfoDefs(k) {
  return sec(`LFO ${k}`, [
    enm(`lfo${k}Shape`, 'Shape', WT_LFO_SHAPES, 'sine'),
    num(`lfo${k}Rate`, 'Rate', 0.01, 40, [2, 0.5, 5, 0.2][k - 1], { unit: 'Hz', curve: 'log', step: 0.01 }),
    bool(`lfo${k}Sync`, 'Tempo sync', false),
    enm(`lfo${k}Div`, 'Division', LFO_DIVS, '1/4'),
    bool(`lfo${k}Retrig`, 'Retrigger on note', false, { adv: true }),
    time(`lfo${k}Fade`, 'Fade in', 0, 10, true),
  ]);
}
function matrixDefs() {
  const out = [];
  for (let s = 1; s <= WT_MATRIX_SLOTS; s++) {
    out.push(enm(`mod${s}Src`, `Slot ${s} source`, WT_MOD_SOURCES, 'off', { adv: s > 4 }));
    out.push(enm(`mod${s}Dst`, `Slot ${s} target`, WT_MOD_DESTS, 'none', { adv: s > 4 }));
    out.push(num(`mod${s}Amt`, `Slot ${s} amount`, -1, 1, 0, { step: 0.001, adv: s > 4 }));
  }
  return sec('Matrix', out);
}

export const WAVETABLE_PARAMS = [
  ...oscDefs(1, { on: true, table: 'basic', level: 0.8, pos: 0.67 }),
  ...oscDefs(2, { on: false, table: 'pwm', level: 0.6, fine: 7 }),
  ...sec('Sub & Noise', [
    num('subLevel', 'Sub level', 0, 1, 0, { step: 0.01 }),
    enm('subWave', 'Sub wave', ['sine', 'triangle', 'square', 'saw'], 'sine'),
    num('subOctave', 'Sub octave', -2, 0, -1, { step: 1, adv: true }),
    num('noiseLevel', 'Noise', 0, 1, 0, { step: 0.01 }),
    enm('noiseType', 'Noise color', ['white', 'pink', 'brown'], 'white', { adv: true }),
  ]),
  ...sec('Filter', [
    enm('filterType', 'Type', WT_FILTERS, 'lp'),
    enm('filterSlope', 'Slope', [{ value: '12', label: '12 dB' }, { value: '24', label: '24 dB' }], '24'),
    num('cutoff', 'Cutoff', 20, 20000, 12000, { unit: 'Hz', curve: 'log' }),
    num('resonance', 'Resonance', 0, 1, 0.1, { step: 0.01 }),
    num('filterDrive', 'Drive', 0, 1, 0, { step: 0.01 }),
    num('fEnvAmount', 'Env 2 amount', -8, 8, 0, { step: 0.01, unit: 'oct' }),
    num('keytrack', 'Key tracking', 0, 1, 0.3, { step: 0.01, adv: true }),
    num('velToFilter', 'Velocity → cutoff', 0, 1, 0.2, { step: 0.01, adv: true }),
  ]),
  ...envDefs(1, 'Env 1 (amp)', [0.005, 0.4, 0.8, 0.25]),
  ...sec('Env 1 (amp)', [num('velToAmp', 'Velocity → amp', 0, 1, 0.6, { step: 0.01, adv: true })]),
  ...envDefs(2, 'Env 2', [0.005, 0.4, 0.2, 0.3]),
  ...envDefs(3, 'Env 3', [0.3, 1, 0, 0.6]),
  ...lfoDefs(1), ...lfoDefs(2), ...lfoDefs(3), ...lfoDefs(4),
  ...matrixDefs(),
  ...sec('Voice', [
    enm('voiceMode', 'Mode', [{ value: 'poly', label: 'Poly' }, { value: 'mono', label: 'Mono' }, { value: 'legato', label: 'Legato' }], 'poly'),
    num('polyphony', 'Voices', 1, 32, 8, { step: 1 }),
    time('glide', 'Glide', 0, 2),
    bool('glideAlways', 'Always glide', false, { adv: true }),
    numBend(),
    num('transpose', 'Transpose', -24, 24, 0, { step: 1, unit: 'st', adv: true }),
  ]),
  ...sec('Output', [
    num('drive', 'Drive', 0, 1, 0, { step: 0.01 }),
    enm('driveType', 'Drive type', [{ value: 'soft', label: 'Soft clip' }, { value: 'tube', label: 'Tube' }, { value: 'amp', label: 'Guitar amp + cab' }], 'soft', { adv: true }),
    num('toneCut', 'Tone', 200, 20000, 20000, { unit: 'Hz', curve: 'log', adv: true }),
    num('lowCut', 'Low cut', 20, 2000, 20, { unit: 'Hz', curve: 'log', adv: true }),
    num('gain', 'Volume', 0, 2, 0.8, { step: 0.01 }),
  ]),
];
function numBend() { return num('bendRange', 'Pitch-bend range', 0, 24, 2, { step: 1, unit: 'st', adv: true }); }

/** Keys that change only what new notes / tables do (everything else is applied live to sounding voices). */
export const WT_TABLE_KEYS = ['osc1Table', 'osc2Table'];
