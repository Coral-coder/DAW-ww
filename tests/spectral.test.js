// Spectral editing core (src/audio/dsp/spectral.js): STFT / ISTFT round trip and the edit operations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stft, istft, processRegion, applySpectralEdit, spectrogram, selectionWeights } from '../src/audio/dsp/spectral.js';
import { rng32 } from '../src/audio/dsp/fft.js';

const SR = 16000;
const sine = (f, n, a = 0.5, ph = 0) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / SR + ph));
const noise = (n, seed = 3, a = 0.3) => { const r = rng32(seed); return Float32Array.from({ length: n }, () => (r() * 2 - 1) * a); };
const maxErr = (a, b, from = 0, to = a.length) => { let m = 0; for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
/** Amplitude of frequency f in x[from, to) (Hann-windowed single-bin DFT, normalised to sine amplitude). */
function amp(x, f, from, to) {
  let re = 0, im = 0, ws = 0;
  for (let i = from; i < to; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - from)) / (to - from));
    re += x[i] * w * Math.cos((2 * Math.PI * f * i) / SR); im += x[i] * w * Math.sin((2 * Math.PI * f * i) / SR); ws += w;
  }
  return (2 * Math.hypot(re, im)) / ws;
}

test('STFT -> ISTFT reconstructs the signal exactly (several sizes / hops, odd lengths)', () => {
  for (const [N, H, len] of [[2048, 512, 20000], [1024, 256, 4097], [512, 256, 3001], [256, 64, 100], [2048, 1024, 9999]]) {
    const x = noise(len, len);
    for (let i = 0; i < len; i++) x[i] += 0.4 * Math.sin(i * 0.01);
    const y = istft(stft(x, { fftSize: N, hop: H }));
    assert.equal(y.length, len);
    assert.ok(maxErr(x, y) < 1e-6, `N=${N} H=${H} len=${len}: max error ${maxErr(x, y)}`);
  }
});

test('processRegion with a 0 dB gain is (numerically) the identity; outside the margin it is bit-exact', () => {
  const x = noise(SR * 2);
  const y = processRegion(x, SR, { t0: 0.8, t1: 1.0, f0: 500, f1: 2000 }, { type: 'gain', db: 0 });
  assert.ok(maxErr(x, y) < 1e-6);
  assert.equal(maxErr(x, y, 0, 4000), 0); // untouched samples copied
  assert.equal(maxErr(x, y, 26000, x.length), 0);
});

test('remove: a tone inside the selection is gone, a tone outside the band survives, nothing changes elsewhere in time', () => {
  const n = SR * 2;
  const x = new Float32Array(n);
  const a = sine(1000, n), b = sine(3000, n, 0.3);
  for (let i = 0; i < n; i++) x[i] = a[i] + b[i];
  const y = processRegion(x, SR, { t0: 0.75, t1: 1.25, f0: 800, f1: 1200 }, { type: 'remove' });
  const mid = [Math.round(0.85 * SR), Math.round(1.15 * SR)];
  assert.ok(amp(y, 1000, ...mid) < 0.01, `1 kHz left: ${amp(y, 1000, ...mid)}`);
  assert.ok(Math.abs(amp(y, 3000, ...mid) - 0.3) < 0.02, `3 kHz kept: ${amp(y, 3000, ...mid)}`);
  assert.ok(Math.abs(amp(y, 1000, 0, Math.round(0.5 * SR)) - 0.5) < 0.01); // before the selection
  assert.ok(Math.abs(amp(y, 1000, Math.round(1.5 * SR), n) - 0.5) < 0.01); // after
});

test('gain: -12 dB attenuates the selected band by 12 dB; +6 dB boosts', () => {
  const n = SR * 2;
  const x = sine(2000, n);
  const mid = [Math.round(0.85 * SR), Math.round(1.15 * SR)];
  const y = processRegion(x, SR, { t0: 0.7, t1: 1.3, f0: 1500, f1: 2500 }, { type: 'gain', db: -12 });
  assert.ok(Math.abs(20 * Math.log10(amp(y, 2000, ...mid) / 0.5) + 12) < 0.3);
  const z = processRegion(x, SR, { t0: 0.7, t1: 1.3, f0: 1500, f1: 2500 }, { type: 'gain', db: 6 });
  assert.ok(Math.abs(20 * Math.log10(amp(z, 2000, ...mid) / 0.5) - 6) < 0.3);
});

test('isolate: inside the selected time span only the band remains', () => {
  const n = SR * 2;
  const x = new Float32Array(n);
  const a = sine(1000, n), b = sine(4000, n, 0.3);
  for (let i = 0; i < n; i++) x[i] = a[i] + b[i];
  const y = processRegion(x, SR, { t0: 0.6, t1: 1.4, f0: 3500, f1: 4500 }, { type: 'isolate' });
  const mid = [Math.round(0.8 * SR), Math.round(1.2 * SR)];
  assert.ok(amp(y, 1000, ...mid) < 0.01);
  assert.ok(Math.abs(amp(y, 4000, ...mid) - 0.3) < 0.02);
  assert.ok(Math.abs(amp(y, 1000, 0, Math.round(0.4 * SR)) - 0.5) < 0.01); // before: untouched
});

test('heal: a click burst inside a steady tone is replaced by the surrounding spectrum', () => {
  const n = SR * 2;
  const x = sine(800, n, 0.4);
  const r = rng32(9);
  const c0 = Math.round(1.0 * SR), c1 = c0 + 400;
  for (let i = c0; i < c1; i++) x[i] += (r() * 2 - 1) * 0.9; // broadband burst
  const sel = { t0: c0 / SR - 0.005, t1: c1 / SR + 0.005, f0: 0, f1: SR / 2 };
  const y = processRegion(x, SR, sel, { type: 'heal' });
  const clean = sine(800, n, 0.4);
  const err = (s) => { let e = 0; for (let i = c0; i < c1; i++) e += (s[i] - clean[i]) ** 2; return Math.sqrt(e / (c1 - c0)); };
  assert.ok(err(y) < err(x) * 0.25, `burst energy ${err(x)} -> ${err(y)}`);
  assert.ok(Math.abs(amp(y, 800, c0 - 2000, c1 + 2000) - 0.4) < 0.05, 'the tone carries on through the healed region');
  assert.equal(maxErr(x, y, 0, c0 - 12000), 0);
});

test('heal fills a dropout (gap) with the surrounding tone', () => {
  const n = SR * 2;
  const x = sine(600, n, 0.5);
  const g0 = Math.round(1 * SR), g1 = g0 + 800;
  x.fill(0, g0, g1);
  const y = processRegion(x, SR, { t0: g0 / SR, t1: g1 / SR, f0: 300, f1: 900 }, { type: 'heal' });
  assert.ok(amp(y, 600, g0 + 100, g1 - 100) > 0.3, `gap level ${amp(y, 600, g0 + 100, g1 - 100)}`);
});

test('selection weights feather smoothly and applySpectralEdit rejects unknown ops', () => {
  const spec = stft(noise(8000), { fftSize: 512, hop: 128 });
  const { wt, wf } = selectionWeights(spec, { t0: 0.1, t1: 0.2, f0: 1000, f1: 2000 }, SR);
  assert.ok(wt.some((v) => v > 0 && v < 1) && wt.some((v) => v === 1));
  assert.ok(wf.some((v) => v > 0 && v < 1) && wf.some((v) => v === 1));
  assert.throws(() => applySpectralEdit(spec, { t0: 0, t1: 0.1 }, { type: 'nope' }, SR));
});

test('spectrogram: a sine shows as a 0 dBFS-ish ridge at its bin', () => {
  const x = sine(1000, SR, 1);
  const s = spectrogram(x, SR, { fftSize: 1024, columns: 20 });
  assert.equal(s.db.length, 20 * s.bins);
  const bin = Math.round((1000 * 1024) / SR);
  const col = 10 * s.bins;
  assert.ok(Math.abs(s.db[col + bin]) < 1.5, `peak ${s.db[col + bin]} dB`);
  assert.ok(s.db[col + bin + 40] < -60);
});
