// YIN pitch detection (de Cheveigné & Kawahara 2002) with an FFT-accelerated difference function — pure DSP,
// Node-safe. Shared by the Pocket hum-to-notes analysis (src/mobile/pitch.js), the tuner and the oscilloscope's
// pitch readout / cycle-locked trigger (src/audio/dsp/scope.js, src/ui/scopes).
//
//   const g = yinGeometry(sampleRate, { minFreq, maxFreq })   analysis frame: g.frameLength samples
//   const { freq, conf, rms } = yin(samples, sampleRate, { geometry: g, offset, threshold })

export const MIN_FREQ = 70; // hum: ~80 Hz (low male voice) with some margin
export const MAX_FREQ = 3200; // whistle: up to ~3 kHz

export const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);
export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const centsBetween = (f, ref) => 1200 * Math.log2(f / ref);

// ------------------------------------------------------------------------------------------------ FFT
const twiddles = new Map();
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  let tw = twiddles.get(n);
  if (!tw) {
    tw = { c: new Float64Array(n / 2), s: new Float64Array(n / 2) };
    for (let k = 0; k < n / 2; k++) { tw.c[k] = Math.cos((2 * Math.PI * k) / n); tw.s[k] = Math.sin((2 * Math.PI * k) / n); }
    twiddles.set(n, tw);
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const wr = tw.c[k * step], wi = sign * tw.s[k * step];
        const a = i + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
export const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

/** Analysis geometry for a sample rate: integration window W, lag range, frame length. */
export function yinGeometry(sampleRate, { minFreq = MIN_FREQ, maxFreq = MAX_FREQ } = {}) {
  const tauMax = Math.ceil(sampleRate / minFreq) + 2;
  const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq) - 1);
  const W = Math.max(tauMax, nextPow2(Math.round(sampleRate * 0.02)));
  return { W, tauMin, tauMax, frameLength: W + tauMax };
}

/**
 * YIN on one frame (buf[offset .. offset + W + tauMax)). Returns {freq, conf (0..1), rms}; freq 0 = unvoiced.
 * Difference function via FFT cross-correlation + prefix energy sums (O(N log N) per frame).
 */
export function yin(buf, sampleRate, opts = {}) {
  const { threshold = 0.15, offset = 0 } = opts;
  const g = opts.geometry || yinGeometry(sampleRate, opts);
  const { W, tauMin } = g;
  const tauMax = Math.min(g.tauMax, buf.length - offset - W);
  if (tauMax <= tauMin + 2) return { freq: 0, conf: 0, rms: 0 };
  const L = W + tauMax;
  const N = nextPow2(L);
  const aRe = new Float64Array(N), aIm = new Float64Array(N), bRe = new Float64Array(N), bIm = new Float64Array(N);
  const pre = new Float64Array(L + 1);
  for (let i = 0; i < L; i++) {
    const x = buf[offset + i];
    bRe[i] = x;
    if (i < W) aRe[i] = x;
    pre[i + 1] = pre[i] + x * x;
  }
  const e0 = pre[W];
  const rms = Math.sqrt(e0 / W);
  if (e0 < 1e-10) return { freq: 0, conf: 0, rms };
  fft(aRe, aIm); fft(bRe, bIm);
  for (let k = 0; k < N; k++) { // conj(A) * B
    const r = aRe[k] * bRe[k] + aIm[k] * bIm[k];
    const im = aRe[k] * bIm[k] - aIm[k] * bRe[k];
    aRe[k] = r; aIm[k] = im;
  }
  fft(aRe, aIm, true);
  // cumulative-mean-normalized difference d'(tau)
  const dn = new Float64Array(tauMax + 1);
  dn[0] = 1;
  let cum = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    const d = Math.max(0, e0 + (pre[tau + W] - pre[tau]) - 2 * aRe[tau]);
    cum += d;
    dn[tau] = cum > 0 ? (d * tau) / cum : 1;
  }
  let tau = -1;
  for (let t = tauMin; t < tauMax; t++) {
    if (dn[t] < threshold) {
      while (t + 1 < tauMax && dn[t + 1] < dn[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) { // no dip under the threshold: global minimum, low confidence
    let best = tauMin;
    for (let t = tauMin; t < tauMax; t++) if (dn[t] < dn[best]) best = t;
    tau = best;
  }
  if (tau <= tauMin || tau >= tauMax) return { freq: 0, conf: 0, rms };
  const s0 = dn[tau - 1], s1 = dn[tau], s2 = dn[tau + 1];
  const den = s0 + s2 - 2 * s1;
  const shift = den > 0 ? Math.max(-1, Math.min(1, (s0 - s2) / (2 * den))) : 0;
  const conf = Math.max(0, Math.min(1, 1 - s1));
  return { freq: sampleRate / (tau + shift), conf, rms };
}

