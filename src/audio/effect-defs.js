// Effect metadata (drives the auto-generated effect UI). Pure data + helpers:
// importable from Node (no Web Audio access here). Implementation lives in effects.js.
//
// EFFECT_DEFS = { type: { name, category, description, params: ParamDef[] } }
// ParamDef    = { key, label, type:'number'|'enum'|'bool'|'track', min, max, step, default, unit?,
//                 curve?: 'lin'|'log'|'exp', options?: [{value,label}], section, advanced? }
// type 'track' holds a track id (string, '' = none) — the UI renders a track picker; it is
// never automatable (automation only targets 'number' params).

/** Tempo-synced note divisions -> length in beats (quarter notes). */
export const DIVISIONS = {
  '4/1': 16, '2/1': 8, '1/1': 4, '1/2D': 3, '1/2': 2, '1/2T': 4 / 3,
  '1/4D': 1.5, '1/4': 1, '1/4T': 2 / 3, '1/8D': 0.75, '1/8': 0.5, '1/8T': 1 / 3,
  '1/16D': 0.375, '1/16': 0.25, '1/16T': 1 / 6, '1/32': 0.125,
};
const DIVISION_LABELS = {
  '4/1': '4 bars', '2/1': '2 bars', '1/1': '1 bar', '1/2D': '1/2 dotted', '1/2': '1/2', '1/2T': '1/2 triplet',
  '1/4D': '1/4 dotted', '1/4': '1/4', '1/4T': '1/4 triplet', '1/8D': '1/8 dotted', '1/8': '1/8', '1/8T': '1/8 triplet',
  '1/16D': '1/16 dotted', '1/16': '1/16', '1/16T': '1/16 triplet', '1/32': '1/32',
};
export const DIVISION_OPTIONS = Object.keys(DIVISIONS).map((value) => ({ value, label: DIVISION_LABELS[value] }));

/** '1/8D' | 0.75 | '0.75' -> beats. Unknown -> 1 beat. */
export function divisionToBeats(div) {
  if (typeof div === 'number' && isFinite(div) && div > 0) return div;
  if (div in DIVISIONS) return DIVISIONS[div];
  const n = parseFloat(div);
  return isFinite(n) && n > 0 ? n : 1;
}

// ---- ParamDef builders ------------------------------------------------------------------
function num(key, label, min, max, def, o = {}) {
  const p = {
    key, label, type: 'number', min, max,
    step: o.step ?? +((max - min) / 200).toPrecision(2),
    default: def, curve: o.curve || 'lin', section: o.section || 'Main',
  };
  if (o.unit) p.unit = o.unit;
  if (o.advanced) p.advanced = true;
  return p;
}
function enm(key, label, options, def, o = {}) {
  const p = {
    key, label, type: 'enum',
    options: options.map((x) => (typeof x === 'object' ? x : { value: x, label: String(x) })),
    default: def, section: o.section || 'Main',
  };
  if (o.advanced) p.advanced = true;
  return p;
}
function bool(key, label, def, o = {}) {
  const p = { key, label, type: 'bool', default: def, section: o.section || 'Main' };
  if (o.advanced) p.advanced = true;
  return p;
}
const mix = (def = 1, o = {}) => num('mix', 'Mix', 0, 1, def, { step: 0.01, section: o.section || 'Output', ...o });
const outDb = (o = {}) => num('output', 'Output', -24, 24, 0, { step: 0.1, unit: 'dB', section: 'Output', ...o });
const freq = (key, label, def, o = {}) => num(key, label, 20, 20000, def, { step: 1, unit: 'Hz', curve: 'log', ...o });
const LFO_SHAPES = [
  { value: 'sine', label: 'Sine' }, { value: 'triangle', label: 'Triangle' }, { value: 'square', label: 'Square' },
  { value: 'saw', label: 'Saw Up' }, { value: 'ramp', label: 'Saw Down' },
];
/** Shared LFO rate params: free rate in Hz, or tempo-synced division. */
function lfoParams({ rate = 1, sync = false, division = '1/4', shape = true, section = 'LFO', maxRate = 20, advShape = false } = {}) {
  const out = [
    bool('sync', 'Tempo Sync', sync, { section }),
    num('rate', 'Rate', 0.01, maxRate, rate, { step: 0.01, unit: 'Hz', curve: 'log', section }),
    enm('division', 'Division', DIVISION_OPTIONS, division, { section }),
  ];
  if (shape) out.push(enm('shape', 'Shape', LFO_SHAPES, 'sine', { section, advanced: advShape }));
  return out;
}

const FILTER_TYPES = [
  { value: 'lowpass', label: 'Low-pass' }, { value: 'highpass', label: 'High-pass' },
  { value: 'bandpass', label: 'Band-pass' }, { value: 'notch', label: 'Notch' },
];
const EQ_BAND_TYPES = [
  { value: 'peaking', label: 'Bell' }, { value: 'lowshelf', label: 'Low Shelf' }, { value: 'highshelf', label: 'High Shelf' },
  { value: 'lowpass', label: 'Low-pass' }, { value: 'highpass', label: 'High-pass' },
  { value: 'bandpass', label: 'Band-pass' }, { value: 'notch', label: 'Notch' },
];
const EQ8_FREQS = [40, 120, 300, 700, 1600, 3500, 7500, 14000];
const EQ8_TYPES = ['highpass', 'lowshelf', 'peaking', 'peaking', 'peaking', 'peaking', 'highshelf', 'lowpass'];
const EQ8_ON = [false, true, true, true, true, true, true, false];

function eq8Params() {
  const out = [];
  for (let i = 1; i <= 8; i++) {
    const section = `Band ${i}`;
    out.push(
      bool(`b${i}On`, 'On', EQ8_ON[i - 1], { section }),
      enm(`b${i}Type`, 'Type', EQ_BAND_TYPES, EQ8_TYPES[i - 1], { section, advanced: true }),
      freq(`b${i}Freq`, 'Freq', EQ8_FREQS[i - 1], { section }),
      num(`b${i}Gain`, 'Gain', -24, 24, 0, { step: 0.1, unit: 'dB', section }),
      num(`b${i}Q`, 'Q', 0.1, 18, 0.9, { step: 0.01, curve: 'log', section, advanced: true }),
    );
  }
  out.push(outDb());
  return out;
}

export const EFFECT_CATEGORIES = ['EQ & Filter', 'Dynamics', 'Distortion', 'Delay & Reverb', 'Modulation', 'Stereo', 'Utility', 'Plugins'];

export const EFFECT_DEFS = {
  // ---------------------------------------------------------------- EQ & Filter
  eq3: {
    name: 'EQ Three', category: 'EQ & Filter',
    description: 'Simple 3-band tone shaping: low shelf, mid bell and high shelf.',
    params: [
      num('low', 'Low', -24, 12, 0, { step: 0.1, unit: 'dB', section: 'Gain' }),
      num('mid', 'Mid', -24, 12, 0, { step: 0.1, unit: 'dB', section: 'Gain' }),
      num('high', 'High', -24, 12, 0, { step: 0.1, unit: 'dB', section: 'Gain' }),
      freq('lowFreq', 'Low Freq', 250, { section: 'Frequencies' }),
      freq('midFreq', 'Mid Freq', 1000, { section: 'Frequencies' }),
      num('midQ', 'Mid Q', 0.1, 10, 0.7, { step: 0.01, curve: 'log', section: 'Frequencies', advanced: true }),
      freq('highFreq', 'High Freq', 4000, { section: 'Frequencies' }),
      outDb(),
    ],
  },
  eq8: {
    name: 'Parametric EQ', category: 'EQ & Filter',
    description: '8-band parametric EQ. Each band can be a bell, shelf, cut or notch filter.',
    params: eq8Params(),
  },
  filter: {
    name: 'Auto Filter', category: 'EQ & Filter',
    description: 'Resonant filter with an LFO sweep that can lock to the tempo. Great for builds and wobbles.',
    params: [
      enm('type', 'Type', FILTER_TYPES, 'lowpass', { section: 'Filter' }),
      freq('cutoff', 'Cutoff', 2000, { section: 'Filter' }),
      num('resonance', 'Resonance', 0.1, 24, 1, { step: 0.01, curve: 'log', section: 'Filter' }),
      enm('slope', 'Slope', [{ value: '12', label: '12 dB/oct' }, { value: '24', label: '24 dB/oct' }], '12', { section: 'Filter', advanced: true }),
      num('depth', 'LFO Depth', 0, 4, 0, { step: 0.01, unit: 'oct', section: 'LFO' }),
      ...lfoParams({ rate: 1, sync: true, division: '1/4' }),
      mix(1),
    ],
  },
  // ---------------------------------------------------------------- Dynamics
  compressor: {
    name: 'Compressor', category: 'Dynamics',
    description: 'Evens out dynamics. Lower the threshold and raise the ratio for more squash; use Mix for parallel compression.',
    params: [
      num('threshold', 'Threshold', -60, 0, -18, { step: 0.1, unit: 'dB', section: 'Dynamics' }),
      num('ratio', 'Ratio', 1, 20, 4, { step: 0.1, curve: 'log', section: 'Dynamics' }),
      num('attack', 'Attack', 0.0005, 0.5, 0.01, { step: 0.0005, unit: 's', curve: 'log', section: 'Dynamics' }),
      num('release', 'Release', 0.01, 1, 0.15, { step: 0.005, unit: 's', curve: 'log', section: 'Dynamics' }),
      num('knee', 'Knee', 0, 40, 6, { step: 0.1, unit: 'dB', section: 'Dynamics', advanced: true }),
      num('makeup', 'Makeup', 0, 24, 0, { step: 0.1, unit: 'dB', section: 'Output' }),
      { key: 'sourceTrackId', label: 'Sidechain', type: 'track', default: '', section: 'Sidechain', description: 'External key: compress this channel by another track / bus (none = its own signal)' },
      mix(1),
    ],
  },
  limiter: {
    name: 'Limiter', category: 'Dynamics',
    description: 'Brick-wall style limiter: pushes loudness up while keeping peaks below the ceiling.',
    params: [
      num('gain', 'Input Gain', 0, 24, 0, { step: 0.1, unit: 'dB', section: 'Limiter' }),
      num('threshold', 'Threshold', -30, 0, -1, { step: 0.1, unit: 'dB', section: 'Limiter' }),
      num('release', 'Release', 0.01, 1, 0.1, { step: 0.005, unit: 's', curve: 'log', section: 'Limiter' }),
      num('ceiling', 'Ceiling', -12, 0, -0.3, { step: 0.1, unit: 'dB', section: 'Output' }),
      bool('clip', 'Soft Clip Safety', true, { section: 'Output', advanced: true }),
    ],
  },
  mastering: {
    name: 'Mastering', category: 'Dynamics',
    description: 'Finishing chain for the master: tone (low shelf, tilt, air), glue compressor, soft saturation, width of the highs only and a true-peak-safe limiter.',
    params: [
      num('low', 'Low', -6, 6, 0, { step: 0.1, unit: 'dB', section: 'Tone' }),
      num('tilt', 'Tilt', -4, 4, 0, { step: 0.1, unit: 'dB', section: 'Tone' }),
      num('air', 'Air', -6, 6, 0, { step: 0.1, unit: 'dB', section: 'Tone' }),
      num('glueThreshold', 'Glue Threshold', -40, 0, -16, { step: 0.1, unit: 'dB', section: 'Glue' }),
      num('glueRatio', 'Glue Ratio', 1, 6, 1.6, { step: 0.05, curve: 'log', section: 'Glue' }),
      num('glueAttack', 'Glue Attack', 0.001, 0.1, 0.03, { step: 0.001, unit: 's', curve: 'log', section: 'Glue', advanced: true }),
      num('glueRelease', 'Glue Release', 0.05, 1, 0.3, { step: 0.005, unit: 's', curve: 'log', section: 'Glue', advanced: true }),
      num('drive', 'Saturation', 0, 12, 0, { step: 0.1, unit: 'dB', section: 'Color' }),
      num('width', 'High Width', 0, 2, 1, { step: 0.01, section: 'Stereo' }),
      freq('widthFreq', 'Width Above', 2500, { section: 'Stereo', advanced: true }),
      num('gain', 'Limiter Drive', 0, 18, 0, { step: 0.1, unit: 'dB', section: 'Limiter' }),
      num('ceiling', 'Ceiling (dBTP)', -6, 0, -1, { step: 0.1, unit: 'dB', section: 'Limiter' }),
      num('release', 'Release', 0.02, 0.6, 0.12, { step: 0.005, unit: 's', curve: 'log', section: 'Limiter' }),
    ],
  },
  gate: {
    name: 'Gate', category: 'Dynamics',
    description: 'Noise gate: silences the signal when it falls below the threshold. Also good for chopping tails.',
    params: [
      num('threshold', 'Threshold', -80, 0, -40, { step: 0.1, unit: 'dB', section: 'Gate' }),
      num('range', 'Range', -80, 0, -80, { step: 0.1, unit: 'dB', section: 'Gate' }),
      num('attack', 'Attack', 0.0005, 0.05, 0.002, { step: 0.0005, unit: 's', curve: 'log', section: 'Gate' }),
      num('release', 'Release', 0.01, 1, 0.08, { step: 0.005, unit: 's', curve: 'log', section: 'Gate' }),
      num('knee', 'Knee', 0, 12, 3, { step: 0.1, unit: 'dB', section: 'Gate', advanced: true }),
      { key: 'sourceTrackId', label: 'Sidechain', type: 'track', default: '', section: 'Sidechain', description: 'External key: open the gate from another track / bus (none = its own signal)' },
    ],
  },
  ducker: {
    name: 'Ducker (Sidechain)', category: 'Dynamics',
    description: 'Keyed ducking: turns this channel down whenever the key track plays (e.g. bass ducks under the kick) — real sidechain compression feel driven by audio.',
    params: [
      { key: 'sourceTrackId', label: 'Key Track', type: 'track', default: '', section: 'Sidechain' },
      num('amount', 'Amount', 0, 1, 0.7, { step: 0.01, section: 'Sidechain' }),
      num('threshold', 'Threshold', -60, 0, -20, { step: 0.1, unit: 'dB', section: 'Sidechain' }),
      num('attack', 'Attack', 0.001, 0.1, 0.005, { step: 0.0005, unit: 's', curve: 'log', section: 'Envelope' }),
      num('release', 'Release', 0.02, 1.5, 0.18, { step: 0.005, unit: 's', curve: 'log', section: 'Envelope' }),
    ],
  },
  pump: {
    name: 'Pump (Sidechain)', category: 'Dynamics',
    description: 'Tempo-synced sidechain-style volume ducking — the classic EDM "pumping" effect without routing a kick.',
    params: [
      enm('division', 'Rate', DIVISION_OPTIONS, '1/4', { section: 'Pump' }),
      num('depth', 'Depth', 0, 1, 0.8, { step: 0.01, section: 'Pump' }),
      num('curve', 'Release', 0.05, 1, 0.6, { step: 0.01, section: 'Pump' }),
      enm('shape', 'Shape', [
        { value: 'classic', label: 'Classic' }, { value: 'linear', label: 'Linear' },
        { value: 'smooth', label: 'Smooth' }, { value: 'hard', label: 'Hard Gate' },
      ], 'classic', { section: 'Pump' }),
      num('attack', 'Attack', 0.001, 0.05, 0.006, { step: 0.001, unit: 's', curve: 'log', section: 'Pump', advanced: true }),
      num('offset', 'Phase Offset', 0, 1, 0, { step: 0.01, section: 'Pump', advanced: true }),
    ],
  },
  // ---------------------------------------------------------------- Distortion
  distortion: {
    name: 'Distortion', category: 'Distortion',
    description: 'Waveshaping distortion: soft, hard clip, tube, fuzz and wavefolding.',
    params: [
      enm('type', 'Type', [
        { value: 'soft', label: 'Soft Clip' }, { value: 'hard', label: 'Hard Clip' }, { value: 'tube', label: 'Tube' },
        { value: 'fuzz', label: 'Fuzz' }, { value: 'foldback', label: 'Foldback' },
      ], 'soft', { section: 'Drive' }),
      num('drive', 'Drive', 0, 48, 12, { step: 0.1, unit: 'dB', section: 'Drive' }),
      freq('tone', 'Tone', 8000, { section: 'Tone' }),
      outDb(),
      mix(1),
    ],
  },
  saturator: {
    name: 'Saturator', category: 'Distortion',
    description: 'Gentle harmonic saturation to add warmth and glue.',
    params: [
      enm('type', 'Type', [
        { value: 'soft', label: 'Soft' }, { value: 'warm', label: 'Warm (asym)' }, { value: 'tube', label: 'Tube' },
      ], 'warm', { section: 'Drive' }),
      num('drive', 'Drive', 0, 24, 6, { step: 0.1, unit: 'dB', section: 'Drive' }),
      freq('tone', 'Tone', 12000, { section: 'Tone' }),
      outDb(),
      mix(1),
    ],
  },
  tape: {
    name: 'Tape', category: 'Distortion',
    description: 'Tape emulation: soft saturation, high-frequency roll-off and wow/flutter pitch wobble.',
    params: [
      num('drive', 'Drive', 0, 24, 4, { step: 0.1, unit: 'dB', section: 'Tape' }),
      freq('tone', 'Tone', 9000, { section: 'Tape' }),
      num('wow', 'Wow', 0, 1, 0.25, { step: 0.01, section: 'Wobble' }),
      num('wowRate', 'Wow Rate', 0.1, 4, 0.6, { step: 0.01, unit: 'Hz', curve: 'log', section: 'Wobble', advanced: true }),
      num('flutter', 'Flutter', 0, 1, 0.15, { step: 0.01, section: 'Wobble' }),
      outDb(),
      mix(1),
    ],
  },
  bitcrusher: {
    name: 'Bitcrusher', category: 'Distortion',
    description: 'Lo-fi digital degradation: bit-depth reduction and sample-rate reduction.',
    params: [
      num('bits', 'Bits', 1, 16, 8, { step: 1, section: 'Crush' }),
      num('downsample', 'Downsample', 1, 32, 1, { step: 1, unit: 'x', section: 'Crush' }),
      outDb(),
      mix(1),
    ],
  },
  // ---------------------------------------------------------------- Delay & Reverb
  delay: {
    name: 'Delay', category: 'Delay & Reverb',
    description: 'Stereo / ping-pong echo with filtered feedback. Sync to the tempo for rhythmic delays.',
    params: [
      bool('sync', 'Tempo Sync', false, { section: 'Time' }),
      num('time', 'Time', 0.01, 2, 0.375, { step: 0.001, unit: 's', curve: 'log', section: 'Time' }),
      enm('division', 'Division', DIVISION_OPTIONS, '1/8D', { section: 'Time' }),
      num('feedback', 'Feedback', 0, 0.95, 0.4, { step: 0.01, section: 'Feedback' }),
      bool('pingpong', 'Ping-Pong', false, { section: 'Feedback' }),
      freq('lowcut', 'Low Cut', 120, { section: 'Feedback', advanced: true }),
      freq('highcut', 'High Cut', 7000, { section: 'Feedback', advanced: true }),
      mix(0.35),
    ],
  },
  reverb: {
    name: 'Reverb', category: 'Delay & Reverb',
    description: 'Convolution reverb with a modelled space — early reflections and a frequency-dependent tail, from small rooms to huge halls and plates.',
    params: [
      enm('character', 'Space', [
        { value: 'auto', label: 'Auto (by size)' }, { value: 'room', label: 'Room' }, { value: 'chamber', label: 'Chamber' },
        { value: 'hall', label: 'Hall' }, { value: 'plate', label: 'Plate' }, { value: 'ambience', label: 'Ambience' }, { value: 'classic', label: 'Classic (v1)' },
      ], 'auto', { section: 'Space' }),
      num('decay', 'Decay', 0.1, 12, 2.2, { step: 0.01, unit: 's', curve: 'log', section: 'Space' }),
      num('size', 'Size', 0, 1, 0.6, { step: 0.01, section: 'Space' }),
      num('predelay', 'Pre-delay', 0, 0.25, 0.01, { step: 0.001, unit: 's', section: 'Space' }),
      num('damping', 'Damping', 0, 1, 0.5, { step: 0.01, section: 'Tone' }),
      freq('lowcut', 'Low Cut', 150, { section: 'Tone', advanced: true }),
      freq('highcut', 'High Cut', 12000, { section: 'Tone', advanced: true }),
      mix(0.3),
    ],
  },
  // ---------------------------------------------------------------- Modulation
  chorus: {
    name: 'Chorus', category: 'Modulation',
    description: 'Lush stereo chorus from modulated short delays.',
    params: [
      ...lfoParams({ rate: 0.8, maxRate: 8, shape: false, division: '1/2' }),
      num('depth', 'Depth', 0, 1, 0.5, { step: 0.01, section: 'Chorus' }),
      num('delay', 'Delay', 0.005, 0.04, 0.018, { step: 0.0005, unit: 's', section: 'Chorus', advanced: true }),
      num('spread', 'Stereo Spread', 0, 1, 1, { step: 0.01, section: 'Chorus', advanced: true }),
      mix(0.5),
    ],
  },
  flanger: {
    name: 'Flanger', category: 'Modulation',
    description: 'Jet-plane comb-filter sweep with feedback.',
    params: [
      ...lfoParams({ rate: 0.25, maxRate: 8, shape: false, division: '1/1' }),
      num('depth', 'Depth', 0, 1, 0.7, { step: 0.01, section: 'Flanger' }),
      num('delay', 'Delay', 0.003, 0.015, 0.004, { step: 0.0001, unit: 's', section: 'Flanger', advanced: true }),
      num('feedback', 'Feedback', -0.95, 0.95, 0.5, { step: 0.01, section: 'Flanger' }),
      mix(0.5),
    ],
  },
  phaser: {
    name: 'Phaser', category: 'Modulation',
    description: 'Sweeping all-pass phaser for swirling movement.',
    params: [
      ...lfoParams({ rate: 0.4, maxRate: 10, shape: false, division: '1/1' }),
      enm('stages', 'Stages', [2, 4, 6, 8, 12].map((v) => ({ value: v, label: String(v) })), 4, { section: 'Phaser' }),
      freq('frequency', 'Frequency', 800, { section: 'Phaser' }),
      num('depth', 'Depth', 0, 4, 2, { step: 0.01, unit: 'oct', section: 'Phaser' }),
      num('feedback', 'Feedback', 0, 0.9, 0.3, { step: 0.01, section: 'Phaser', advanced: true }),
      num('q', 'Q', 0.1, 4, 0.7, { step: 0.01, section: 'Phaser', advanced: true }),
      bool('stereo', 'Stereo', true, { section: 'Phaser', advanced: true }),
      mix(0.5),
    ],
  },
  tremolo: {
    name: 'Tremolo', category: 'Modulation',
    description: 'Rhythmic volume modulation. Enable Stereo for a ping-pong tremolo.',
    params: [
      ...lfoParams({ rate: 5, sync: true, division: '1/8' }),
      num('depth', 'Depth', 0, 1, 0.6, { step: 0.01, section: 'Tremolo' }),
      bool('stereo', 'Stereo', false, { section: 'Tremolo' }),
    ],
  },
  autopan: {
    name: 'Auto Pan', category: 'Modulation',
    description: 'Moves the sound left and right with an LFO.',
    params: [
      ...lfoParams({ rate: 1, sync: true, division: '1/2' }),
      num('depth', 'Depth', 0, 1, 0.8, { step: 0.01, section: 'Pan' }),
    ],
  },
  // ---------------------------------------------------------------- Stereo / Utility
  widener: {
    name: 'Stereo Widener', category: 'Stereo',
    description: 'Mid/side width control. Keep the low end mono for punchy, club-safe mixes.',
    params: [
      num('width', 'Width', 0, 2, 1.4, { step: 0.01, section: 'Stereo' }),
      freq('monoBelow', 'Mono Below', 20, { section: 'Stereo', advanced: true }),
      outDb(),
    ],
  },
  utility: {
    name: 'Utility', category: 'Utility',
    description: 'Gain, pan, stereo width, mono and phase invert.',
    params: [
      num('gain', 'Gain', -36, 24, 0, { step: 0.1, unit: 'dB', section: 'Utility' }),
      num('pan', 'Pan', -1, 1, 0, { step: 0.01, section: 'Utility' }),
      num('width', 'Width', 0, 2, 1, { step: 0.01, section: 'Utility' }),
      bool('mono', 'Mono', false, { section: 'Utility' }),
      bool('invert', 'Phase Invert', false, { section: 'Utility', advanced: true }),
    ],
  },
  // ---------------------------------------------------------------- Plugins (src/plugins, lazy-loaded)
  // Extra keys kept in effect.params: faust {name, code, url, values:{address: value}}, wam {name, url, state}.
  faust: {
    name: 'Faust Effect', category: 'Plugins', plugin: true,
    description: 'A Faust DSP program compiled in the browser — load one from the plugin catalog, a GitHub link or the Faust editor.',
    params: [num('mix', 'Mix', 0, 1, 1, { step: 0.01, section: 'Plugin' })],
  },
  native: {
    name: 'Native Plugin', category: 'Plugins', plugin: true,
    description: 'A VST3, Audio Unit or CLAP effect installed on this Mac (daW³ Mac app; runs in the out-of-process plugin host).',
    params: [num('mix', 'Mix', 0, 1, 1, { step: 0.01, section: 'Plugin' })],
  },
  wam: {
    name: 'Web Audio Module', category: 'Plugins', plugin: true,
    description: 'A Web Audio Modules 2.0 effect plugin loaded from a URL (experimental; may only run live).',
    params: [num('mix', 'Mix', 0, 1, 1, { step: 0.01, section: 'Plugin' })],
  },
};

export const EFFECT_TYPES = Object.keys(EFFECT_DEFS);

/** { key: default } for an effect type ({} for unknown types). */
export function getEffectDefaults(type) {
  const def = EFFECT_DEFS[type];
  if (!def) return {};
  return Object.fromEntries(def.params.map((p) => [p.key, p.default]));
}

/** Merge an Effect's stored params over the defaults, coercing enum/bool/number types. */
export function resolveEffectParams(effect) {
  const def = EFFECT_DEFS[effect?.type];
  const params = effect?.params || {};
  if (!def) return { ...params };
  const out = {};
  for (const p of def.params) {
    let v = params[p.key];
    if (v === undefined || v === null) v = p.default;
    if (p.type === 'number') {
      v = Number(v);
      if (!isFinite(v)) v = p.default;
      v = Math.min(p.max, Math.max(p.min, v));
    } else if (p.type === 'bool') {
      v = v === true || v === 1 || v === 'true' || v === '1';
    } else if (p.type === 'track') {
      v = v ? String(v) : '';
    } else if (p.type === 'enum') {
      const match = p.options.find((o) => o.value === v || String(o.value) === String(v));
      v = match ? match.value : p.default;
    }
    out[p.key] = v;
  }
  return out;
}
