// Space effect definitions (algorithmic + shimmer reverb, tape / multitap / granular delay). Receives the ParamDef
// helpers from effect-defs.js and returns { type: { name, category, description, params, presets? } } entries merged
// into EFFECT_DEFS. presets = { 'Preset name': { paramKey: value, ... } } — same shape as EFFECT_PRESETS.
// DSP: src/audio/fx/dsp (reverb.js, granular.js) in the worklets of src/audio/fx/worklets; builders in ../builders/space.js.

export const REVERB_MODE_OPTIONS = [
  { value: 'room', label: 'Room' }, { value: 'hall', label: 'Hall' }, { value: 'plate', label: 'Plate' },
  { value: 'chamber', label: 'Chamber' }, { value: 'spring', label: 'Spring' },
];
export const SHIMMER_OPTIONS = [
  { value: '12', label: '+12 (octave)' }, { value: '7', label: '+7 (fifth)' }, { value: '5', label: '+5 (fourth)' },
  { value: '-12', label: '−12 (octave down)' }, { value: '19', label: '+19 (octave + fifth)' }, { value: '24', label: '+24 (two octaves)' },
  { value: '12+7', label: '+12 & +7' }, { value: '12-12', label: '+12 & −12' },
];
export const TAP_FILTERS = [
  { value: 'off', label: 'Off' }, { value: 'lowpass', label: 'Low-pass' }, { value: 'highpass', label: 'High-pass' }, { value: 'bandpass', label: 'Band-pass' },
];
export const GRAIN_WINDOW_OPTIONS = [{ value: 'hann', label: 'Smooth' }, { value: 'tukey', label: 'Punchy' }, { value: 'triangle', label: 'Triangle' }];
export const MULTITAP_COUNT = 8;
const TAP_DEFAULTS = [
  { on: true, pos: 0.1875, level: 0.8, pan: -0.5 }, { on: true, pos: 0.375, level: 0.65, pan: 0.5 },
  { on: true, pos: 0.5, level: 0.55, pan: -0.25 }, { on: true, pos: 0.75, level: 0.45, pan: 0.25 },
  { on: false, pos: 0.0625, level: 0.5, pan: 0 }, { on: false, pos: 0.25, level: 0.5, pan: 0 },
  { on: false, pos: 0.625, level: 0.5, pan: 0 }, { on: false, pos: 0.875, level: 0.5, pan: 0 },
];

/** Multitap preset helper: taps = [[pos, level, pan, filter?, freq?], ...] (others off). */
function taps(list, extra = {}) {
  const out = { ...extra };
  for (let i = 1; i <= MULTITAP_COUNT; i++) {
    const t = list[i - 1];
    out[`t${i}On`] = !!t;
    if (t) {
      out[`t${i}Pos`] = t[0]; out[`t${i}Level`] = t[1]; out[`t${i}Pan`] = t[2] ?? 0;
      out[`t${i}Filter`] = t[3] || 'off';
      if (t[4]) out[`t${i}Freq`] = t[4];
    }
  }
  return out;
}

export default function spaceDefs({ num, enm, bool, DIVISION_OPTIONS }) {
  const mix = (def) => num('mix', 'Mix', 0, 1, def, { step: 0.01, section: 'Output' });
  const hz = (key, label, min, max, def, o = {}) => num(key, label, min, max, def, { step: 1, unit: 'Hz', curve: 'log', ...o });

  const tapParams = [];
  for (let i = 1; i <= MULTITAP_COUNT; i++) {
    const d = TAP_DEFAULTS[i - 1];
    const section = `Tap ${i}`;
    tapParams.push(
      bool(`t${i}On`, 'On', d.on, { section }),
      num(`t${i}Pos`, 'Position', 0.015625, 1, d.pos, { step: 0.015625, section }),
      num(`t${i}Level`, 'Level', 0, 1, d.level, { step: 0.01, section }),
      num(`t${i}Pan`, 'Pan', -1, 1, d.pan, { step: 0.01, section }),
      enm(`t${i}Filter`, 'Filter', TAP_FILTERS, 'off', { section, advanced: true }),
      hz(`t${i}Freq`, 'Filter Freq', 40, 18000, 2500, { section, advanced: true }),
    );
  }

  return {
    algoReverb: {
      name: 'Algorithmic Reverb', category: 'Delay & Reverb',
      description: 'Feedback-delay-network reverb (room, hall, plate, chamber, spring) with modulation, early/late balance, freeze and width. Rendered live and offline by an AudioWorklet.',
      params: [
        enm('mode', 'Space', REVERB_MODE_OPTIONS, 'hall', { section: 'Space' }),
        num('size', 'Size', 0, 1, 0.6, { step: 0.01, section: 'Space' }),
        num('decay', 'Decay', 0.1, 30, 2.4, { step: 0.01, unit: 's', curve: 'log', section: 'Space' }),
        num('predelay', 'Pre-delay', 0, 0.5, 0.02, { step: 0.001, unit: 's', section: 'Space' }),
        num('balance', 'Early / Late', 0, 1, 0.6, { step: 0.01, section: 'Space' }),
        num('diffusion', 'Diffusion', 0, 1, 0.75, { step: 0.01, section: 'Character' }),
        num('mod', 'Modulation', 0, 1, 0.3, { step: 0.01, section: 'Character' }),
        num('damping', 'Damping', 0, 1, 0.45, { step: 0.01, section: 'Tone' }),
        hz('lowcut', 'Low Cut', 20, 2000, 100, { section: 'Tone' }),
        hz('highcut', 'High Cut', 1000, 20000, 9000, { section: 'Tone' }),
        bool('freeze', 'Freeze', false, { section: 'Space' }),
        num('width', 'Width', 0, 2, 1, { step: 0.01, section: 'Output' }),
        mix(0.3),
      ],
      presets: {
        'Small Room': { mode: 'room', size: 0.3, decay: 0.6, predelay: 0.004, balance: 0.4, damping: 0.55, highcut: 8000, mix: 0.22 },
        'Drum Room': { mode: 'room', size: 0.45, decay: 0.9, predelay: 0.002, balance: 0.35, diffusion: 0.85, damping: 0.4, lowcut: 180, mix: 0.25 },
        'Vocal Plate': { mode: 'plate', size: 0.55, decay: 1.8, predelay: 0.03, balance: 0.8, diffusion: 0.85, damping: 0.3, lowcut: 200, highcut: 11000, mix: 0.25 },
        'Bright Plate': { mode: 'plate', size: 0.7, decay: 2.6, predelay: 0.015, balance: 0.85, damping: 0.1, highcut: 16000, mix: 0.3 },
        'Snare Plate': { mode: 'plate', size: 0.4, decay: 1.2, predelay: 0.008, balance: 0.75, damping: 0.25, lowcut: 250, mix: 0.3 },
        'Concert Hall': { mode: 'hall', size: 0.8, decay: 3.2, predelay: 0.035, balance: 0.6, mod: 0.35, damping: 0.5, highcut: 8000, mix: 0.3 },
        'Cathedral': { mode: 'hall', size: 1, decay: 8, predelay: 0.06, balance: 0.75, mod: 0.45, damping: 0.55, lowcut: 80, highcut: 7000, width: 1.2, mix: 0.35 },
        'Stone Chamber': { mode: 'chamber', size: 0.55, decay: 1.6, predelay: 0.012, balance: 0.5, damping: 0.35, mix: 0.25 },
        'Studio Chamber': { mode: 'chamber', size: 0.7, decay: 2.2, predelay: 0.02, balance: 0.6, damping: 0.45, lowcut: 150, highcut: 9500, mix: 0.25 },
        'Surf Spring': { mode: 'spring', size: 0.5, decay: 2.5, predelay: 0, balance: 0.85, diffusion: 0.5, damping: 0.3, lowcut: 250, highcut: 5000, mix: 0.35 },
        'Dub Spring': { mode: 'spring', size: 0.7, decay: 4, balance: 0.9, damping: 0.45, lowcut: 300, highcut: 4500, mix: 0.4 },
        'Ambient Wash': { mode: 'hall', size: 1, decay: 14, predelay: 0.08, balance: 0.95, diffusion: 0.9, mod: 0.7, damping: 0.6, lowcut: 200, width: 1.4, mix: 0.45 },
        'Infinite Pad (Freeze)': { mode: 'hall', size: 0.9, decay: 20, balance: 1, mod: 0.6, damping: 0.4, freeze: true, width: 1.3, mix: 0.5 },
        'Tight Ambience': { mode: 'room', size: 0.15, decay: 0.35, predelay: 0, balance: 0.25, damping: 0.5, mix: 0.18 },
        'Wide Synth Hall': { mode: 'hall', size: 0.75, decay: 4.5, predelay: 0.025, balance: 0.7, mod: 0.6, damping: 0.35, width: 1.6, mix: 0.3 },
        'Lo-Fi Chamber': { mode: 'chamber', size: 0.5, decay: 1.4, balance: 0.6, damping: 0.8, lowcut: 300, highcut: 3500, mix: 0.3 },
      },
    },

    shimmer: {
      name: 'Shimmer Reverb', category: 'Delay & Reverb',
      description: 'Lush reverb with a pitch shifter in its feedback loop: each pass climbs an octave (or a fifth, fourth, octave down…) for glowing, ever-rising tails.',
      params: [
        enm('interval', 'Interval', SHIMMER_OPTIONS, '12', { section: 'Shimmer' }),
        num('amount', 'Shimmer', 0, 1, 0.5, { step: 0.01, section: 'Shimmer' }),
        hz('tone', 'Shimmer Tone', 800, 16000, 6000, { section: 'Shimmer' }),
        num('decay', 'Decay', 0.5, 30, 6, { step: 0.01, unit: 's', curve: 'log', section: 'Space' }),
        num('size', 'Size', 0, 1, 0.8, { step: 0.01, section: 'Space' }),
        num('predelay', 'Pre-delay', 0, 0.5, 0.03, { step: 0.001, unit: 's', section: 'Space' }),
        enm('mode', 'Tank', REVERB_MODE_OPTIONS.filter((o) => ['hall', 'plate', 'chamber'].includes(o.value)), 'hall', { section: 'Space', advanced: true }),
        num('damping', 'Damping', 0, 1, 0.35, { step: 0.01, section: 'Tone' }),
        num('mod', 'Modulation', 0, 1, 0.5, { step: 0.01, section: 'Tone', advanced: true }),
        num('diffusion', 'Diffusion', 0, 1, 0.8, { step: 0.01, section: 'Tone', advanced: true }),
        hz('lowcut', 'Low Cut', 20, 2000, 150, { section: 'Tone', advanced: true }),
        hz('highcut', 'High Cut', 1000, 20000, 12000, { section: 'Tone', advanced: true }),
        bool('freeze', 'Freeze', false, { section: 'Space' }),
        num('width', 'Width', 0, 2, 1.2, { step: 0.01, section: 'Output' }),
        mix(0.35),
      ],
      presets: {
        'Classic Octave Shimmer': { interval: '12', amount: 0.55, decay: 7, size: 0.85, tone: 6000, mix: 0.4 },
        'Gentle Glow': { interval: '12', amount: 0.25, decay: 4, size: 0.7, tone: 4500, mix: 0.3 },
        'Fifth Heaven': { interval: '7', amount: 0.5, decay: 8, size: 0.9, tone: 7000, mix: 0.4 },
        'Fourth Choir': { interval: '5', amount: 0.45, decay: 6, size: 0.8, damping: 0.45, mix: 0.35 },
        'Octave + Fifth Cloud': { interval: '12+7', amount: 0.55, decay: 10, size: 1, tone: 6500, width: 1.5, mix: 0.45 },
        'Dark Undertow': { interval: '-12', amount: 0.5, decay: 9, size: 0.9, tone: 2500, damping: 0.6, mix: 0.4 },
        'Sub & Air': { interval: '12-12', amount: 0.45, decay: 8, size: 0.95, tone: 5000, mix: 0.4 },
        'Crystal Plate': { mode: 'plate', interval: '12', amount: 0.4, decay: 5, size: 0.6, tone: 9000, damping: 0.15, mix: 0.3 },
        'Angelic Pad': { interval: '19', amount: 0.4, decay: 12, size: 1, tone: 7000, predelay: 0.06, width: 1.6, mix: 0.5 },
        'Two-Octave Sparkle': { interval: '24', amount: 0.3, decay: 6, size: 0.8, tone: 11000, mix: 0.3 },
        'Endless Bloom (Freeze)': { interval: '12', amount: 0.6, decay: 20, size: 1, freeze: true, width: 1.5, mix: 0.55 },
        'Guitar Ambience': { interval: '12', amount: 0.35, decay: 5, size: 0.75, predelay: 0.045, lowcut: 250, tone: 5000, mix: 0.35 },
      },
    },

    tapeDelay: {
      name: 'Tape Delay', category: 'Delay & Reverb',
      description: 'Tape echo: saturation and head-age tone inside the feedback loop, wow, flutter and drift. Push feedback past 100 % for self-oscillating dub sweeps.',
      params: [
        bool('sync', 'Tempo Sync', false, { section: 'Time' }),
        num('time', 'Time', 0.02, 2, 0.32, { step: 0.001, unit: 's', curve: 'log', section: 'Time' }),
        enm('division', 'Division', DIVISION_OPTIONS, '1/8D', { section: 'Time' }),
        num('spread', 'Stereo Offset', 0, 1, 0.15, { step: 0.01, section: 'Time', advanced: true }),
        num('feedback', 'Feedback', 0, 1.1, 0.45, { step: 0.01, section: 'Tape' }),
        num('saturation', 'Saturation', 0, 24, 6, { step: 0.1, unit: 'dB', section: 'Tape' }),
        num('age', 'Head Age', 0, 1, 0.4, { step: 0.01, section: 'Tape' }),
        num('wow', 'Wow', 0, 1, 0.3, { step: 0.01, section: 'Wobble' }),
        num('flutter', 'Flutter', 0, 1, 0.25, { step: 0.01, section: 'Wobble' }),
        num('wowRate', 'Wow Rate', 0.1, 3, 0.5, { step: 0.01, unit: 'Hz', curve: 'log', section: 'Wobble', advanced: true }),
        num('drift', 'Drift', 0, 1, 0.3, { step: 0.01, section: 'Wobble', advanced: true }),
        mix(0.35),
      ],
      presets: {
        'Slapback': { sync: false, time: 0.11, feedback: 0.12, saturation: 5, age: 0.3, wow: 0.15, flutter: 0.2, mix: 0.3 },
        'Rockabilly Slap': { sync: false, time: 0.085, feedback: 0.2, saturation: 8, age: 0.5, wow: 0.1, flutter: 0.3, mix: 0.35 },
        'Dotted Eighth Echo': { sync: true, division: '1/8D', feedback: 0.45, saturation: 5, age: 0.35, mix: 0.3 },
        'Quarter Note Tape': { sync: true, division: '1/4', feedback: 0.4, saturation: 6, age: 0.4, mix: 0.3 },
        'Dub Siren': { sync: true, division: '1/4D', feedback: 0.92, saturation: 12, age: 0.6, wow: 0.35, mix: 0.45 },
        'Runaway Oscillation': { sync: true, division: '1/8', feedback: 1.06, saturation: 14, age: 0.5, wow: 0.4, flutter: 0.3, mix: 0.5 },
        'Worn Cassette': { sync: false, time: 0.38, feedback: 0.5, saturation: 9, age: 0.9, wow: 0.7, flutter: 0.55, drift: 0.7, mix: 0.4 },
        'Clean Studio Tape': { sync: true, division: '1/8', feedback: 0.35, saturation: 2, age: 0.1, wow: 0.08, flutter: 0.08, drift: 0.1, mix: 0.25 },
        'Space Echo Swell': { sync: true, division: '1/8T', feedback: 0.7, saturation: 9, age: 0.55, wow: 0.3, spread: 0.4, mix: 0.4 },
        'Lo-Fi Warble': { sync: false, time: 0.24, feedback: 0.55, saturation: 10, age: 0.8, wow: 1, wowRate: 0.9, flutter: 0.6, mix: 0.4 },
        'Long Ambient Tape': { sync: true, division: '1/2', feedback: 0.65, saturation: 4, age: 0.65, wow: 0.25, drift: 0.5, spread: 0.5, mix: 0.35 },
        'Wide Doubler': { sync: false, time: 0.03, feedback: 0, saturation: 3, age: 0.2, wow: 0.3, flutter: 0.3, spread: 0.8, mix: 0.4 },
      },
    },

    multitap: {
      name: 'Multitap Delay', category: 'Delay & Reverb',
      description: 'Up to 8 echo taps inside a pattern length (synced or free), each with its own level, pan and filter; feedback repeats the whole pattern.',
      params: [
        bool('sync', 'Tempo Sync', true, { section: 'Pattern' }),
        num('length', 'Length', 0.1, 4, 1, { step: 0.001, unit: 's', curve: 'log', section: 'Pattern' }),
        enm('division', 'Length (synced)', DIVISION_OPTIONS, '1/1', { section: 'Pattern' }),
        num('feedback', 'Feedback', 0, 0.95, 0.3, { step: 0.01, section: 'Pattern' }),
        hz('fbLowcut', 'Feedback Low Cut', 20, 2000, 150, { section: 'Pattern', advanced: true }),
        hz('fbHighcut', 'Feedback High Cut', 1000, 20000, 6000, { section: 'Pattern', advanced: true }),
        ...tapParams,
        mix(0.4),
      ],
      presets: {
        'Rhythmic 4-Tap': taps([[0.1875, 0.8, -0.5], [0.375, 0.65, 0.5], [0.5, 0.55, -0.25], [0.75, 0.45, 0.25]], { sync: true, division: '1/1', feedback: 0.3 }),
        'Ping-Pong Eighths': taps([[0.125, 0.8, -1], [0.25, 0.7, 1], [0.375, 0.6, -1], [0.5, 0.5, 1], [0.625, 0.4, -1], [0.75, 0.32, 1], [0.875, 0.25, -1]], { sync: true, division: '1/1', feedback: 0.2 }),
        'Dotted Cascade': taps([[0.1875, 0.8, -0.6], [0.375, 0.6, 0.6], [0.5625, 0.45, -0.6], [0.75, 0.33, 0.6]], { sync: true, division: '1/1', feedback: 0.25 }),
        'Triplet Bounce': taps([[1 / 6, 0.75, -0.5], [2 / 6, 0.6, 0.5], [3 / 6, 0.5, -0.5], [4 / 6, 0.4, 0.5], [5 / 6, 0.3, 0]], { sync: true, division: '1/1', feedback: 0.15 }),
        'Bouncing Ball': taps([[0.25, 0.85, 0], [0.4375, 0.7, 0], [0.5938, 0.56, 0], [0.7188, 0.44, 0], [0.8125, 0.34, 0], [0.875, 0.26, 0], [0.9219, 0.2, 0], [0.9531, 0.15, 0]], { sync: true, division: '1/1', feedback: 0 }),
        'Filtered Steps': taps([[0.125, 0.8, -0.4, 'highpass', 600], [0.25, 0.7, 0.4, 'bandpass', 1200], [0.375, 0.6, -0.4, 'bandpass', 2400], [0.5, 0.5, 0.4, 'lowpass', 3000], [0.625, 0.42, -0.4, 'lowpass', 1800], [0.75, 0.35, 0.4, 'lowpass', 1000]], { sync: true, division: '1/1', feedback: 0.2 }),
        'Telephone Echoes': taps([[0.1875, 0.8, -0.5, 'bandpass', 1500], [0.375, 0.65, 0.5, 'bandpass', 1500], [0.75, 0.5, 0, 'bandpass', 1200]], { sync: true, division: '1/1', feedback: 0.35, fbHighcut: 3500, fbLowcut: 400 }),
        'Early Reflections': taps([[0.07, 0.6, -0.7], [0.11, 0.5, 0.6], [0.17, 0.45, -0.3], [0.23, 0.38, 0.8], [0.31, 0.3, -0.8], [0.4, 0.25, 0.4]], { sync: false, length: 0.12, feedback: 0 }),
        'Dub Throws': taps([[0.375, 0.8, -0.6, 'lowpass', 2500], [0.75, 0.6, 0.6, 'lowpass', 1800]], { sync: true, division: '1/1', feedback: 0.6, fbHighcut: 2500 }),
        'Two-Bar Canon': taps([[0.25, 0.7, -0.6], [0.5, 0.55, 0.6], [0.75, 0.4, 0]], { sync: true, division: '2/1', feedback: 0.35 }),
        'Haunted Corridor': taps([[0.13, 0.5, -0.9, 'highpass', 1000], [0.29, 0.45, 0.9, 'lowpass', 2500], [0.47, 0.4, -0.5, 'bandpass', 800], [0.71, 0.35, 0.5, 'lowpass', 1200]], { sync: false, length: 1.4, feedback: 0.55, fbHighcut: 3000 }),
        'Stutter Grid': taps([[0.0625, 0.9, 0], [0.125, 0.8, 0], [0.1875, 0.7, 0], [0.25, 0.6, 0]], { sync: true, division: '1/2', feedback: 0.1 }),
      },
    },

    grainDelay: {
      name: 'Granular Delay', category: 'Delay & Reverb',
      description: 'Granular delay / cloud: the echo is rebuilt from short grains with pitch, position and stereo randomisation, feedback and freeze — from shimmering echoes to frozen textures.',
      params: [
        bool('sync', 'Tempo Sync', false, { section: 'Time' }),
        num('time', 'Time', 0.01, 4, 0.3, { step: 0.001, unit: 's', curve: 'log', section: 'Time' }),
        enm('division', 'Division', DIVISION_OPTIONS, '1/8', { section: 'Time' }),
        num('spread', 'Position Spread', 0, 1, 0.3, { step: 0.01, section: 'Time' }),
        num('size', 'Grain Size', 0.005, 0.5, 0.08, { step: 0.001, unit: 's', curve: 'log', section: 'Grains' }),
        num('density', 'Density', 0.5, 100, 18, { step: 0.1, unit: '/s', curve: 'log', section: 'Grains' }),
        bool('densitySync', 'Rhythmic Grains', false, { section: 'Grains', advanced: true }),
        enm('grainDivision', 'Grain Rate', DIVISION_OPTIONS, '1/16', { section: 'Grains', advanced: true }),
        enm('window', 'Grain Shape', GRAIN_WINDOW_OPTIONS, 'hann', { section: 'Grains', advanced: true }),
        num('pitch', 'Pitch', -24, 24, 0, { step: 0.1, unit: 'st', section: 'Pitch' }),
        num('pitchRand', 'Pitch Random', 0, 12, 0, { step: 0.1, unit: 'st', section: 'Pitch' }),
        num('reverse', 'Reverse', 0, 1, 0, { step: 0.01, section: 'Pitch' }),
        num('feedback', 'Feedback', 0, 0.95, 0.35, { step: 0.01, section: 'Feedback' }),
        hz('tone', 'Tone', 500, 20000, 9000, { section: 'Feedback' }),
        bool('freeze', 'Freeze', false, { section: 'Feedback' }),
        num('pan', 'Stereo Spread', 0, 1, 0.6, { step: 0.01, section: 'Output' }),
        mix(0.4),
      ],
      presets: {
        'Grain Echo': { time: 0.3, size: 0.08, density: 18, spread: 0.2, feedback: 0.35, mix: 0.35 },
        'Octave Up Sparkle': { time: 0.25, size: 0.12, density: 25, pitch: 12, spread: 0.3, feedback: 0.45, tone: 8000, mix: 0.35 },
        'Octave Down Cloud': { time: 0.4, size: 0.15, density: 20, pitch: -12, spread: 0.4, feedback: 0.4, tone: 5000, mix: 0.35 },
        'Texture Cloud': { time: 0.6, size: 0.2, density: 40, spread: 0.9, pitchRand: 0.3, pan: 1, feedback: 0.5, mix: 0.5 },
        'Random Pitch Swarm': { time: 0.35, size: 0.06, density: 45, spread: 0.6, pitchRand: 7, pan: 1, feedback: 0.3, mix: 0.45 },
        'Reverse Shimmer': { time: 0.5, size: 0.25, density: 12, reverse: 1, pitch: 12, spread: 0.3, feedback: 0.4, mix: 0.4 },
        'Half Reverse': { time: 0.45, size: 0.18, density: 14, reverse: 0.5, spread: 0.25, feedback: 0.35, mix: 0.4 },
        'Frozen Pad': { time: 0.8, size: 0.3, density: 30, spread: 1, pan: 1, feedback: 0.2, freeze: true, mix: 0.6 },
        'Glitch Stutter': { sync: true, division: '1/16', size: 0.03, density: 60, window: 'tukey', spread: 0.1, feedback: 0.5, mix: 0.45 },
        'Rhythmic Grains': { sync: true, division: '1/8', densitySync: true, grainDivision: '1/16', size: 0.07, window: 'tukey', spread: 0.15, feedback: 0.4, mix: 0.4 },
        'Fifth Harmony Echo': { time: 0.3, size: 0.1, density: 22, pitch: 7, spread: 0.2, feedback: 0.4, mix: 0.35 },
        'Granular Wash': { time: 1.2, size: 0.35, density: 25, spread: 1, pan: 1, pitchRand: 0.15, feedback: 0.7, tone: 4000, mix: 0.5 },
        'Tiny Grains Buzz': { time: 0.12, size: 0.008, density: 90, spread: 0.5, pan: 0.8, feedback: 0.25, mix: 0.35 },
      },
    },
  };
}
