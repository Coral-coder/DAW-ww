// Sample analysis for warping (pure, Node-safe): tempo + beat grid + transients of decoded audio.
// -> sample.analysis = { v, bpm, confidence, firstBeat, downbeat, transients: [sec], alternatives }
import { onsetEnvelope, detectTransients } from './onset.js';
import { detectTempo } from './tempo.js';

export const ANALYSIS_VERSION = 1;

/** Analyse PCM channels (Float32Array[]) at sample rate sr. Bounded work: at most `maxSec` seconds are analysed. */
export function analyzeChannels(channels, sr, { maxSec = 90, beatsPerBar = 4, minBpm = 70, maxBpm = 180 } = {}) {
  const lim = Math.min(channels[0]?.length || 0, Math.round(maxSec * sr));
  const chs = channels.map((c) => (c.length > lim ? c.subarray(0, lim) : c));
  const onset = onsetEnvelope(chs, sr);
  const tempo = detectTempo(onset, { minBpm, maxBpm, beatsPerBar });
  const transients = detectTransients(onset.env, onset.fps, { sensitivity: 0.6, minGap: 0.045 })
    .map((t) => refineOnset(chs, sr, t));
  // a hit right at the start has no "before" in the onset envelope: add it from the waveform
  if (!transients.length || transients[0] > 0.03) {
    let head = 0, all = 0;
    const x = chs[0], n10 = Math.min(x.length, Math.round(0.01 * sr));
    for (let i = 0; i < x.length; i += 7) { const a = Math.abs(x[i]); if (a > all) all = a; if (i < n10 && a > head) head = a; }
    if (all > 0 && head > all * 0.1) transients.unshift(0);
  }
  // short loops: the length is the best tempo hint (a loop is a whole number of bars / beats)
  const dur = (channels[0]?.length || 0) / sr;
  let { bpm } = tempo;
  if (dur > 0 && dur < 32) {
    const beats = (dur * bpm) / 60;
    const whole = Math.round(beats);
    const exact = (whole * 60) / dur;
    if (whole >= 2 && Math.abs(beats - whole) / whole < 0.03 && exact >= minBpm * 0.9 && exact <= maxBpm * 1.1) bpm = Math.round(exact * 1000) / 1000;
  }
  return { v: ANALYSIS_VERSION, bpm, confidence: tempo.confidence, firstBeat: tempo.firstBeat, downbeat: tempo.downbeat, transients, alternatives: tempo.alternatives };
}

/** Move an envelope-frame onset to the attack start in the waveform (first sample above 10 % of the local peak). */
function refineOnset(chs, sr, t) {
  const x = chs[0];
  const a = Math.max(0, Math.round((t - 0.012) * sr)), b = Math.min(x.length, Math.round((t + 0.02) * sr));
  let peak = 0;
  for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (!(peak > 0)) return t;
  // noise floor just before
  for (let i = a; i < b; i++) if (Math.abs(x[i]) > peak * 0.1) return Math.max(0, (i - 8) / sr);
  return t;
}

/** Analyse an AudioBuffer. */
export function analyzeBuffer(buffer, opts) {
  const chs = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chs.push(buffer.getChannelData(c));
  return analyzeChannels(chs, buffer.sampleRate, opts);
}
