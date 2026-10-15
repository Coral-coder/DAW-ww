// EQ frequency-response math (pure JS, Node-testable): the exact BiquadFilterNode coefficient formulas of the Web
// Audio spec (Audio EQ Cookbook with the spec's Q conventions — low/high-pass Q in dB, shelves with slope S = 1, Q
// ignored), the magnitude response of a cascade, and the band layout of the 'eq8' and 'eq3' effects.
//
//   biquadCoeffs(type, freq, Q, gainDb, sampleRate) -> {b0, b1, b2, a1, a2} (normalised by a0)
//   biquadMagDb(c, f, sampleRate)                   -> dB at frequency f
//   eqBands(fxType, params)                         -> [{i, type, freq, q, gain, on, keys: {freq, gain, q, on}, hasGain, hasQ}]
//   eqResponse(bands, freqs, sampleRate, outputDb)  -> Float64Array of dB (enabled bands summed, plus output gain)
//   logFreqs(n, lo = 20, hi = 20000)                -> n log-spaced frequencies
//   freqToX / xToFreq / dbToY / yToDb               display mapping (log frequency, linear dB)

export const EQ_TYPES = ['eq8', 'eq3'];
export const GAIN_TYPES = new Set(['peaking', 'lowshelf', 'highshelf']);
export const Q_TYPES = new Set(['peaking', 'lowpass', 'highpass', 'bandpass', 'notch']);

export function biquadCoeffs(type, freq, Q, gainDb, sampleRate) {
  const nyq = sampleRate / 2;
  const f = Math.max(1e-3, Math.min(nyq, freq));
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const A = Math.pow(10, (gainDb || 0) / 40);
  const q = Math.max(1e-4, Q || 1e-4);
  const aQ = sw / (2 * q);
  const aQdB = sw / (2 * Math.pow(10, (Q || 0) / 20));
  const aS = (sw / 2) * Math.SQRT2; // S = 1
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lowpass': b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + aQdB; a1 = -2 * cw; a2 = 1 - aQdB; break;
    case 'highpass': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; a0 = 1 + aQdB; a1 = -2 * cw; a2 = 1 - aQdB; break;
    case 'bandpass': b0 = aQ; b1 = 0; b2 = -aQ; a0 = 1 + aQ; a1 = -2 * cw; a2 = 1 - aQ; break;
    case 'notch': b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + aQ; a1 = -2 * cw; a2 = 1 - aQ; break;
    case 'peaking': b0 = 1 + aQ * A; b1 = -2 * cw; b2 = 1 - aQ * A; a0 = 1 + aQ / A; a1 = -2 * cw; a2 = 1 - aQ / A; break;
    case 'lowshelf': {
      const s = 2 * aS * Math.sqrt(A);
      b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s);
      a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s;
      break;
    }
    case 'highshelf': {
      const s = 2 * aS * Math.sqrt(A);
      b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s);
      a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s;
      break;
    }
    case 'allpass': b0 = 1 - aQ; b1 = -2 * cw; b2 = 1 + aQ; a0 = 1 + aQ; a1 = -2 * cw; a2 = 1 - aQ; break;
    default: return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Magnitude (dB) of a normalised biquad at frequency f. */
export function biquadMagDb(c, f, sampleRate) {
  const w = (2 * Math.PI * f) / sampleRate;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  // H(e^jw) = (b0 + b1 e^-jw + b2 e^-2jw) / (1 + a1 e^-jw + a2 e^-2jw)
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2, ni = -(c.b1 * s1 + c.b2 * s2);
  const dr = 1 + c.a1 * c1 + c.a2 * c2, di = -(c.a1 * s1 + c.a2 * s2);
  const mag2 = (nr * nr + ni * ni) / Math.max(1e-300, dr * dr + di * di);
  return 10 * Math.log10(Math.max(1e-30, mag2));
}

/** Bands of an EQ effect from its resolved params. */
export function eqBands(fxType, p = {}) {
  if (fxType === 'eq3') {
    return [
      { i: 0, type: 'lowshelf', freq: p.lowFreq ?? 250, q: 0.7071, gain: p.low ?? 0, on: true, keys: { freq: 'lowFreq', gain: 'low' }, label: 'Low' },
      { i: 1, type: 'peaking', freq: p.midFreq ?? 1000, q: p.midQ ?? 0.7, gain: p.mid ?? 0, on: true, keys: { freq: 'midFreq', gain: 'mid', q: 'midQ' }, label: 'Mid' },
      { i: 2, type: 'highshelf', freq: p.highFreq ?? 4000, q: 0.7071, gain: p.high ?? 0, on: true, keys: { freq: 'highFreq', gain: 'high' }, label: 'High' },
    ].map((b) => ({ ...b, hasGain: true, hasQ: !!b.keys.q }));
  }
  const out = [];
  for (let n = 1; n <= 8; n++) {
    const type = p[`b${n}Type`] || 'peaking';
    out.push({
      i: n - 1, type, freq: p[`b${n}Freq`] ?? 1000, q: p[`b${n}Q`] ?? 0.9, gain: p[`b${n}Gain`] ?? 0, on: !!p[`b${n}On`],
      keys: { freq: `b${n}Freq`, gain: `b${n}Gain`, q: `b${n}Q`, on: `b${n}On` }, label: String(n),
      hasGain: GAIN_TYPES.has(type), hasQ: Q_TYPES.has(type),
    });
  }
  return out;
}

/** Combined response (dB) of the enabled bands at `freqs`, plus `outputDb`. */
export function eqResponse(bands, freqs, sampleRate = 48000, outputDb = 0) {
  const out = new Float64Array(freqs.length).fill(outputDb || 0);
  for (const b of bands) {
    if (!b.on) continue;
    const c = biquadCoeffs(b.type, b.freq, b.q, b.gain, sampleRate);
    for (let i = 0; i < freqs.length; i++) out[i] += biquadMagDb(c, freqs[i], sampleRate);
  }
  return out;
}

/** Response of a single band (dB) at `freqs`. */
export const bandResponse = (b, freqs, sampleRate = 48000) => eqResponse([{ ...b, on: true }], freqs, sampleRate, 0);

export function logFreqs(n, lo = 20, hi = 20000) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = lo * Math.pow(hi / lo, n > 1 ? i / (n - 1) : 0);
  return out;
}

// display mapping
export const freqToX = (f, w, lo = 20, hi = 20000) => (Math.log(Math.max(lo, Math.min(hi, f)) / lo) / Math.log(hi / lo)) * w;
export const xToFreq = (x, w, lo = 20, hi = 20000) => lo * Math.pow(hi / lo, Math.max(0, Math.min(1, x / w)));
export const dbToY = (db, h, range = 24) => h / 2 - (Math.max(-range, Math.min(range, db)) / range) * (h / 2);
export const yToDb = (y, h, range = 24) => Math.max(-range, Math.min(range, ((h / 2 - y) / (h / 2)) * range));
