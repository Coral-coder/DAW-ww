// Latency (frames) of the dynamics / EQ family — pure, used by latency.js effectLatencyFrames().
//   multiband, expander: their look-ahead (whole frames, the worklet delays the audio by exactly that)
//   lineq, matcheq: linear-phase FIR kernel → (taps − 1) / 2 frames (ConvolverNode itself adds none)
//   transient, deesser, dyneq: 0 (IIR / zero-latency detectors)
import { firTaps, firLatency } from './dsp/fir.js';
import { lookaheadFrames } from './dsp/dynamics-core.js';

/** Defaults the defs use (raw project params may omit them). */
export const LATENCY_DEFAULTS = { multibandLookahead: 0, expanderLookahead: 0.002, firQuality: 'medium' };

/** Frames for a dynamics-family effect def {type, params}, or null when the type is not one of ours. */
export function dynamicsLatencyFrames(def, sampleRate = 44100) {
  const p = def?.params || {};
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null && v !== undefined ? Number(v) : d);
  switch (def?.type) {
    case 'multiband': return lookaheadFrames(num(p.lookahead, LATENCY_DEFAULTS.multibandLookahead), sampleRate);
    case 'expander': return lookaheadFrames(num(p.lookahead, LATENCY_DEFAULTS.expanderLookahead), sampleRate);
    case 'lineq':
    case 'matcheq': return firLatency(firTaps(p.quality || LATENCY_DEFAULTS.firQuality, sampleRate));
    case 'transient': case 'deesser': case 'dyneq': return 0;
    default: return null;
  }
}
