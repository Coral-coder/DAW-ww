// PADsynth (Nasca Octavian Paul / ZynAddSubFX): every harmonic is spread into a Gaussian band of
// partials whose width grows with frequency, phases are randomised and one inverse FFT yields a
// perfectly looping, naturally "ensembled" table. Played back with a BufferSource at
// playbackRate = f / f0 (two decorrelated read positions give a wide stereo image for free).
import { fft, rng32 } from './fft.js';
import { cachedBuffer, makeBuffer } from './bufcache.js';

const N = 1 << 18; // ~5.5 s @ 48 kHz loop

// Vowel "aah" formants (Hz, bandwidth Hz, gain) — Peterson & Barney / Csound formant tables (alto/tenor mix)
const AAH = [[760, 110, 1], [1150, 130, 0.55], [2600, 200, 0.28], [3300, 250, 0.16], [4200, 300, 0.07]];
// Violin-family body + bridge hill (rough string-section spectral envelope)
const STRING_BODY = [[290, 120, 0.7], [520, 180, 0.6], [1100, 400, 0.45], [2700, 900, 0.6], [4500, 1500, 0.2]];

/**
 * Profiles: harmonic amplitude(n, f) and bandwidth (cents) of the base harmonic.
 *  pad      — warm analog-ish (1/n^0.9 with soft rolloff), 28 c bandwidth (JP-8000 / Zyn "Warm Pad")
 *  ensemble — string section: saw spectrum through a violin body envelope, 18 c bandwidth
 *  choir    — "aah" vowel formants, 40 c bandwidth (Zyn "Choir" style)
 */
export const PAD_PROFILES = {
  pad: { bw: 28, bwScale: 1.0, amp: (n, f) => Math.pow(n, -0.9) * Math.exp(-f / 7000) },
  ensemble: { bw: 18, bwScale: 1.0, amp: (n, f) => Math.pow(n, -0.75) * (0.12 + formant(STRING_BODY, f)) * Math.exp(-f / 9000) },
  choir: { bw: 40, bwScale: 0.85, amp: (n, f) => Math.pow(n, -0.35) * (0.012 + formant(AAH, f)) * Math.exp(-f / 7000) },
};

function formant(table, f) {
  let s = 0;
  for (const [fc, bw, g] of table) { const x = (f - fc) / bw; s += g * Math.exp(-x * x); }
  return s;
}

/** Zone (base note) for a MIDI pitch: every `step` semitones. */
export function padZone(midi, step = 4) { return Math.round(midi / step) * step; }

/**
 * Get a cached PADsynth table: { buffer, f0 } where f0 is the exact frequency of harmonic 1.
 * width scales the bandwidth (0.25..4), tone tilts the spectrum (-1 dark .. +1 bright).
 */
export function padTable(sampleRate, profileId, zoneMidi, width = 1, tone = 0, ctx) {
  const prof = PAD_PROFILES[profileId] || PAD_PROFILES.pad;
  const w = Math.round(Math.max(0.25, Math.min(4, width)) * 8) / 8;
  const tn = Math.round(Math.max(-1, Math.min(1, tone)) * 4) / 4;
  const binHz = sampleRate / N;
  // snap f0 to an exact bin so the loop is exactly periodic and the pitch exact
  const f0 = Math.max(1, Math.round((440 * Math.pow(2, (zoneMidi - 69) / 12)) / binHz)) * binHz;
  const key = `pad:${sampleRate}:${profileId}:${zoneMidi}:${w}:${tn}`;
  const buffer = cachedBuffer(key, () => {
    const half = N / 2;
    const amp = new Float64Array(half);
    const nyq = sampleRate / 2;
    const tilt = (f) => Math.pow(f / 1000, tn * 0.6);
    for (let n = 1; ; n++) {
      const fn = f0 * n;
      if (fn > nyq * 0.92) break;
      const a = prof.amp(n, fn) * tilt(fn);
      if (a < 1e-5) continue;
      const bwHz = (Math.pow(2, (prof.bw * w) / 1200) - 1) * f0 * Math.pow(n, prof.bwScale);
      const bwBins = Math.max(0.5, bwHz / binHz);
      const c = fn / binHz;
      const lo = Math.max(1, Math.floor(c - bwBins * 3)), hi = Math.min(half - 1, Math.ceil(c + bwBins * 3));
      const norm = a / Math.sqrt(bwBins);
      for (let i = lo; i <= hi; i++) {
        const x = (i - c) / bwBins;
        amp[i] += norm * Math.exp(-x * x);
      }
    }
    const re = new Float64Array(N), im = new Float64Array(N);
    const rnd = rng32(zoneMidi * 7919 + profileId.length * 104729 + Math.round(w * 8) * 31 + Math.round(tn * 4) * 17);
    for (let i = 1; i < half; i++) {
      if (amp[i] <= 0) continue;
      const ph = rnd() * 2 * Math.PI;
      re[i] = amp[i] * Math.cos(ph); im[i] = amp[i] * Math.sin(ph);
      re[N - i] = re[i]; im[N - i] = -im[i];
    }
    fft(re, im, true);
    const out = new Float32Array(N);
    let s2 = 0;
    for (let i = 0; i < N; i++) s2 += re[i] * re[i];
    const g = 0.25 / Math.sqrt(s2 / N || 1); // fixed RMS (-12 dBFS) for every table
    for (let i = 0; i < N; i++) out[i] = re[i] * g;
    return makeBuffer([out], sampleRate, ctx);
  });
  return { buffer, f0 };
}
