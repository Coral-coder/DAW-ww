// Dynamics / EQ effect family: crossovers, envelope followers, gain computers, the processing cores, FIR kernel
// design, match-EQ curves, params ↔ AudioParams, latency rules, the worklet wrapper and the builders on a mock context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compressGain, upwardGain, expandGain, dynamicAmount, EnvelopeFollower, GainSmoother, timeCoef, Crossover, LR4,
  MultibandCore, TransientCore, DeesserCore, ExpanderCore, DynEqCore, lookaheadFrames, softClip,
} from '../src/audio/fx/dsp/dynamics-core.js';
import { rbjCoefs, biquadMag, analogMag, bandsMag, linToDb, logFreqs, interpLog } from '../src/audio/fx/dsp/curve-math.js';
import {
  designLinearPhase, kernelResponse, firTaps, firLatency, MATCH_FREQS, bandsFromPower, averageSpectrum, smoothSpectrum,
  matchCurve, curveMagFn, packCurve,
} from '../src/audio/fx/dsp/fir.js';
import { PROCS } from '../src/audio/fx/dsp/dynamics-params.js';
import { dynamicsLatencyFrames } from '../src/audio/fx/dynamics-latency.js';
import { effectLatencyFrames } from '../src/audio/latency.js';
import { EFFECT_DEFS, getEffectDefaults, resolveEffectParams } from '../src/audio/effect-defs.js';
import { KEYED_FX } from '../src/core/patch.js';
import { MockContext } from './lib/mock-audio.js';

const SR = 48000;
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (±${tol})`);
const sine = (f, n, amp = 1, sr = SR, ph = 0) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * f * i / sr + ph));
const rms = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };
const dbr = (x, a, b) => linToDb(rms(x, a, b));
/** Run a core over a stereo signal in 128-frame blocks. */
function run(core, L, R = L, key = null) {
  const n = L.length, oL = new Float32Array(n), oR = new Float32Array(n);
  for (let i = 0; i < n; i += 128) {
    const e = Math.min(n, i + 128);
    core.process([L.subarray(i, e), R.subarray(i, e)], [oL.subarray(i, e), oR.subarray(i, e)], e - i, key ? [key.subarray(i, e), key.subarray(i, e)] : null);
  }
  return [oL, oR];
}
function noise(n, seed = 1, amp = 0.3) {
  let s = seed >>> 0;
  return Float32Array.from({ length: n }, () => { s = (s * 1664525 + 1013904223) >>> 0; return amp * ((s / 4294967296) * 2 - 1); });
}

// ------------------------------------------------------------------------------------ crossovers
test('Linkwitz-Riley crossover: 3- and 4-band sums are flat (allpass) at 44.1 / 48 / 96 kHz', () => {
  for (const sr of [44100, 48000, 96000]) {
    for (const freqs of [[120, 2500], [88, 2500, 8000], [200, 1200, 5000], [60, 300, 12000]]) {
      const xo = new Crossover(sr, freqs);
      const N = 16384, ir = new Float64Array(N);
      for (let i = 0; i < N; i++) { const o = xo.process(i === 0 ? 1 : 0); let s = 0; for (const v of o) s += v; ir[i] = s; }
      const r = kernelResponse(ir, [20, 45, 88, 120, 300, 1000, 2500, 5000, 8000, 12000, 18000], sr);
      for (const m of r) close(linToDb(m), 0, 0.01, `sum ${sr} ${freqs}`);
    }
  }
});

test('Linkwitz-Riley crossover: each band passes its range and rejects the others; LR4 is −6 dB at fc', () => {
  const xo = new Crossover(SR, [200, 3000]);
  const N = 16384, irs = [new Float64Array(N), new Float64Array(N), new Float64Array(N)];
  for (let i = 0; i < N; i++) { const o = xo.process(i === 0 ? 1 : 0); for (let k = 0; k < 3; k++) irs[k][i] = o[k]; }
  const [lo, mid, hi] = irs.map((ir) => kernelResponse(ir, [40, 200, 900, 3000, 12000], SR).map(linToDb));
  close(lo[0], 0, 0.1, 'low @40'); assert.ok(lo[3] < -30 && lo[4] < -60, 'low rejects highs');
  close(lo[1], -6.02, 0.05, 'low @fc'); close(mid[3], -6.02, 0.2, 'mid @fc2');
  close(mid[2], 0, 0.5, 'mid @900'); assert.ok(mid[0] < -25 && mid[4] < -25, 'mid rejects');
  close(hi[4], 0, 0.1, 'high @12k'); assert.ok(hi[0] < -60, 'high rejects lows');
  const lr = new LR4(SR, 1000);
  const ir = new Float64Array(8192);
  for (let i = 0; i < 8192; i++) ir[i] = lr.split(i === 0 ? 1 : 0);
  close(linToDb(kernelResponse(ir, [1000], SR)[0]), -6.02, 0.02, 'LR4 low @fc');
});

// ------------------------------------------------------------------------------------ followers and gain computers
test('envelope follower: one-pole attack / release time constants; gain smoother branches', () => {
  const e = new EnvelopeFollower(SR, 0.01, 0.1);
  let y = 0;
  for (let i = 0; i < 0.01 * SR; i++) y = e.process(1);
  close(y, 1 - Math.exp(-1), 0.002, 'attack τ');
  for (let i = 0; i < 0.1 * SR; i++) y = e.process(0);
  close(y / (1 - Math.exp(-1)), Math.exp(-1), 0.002, 'release τ');
  // follows |x| (rectifies): a sine settles near its peak with a slow release
  const f = new EnvelopeFollower(SR, 0.0001, 0.5);
  const s = sine(100, SR / 2, 0.5);
  for (const v of s) f.process(v);
  assert.ok(f.y > 0.45 && f.y <= 0.5, `peak follow ${f.y}`);
  assert.equal(timeCoef(0, SR), 0);
  const g = new GainSmoother(SR, 0.05, 0.001);
  for (let i = 0; i < 48; i++) g.process(-10);
  assert.ok(g.y < -6, 'falls fast');
  for (let i = 0; i < 48; i++) g.process(0);
  assert.ok(g.y < -5, 'rises slowly');
});

test('gain computers: compressor, upward, expander, dynamic amount', () => {
  close(compressGain(-30, -20, 4), 0, 0);
  close(compressGain(-8, -20, 4), -9, 1e-9, '12 dB over at 4:1 → −9');
  close(compressGain(0, -20, 1), 0, 1e-12, 'ratio 1');
  // soft knee: continuous at both knee edges, −slope·knee/8 at the threshold
  close(compressGain(-23, -20, 4, 6), compressGain(-23.0001, -20, 4, 0), 1e-3, 'knee start');
  close(compressGain(-17, -20, 4, 6), -0.75 * 3, 1e-9, 'knee end');
  close(compressGain(-20, -20, 4, 6), -0.75 * 6 / 8, 1e-9, 'knee centre');
  // upward: lifts below the threshold, capped, never lifts silence
  close(upwardGain(-30, -40, 3), 0, 0);
  close(upwardGain(-52, -40, 3), 8, 1e-9, '12 dB under at 3:1 → +8');
  assert.equal(upwardGain(-70, -10, 100, 0, 24), 24, 'max boost');
  close(upwardGain(-95, -40, 3), 0, 0, 'noise floor untouched');
  assert.ok(upwardGain(-84, -40, 3) < upwardGain(-70, -40, 3), 'fades towards the floor');
  // expander: 1:ratio below the threshold, limited by the range
  close(expandGain(-30, -40, 4, -40), 0, 0);
  close(expandGain(-45, -40, 4, -40), -15, 1e-9, '5 dB under at 1:4');
  assert.equal(expandGain(-80, -40, 4, -40), -40, 'range');
  assert.equal(expandGain(-80, -40, 50, -80), -80, 'gate');
  // dynamic EQ amount
  close(dynamicAmount(-14, -20, 3, 'above', 0), 4, 1e-9, 'above');
  close(dynamicAmount(-30, -20, 3, 'above', 0), 0, 0);
  close(dynamicAmount(-26, -20, 3, 'below', 0), 4, 1e-9, 'below');
  close(dynamicAmount(-10, -20, 3, 'below', 0), 0, 0);
  assert.equal(softClip(0.5), 0.5);
  assert.ok(softClip(3) < 1 && softClip(3) > 0.95 && softClip(-3) === -softClip(3));
});

// ------------------------------------------------------------------------------------ cores
test('multiband core: transparent at ratio 1, compresses loud bands, upward mode lifts quiet ones, solo / bypass', () => {
  const n = SR;
  const x = sine(1000, n, 0.5);
  const flat = new MultibandCore(SR);
  flat.set({ band: [0, 1, 2, 3].map(() => ({ ratio: 1 })) });
  const [y] = run(flat, x);
  close(dbr(y, n / 2, n), dbr(x, n / 2, n), 0.01, 'unity');
  const mb = new MultibandCore(SR);
  mb.set({ band: [0, 1, 2, 3].map(() => ({ thr: -30, ratio: 4, attack: 0.002, release: 0.05 })) });
  const [c] = run(mb, x);
  const red = dbr(c, n / 2, n) - dbr(x, n / 2, n);
  assert.ok(red < -10 && red > -20, `downward ${red}`);
  const m = mb.readMeter();
  assert.ok(Math.min(...m.gr) < -10, 'meter reports the reduction');
  // upward: a quiet tone is raised
  const q = sine(1000, n, 0.01);
  const up = new MultibandCore(SR);
  up.set({ mode: 'up', band: [0, 1, 2, 3].map(() => ({ upThr: -30, upRatio: 3, attack: 0.002, release: 0.05 })) });
  const [u] = run(up, q);
  assert.ok(dbr(u, n / 2, n) - dbr(q, n / 2, n) > 6, 'upward lift');
  assert.ok(up.readMeter().up[1] > 6);
  // depth 0 → transparent even in OTT mode
  const d0 = new MultibandCore(SR);
  d0.set({ mode: 'both', depth: 0 });
  close(dbr(run(d0, x)[0], n / 2, n), dbr(x, n / 2, n), 0.01, 'depth 0');
  // solo the low band: a 5 kHz tone disappears, a 60 Hz tone stays
  const solo = new MultibandCore(SR);
  solo.set({ band: [{ solo: true, ratio: 1 }, { ratio: 1 }, { ratio: 1 }] });
  assert.ok(dbr(run(solo, sine(5000, n, 0.5))[0], n / 2, n) < -50);
  close(dbr(run(solo, sine(30, n, 0.5))[0], n / 2, n), dbr(sine(30, n, 0.5), n / 2, n), 0.1, 'solo passes its band');
  // bypassed band: no compression and no makeup
  const byp = new MultibandCore(SR);
  byp.set({ band: [0, 1, 2, 3].map(() => ({ thr: -40, ratio: 10, makeup: 12, bypass: true })) });
  close(dbr(run(byp, x)[0], n / 2, n), dbr(x, n / 2, n), 0.01, 'bypass');
  // 4 bands: still flat at ratio 1; mix 0 is the phase-matched band sum
  const four = new MultibandCore(SR);
  four.set({ bands: 4, freqs: [100, 1000, 6000], mix: 0, band: [0, 1, 2, 3].map(() => ({ thr: -50, ratio: 10 })) });
  close(dbr(run(four, x)[0], n / 2, n), dbr(x, n / 2, n), 0.01, 'mix 0');
});

test('multiband core: look-ahead delays the audio by exactly the reported frames', () => {
  const mb = new MultibandCore(SR);
  mb.set({ lookahead: 0.005, band: [0, 1, 2, 3].map(() => ({ ratio: 1 })) });
  const x = new Float32Array(2048); x[0] = 1;
  const [y] = run(mb, x);
  // the allpass sum smears the impulse; its energy centroid starts right at the look-ahead
  const first = y.findIndex((v) => Math.abs(v) > 1e-6);
  assert.equal(first, lookaheadFrames(0.005, SR));
  assert.equal(first, 240);
});

test('transient shaper: attack boosts onsets, sustain lengthens tails, both level-independent', () => {
  const n = SR;
  const hit = new Float32Array(n);
  for (const t0 of [0.1, 0.4, 0.7]) {
    const s0 = Math.round(t0 * SR);
    for (let i = 0; i < 0.25 * SR; i++) hit[s0 + i] = Math.exp(-i / (0.06 * SR)) * Math.sin(2 * Math.PI * 180 * i / SR) * 0.5;
  }
  const on = (y) => dbr(y, Math.round(0.4 * SR), Math.round(0.405 * SR));
  const tail = (y) => dbr(y, Math.round(0.52 * SR), Math.round(0.62 * SR));
  const shape = (o) => { const c = new TransientCore(SR); c.set(o); return run(c, hit)[0]; };
  const neutral = shape({});
  close(on(neutral), on(hit), 0.01, 'neutral');
  const punch = shape({ attack: 100 }), soft = shape({ attack: -100 });
  assert.ok(on(punch) - on(hit) > 3, `attack + ${on(punch) - on(hit)}`);
  assert.ok(on(soft) - on(hit) < -3, `attack − ${on(soft) - on(hit)}`);
  const longer = shape({ sustain: 100 }), shorter = shape({ sustain: -100 });
  assert.ok(tail(longer) - tail(hit) > 3, `sustain + ${tail(longer) - tail(hit)}`);
  assert.ok(tail(shorter) - tail(hit) < -3, `sustain − ${tail(shorter) - tail(hit)}`);
  // level independence: the same shape 20 dB quieter gets the same relative change
  const quiet = hit.map((v) => v * 0.1);
  const c2 = new TransientCore(SR); c2.set({ attack: 100 });
  const pq = run(c2, quiet)[0];
  close(on(pq) - on(quiet), on(punch) - on(hit), 0.5, 'level independent');
  const cl = new TransientCore(SR); cl.set({ attack: 100, clip: true });
  assert.ok(Math.max(...run(cl, hit.map((v) => v * 2))[0]) <= 1, 'soft clip keeps peaks under 0 dBFS');
});

test('de-esser: turns down the sibilant band only (split), the whole signal (wide), listen = detector', () => {
  const n = SR;
  const ess = sine(7500, n, 0.4), low = sine(200, n, 0.4);
  const x = ess.map((v, i) => v + low[i]);
  const d = new DeesserCore(SR);
  d.set({ freq: 5000, thr: -30, range: 10 });
  const [y] = run(d, x);
  // measure the bands of the output with fresh crossovers
  const split = (sig) => { const xo = new Crossover(SR, [1500]); const lo = new Float32Array(n), hi = new Float32Array(n); for (let i = 0; i < n; i++) { const o = xo.process(sig[i]); lo[i] = o[0]; hi[i] = o[1]; } return [lo, hi]; };
  const [ylo, yhi] = split(y), [xlo, xhi] = split(x);
  close(dbr(ylo, n / 2, n), dbr(xlo, n / 2, n), 0.1, 'lows untouched');
  // split-band output at f: LR4 low + high·g = (1 + g·w⁴) / (1 + w⁴), w = f / freq
  const w4 = (Math.tan(Math.PI * 7500 / SR) / Math.tan(Math.PI * 5000 / SR)) ** 4, g = Math.pow(10, -10 / 20); // (bilinear-warped)
  close(dbr(yhi, n / 2, n) - dbr(xhi, n / 2, n), linToDb((1 + g * w4) / (1 + w4)), 0.3, 'sibilance down (split at 5 kHz)');
  close(d.readMeter().gr, -10, 0.01, 'meter');
  const w = new DeesserCore(SR); w.set({ freq: 5000, thr: -30, range: 6, mode: 'wide' });
  const [ywl] = split(run(w, x)[0]);
  assert.ok(dbr(ywl, n / 2, n) - dbr(xlo, n / 2, n) < -5, 'wideband turns the lows down too');
  const quiet = new DeesserCore(SR); quiet.set({ freq: 5000, thr: -2, range: 10 });
  close(dbr(run(quiet, x)[0], n / 2, n), dbr(x, n / 2, n), 0.05, 'below threshold: transparent');
  const l = new DeesserCore(SR); l.set({ freq: 5000, listen: true });
  const [yl] = split(run(l, x)[0]);
  assert.ok(dbr(yl, n / 2, n) < -40, 'listen: only the detector band');
  const bp = new DeesserCore(SR); bp.set({ freq: 7500, detect: 'bp', thr: -30, range: 8 });
  run(bp, x);
  assert.ok(bp.readMeter().gr < -7, 'band-pass detector');
});

test('expander / gate: range, hysteresis, hold, look-ahead and external key', () => {
  const n = SR;
  const e = new ExpanderCore(SR);
  e.set({ thr: -40, ratio: 50, range: -60, hyst: 6, attack: 0.0005, hold: 0, release: 0.01, lookahead: 0 });
  const quiet = sine(500, n, 0.003); // ≈ −50 dBFS peak
  close(dbr(run(e, quiet)[0], n / 2, n) - dbr(quiet, n / 2, n), -60, 0.5, 'closed → range');
  const loud = sine(500, n, 0.3);
  const e2 = new ExpanderCore(SR); e2.set({ thr: -40, ratio: 50, range: -60 });
  close(dbr(run(e2, loud)[0], n / 2, n), dbr(loud, n / 2, n), 0.05, 'open → transparent');
  // hysteresis: open at −30 dBFS, then a level 4 dB under the threshold keeps it open (hyst 6), 8 dB under closes it
  const mk = (amps) => { const out = new Float32Array(amps.length * SR / 2); amps.forEach((a, k) => out.set(sine(500, SR / 2, a), k * SR / 2)); return out; };
  const thrLin = Math.pow(10, -40 / 20);
  const sig = mk([thrLin * 3, thrLin * Math.pow(10, -4 / 20), thrLin * Math.pow(10, -8 / 20)]);
  const hy = new ExpanderCore(SR); hy.set({ thr: -40, ratio: 50, range: -60, hyst: 6, attack: 0.0005, hold: 0, release: 0.01, lookahead: 0 });
  const [hyo] = run(hy, sig);
  const seg = (k) => dbr(hyo, k * SR / 2 + SR / 4, (k + 1) * SR / 2) - dbr(sig, k * SR / 2 + SR / 4, (k + 1) * SR / 2);
  close(seg(1), 0, 1, 'held open inside the hysteresis');
  assert.ok(seg(2) < -40, `closed below thr − hyst (${seg(2)})`);
  // hold: a short burst keeps the gate open for `hold` after it ends
  const burst = new Float32Array(SR); burst.set(sine(500, SR / 10, 0.5)); burst.set(sine(500, SR / 2, 0.001), SR / 10);
  const ho = new ExpanderCore(SR); ho.set({ thr: -40, ratio: 50, range: -80, hyst: 0, attack: 0.0001, hold: 0.2, release: 0.005, lookahead: 0 });
  const [hoo] = run(ho, burst);
  close(dbr(hoo, SR / 10 + SR / 20, SR / 10 + SR / 10) - dbr(burst, SR / 10 + SR / 20, SR / 10 + SR / 10), 0, 1, 'held');
  assert.ok(dbr(hoo, SR / 2, 0.6 * SR) - dbr(burst, SR / 2, 0.6 * SR) < -60, 'closes after hold + release');
  // external key: the quiet signal passes while the key is loud
  const k = new ExpanderCore(SR); k.set({ thr: -40, ratio: 50, range: -60, keyed: true });
  close(dbr(run(k, quiet, quiet, loud)[0], n / 2, n), dbr(quiet, n / 2, n), 0.1, 'keyed open');
  // sidechain high-pass: a loud 50 Hz key does not open the gate when filtered out
  const hp = new ExpanderCore(SR); hp.set({ thr: -40, ratio: 50, range: -60, keyed: true, hpf: 1000 });
  assert.ok(dbr(run(hp, quiet, quiet, sine(50, n, 0.05))[0], n / 2, n) - dbr(quiet, n / 2, n) < -40, 'SC filter');
  // look-ahead = whole frames
  const la = new ExpanderCore(SR); la.set({ thr: -100, lookahead: 0.002 });
  const imp = new Float32Array(512); imp[0] = 1;
  assert.equal(run(la, imp)[0].findIndex((v) => v !== 0), 96);
});

test('dynamic EQ: a band cuts only while its band level is above the threshold (and boosts below in "below" mode)', () => {
  const n = SR;
  const quiet = sine(3000, n, 0.01), loud = sine(3000, n, 0.5);
  const make = (o) => { const c = new DynEqCore(SR); c.set({ band: [{ on: true, type: 'peaking', freq: 3000, q: 2, thr: -30, ratio: 4, range: -9, attack: 0.002, release: 0.05, ...o }] }); return c; };
  close(dbr(run(make({}), quiet)[0], n / 2, n), dbr(quiet, n / 2, n), 0.05, 'quiet: untouched');
  const c = make({});
  const dl = dbr(run(c, loud)[0], n / 2, n) - dbr(loud, n / 2, n);
  close(dl, -9, 0.3, 'loud: cut by the range');
  close(c.readMeter().dyn[0], -9, 0.01, 'meter');
  const below = make({ mode: 'below', range: 6 });
  close(dbr(run(below, quiet)[0], n / 2, n) - dbr(quiet, n / 2, n), 6, 0.3, 'below: boost when quiet');
  // other frequencies are not affected by the band's cut
  const mixed = sine(3000, n, 0.5).map((v, i) => v + Math.sin(2 * Math.PI * 200 * i / SR) * 0.3);
  const [y] = run(make({}), mixed);
  const lo = (s) => { const b = new LR4(SR, 600); const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = b.split(s[i]); return o; };
  close(dbr(lo(y), n / 2, n), dbr(lo(mixed), n / 2, n), 0.3, '200 Hz unaffected');
  // static gain works without dynamics
  const st = new DynEqCore(SR); st.set({ band: [{ on: true, freq: 1000, gain: 6, q: 1, thr: 0, ratio: 1 }] });
  close(dbr(run(st, sine(1000, n, 0.1))[0], n / 2, n) - dbr(sine(1000, n, 0.1), n / 2, n), 6, 0.05, 'static');
});

// ------------------------------------------------------------------------------------ curve math / FIR
test('curve math: RBJ biquads match their analog prototypes away from Nyquist', () => {
  for (const t of ['peaking', 'lowshelf', 'highshelf', 'lowpass', 'highpass', 'bandpass', 'notch']) {
    const c = rbjCoefs(t, 1000, 0.9, 6, 96000);
    for (const f of [100, 500, 1000, 2000]) {
      const a = linToDb(analogMag(t, f, 1000, 0.9, 6)), d = linToDb(biquadMag(c, f, 96000));
      if (a > -40) close(d, a, 0.15, `${t} @${f}`);
    }
  }
  close(linToDb(analogMag('peaking', 1000, 1000, 1, 6)), 6, 1e-9, 'bell centre');
  close(linToDb(analogMag('lowshelf', 10, 1000, 0.7, -6)), -6, 0.01, 'low shelf');
  close(linToDb(analogMag('highshelf', 20000, 1000, 0.7, 4)), 4, 0.01, 'high shelf');
  close(linToDb(analogMag('highpass48', 100, 100, 1, 0)), -3.01, 0.01, 'Butterworth −3 dB');
  close(linToDb(analogMag('highpass48', 50, 100, 1, 0)), -48.2, 0.2, '48 dB/oct');
  close(linToDb(bandsMag([{ type: 'peaking', freq: 1000, gain: 6, q: 1 }, { type: 'peaking', freq: 1000, gain: 6, q: 1, on: false }], 1000)), 6, 1e-9, 'off band ignored');
  const fs = logFreqs(4, 10, 1000);
  close(fs[1], 10 * Math.cbrt(100), 1e-9);
  close(interpLog([100, 1000], [0, 10], Math.sqrt(1e5)), 5, 1e-9, 'log interpolation');
});

test('FIR kernel design: symmetric (linear phase), magnitude matches the target, latency (taps − 1) / 2', () => {
  const bands = [{ type: 'highpass24', freq: 30, q: 0.71 }, { type: 'peaking', freq: 120, gain: 5, q: 1 }, { type: 'peaking', freq: 1000, gain: -8, q: 2 }, { type: 'highshelf', freq: 8000, gain: 4, q: 0.7 }];
  for (const [quality, minF, tol] of [['low', 150, 0.4], ['medium', 80, 0.35], ['high', 50, 0.2]]) {
    const taps = firTaps(quality, SR);
    assert.equal(taps % 2, 1, 'odd length');
    const h = designLinearPhase((f) => bandsMag(bands, f), taps, SR);
    assert.equal(h.length, taps);
    for (let i = 0; i < taps; i++) assert.ok(Math.abs(h[i] - h[taps - 1 - i]) < 1e-7, 'symmetric');
    const fs = [minF, 200, 500, 1000, 2000, 5000, 8000, 12000, 18000];
    const r = kernelResponse(h, fs, SR);
    fs.forEach((f, i) => close(linToDb(r[i]), linToDb(bandsMag(bands, f)), tol, `${quality} @${f}`));
  }
  // flat target → a unit impulse at the centre: the latency
  const flat = designLinearPhase(() => 1, firTaps('medium', SR), SR);
  const c = flat.indexOf(Math.max(...flat));
  assert.equal(c, firLatency(flat.length));
  close(flat[c], 1, 1e-6); close(flat.reduce((a, b) => a + Math.abs(b), 0), 1, 1e-6);
  // kernel length scales with the sample rate (same time span)
  assert.equal(firTaps('medium', 48000), 4095);
  assert.equal(firTaps('medium', 96000), 8191);
  assert.equal(firTaps('medium', 44100), 4095);
  assert.equal(firTaps('max', 48000), 16383);
  assert.equal(firTaps('bogus', 48000), 4095);
});

test('match EQ: band integration, smoothing and the bounded correction curve', () => {
  // flat power → equal band levels
  const fft = 8192, pw = new Float64Array(fft / 2 + 1).fill(1);
  const b = bandsFromPower(pw, SR, fft);
  assert.equal(b.length, MATCH_FREQS.length);
  for (const v of b) close(v, 0, 1e-9);
  // a known tilt between reference and current comes back as the correction (level-aligned)
  const tilt = (f) => 3 * Math.log2(f / 1000); // +3 dB / octave around 1 kHz
  const cur = MATCH_FREQS.map(() => -20);
  const ref = MATCH_FREQS.map((f) => -20 + tilt(f));
  const c = matchCurve(ref, cur, { amount: 1, smoothing: 0, maxBoost: 30, maxCut: 30, low: 20, high: 20000 });
  let mean = 0, k = 0;
  MATCH_FREQS.forEach((f) => { if (f >= 200 && f <= 5000) { mean += tilt(f); k++; } });
  mean /= k;
  MATCH_FREQS.forEach((f, i) => close(c[i], tilt(f) - mean, 1e-9, `@${f.toFixed(0)}`));
  // a pure level difference is not "corrected"
  const louder = cur.map((v) => v + 9);
  for (const v of matchCurve(louder, cur, { smoothing: 0 })) close(v, 0, 1e-9);
  // amount, clamps and limits
  const half = matchCurve(ref, cur, { amount: 0.5, smoothing: 0, maxBoost: 30, maxCut: 30, low: 20, high: 20000 });
  half.forEach((v, i) => close(v, c[i] / 2, 1e-9));
  const clamped = matchCurve(ref, cur, { amount: 1, smoothing: 0, maxBoost: 2, maxCut: 3, low: 20, high: 20000 });
  assert.ok(Math.max(...clamped) <= 2 + 1e-9 && Math.min(...clamped) >= -3 - 1e-9);
  const lim = matchCurve(ref, cur, { amount: 1, smoothing: 0, maxBoost: 30, maxCut: 30, low: 100, high: 5000 });
  MATCH_FREQS.forEach((f, i) => { if (f < 100 / 1.42 || f > 5000 * 1.42) close(lim[i], 0, 1e-9, `outside limits @${f}`); });
  // smoothing removes narrow ripple
  const ripple = MATCH_FREQS.map((_, i) => (i % 2 ? 4 : -4));
  const sm = smoothSpectrum(ripple, MATCH_FREQS, 1 / 2);
  assert.ok(Math.max(...sm.slice(5, -5).map(Math.abs)) < 1);
  assert.equal(matchCurve(null, cur).every((v) => v === 0), true);
  assert.deepEqual(packCurve([1.234, -Infinity, 99]), [1.2, -150, 50]);
  // the FIR built from the correction reproduces it
  const h = designLinearPhase(curveMagFn(c), firTaps('high', SR), SR);
  const fs = [100, 300, 1000, 3000, 10000];
  kernelResponse(h, fs, SR).forEach((m, i) => close(linToDb(m), interpLog(MATCH_FREQS, c, fs[i]), 0.25, `fir @${fs[i]}`));
});

test('match EQ: averaged spectrum of audio recovers a filter applied to it', () => {
  const n = SR * 2;
  const x = noise(n, 7, 0.3);
  // one-pole low-pass: |H|² = 1 / (1 + (f/fc)²), fc ≈ 1 kHz
  const a = Math.exp(-2 * Math.PI * 1000 / SR);
  const y = new Float32Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) { s = (1 - a) * x[i] + a * s; y[i] = s; }
  const sx = averageSpectrum([x], SR), sy = averageSpectrum([y], SR);
  const diff = (f) => interpLog(MATCH_FREQS, sy, f) - interpLog(MATCH_FREQS, sx, f);
  close(diff(100) - diff(4000), linToDb(1 / Math.hypot(1, 0.1)) - linToDb(1 / Math.hypot(1, 4)), 1.2, 'relative response');
  // silence is ignored by the average
  const padded = new Float32Array(n * 2); padded.set(x, n);
  const sp = averageSpectrum([padded], SR);
  close(interpLog(MATCH_FREQS, sp, 1000), interpLog(MATCH_FREQS, sx, 1000), 0.5, 'silent frames skipped');
});

// ------------------------------------------------------------------------------------ params, latency, defs
test('params ↔ AudioParams: every encoded value has a descriptor and decodes to the core fields', () => {
  for (const [type, proc] of Object.entries(PROCS)) {
    const p = resolveEffectParams({ type, params: {} });
    const enc = proc.encode(p, SR);
    const names = new Set(proc.spec.map((s) => s[0]));
    for (const [k, v] of Object.entries(enc)) { assert.ok(names.has(k), `${type}.${k} has a descriptor`); assert.ok(Number.isFinite(v), `${type}.${k} finite`); }
    for (const n of names) assert.ok(n in enc, `${type}: ${n} encoded`);
    const dec = proc.decode(Object.fromEntries(Object.entries(enc).map(([k, v]) => [k, Math.fround(v)])), SR);
    assert.ok(dec && typeof dec === 'object');
  }
  const mb = PROCS.multiband.decode(PROCS.multiband.encode(resolveEffectParams({ type: 'multiband', params: { bands: 4, mode: 'both', b2Solo: true, lookahead: 0.003 } }), SR), SR);
  assert.equal(mb.bands, 4); assert.equal(mb.mode, 'both'); assert.equal(mb.band[1].solo, true);
  assert.equal(lookaheadFrames(mb.lookahead, SR), 144);
  const ex = PROCS.expander.decode(PROCS.expander.encode(resolveEffectParams({ type: 'expander', params: { sourceTrackId: 't1' } }), SR), SR);
  assert.equal(ex.keyed, true);
  const dq = PROCS.dyneq.decode(PROCS.dyneq.encode(resolveEffectParams({ type: 'dyneq', params: { b3Type: 'highshelf', b3Mode: 'below' } }), SR), SR);
  assert.equal(dq.band[2].type, 'highshelf'); assert.equal(dq.band[2].mode, 'below');
});

test('latency rules: look-ahead and linear-phase kernels are reported through latency.js', () => {
  assert.equal(effectLatencyFrames({ type: 'lineq', params: {} }, 48000), 2047);
  assert.equal(effectLatencyFrames({ type: 'lineq', params: { quality: 'max' } }, 48000), 8191);
  assert.equal(effectLatencyFrames({ type: 'matcheq', params: { quality: 'low' } }, 44100), 1023);
  assert.equal(effectLatencyFrames({ type: 'expander', params: {} }, 48000), 96);
  assert.equal(effectLatencyFrames({ type: 'expander', params: { lookahead: 0 } }, 48000), 0);
  assert.equal(effectLatencyFrames({ type: 'multiband', params: {} }, 48000), 0);
  assert.equal(effectLatencyFrames({ type: 'multiband', params: { lookahead: 0.005 } }, 44100), 220);
  for (const t of ['transient', 'deesser', 'dyneq']) assert.equal(effectLatencyFrames({ type: t, params: {} }, 48000), 0);
  assert.equal(dynamicsLatencyFrames({ type: 'reverb' }), null);
  assert.equal(effectLatencyFrames({ type: 'reverb', params: {} }), 0);
  assert.equal(effectLatencyFrames({ type: 'lineq', latency: 10 }), 10, 'manual override still wins');
});

test('defs: categories, presets resolve without clamping, keyed types', () => {
  const want = { multiband: 'Dynamics', transient: 'Dynamics', deesser: 'Dynamics', expander: 'Dynamics', dyneq: 'EQ & Filter', lineq: 'EQ & Filter', matcheq: 'EQ & Filter' };
  for (const [type, cat] of Object.entries(want)) {
    const def = EFFECT_DEFS[type];
    assert.equal(def.category, cat, type);
    const n = Object.keys(def.presets).length;
    assert.ok(n >= 10 && n <= 20, `${type}: ${n} presets`);
    const keys = new Set(def.params.map((p) => p.key));
    for (const [name, pr] of Object.entries(def.presets)) {
      const r = resolveEffectParams({ type, params: pr });
      for (const [k, v] of Object.entries(pr)) { assert.ok(keys.has(k), `${type}/${name}: ${k}`); assert.equal(r[k], v, `${type}/${name}: ${k} in range`); }
    }
  }
  assert.equal(getEffectDefaults('multiband').wetMix, 1);
  assert.ok(!EFFECT_DEFS.multiband.params.some((p) => p.key === 'mix'), 'multiband mixes internally (phase-matched dry)');
  assert.ok(KEYED_FX.has('expander') && KEYED_FX.has('matcheq'));
});

// ------------------------------------------------------------------------------------ worklet + builders
test('worklet wrapper (stubbed scope): registers every processor and processes with AudioParams', async () => {
  const procs = {};
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null, posted: [], postMessage(m) { this.posted.push(m); } }; } };
  globalThis.registerProcessor = (name, cls) => { procs[name] = cls; };
  globalThis.sampleRate = SR;
  try {
    await import(`../src/audio/fx/dynamics-worklet.js?t=${Date.now()}`);
    for (const p of Object.values(PROCS)) assert.ok(procs[p.name], p.name);
    const Cls = procs[PROCS.deesser.name];
    assert.ok(Cls.parameterDescriptors.every((d) => d.automationRate === 'k-rate'));
    const node = new Cls({ processorOptions: { meter: true } });
    const enc = PROCS.deesser.encode(resolveEffectParams({ type: 'deesser', params: { freq: 5000, threshold: -30, range: 10 } }), SR);
    const params = Object.fromEntries(Cls.parameterDescriptors.map((d) => [d.name, new Float32Array([enc[d.name]])]));
    const x = sine(7500, SR, 0.4);
    let outE = 0, inE = 0;
    for (let i = 0; i < SR; i += 128) {
      const blk = x.subarray(i, i + 128);
      const out = [new Float32Array(128), new Float32Array(128)];
      assert.equal(node.process([[blk]], [out], params), true);
      if (i > SR / 2) { for (let j = 0; j < 128; j++) { outE += out[0][j] ** 2; inE += blk[j] ** 2; } }
    }
    const w4 = (Math.tan(Math.PI * 7500 / SR) / Math.tan(Math.PI * 5000 / SR)) ** 4, g = Math.pow(10, -10 / 20);
    close(10 * Math.log10(outE / inE), linToDb((1 + g * w4) / (1 + w4)), 0.3, 'processed through the core');
    assert.ok(node.port.posted.some((m) => m.type === 'meter' && m.gr < -9), 'meters posted');
    // no input connected → silence, still alive; dispose ends it
    const out = [new Float32Array(128), new Float32Array(128)];
    assert.equal(node.process([[]], [out], params), true);
    node.port.onmessage({ data: 'dispose' });
    assert.equal(node.process([[]], [out], params), false);
  } finally {
    delete globalThis.AudioWorkletProcessor; delete globalThis.registerProcessor; delete globalThis.sampleRate;
  }
});

class FxMockContext extends MockContext {
  createConvolver() { const n = this._node('convolver'); n.buffer = null; n.normalize = true; return n; }
  createBiquadFilter() { const n = this._node('biquad'); n.frequency = { value: 0 }; return n; }
  _node(kind) { const n = this.createGain(); n.kind = kind; return n; }
}

test('builders on a mock context: every type builds, passes audio until the worklet loads, reports latency', async () => {
  const { createEffect } = await import('../src/audio/effects.js');
  const ctx = new FxMockContext({ sampleRate: 48000 });
  for (const type of ['multiband', 'transient', 'deesser', 'expander', 'dyneq', 'lineq', 'matcheq']) {
    const fx = createEffect(ctx, { id: 'f1', type, enabled: true, params: {} });
    assert.ok(fx.input && fx.output, type);
    assert.equal(Math.round(fx.latency * 48000), effectLatencyFrames({ type, params: {} }, 48000), `${type} latency`);
    if (['multiband', 'deesser', 'expander', 'dyneq'].includes(type)) assert.equal(typeof fx.getReduction, 'function', `${type} GR`);
    if (fx.ready) { assert.equal(await fx.ready, false, `${type}: no AudioWorklet in the mock`); assert.match(fx.error, /AudioWorklet/); }
    assert.ok(fx.probe, `${type} probe`);
    fx.update({ id: 'f1', type, enabled: true, params: { output: -3 } });
    fx.dispose();
  }
  // keyed types expose a key input
  assert.ok(createEffect(ctx, { type: 'expander', params: {} }).keyInput);
  assert.ok(createEffect(ctx, { type: 'matcheq', params: {} }).keyInput);
  // linear-phase EQ: the convolver gets an odd, symmetric kernel of the chosen quality
  const le = createEffect(ctx, { type: 'lineq', params: { quality: 'low', b3On: true, b3Gain: 6 } });
  const conv = (function find(n, seen = new Set()) { if (seen.has(n)) return null; seen.add(n); if (n.kind === 'convolver') return n; for (const o of n.outs) { const r = find(o, seen); if (r) return r; } return null; })(le.input);
  assert.ok(conv && conv.buffer && conv.normalize === false);
  assert.equal(conv.buffer.length, firTaps('low', 48000));
  // match EQ with stored spectra exposes its correction curve
  const ref = Array.from(MATCH_FREQS, (f) => -20 + 2 * Math.log2(f / 1000)), cur = Array.from(MATCH_FREQS, () => -20);
  const me = createEffect(ctx, { type: 'matcheq', params: { refSpectrum: ref, curSpectrum: cur, amount: 1, smoothing: '1/1' } });
  assert.equal(me.probe.curve.length, MATCH_FREQS.length);
  assert.ok(me.probe.curve.at(-30) > 2);
});
