// True-peak metering and an offline look-ahead true-peak limiter (pure JS, Float32Array channels; Node-testable).
//
//   truePeak(channels)                       -> linear true peak (4x oversampled, ITU-R BS.1770-4 style interpolator)
//   truePeakDb(channels)                     -> dBTP
//   limitTruePeak(channels, sampleRate, {ceilingDb = -1, lookahead = 0.0015, release = 0.06})
//       -> { channels: Float32Array[] (new), gainReductionDb (max), truePeakDb (after) }
//
// The limiter is for finished renders (export / bounce): it sees the whole signal, so its "look-ahead" is free
// (no added delay). Gain = min over a look-ahead window of ceiling / truePeak, ramped linearly into each peak
// (attack = look-ahead) and released exponentially; a second pass catches inter-sample overs the gain ramp
// itself creates. Never clips, never adds latency, unity gain when the input is already under the ceiling.

const PHASES = 4;
const TAPS = 12; // per phase (48-tap prototype, like the BS.1770 reference interpolator)
let KERNEL = null;

function kernel() {
  if (KERNEL) return KERNEL;
  // windowed-sinc low-pass at the original Nyquist, Kaiser-like (Blackman-Harris) window, split into 4 phases
  const N = TAPS * PHASES;
  const h = new Float64Array(N);
  const c = (N - 1) / 2;
  for (let i = 0; i < N; i++) {
    const x = (i - c) / PHASES;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = 0.35875 - 0.48829 * Math.cos((2 * Math.PI * i) / (N - 1)) + 0.14128 * Math.cos((4 * Math.PI * i) / (N - 1)) - 0.01168 * Math.cos((6 * Math.PI * i) / (N - 1));
    h[i] = sinc * w;
  }
  KERNEL = [];
  for (let p = 0; p < PHASES; p++) {
    const k = new Float64Array(TAPS);
    let sum = 0;
    for (let t = 0; t < TAPS; t++) { k[t] = h[t * PHASES + p]; sum += k[t]; }
    for (let t = 0; t < TAPS; t++) k[t] /= sum; // each phase has unity DC gain
    KERNEL.push(k);
  }
  return KERNEL;
}

/**
 * Per-frame true-peak envelope: env[n] = max over channels and the 4 interpolated points around frame n.
 * (Interpolated points are centred on the frame, so the envelope is aligned with the signal.)
 */
export function truePeakEnvelope(channels) {
  const K = kernel();
  const n = channels[0]?.length || 0;
  const env = new Float32Array(n);
  const half = TAPS / 2;
  for (const x of channels) {
    for (let i = 0; i < n; i++) {
      let m = Math.abs(x[i]);
      for (let p = 0; p < PHASES; p++) {
        const k = K[p];
        let acc = 0;
        // output point between frames i-1 .. i (fractional position p / PHASES before frame i)
        for (let t = 0; t < TAPS; t++) {
          const j = i - half + t + 1;
          if (j >= 0 && j < n) acc += x[j] * k[TAPS - 1 - t];
        }
        const a = Math.abs(acc);
        if (a > m) m = a;
      }
      if (m > env[i]) env[i] = m;
    }
  }
  return env;
}

export function truePeak(channels) {
  const env = truePeakEnvelope(channels);
  let m = 0;
  for (let i = 0; i < env.length; i++) if (env[i] > m) m = env[i];
  return m;
}

export const truePeakDb = (channels) => { const p = truePeak(channels); return p > 0 ? 20 * Math.log10(p) : -Infinity; };

function gainCurve(env, ceiling, la, relCoef) {
  const n = env.length;
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) g[i] = env[i] > ceiling ? ceiling / env[i] : 1;
  // attack: ramp down linearly over `la` frames before each peak (backward pass)
  const step = 1 / Math.max(1, la);
  for (let i = n - 2; i >= 0; i--) { const lim = g[i + 1] + step; if (lim < g[i]) g[i] = lim; }
  // the peak's neighbours (inter-sample peak spans frames i-1..i): hold one frame on both sides
  for (let i = n - 1; i > 0; i--) if (g[i - 1] < g[i]) g[i] = Math.min(g[i], g[i - 1]);
  // release: recover exponentially (forward pass)
  let prev = 1;
  for (let i = 0; i < n; i++) {
    const rel = 1 - (1 - prev) * relCoef;
    const v = g[i] < rel ? g[i] : rel;
    g[i] = v;
    prev = v;
  }
  return g;
}

export function limitTruePeak(channels, sampleRate = 44100, { ceilingDb = -1, lookahead = 0.0015, release = 0.06 } = {}) {
  const ceiling = Math.pow(10, ceilingDb / 20);
  const la = Math.max(1, Math.round(lookahead * sampleRate));
  const relCoef = Math.exp(-1 / Math.max(1, release * sampleRate));
  let cur = channels.map((c) => Float32Array.from(c));
  let minGain = 1;
  for (let pass = 0; pass < 4; pass++) {
    const env = truePeakEnvelope(cur);
    let over = false;
    for (let i = 0; i < env.length; i++) if (env[i] > ceiling * (1 + 1e-6)) { over = true; break; }
    if (!over) break;
    const target = ceiling * (pass ? 0.9995 : 1); // later passes aim a hair lower (Float32 rounding)
    const g = gainCurve(env, target, la, relCoef);
    cur = cur.map((c) => { const o = new Float32Array(c.length); for (let i = 0; i < c.length; i++) o[i] = c[i] * g[i]; return o; });
    let gm = 1;
    for (let i = 0; i < g.length; i++) if (g[i] < gm) gm = g[i];
    minGain *= gm;
  }
  const tp = truePeak(cur);
  return { channels: cur, gainReductionDb: minGain < 1 ? 20 * Math.log10(minGain) : 0, truePeakDb: tp > 0 ? 20 * Math.log10(tp) : -Infinity };
}
