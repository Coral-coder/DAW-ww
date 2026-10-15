// DSP math of the character / pitch & voice families (src/audio/fx/dsp): Hilbert pair, frequency shifter, comb
// tuning, envelope filter mapping, waveshaper curves, mid/side matrices, LPC / formant shifting, harmony intervals,
// pitch detection and the vocoder band layout — plus the effect defs and latency reporting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Biquad, rms, midiToHz } from '../src/audio/fx/dsp/common.js';
import {
  hilbertPhaseDifference, Hilbert, FreqShifterEngine, combTuning, ResonatorEngine, onePolePhaseDelay, wahCutoff,
  shapeFn, shapeCurve, SHAPES_PLUS, msPlan, matMul, matApply, MS_ENCODE, MS_DECODE, correlation, haasFirstNotch,
} from '../src/audio/fx/dsp/character.js';
import { autocorr, levinson, LatticeAnalysis, LatticeSynthesis } from '../src/audio/fx/dsp/lpc.js';
import { scaleInterval, PitchDetector } from '../src/audio/fx/dsp/pitch.js';
import { bandLayout, FormantEngine, HarmonizerEngine, VocoderEngine } from '../src/audio/fx/dsp/voice.js';
import { EFFECT_DEFS, resolveEffectParams } from '../src/audio/effect-defs.js';
import { effectLatencyFrames, OVERSAMPLE_FRAMES } from '../src/audio/latency.js';
import { KEYED_FX } from '../src/core/patch.js';

const SR = 44100;
const sine = (f, n, a = 0.5) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / SR));
function run(eng, x, n = x.length, key = null) {
  const l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i += 128) {
    const m = Math.min(128, n - i), xi = x.subarray(i, i + m), k = key ? key.subarray(i, i + m) : null;
    eng.process(xi, xi, l.subarray(i, i + m), r.subarray(i, i + m), m, k, k);
  }
  return { l, r };
}
/** Single-bin DFT amplitude (Hann window) of s[a..b) at f. */
function bin(s, f, a, b) {
  let re = 0, im = 0;
  for (let i = a; i < b; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - a)) / (b - a));
    re += w * s[i] * Math.cos((2 * Math.PI * f * i) / SR); im += w * s[i] * Math.sin((2 * Math.PI * f * i) / SR);
  }
  return (Math.hypot(re, im) / (b - a)) * 4;
}

// ------------------------------------------------------------------------------------------- Hilbert / shifter
test('Hilbert pair: 90° ± 1° from 40 Hz to 20 kHz (44.1 and 48 kHz)', () => {
  for (const sr of [44100, 48000]) {
    for (let f = 40; f <= 20000; f *= 1.15) {
      const d = hilbertPhaseDifference(f, sr);
      assert.ok(Math.abs(d - 90) < 1, `${f.toFixed(0)} Hz @ ${sr}: ${d.toFixed(2)}°`);
    }
  }
  // the running filter agrees with the closed form: i = cos -> q = sin (q lags by 90°)
  const h = new Hilbert();
  const f = 1000, n = 8000;
  let iq = 0, ii = 0, qq = 0;
  for (let k = 0; k < n; k++) {
    h.process(Math.cos((2 * Math.PI * f * k) / SR));
    if (k > 2000) { const ref = Math.sin((2 * Math.PI * f * (k - 0)) / SR); iq += h.q * ref; qq += h.q * h.q; ii += ref * ref; }
  }
  assert.ok(Math.abs(Math.abs(iq / Math.sqrt(ii * qq)) - 1) < 0.02, 'q is a 90°-shifted copy');
});

test('frequency shifter moves a partial by +shift (up), −shift (down) and both (L up, R down)', () => {
  const n = SR / 2, x = sine(1000, n);
  for (const [dir, fl, fr] of [[0, 1150, 1150], [1, 850, 850], [2, 1150, 850]]) {
    const fs = new FreqShifterEngine(SR); fs.set({ shift: 150, direction: dir });
    const { l, r } = run(fs, x);
    assert.ok(bin(l, fl, 4096, n) > 0.45, `dir ${dir} left at ${fl}`);
    assert.ok(bin(l, 1000, 4096, n) < 0.01 && bin(l, 2000 - fl, 4096, n) < 0.02, `dir ${dir}: carrier and mirror image suppressed`);
    assert.ok(bin(r, fr, 4096, n) > 0.45, `dir ${dir} right at ${fr}`);
  }
  // per-sample modulation input (LFO) adds to the shift
  const fs = new FreqShifterEngine(SR); fs.set({ shift: 100, direction: 0 });
  const l = new Float32Array(n), r = new Float32Array(n), mod = new Float32Array(128).fill(50);
  for (let i = 0; i < n; i += 128) fs.process(x.subarray(i, i + 128), x.subarray(i, i + 128), l.subarray(i, i + 128), r.subarray(i, i + 128), 128, mod);
  assert.ok(bin(l, 1150, 4096, n) > 0.45);
});

// ------------------------------------------------------------------------------------------- resonator
test('comb tuning: resonance at the note within 1 cent, fundamental decays at the requested T60', () => {
  for (const [note, type] of [[45, 'comb'], [57, 'comb'], [69, 'comb'], [81, 'comb'], [57, 'odd']]) {
    const f = midiToHz(note);
    const rs = new ResonatorEngine(SR); rs.set({ note, chord: 0, decay: 2, bright: 0.4, type: type === 'odd' ? 1 : 0 });
    const n = SR, x = new Float32Array(n); x[0] = 1;
    const { l } = run(rs, x);
    let best = -1, bf = f;
    for (let c = -30; c <= 30; c += 0.25) { const ff = f * 2 ** (c / 1200), v = bin(l, ff, 0, n); if (v > best) { best = v; bf = ff; } }
    assert.ok(Math.abs(1200 * Math.log2(bf / f)) < 1, `${type} note ${note}: ${(1200 * Math.log2(bf / f)).toFixed(2)} ct`);
    if (type === 'odd') assert.ok(bin(l, 2 * f, 0, n) < bin(l, f, 0, n) * 0.1, 'odd type has no 2nd harmonic');
    else {
      const a1 = bin(l, f, SR * 0.1, SR * 0.3), a2 = bin(l, f, SR * 0.6, SR * 0.8);
      const rate = (20 * Math.log10(a2 / a1)) / 0.5; // dB per second
      assert.ok(Math.abs(rate + 30) < 3, `note ${note}: ${rate.toFixed(1)} dB/s (T60 2 s = −30 dB/s)`);
    }
  }
  // the loop filter's phase delay is removed from the delay line
  const t = combTuning(440, 1, 0.5, SR);
  assert.ok(Math.abs(t.delay + 1 + onePolePhaseDelay(0.5, 440, SR) - SR / 440) < 1e-9);
});

test('envelope filter cutoff mapping', () => {
  assert.equal(wahCutoff(0, 200, 4, 1), 200);
  assert.ok(Math.abs(wahCutoff(1, 200, 4, 1) - 3200) < 1e-9);
  assert.ok(Math.abs(wahCutoff(10, 200, 4, 1) - 3200) < 1e-9, 'saturates at the range');
  assert.ok(Math.abs(wahCutoff(0.5, 3000, -2, 1) - 1500) < 1e-9, 'negative range sweeps down');
});

// ------------------------------------------------------------------------------------------- waveshapers
test('waveshaper curves: silent at 0, bounded, symmetric where they should be', () => {
  for (const shape of SHAPES_PLUS) {
    for (const k of [1, 4, 16]) {
      for (const bias of [0, 0.3]) {
        const f = shapeFn(shape, k, { stages: 3, bias });
        assert.ok(Math.abs(f(0)) < 1e-9, `${shape} k${k} b${bias}: f(0) = ${f(0)}`);
        for (let x = -1; x <= 1; x += 0.01) assert.ok(Math.abs(f(x)) <= 1 + 1e-9, `${shape} bounded`);
      }
      const f = shapeFn(shape, k, { stages: 3 });
      for (let x = 0.05; x <= 1; x += 0.05) {
        if (['soft', 'hard', 'sinefold', 'wavefold', 'cubic', 'fuzz'].includes(shape)) assert.ok(Math.abs(f(x) + f(-x)) < 1e-9, `${shape} odd`);
        if (shape === 'fullrect') assert.ok(Math.abs(f(x) - f(-x)) < 1e-9, 'full-wave rectifier is even (octave up)');
        if (shape === 'halfrect') assert.ok(f(-x) === 0 && f(x) > 0, 'half-wave rectifier passes one polarity');
      }
    }
  }
  assert.ok(shapeFn('tube', 4)(0.5) > -shapeFn('tube', 4)(-0.5), 'tube is asymmetric');
  assert.ok(Math.abs(shapeFn('soft', 8)(1) - 1) < 1e-9, 'soft clip normalised to full scale');
  assert.ok(Math.abs(shapeFn('sinefold', 3)(1 / 3) - 1) < 1e-9 && shapeFn('sinefold', 3)(1) < 0, 'sine fold wraps past the peak');
  const c = shapeCurve('wavefold', 6, { stages: 4 }, 1024);
  assert.equal(c.length, 1024);
  assert.ok(c.every((v) => Math.abs(v) <= 1));
  // more stages = more folds (zero crossings)
  const crossings = (stages) => { const g = shapeFn('wavefold', 6, { stages }); let z = 0, prev = g(-1); for (let x = -1; x <= 1; x += 0.0005) { const y = g(x); if (Math.sign(y) !== Math.sign(prev)) z++; prev = y; } return z; };
  assert.ok(crossings(4) > crossings(1));
});

// ------------------------------------------------------------------------------------------- mid / side
test('mid/side matrices: decode ∘ encode = identity, solo, mono and swap', () => {
  assert.deepEqual(matMul(MS_DECODE, MS_ENCODE), [1, 0, 0, 1]);
  const lr = (plan, L, R) => {
    const [m, s] = matApply(plan.inM, L, R);
    return matApply(plan.outM, m * plan.gm, s * plan.gs);
  };
  assert.deepEqual(lr(msPlan({}), 0.7, -0.2).map((v) => +v.toFixed(12)), [0.7, -0.2]);
  assert.deepEqual(lr(msPlan({ solo: 'mid' }), 1, 0), [0.5, 0.5], 'solo mid = mono sum');
  assert.deepEqual(lr(msPlan({ solo: 'side' }), 1, 1), [0, 0], 'solo side cancels a centred signal');
  assert.deepEqual(lr(msPlan({ solo: 'side' }), 1, 0), [0.5, -0.5]);
  assert.deepEqual(lr(msPlan({ mono: true }), 1, 0), [0.5, 0.5]);
  assert.deepEqual(lr(msPlan({ swap: true }), 1, 0), [0, 1]);
  assert.deepEqual(lr(msPlan({ mode: 'encode' }), 1, 0), [0.5, 0.5], 'encode: M = (L+R)/2, S = (L−R)/2');
  assert.deepEqual(lr(msPlan({ mode: 'encode' }), 0, 1), [0.5, -0.5]);
  assert.deepEqual(lr(msPlan({ mode: 'decode' }), 0.5, 0.5), [1, 0], 'decode: L = M+S, R = M−S');
  // encode then decode through two tools = identity
  const [m, s] = lr(msPlan({ mode: 'encode' }), 0.3, -0.8);
  assert.deepEqual(lr(msPlan({ mode: 'decode' }), m, s).map((v) => +v.toFixed(12)), [0.3, -0.8]);
  const g = lr(msPlan({ gainS: 2 }), 1, 0); // side +6 dB widens
  assert.ok(g[0] > 1 && g[1] < 0);
  assert.ok(Math.abs(correlation([1, 2, 3], [2, 4, 6]) - 1) < 1e-12 && Math.abs(correlation([1, -1], [-1, 1]) + 1) < 1e-12);
  assert.equal(haasFirstNotch(10), 50);
});

// ------------------------------------------------------------------------------------------- LPC
test('Levinson recovers an AR(2) process; lattice = direct form; analysis ∘ synthesis = identity', () => {
  // x[n] = 1.3 x[n-1] − 0.6 x[n-2] + e[n]  ->  A(z) = 1 − 1.3 z⁻¹ + 0.6 z⁻²
  let s = 1;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const n = 60000, x = new Float64Array(n);
  for (let i = 2; i < n; i++) x[i] = 1.3 * x[i - 1] - 0.6 * x[i - 2] + rnd();
  const lev = levinson(autocorr(x, n, 2), 2);
  assert.ok(Math.abs(lev.a[1] + 1.3) < 0.02 && Math.abs(lev.a[2] - 0.6) < 0.02, `a = ${lev.a[1]}, ${lev.a[2]}`);
  // lattice analysis with k equals direct-form A(z) with a
  const p = 8, r = autocorr(x, 4000, p), L = levinson(r, p);
  const ana = new LatticeAnalysis(p), syn = new LatticeSynthesis(p);
  for (let i = 0; i < 3000; i++) {
    let direct = x[i];
    for (let j = 1; j <= p; j++) direct += L.a[j] * (i - j >= 0 ? x[i - j] : 0);
    const e = ana.process(x[i], L.k);
    assert.ok(Math.abs(e - direct) < 1e-9, 'lattice == direct form');
    assert.ok(Math.abs(syn.process(e, L.k) - x[i]) < 1e-9, 'synthesis inverts analysis');
  }
  assert.ok(L.k.slice(1).every((k) => Math.abs(k) < 1), 'stable (|k| < 1)');
});

/** A vowel-like test voice: 150 Hz pulse train through three formant resonators. */
function vowel(n, f0 = 150) {
  const fs = [[700, 5], [1200, 6], [2600, 8]].map(([f, q]) => new Biquad().bandpass(f, q, SR));
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) { ph += f0 / SR; let e = 0; if (ph >= 1) { ph -= 1; e = 1; } let y = 0; for (const b of fs) y += b.process(e); x[i] = y * 3; }
  return x;
}
function centroid(s, a, b) {
  let num = 0, den = 0;
  for (let f = 100; f < 6000; f += 50) { const v = bin(s, f, a, b) ** 2; num += f * v; den += v; }
  return num / den;
}

test('formant shifter: 0 st reconstructs exactly, ±st moves the formants and keeps the pitch', () => {
  const n = SR, x = vowel(n);
  const e0 = new FormantEngine(SR); e0.set({ shift: 0 });
  const y0 = run(e0, x).l;
  let err = 0; for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(y0[i] - x[i]));
  assert.ok(err < 1e-4, `identity error ${err}`);
  const c0 = centroid(x, SR / 2, SR / 2 + 4096);
  const up = new FormantEngine(SR); up.set({ shift: 5 });
  const dn = new FormantEngine(SR); dn.set({ shift: -5 });
  const yu = run(up, x).l, yd = run(dn, x).l;
  assert.ok(centroid(yu, SR / 2, SR / 2 + 4096) > c0 * 1.15, 'formants up');
  assert.ok(centroid(yd, SR / 2, SR / 2 + 4096) < c0 * 0.85, 'formants down');
  // pitch kept: the 150 Hz fundamental is still the lowest strong partial
  assert.ok(bin(yu, 150, SR / 2, n) > bin(yu, 150 * 2 ** (5 / 12), SR / 2, n) * 4);
  assert.ok(Math.abs(20 * Math.log10(rms(yu, SR / 2, n) / rms(x, SR / 2, n))) < 6, 'level roughly kept');
});

test('harmony: scale-aware intervals and pitch tracking', () => {
  // C major: a third above C is E (+4), above D is F (+3), above E is G (+3), a fifth above B is F (+6)
  assert.equal(scaleInterval(60, 0, 'major', 2), 4);
  assert.equal(scaleInterval(62, 0, 'major', 2), 3);
  assert.equal(scaleInterval(64, 0, 'major', 2), 3);
  assert.equal(scaleInterval(71, 0, 'major', 4), 6);
  assert.equal(scaleInterval(60, 0, 'major', 7), 12, 'seven steps = an octave');
  assert.equal(scaleInterval(60, 0, 'major', -2), -3, 'third below C is A');
  assert.equal(scaleInterval(57, 9, 'minor', 2), 3, 'A minor: third above A is C');
  assert.equal(scaleInterval(61, 0, 'major', 2), 3, 'off-scale C♯ harmonises from C: E');
  const det = new PitchDetector(SR);
  const x = sine(220, SR / 2, 0.3);
  for (const v of x) det.feed(v);
  assert.ok(Math.abs(1200 * Math.log2(det.hz / 220)) < 10, `detected ${det.hz}`);
  // the harmonizer follows the sung note: a scale third above A3 in C major = C4 (+3)
  const h = new HarmonizerEngine(SR);
  h.set({ scaleMode: 1, key: 0, scale: 0, v2On: 1, v2Int: 2 });
  run(h, x);
  assert.equal(h.targets()[1], 3);
  assert.equal(h.latency, effectLatencyFrames({ type: 'pitchShift', params: { latency: 'low' } }, SR));
});

test('harmonizer voices land on their intervals (formant preservation off and on)', () => {
  const n = SR, x = sine(220, n, 0.3);
  for (const formant of [0, 1]) {
    const h = new HarmonizerEngine(SR);
    h.set({ semis: 0, level1: 0, v2On: 1, v2Int: 7, v2Pan: 0, v2Level: 1, formant, quality: 1 });
    const { l } = run(h, x);
    const f = 220 * 2 ** (7 / 12);
    assert.ok(bin(l, f, SR / 2, n) > 4 * bin(l, 220, SR / 2, n), `formant ${formant}: fifth above dominates`);
  }
});

// ------------------------------------------------------------------------------------------- vocoder
test('vocoder band layout: geometric centres from lo to hi, adjacent bands cross between −3 and −15 dB', () => {
  for (const nb of [8, 16, 32]) {
    const L = bandLayout(nb, 100, 8000);
    assert.equal(L.freqs.length, nb);
    assert.ok(Math.abs(L.freqs[0] - 100) < 1e-9 && Math.abs(L.freqs[nb - 1] - 8000) < 1e-6);
    const ratio = L.freqs[1] / L.freqs[0];
    for (let i = 1; i < nb; i++) assert.ok(Math.abs(L.freqs[i] / L.freqs[i - 1] - ratio) < 1e-9);
    const b = new Biquad().bandpass(L.freqs[4], L.q, SR);
    const mid = Math.sqrt(L.freqs[4] * L.freqs[5]);
    const db = 2 * 20 * Math.log10(b.magnitude(mid, SR)); // two sections in series
    assert.ok(db < -3 && db > -15, `${nb} bands: crossover ${db.toFixed(1)} dB`);
    assert.ok(Math.abs(b.magnitude(L.freqs[4], SR) - 1) < 1e-9, '0 dB at the centre');
  }
});

test('vocoder output follows the modulator spectrum; sidechain carrier works', () => {
  const n = SR;
  // modulator: noise band-passed around 2 kHz
  const bp = [new Biquad().bandpass(2000, 4, SR), new Biquad().bandpass(2000, 4, SR)];
  let s = 7;
  const mod = Float32Array.from({ length: n }, () => { s = (s * 16807) % 2147483647; return bp[1].process(bp[0].process(s / 2147483647 - 0.5)); });
  const v = new VocoderEngine(SR); v.set({ bands: 16, note: 45, chord: 0, detune: 0, sibilance: 0, noise: 0 });
  const { l } = run(v, mod);
  const near = Math.max(...[1760, 1980, 2200].map((f) => bin(l, f, SR / 4, n)));
  const far = Math.max(...[220, 330, 440].map((f) => bin(l, f, SR / 4, n)));
  assert.ok(near > far * 5, `energy follows the modulator (${near} vs ${far})`);
  assert.ok(Number.isFinite(rms(l)) && rms(l) > 1e-3);
  const vs = new VocoderEngine(SR); vs.set({ bands: 16, carrier: 1, sibilance: 0, noise: 0 });
  const carrier = sine(1980, n, 0.5);
  const y = run(vs, mod, n, carrier).l;
  assert.ok(bin(y, 1980, SR / 4, n) > 0.01, 'sidechain carrier tone comes through');
});

// ------------------------------------------------------------------------------------------- defs / latency
const CHAR = ['pitchShift', 'vocoder', 'formantShift', 'freqShift', 'ringMod', 'resonator', 'autoWah', 'distortionPlus', 'msTool', 'haas'];

test('character defs: categories and 10–20 valid presets each', () => {
  const cats = { pitchShift: 'Pitch & Voice', vocoder: 'Pitch & Voice', formantShift: 'Pitch & Voice', freqShift: 'Modulation', ringMod: 'Modulation', resonator: 'EQ & Filter', autoWah: 'EQ & Filter', distortionPlus: 'Distortion', msTool: 'Stereo', haas: 'Stereo' };
  for (const t of CHAR) {
    const d = EFFECT_DEFS[t];
    assert.equal(d.category, cats[t], t);
    const n = Object.keys(d.presets).length;
    assert.ok(n >= 10 && n <= 20, `${t}: ${n} presets`);
    const keys = new Set(d.params.map((p) => p.key));
    for (const [name, pr] of Object.entries(d.presets)) {
      for (const [k, v] of Object.entries(pr)) {
        assert.ok(keys.has(k), `${t} / ${name}: unknown ${k}`);
        const p = d.params.find((x) => x.key === k);
        if (p.type === 'number') assert.ok(v >= p.min && v <= p.max, `${t} / ${name}: ${k}=${v}`);
        if (p.type === 'enum') assert.ok(p.options.some((o) => o.value === v), `${t} / ${name}: ${k}=${v}`);
      }
      const r = resolveEffectParams({ type: t, params: pr });
      for (const [k, v] of Object.entries(pr)) assert.equal(r[k], v);
    }
  }
  assert.ok(KEYED_FX.has('vocoder'), 'vocoder takes a sidechain carrier');
  assert.ok(EFFECT_DEFS.vocoder.params.some((p) => p.key === 'sourceTrackId' && p.type === 'track'));
});

test('latency: pitch shifter by mode, formant shifter only when pitching, Distortion+ by oversampling', () => {
  const sr = 48000;
  assert.ok(effectLatencyFrames({ type: 'pitchShift', params: {} }, sr) > effectLatencyFrames({ type: 'pitchShift', params: { latency: 'low' } }, sr));
  assert.ok(effectLatencyFrames({ type: 'pitchShift', params: { latency: 'low' } }, sr) / sr < 0.02, 'low latency under 20 ms');
  assert.equal(effectLatencyFrames({ type: 'formantShift', params: { shift: 5 } }, sr), 0);
  assert.ok(effectLatencyFrames({ type: 'formantShift', params: { pitch: 3 } }, sr) > 0);
  assert.equal(effectLatencyFrames({ type: 'distortionPlus', params: {} }, sr), OVERSAMPLE_FRAMES['2x']);
  assert.equal(effectLatencyFrames({ type: 'distortionPlus', params: { oversample: 'none' } }, sr), 0);
  assert.equal(effectLatencyFrames({ type: 'distortionPlus', params: { oversample: '4x' } }, sr), OVERSAMPLE_FRAMES['4x']);
  for (const t of ['vocoder', 'freqShift', 'ringMod', 'resonator', 'autoWah', 'msTool', 'haas']) assert.equal(effectLatencyFrames({ type: t, params: {} }, sr), 0, t);
});
