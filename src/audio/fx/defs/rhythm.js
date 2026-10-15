// Rhythm effect definitions. Receives the ParamDef helpers from effect-defs.js and returns
// { type: { name, category, description, params, presets? } } entries merged into EFFECT_DEFS.
// presets (optional) = { 'Preset name': { paramKey: value, ... } } — same shape as EFFECT_PRESETS.
//
// Step patterns and curves are 'pattern' params: opaque strings (see fx/rhythm-dsp.js for the formats) edited by
// the custom card UIs in ui/fx-ui/rhythm.js. Generic UIs, Pocket and automation skip them; everything numeric is
// automatable as usual.
import { GATE_PATTERNS, SHAPER_CURVES } from '../rhythm-library.js';

const pick = (all, keys) => all.filter((o) => keys.includes(o.value));

export default function rhythmDefs({ num, enm, bool, DIVISION_OPTIONS }) {
  const mix = (def = 1) => num('mix', 'Mix', 0, 1, def, { step: 0.01, section: 'Output' });
  const pattern = (key, label, def, section, o = {}) => ({ key, label, type: 'pattern', default: def, section, ...o });

  const GATE_DIVS = pick(DIVISION_OPTIONS, ['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32']);
  const SHAPER_LENGTHS = [
    { value: '1/8', label: '1/8 note' }, { value: '1/4', label: '1 beat' }, { value: '1/2', label: '2 beats' },
    { value: '1/1', label: '1 bar' }, { value: '2/1', label: '2 bars' }, { value: '4/1', label: '4 bars' },
  ];
  const REPEAT_GRID = [...pick(DIVISION_OPTIONS, ['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32']), { value: '1/64', label: '1/64' }];
  const INTERVALS = [
    { value: '1/4', label: '1 beat' }, { value: '1/2', label: '2 beats' }, { value: '1/1', label: '1 bar' },
    { value: '2/1', label: '2 bars' }, { value: '4/1', label: '4 bars' },
  ];
  const TIME_LENGTHS = pick(DIVISION_OPTIONS, ['1/16', '1/8', '1/4', '1/2', '1/1', '2/1']);

  // ---------------------------------------------------------------- trance gate presets
  const gate = (name, extra = {}) => ({ ...GATE_PATTERNS[name], ...extra });
  const gatePresets = {
    'Classic Trance': gate('Classic Trance', { length: 0.7, release: 0.03, depth: 1 }),
    'Trance Lift': gate('Trance Lift', { length: 0.6, release: 0.025 }),
    'Smooth Pad Gate': gate('Straight 16ths', { length: 0.55, attack: 0.008, release: 0.06, curve: -0.3, depth: 0.85 }),
    'Offbeat Pluck': gate('Offbeat 8ths', { length: 0.5, release: 0.04, curve: 0.5 }),
    'Rolling Psy': gate('Rolling Offbeat', { length: 0.8, release: 0.012, curve: 0.4 }),
    'Gallop': gate('Gallop', { length: 0.65, release: 0.02 }),
    '3-3-2 House': gate('Three-Three-Two', { length: 0.9, release: 0.05, swing: 0.2 }),
    'Dotted Echo': gate('Dotted 8ths', { length: 0.8, release: 0.08 }),
    'Quarter Chop': gate('Quarter Chop', { legato: true, length: 1, release: 0.015 }),
    'Half-Bar Stutter': gate('Half-Bar Chop', { length: 0.45, release: 0.01, curve: 0.6 }),
    'Dub Chop': gate('Dub Chop', { length: 0.6, release: 0.09, curve: -0.2 }),
    'Swing House Organ': gate('House Organ', { length: 0.75, swing: 0.35, release: 0.04 }),
    'Accent Pump': gate('Accent Pump', { length: 0.85, release: 0.03 }),
    'Ramp Up Swells': gate('Ramp Up', { legato: true, length: 1, attack: 0.004 }),
    'Echo Taps': gate('Echo Taps', { length: 0.5, release: 0.07 }),
    'Euclid 7': gate('Euclid 7/16', { length: 0.6, release: 0.03 }),
    'Triplet Gallop': gate('Triplet Gallop', { length: 0.7, release: 0.03 }),
    '32nd Roll Build': gate('32nd Roll', { length: 0.6, release: 0.01 }),
    'Ping-Pong 8ths': gate('Ping-Pong 8ths', { length: 0.7, release: 0.05 }),
    'Stereo Trance': gate('Stereo Trance', { length: 0.6, release: 0.025 }),
    'Wide Weave': gate('Wide Weave', { length: 0.65, release: 0.03 }),
    'Subtle Movement': gate('Classic Trance', { length: 0.8, release: 0.06, depth: 0.45, mix: 1 }),
  };

  // ---------------------------------------------------------------- volume shaper presets
  const shape = (name, extra = {}) => ({ shape: SHAPER_CURVES[name], ...extra });
  const shaperPresets = {
    'Sidechain 1/4 Classic': shape('Pump Classic', { length: '1/4' }),
    'Sidechain 1/4 Hard': shape('Pump Hard', { length: '1/4' }),
    'Sidechain 1/4 Soft': shape('Pump Soft', { length: '1/4', depth: 0.8 }),
    'Sidechain Long Release': shape('Pump Long', { length: '1/4' }),
    'Sidechain Late Recovery': shape('Pump Late', { length: '1/4' }),
    'Sidechain 1/8 Fast': shape('Pump Classic', { length: '1/8', depth: 0.7 }),
    'Duck & Hold': shape('Duck & Hold', { length: '1/4' }),
    'Half-Time Pump': shape('Pump Classic', { length: '1/2' }),
    'Half-Time Double': shape('Half-Time Pump', { length: '1/1' }),
    '8th Gate': shape('Gate 1/2', { length: '1/4', smoothing: 0.003 }),
    '16th Gate': shape('Gate 1/4 x2', { length: '1/4', smoothing: 0.002 }),
    'Short Stabs': shape('Gate Short', { length: '1/4', smoothing: 0.002 }),
    'Swell (1 bar)': shape('Swell', { length: '1/1' }),
    'Reverse Swell (1 bar)': shape('Reverse Swell', { length: '1/1', smoothing: 0.004 }),
    'Build Swell (4 bars)': shape('Swell', { length: '4/1' }),
    'Fade Out (2 bars)': shape('Fade Out', { length: '2/1' }),
    'Tremolo Sine 1/8': shape('Sine', { length: '1/8', depth: 0.6 }),
    'Filter Pump': shape('Pump Classic', { length: '1/4', target: 'filter', cutoffMin: 300, cutoffMax: 14000 }),
    'Filter Swell (2 bars)': shape('Swell', { length: '2/1', target: 'filter', cutoffMin: 150, cutoffMax: 16000, resonance: 2 }),
    'Filter Steps': shape('Stair Steps', { length: '1/1', target: 'filter', cutoffMin: 250, cutoffMax: 8000, resonance: 4, smoothing: 0.004 }),
  };

  // ---------------------------------------------------------------- beat repeat presets
  const repeatPresets = {
    'Bar-End 1/16 Stutter': { interval: '1/1', offset: 12, gate: 4, grid: '1/16', chance: 1, mode: 'insert' },
    'Bar-End 1/32 Roll': { interval: '1/1', offset: 14, gate: 2, grid: '1/32', chance: 1 },
    'Phrase Fill (4 bars)': { interval: '4/1', offset: 15, gate: 16, grid: '1/16', decay: 0.08 },
    'Triplet Roll': { interval: '1/1', offset: 12, gate: 4, grid: '1/16T' },
    'Pitch Dive': { interval: '2/1', offset: 12, gate: 8, grid: '1/16', pitch: -1, decay: 0.05 },
    'Tape Echo Repeats': { interval: '1/1', offset: 8, gate: 8, grid: '1/8', decay: 0.3, mode: 'mix', mix: 0.8 },
    'Random Glitch': { interval: '1/4', offset: 2, gate: 2, grid: '1/32', chance: 0.3, seed: 7 },
    'Random Stutter': { interval: '1/2', offset: 4, gate: 4, grid: '1/16', chance: 0.4, seed: 3 },
    '1/64 Buzz': { interval: '1/1', offset: 15, gate: 1, grid: '1/64' },
    'Beat Loop': { interval: '2/1', offset: 0, gate: 8, grid: '1/4' },
    'Half-Bar 1/8 Loop': { interval: '1/1', offset: 8, gate: 8, grid: '1/8' },
    'Gated Repeats Only': { interval: '1/1', offset: 0, gate: 16, grid: '1/8', mode: 'gate' },
    'Decaying Echo Mix': { interval: '1/1', offset: 12, gate: 4, grid: '1/16', decay: 0.25, mode: 'mix' },
    'Manual Stutter Only': { interval: '4/1', chance: 0, grid: '1/16' },
  };

  // ---------------------------------------------------------------- time shaper presets
  const timePresets = {
    'Tape Stop: last beat / 4 bars': { mode: 'tapestop', trigger: 'sync', every: 4, length: '1/4', align: 'end', curve: 0 },
    'Tape Stop: slow 2 beats': { mode: 'tapestop', every: 4, length: '1/2', curve: -0.4 },
    'Tape Stop + Start': { mode: 'tapestop', every: 4, length: '1/2', tapeStart: true, startLength: '1/4', curve: 0.2 },
    'Quick Brake 1/8': { mode: 'tapestop', every: 1, length: '1/8', curve: 0.5 },
    'Turntable Stop (bar)': { mode: 'tapestop', every: 8, length: '1/1', curve: -0.6 },
    'Tape Start Intro': { mode: 'tapestart', every: 4, length: '1/2', align: 'start', curve: 0.3 },
    'Reverse Last Beat': { mode: 'reverse', every: 1, length: '1/4', align: 'end' },
    'Reverse 1/8 Flip': { mode: 'reverse', every: 1, length: '1/8', align: 'end' },
    'Reverse Half Bar / 2 bars': { mode: 'reverse', every: 2, length: '1/2', align: 'end' },
    'Reverse Bar / 4 bars': { mode: 'reverse', every: 4, length: '1/1', align: 'end' },
    'Half Speed Last Bar': { mode: 'halfspeed', every: 4, length: '1/1', align: 'end' },
    'Half-Time Every Bar': { mode: 'halfspeed', every: 1, length: '1/1', align: 'start' },
    'Half Speed Beat Drop': { mode: 'halfspeed', every: 2, length: '1/2', align: 'end' },
    'Manual Tape Stop': { mode: 'tapestop', trigger: 'manual', length: '1/2', tapeStart: true, startLength: '1/4' },
    'Manual Reverse': { mode: 'reverse', trigger: 'manual', length: '1/4' },
  };

  return {
    trancegate: {
      name: 'Trance Gate', category: 'Rhythm',
      description: 'Step-sequenced volume gate locked to the song grid: draw per-step levels, shape the attack and release, swing it and offset the right channel for stereo movement.',
      params: [
        pattern('pattern', 'Pattern', GATE_PATTERNS['Classic Trance'].pattern, 'Pattern'),
        pattern('patternR', 'Pattern R', '', 'Pattern'),
        num('steps', 'Steps', 1, 32, 16, { step: 1, section: 'Pattern' }),
        enm('division', 'Resolution', GATE_DIVS, '1/16', { section: 'Pattern' }),
        num('length', 'Step Length', 0.05, 1, 0.7, { step: 0.01, unit: '%', section: 'Envelope' }),
        num('attack', 'Attack', 0.0003, 0.1, 0.002, { step: 0.0001, unit: 's', curve: 'log', section: 'Envelope' }),
        num('release', 'Release', 0.001, 0.5, 0.03, { step: 0.001, unit: 's', curve: 'log', section: 'Envelope' }),
        num('curve', 'Shape', -1, 1, 0, { step: 0.01, section: 'Envelope' }),
        bool('legato', 'Legato', false, { section: 'Envelope', advanced: true }),
        num('swing', 'Swing', 0, 1, 0, { step: 0.01, unit: '%', section: 'Groove' }),
        enm('stereo', 'Stereo', [
          { value: 'mono', label: 'Linked' }, { value: 'offset', label: 'Offset R' },
          { value: 'separate', label: 'Separate R' }, { value: 'invert', label: 'Inverted R' },
        ], 'mono', { section: 'Stereo' }),
        num('stereoOffset', 'R Offset', -16, 16, 2, { step: 1, section: 'Stereo' }),
        num('depth', 'Depth', 0, 1, 1, { step: 0.01, unit: '%', section: 'Output' }),
        mix(1),
      ],
      presets: gatePresets,
    },
    volshaper: {
      name: 'Volume Shaper', category: 'Rhythm',
      description: 'LFO-tool style drawable gain curve over 1/8 note to 4 bars, locked to the grid: sidechain pumps, gates, swells. Can also sweep a filter.',
      params: [
        pattern('shape', 'Curve', SHAPER_CURVES['Pump Classic'], 'Shape'),
        enm('length', 'Length', SHAPER_LENGTHS, '1/4', { section: 'Shape' }),
        num('depth', 'Depth', 0, 1, 1, { step: 0.01, unit: '%', section: 'Shape' }),
        num('offset', 'Phase', 0, 1, 0, { step: 0.01, unit: '%', section: 'Shape' }),
        num('smoothing', 'Smoothing', 0, 0.05, 0.001, { step: 0.0005, unit: 's', section: 'Shape' }),
        enm('grid', 'Snap Grid', [4, 8, 16, 32].map((v) => ({ value: v, label: `${v} divisions` })), 16, { section: 'Shape', advanced: true }),
        bool('snap', 'Snap', true, { section: 'Shape', advanced: true }),
        enm('target', 'Destination', [
          { value: 'volume', label: 'Volume' }, { value: 'filter', label: 'Filter cutoff' }, { value: 'both', label: 'Volume + filter' },
        ], 'volume', { section: 'Filter' }),
        num('cutoffMin', 'Cutoff Low', 20, 20000, 250, { step: 1, unit: 'Hz', curve: 'log', section: 'Filter' }),
        num('cutoffMax', 'Cutoff High', 20, 20000, 12000, { step: 1, unit: 'Hz', curve: 'log', section: 'Filter' }),
        num('resonance', 'Resonance', 0.5, 10, 0.9, { step: 0.01, curve: 'log', section: 'Filter', advanced: true }),
        mix(1),
      ],
      presets: shaperPresets,
    },
    beatrepeat: {
      name: 'Beat Repeat', category: 'Rhythm',
      description: 'Grid-locked stutter: captures a slice at a set point of every interval and repeats it, with chance, decay and pitch-down per repeat. Hold the Stutter button to repeat live.',
      params: [
        enm('interval', 'Interval', INTERVALS, '1/1', { section: 'Repeat' }),
        num('offset', 'Offset', 0, 15, 12, { step: 1, unit: '/16', section: 'Repeat' }),
        num('gate', 'Gate', 1, 64, 4, { step: 1, unit: '/16', section: 'Repeat' }),
        enm('grid', 'Repeat', REPEAT_GRID, '1/16', { section: 'Repeat' }),
        num('chance', 'Chance', 0, 1, 1, { step: 0.01, unit: '%', section: 'Repeat' }),
        num('decay', 'Decay', 0, 1, 0, { step: 0.01, unit: '%', section: 'Repeats' }),
        num('pitch', 'Pitch / Repeat', -12, 0, 0, { step: 0.1, unit: 'st', section: 'Repeats' }),
        enm('mode', 'Mode', [
          { value: 'insert', label: 'Insert' }, { value: 'mix', label: 'Mix' }, { value: 'gate', label: 'Gate' },
        ], 'insert', { section: 'Output' }),
        num('seed', 'Variation', 0, 99, 0, { step: 1, section: 'Repeat', advanced: true }),
        mix(1),
      ],
      presets: repeatPresets,
    },
    timeshaper: {
      name: 'Time Shaper', category: 'Rhythm',
      description: 'Tape stop / tape start, synced reverse and half speed on a buffer of the input — triggered every N bars or by hand.',
      params: [
        enm('mode', 'Effect', [
          { value: 'tapestop', label: 'Tape Stop' }, { value: 'tapestart', label: 'Tape Start' },
          { value: 'reverse', label: 'Reverse' }, { value: 'halfspeed', label: 'Half Speed' },
        ], 'tapestop', { section: 'Time' }),
        enm('trigger', 'Trigger', [{ value: 'sync', label: 'Every N bars' }, { value: 'manual', label: 'Manual' }], 'sync', { section: 'Time' }),
        enm('every', 'Every', [1, 2, 4, 8].map((v) => ({ value: v, label: `${v} bar${v > 1 ? 's' : ''}` })), 4, { section: 'Time' }),
        enm('length', 'Length', TIME_LENGTHS, '1/4', { section: 'Time' }),
        enm('align', 'Position', [{ value: 'end', label: 'End of interval' }, { value: 'start', label: 'Start of interval' }], 'end', { section: 'Time' }),
        num('curve', 'Curve', -1, 1, 0, { step: 0.01, section: 'Tape' }),
        bool('tapeStart', 'Tape Start After', false, { section: 'Tape' }),
        enm('startLength', 'Start Time', TIME_LENGTHS, '1/4', { section: 'Tape' }),
        mix(1),
      ],
      presets: timePresets,
    },
  };
}
