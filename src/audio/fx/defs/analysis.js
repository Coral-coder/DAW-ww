// Analysis effect definitions. Receives the ParamDef helpers from effect-defs.js and returns
// { type: { name, category, description, params, presets? } } entries merged into EFFECT_DEFS.
// presets (optional) = { 'Preset name': { paramKey: value, ... } } — same shape as EFFECT_PRESETS.
//
// Analyzers pass the audio through untouched (no latency); their params only configure the display
// (src/ui/scopes). The spectrum analyzer's 'sourceTrackId' is a compare input fed like a sidechain key.
import { WINDOW_OPTIONS, COLORMAP_OPTIONS } from '../../dsp/scope.js';

const CHANNELS = [
  { value: 'stereo', label: 'L + R' }, { value: 'L', label: 'Left' }, { value: 'R', label: 'Right' },
  { value: 'M', label: 'Mid' }, { value: 'S', label: 'Side' },
];
const FFT_SIZES = [1024, 2048, 4096, 8192, 16384, 32768].map((v) => ({ value: v, label: String(v) }));
const SLOPES = [0, 3, 4.5, 6].map((v) => ({ value: v, label: v ? `${v} dB/oct` : 'Flat' }));

// eslint-disable-next-line no-unused-vars
export default function analysisDefs({ num, enm, bool, lfoParams, DIVISION_OPTIONS }) {
  const a4 = (o = {}) => num('a4', 'A4 Reference', 415, 466, 440, { step: 0.1, unit: 'Hz', section: o.section || 'Pitch', ...o });
  return {
    oscilloscope: {
      name: 'Oscilloscope', category: 'Analysis',
      description: 'Waveform display with cycle-locked triggering (periodic waves stand still), free run, zoom, channel views and a pitch readout. Passes audio through untouched.',
      params: [
        enm('trigger', 'Trigger', [
          { value: 'cycle', label: 'Cycle lock (pitch)' }, { value: 'zero', label: 'Zero crossing' }, { value: 'free', label: 'Free run' },
        ], 'cycle', { section: 'Trigger' }),
        num('cycles', 'Cycles', 1, 16, 2, { step: 1, section: 'Trigger' }),
        num('time', 'Time Window', 0.5, 500, 20, { step: 0.1, unit: 'ms', curve: 'log', section: 'Trigger' }),
        enm('slope', 'Slope', [{ value: 'rise', label: 'Rising' }, { value: 'fall', label: 'Falling' }], 'rise', { section: 'Trigger', advanced: true }),
        num('level', 'Trigger Level', -1, 1, 0, { step: 0.01, section: 'Trigger', advanced: true }),
        enm('channel', 'Channel', [...CHANNELS, { value: 'ms', label: 'M + S' }], 'stereo', { section: 'Display' }),
        num('gain', 'Vertical Zoom', 0.25, 64, 1, { step: 0.01, unit: 'x', curve: 'log', section: 'Display' }),
        bool('auto', 'Auto Gain', true, { section: 'Display' }),
        num('persistence', 'Persistence', 0, 0.95, 0.35, { step: 0.01, section: 'Display', advanced: true }),
        bool('pitch', 'Pitch Readout', true, { section: 'Pitch' }),
        a4({ advanced: true }),
      ],
      presets: {
        'Cycle Lock — 2 cycles': { trigger: 'cycle', cycles: 2, channel: 'stereo', auto: true, persistence: 0.35 },
        'Single Cycle Close-up': { trigger: 'cycle', cycles: 1, channel: 'M', auto: true, persistence: 0.2 },
        'Bass Waveform': { trigger: 'cycle', cycles: 2, channel: 'M', auto: true, persistence: 0.5 },
        'Synth Shape Check': { trigger: 'cycle', cycles: 4, channel: 'L', auto: true, persistence: 0.3 },
        'Zero-Cross 10 ms': { trigger: 'zero', time: 10, channel: 'stereo', auto: true },
        'Zero-Cross 50 ms': { trigger: 'zero', time: 50, channel: 'stereo', auto: true },
        'Transient Window (Free)': { trigger: 'free', time: 100, channel: 'M', auto: false, gain: 1, persistence: 0 },
        'Envelope View (500 ms)': { trigger: 'free', time: 500, channel: 'M', auto: false, gain: 1, persistence: 0 },
        'Mid / Side Overlay': { trigger: 'cycle', cycles: 2, channel: 'ms', auto: true },
        'Phosphor Glow': { trigger: 'cycle', cycles: 3, channel: 'stereo', auto: true, persistence: 0.85 },
        'Side Only (Width Check)': { trigger: 'zero', time: 20, channel: 'S', auto: true },
        'Fixed Scale 1:1': { trigger: 'zero', time: 20, channel: 'stereo', auto: false, gain: 1 },
      },
    },
    vectorscope: {
      name: 'Vectorscope', category: 'Analysis',
      description: 'Goniometer: stereo image as a Lissajous (M/S, rotated 45°), polar or scatter plot, with correlation and balance meters. Passes audio through untouched.',
      params: [
        enm('mode', 'Mode', [
          { value: 'lissajous', label: 'Lissajous (lines)' }, { value: 'scatter', label: 'Scatter (dots)' }, { value: 'polar', label: 'Polar' },
        ], 'lissajous', { section: 'Display' }),
        enm('solo', 'Show', [{ value: 'stereo', label: 'Stereo' }, { value: 'M', label: 'Mid only' }, { value: 'S', label: 'Side only' }], 'stereo', { section: 'Display' }),
        num('gain', 'Zoom', 0.25, 16, 1, { step: 0.01, unit: 'x', curve: 'log', section: 'Display' }),
        bool('auto', 'Auto Gain', true, { section: 'Display' }),
        num('persistence', 'Persistence', 0, 0.98, 0.75, { step: 0.01, section: 'Display' }),
        num('integration', 'Meter Time', 0.05, 3, 0.3, { step: 0.01, unit: 's', curve: 'log', section: 'Meters' }),
      ],
      presets: {
        'Goniometer': { mode: 'lissajous', solo: 'stereo', auto: true, persistence: 0.75, integration: 0.3 },
        'Dot Cloud': { mode: 'scatter', solo: 'stereo', auto: true, persistence: 0.6 },
        'Polar Level': { mode: 'polar', solo: 'stereo', auto: true, persistence: 0.7 },
        'Long Trails': { mode: 'lissajous', persistence: 0.95, auto: true },
        'Fast Response': { mode: 'scatter', persistence: 0.2, integration: 0.08, auto: true },
        'Slow Meters (Mastering)': { mode: 'lissajous', persistence: 0.85, integration: 2, auto: true },
        'Side Check': { mode: 'scatter', solo: 'S', auto: true, persistence: 0.6 },
        'Mid Check': { mode: 'scatter', solo: 'M', auto: true, persistence: 0.6 },
        'Fixed Scale (0 dBFS edge)': { mode: 'lissajous', auto: false, gain: 1, persistence: 0.75 },
        'Zoomed −12 dB': { mode: 'lissajous', auto: false, gain: 4, persistence: 0.75 },
      },
    },
    spectrum: {
      name: 'Spectrum Analyzer', category: 'Analysis',
      description: 'FFT spectrum (1k–32k points) on a log frequency axis with slope tilt, averaging, peak hold, max trace, channel modes, hover readout and a compare trace from another track. Passes audio through untouched.',
      params: [
        enm('fftSize', 'FFT Size', FFT_SIZES, 8192, { section: 'Analysis' }),
        enm('window', 'Window', WINDOW_OPTIONS, 'hann', { section: 'Analysis', advanced: true }),
        num('average', 'Averaging', 0, 5000, 300, { step: 10, unit: 'ms', section: 'Analysis' }),
        enm('smoothing', 'Smoothing', [
          { value: 0, label: 'Off' }, { value: 48, label: '1/48 oct' }, { value: 24, label: '1/24 oct' }, { value: 12, label: '1/12 oct' },
          { value: 6, label: '1/6 oct' }, { value: 3, label: '1/3 oct' },
        ], 0, { section: 'Analysis' }),
        enm('slope', 'Slope', SLOPES, 4.5, { section: 'Display' }),
        enm('channel', 'Channel', CHANNELS, 'stereo', { section: 'Display' }),
        num('floor', 'Floor', -150, -30, -96, { step: 1, unit: 'dB', section: 'Display' }),
        num('top', 'Top', -30, 24, 6, { step: 1, unit: 'dB', section: 'Display', advanced: true }),
        bool('fill', 'Fill', true, { section: 'Display', advanced: true }),
        bool('peakHold', 'Peak Hold', true, { section: 'Hold' }),
        num('holdTime', 'Hold Time', 0, 20, 2, { step: 0.1, unit: 's', section: 'Hold' }),
        bool('showMax', 'Max Trace', false, { section: 'Hold' }),
        { key: 'sourceTrackId', label: 'Compare', type: 'track', default: '', section: 'Compare', description: 'Draw another track / bus spectrum underneath (fed like a sidechain key, time-aligned)' },
        a4({ section: 'Display', advanced: true }),
      ],
      presets: {
        'Mixing (SPAN default)': { fftSize: 8192, average: 300, slope: 4.5, channel: 'stereo', smoothing: 0, peakHold: true, floor: -96 },
        'Mastering (slow, 1/6 oct)': { fftSize: 16384, average: 2000, slope: 4.5, channel: 'M', smoothing: 6, peakHold: true, holdTime: 5, floor: -90 },
        'Pink Reference (3 dB)': { fftSize: 8192, average: 1000, slope: 3, channel: 'M', smoothing: 12 },
        'Flat (Engineering)': { fftSize: 8192, average: 300, slope: 0, channel: 'stereo', smoothing: 0, floor: -120 },
        'Fast Transients': { fftSize: 2048, average: 0, slope: 4.5, channel: 'M', peakHold: true, holdTime: 1 },
        'Low-End Detail (32k)': { fftSize: 32768, average: 500, slope: 4.5, channel: 'M', smoothing: 24, floor: -90 },
        'Side Channel': { fftSize: 8192, average: 400, slope: 4.5, channel: 'S', smoothing: 12 },
        'Mid / Side Check': { fftSize: 8192, average: 400, slope: 4.5, channel: 'M', showMax: true },
        'Max Hold (Song Overview)': { fftSize: 8192, average: 300, slope: 4.5, channel: 'M', showMax: true, peakHold: false, smoothing: 12 },
        'Third-Octave RTA': { fftSize: 16384, average: 1000, slope: 0, channel: 'M', smoothing: 3, floor: -80 },
        'Resonance Hunting': { fftSize: 32768, average: 150, slope: 4.5, channel: 'M', smoothing: 0, peakHold: true, holdTime: 8 },
        'Noise Floor': { fftSize: 16384, average: 3000, slope: 0, channel: 'stereo', floor: -150, top: -30 },
      },
    },
    spectrogram: {
      name: 'Spectrogram', category: 'Analysis',
      description: 'Scrolling time × frequency display (log, linear or mel scale, several colour maps incl. colour-blind safe ones) or a 3D waterfall. Passes audio through untouched.',
      params: [
        enm('view', 'View', [{ value: '2d', label: 'Spectrogram' }, { value: '3d', label: '3D Waterfall' }], '2d', { section: 'Display' }),
        enm('direction', 'Scroll', [{ value: 'h', label: 'Horizontal (time →)' }, { value: 'v', label: 'Vertical (time ↓)' }], 'h', { section: 'Display' }),
        enm('scale', 'Frequency Scale', [{ value: 'log', label: 'Log' }, { value: 'linear', label: 'Linear' }, { value: 'mel', label: 'Mel' }], 'log', { section: 'Display' }),
        enm('colormap', 'Colours', COLORMAP_OPTIONS, 'viridis', { section: 'Display' }),
        num('speed', 'Speed', 10, 400, 80, { step: 1, unit: 'px/s', curve: 'log', section: 'Display' }),
        num('floor', 'Floor', -150, -30, -100, { step: 1, unit: 'dB', section: 'Level' }),
        num('range', 'Dynamic Range', 20, 150, 90, { step: 1, unit: 'dB', section: 'Level' }),
        enm('slope', 'Slope', SLOPES, 3, { section: 'Level', advanced: true }),
        enm('fftSize', 'FFT Size', FFT_SIZES.filter((o) => o.value <= 16384), 4096, { section: 'Analysis' }),
        enm('window', 'Window', WINDOW_OPTIONS, 'hann', { section: 'Analysis', advanced: true }),
        enm('channel', 'Channel', [{ value: 'M', label: 'Mono (L+R)' }, { value: 'L', label: 'Left' }, { value: 'R', label: 'Right' }, { value: 'S', label: 'Side' }], 'M', { section: 'Analysis', advanced: true }),
        num('angle', '3D Angle', 0, 80, 40, { step: 1, unit: '°', section: '3D' }),
        num('depth', '3D Depth', 16, 160, 64, { step: 1, section: '3D' }),
        num('height', '3D Height', 0.2, 3, 1, { step: 0.01, curve: 'log', section: '3D', advanced: true }),
      ],
      presets: {
        'Mix Overview': { view: '2d', direction: 'h', scale: 'log', colormap: 'viridis', speed: 60, floor: -100, range: 90 },
        'Colour-Blind Safe (Cividis)': { view: '2d', scale: 'log', colormap: 'cividis', floor: -100, range: 90 },
        'Vocal Detail (Mel)': { view: '2d', scale: 'mel', colormap: 'magma', fftSize: 2048, speed: 120, floor: -90, range: 80 },
        'Drums / Transients': { view: '2d', scale: 'log', colormap: 'inferno', fftSize: 1024, speed: 240, floor: -90, range: 70 },
        'Bass Detail': { view: '2d', scale: 'log', colormap: 'viridis', fftSize: 16384, speed: 40, floor: -100, range: 80 },
        'Linear (Engineering)': { view: '2d', scale: 'linear', colormap: 'gray', fftSize: 4096, floor: -120, range: 110 },
        'Vertical Waterfall': { view: '2d', direction: 'v', scale: 'log', colormap: 'heat', speed: 80 },
        '3D Waterfall': { view: '3d', scale: 'log', colormap: 'viridis', angle: 40, depth: 64, speed: 60 },
        '3D Steep Mountains': { view: '3d', scale: 'log', colormap: 'magma', angle: 60, depth: 96, height: 1.6 },
        '3D Low Angle': { view: '3d', scale: 'log', colormap: 'ice', angle: 18, depth: 48 },
        'Noise Hunting': { view: '2d', scale: 'log', colormap: 'heat', floor: -140, range: 80, fftSize: 8192, speed: 30 },
        'Slow History': { view: '2d', scale: 'log', colormap: 'viridis', speed: 15, fftSize: 8192 },
      },
    },
    tuner: {
      name: 'Tuner', category: 'Analysis',
      description: 'Chromatic tuner (mono sum): note, octave, cents and frequency on a needle and a strobe, adjustable A4 reference and a signal-level gate. Passes audio through untouched.',
      params: [
        enm('display', 'Display', [{ value: 'both', label: 'Needle + Strobe' }, { value: 'needle', label: 'Needle' }, { value: 'strobe', label: 'Strobe' }], 'both', { section: 'Tuner' }),
        a4({ section: 'Tuner' }),
        enm('range', 'Range', [
          { value: 'full', label: 'Full (25 Hz – 4.2 kHz)' }, { value: 'bass', label: 'Bass (25 – 500 Hz)' },
          { value: 'guitar', label: 'Guitar (60 Hz – 1.5 kHz)' }, { value: 'voice', label: 'Voice (70 Hz – 1.2 kHz)' }, { value: 'high', label: 'High (200 Hz – 4.2 kHz)' },
        ], 'full', { section: 'Tuner' }),
        num('gate', 'Gate', -90, -20, -55, { step: 1, unit: 'dB', section: 'Tuner' }),
        num('tolerance', 'In-Tune Zone', 1, 10, 3, { step: 0.5, unit: 'ct', section: 'Display', advanced: true }),
        num('response', 'Response', 0.02, 1, 0.12, { step: 0.01, unit: 's', curve: 'log', section: 'Display', advanced: true }),
        enm('accidentals', 'Accidentals', [{ value: 'sharp', label: '♯ Sharps' }, { value: 'flat', label: '♭ Flats' }], 'sharp', { section: 'Display', advanced: true }),
      ],
      presets: {
        'Concert A440': { a4: 440, range: 'full', display: 'both' },
        'Orchestra A442': { a4: 442, range: 'full' },
        'European A443': { a4: 443, range: 'full' },
        'Baroque A415': { a4: 415, range: 'full', accidentals: 'flat' },
        'Verdi A432': { a4: 432, range: 'full' },
        'Classical A430': { a4: 430, range: 'full' },
        'Guitar': { a4: 440, range: 'guitar', display: 'both', gate: -50 },
        'Bass Guitar': { a4: 440, range: 'bass', display: 'both', gate: -55, response: 0.2 },
        'Vocals': { a4: 440, range: 'voice', display: 'needle', gate: -50, response: 0.18 },
        'Strobe (Precise)': { a4: 440, display: 'strobe', tolerance: 1 },
        'Synth / Oscillator': { a4: 440, range: 'full', display: 'both', response: 0.05, tolerance: 1 },
        'Noisy Room': { a4: 440, range: 'full', gate: -35, response: 0.25 },
      },
    },
  };
}
