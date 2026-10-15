// Processing latency of the space / character effect families (frames), used by src/audio/latency.js. Raw (unresolved)
// params: missing keys take the defaults of src/audio/fx/defs.
import { shifterLatency } from './dsp/pitch.js';

/** Frames of latency for a family effect def, or null when the type is not one of these families. */
export function familyLatencyFrames(def, sampleRate, oversampleFrames) {
  const p = def?.params || {};
  switch (def?.type) {
    case 'pitchShift': return shifterLatency(p.latency === 'low' ? 'low' : 'quality', sampleRate);
    case 'formantShift': return Math.abs(Number(p.pitch) || 0) >= 0.5 ? shifterLatency('low', sampleRate) : 0;
    case 'distortionPlus': return oversampleFrames[p.oversample ?? '2x'] ?? 0;
    default: return null;
  }
}
