// Round-trip latency calibration: the native engine plays a short chirp on one output channel while
// recording an input channel (patch a loopback cable, or hold the mic to the speaker); the delay of
// the chirp in the recording is the device's real round-trip latency (driver + converters + buffers).
// Pure functions, Node-testable.

/** Linear chirp (fStart -> fEnd Hz) with a Hann window. */
export function makeChirp(sampleRate = 48000, { durationMs = 20, fStart = 300, fEnd = 8000, gain = 0.5 } = {}) {
  const n = Math.max(32, Math.round((sampleRate * durationMs) / 1000));
  const out = new Float32Array(n);
  const T = n / sampleRate;
  const k = (fEnd - fStart) / T;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    out[i] = gain * w * Math.sin(2 * Math.PI * (fStart * t + 0.5 * k * t * t));
  }
  return out;
}

/**
 * Find `signal` in `captured` by normalized cross-correlation.
 * -> { lag (samples), score (0..1 normalized peak), confidence (peak / runner-up outside ±len) }
 */
export function findDelay(captured, signal, { maxLag = captured.length - signal.length } = {}) {
  const m = signal.length;
  let sigE = 0;
  for (let i = 0; i < m; i++) sigE += signal[i] * signal[i];
  if (!(sigE > 0) || captured.length < m) return { lag: -1, score: 0, confidence: 0 };
  // running energy of the captured window
  let winE = 0;
  for (let i = 0; i < m; i++) winE += captured[i] * captured[i];
  const last = Math.min(maxLag, captured.length - m);
  const scores = new Float32Array(last + 1);
  for (let lag = 0; lag <= last; lag++) {
    if (lag > 0) {
      const a = captured[lag - 1], b = captured[lag + m - 1];
      winE += b * b - a * a;
    }
    let acc = 0;
    for (let i = 0; i < m; i++) acc += captured[lag + i] * signal[i];
    const denom = Math.sqrt(sigE * Math.max(winE, 1e-12));
    scores[lag] = acc / denom;
  }
  let best = 0;
  for (let i = 1; i <= last; i++) if (scores[i] > scores[best]) best = i;
  let second = 0;
  for (let i = 0; i <= last; i++) if (Math.abs(i - best) > m && scores[i] > second) second = scores[i];
  const score = Math.max(0, scores[best]);
  return { lag: score > 0 ? best : -1, score, confidence: second > 0 ? score / second : score > 0 ? Infinity : 0 };
}

/** Interpret a ping capture: { ok, latencySamples, latencyMs, score, message }. */
export function analyzePing(captured, signal, sampleRate, { minScore = 0.35, minConfidence = 1.5 } = {}) {
  const r = findDelay(captured, signal);
  if (r.lag < 0 || r.score < minScore || r.confidence < minConfidence) {
    return { ok: false, latencySamples: null, latencyMs: null, score: r.score,
      message: 'No clear ping came back. Connect an output to an input with a cable (or hold the mic near the speaker) and try again.' };
  }
  const ms = (r.lag / sampleRate) * 1000;
  return { ok: true, latencySamples: r.lag, latencyMs: Math.round(ms * 100) / 100, score: r.score, message: `Round-trip latency ${ms.toFixed(1)} ms (${r.lag} samples)` };
}
