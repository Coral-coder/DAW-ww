// EQ curve math (Web Audio biquad formulas) and the EQ builders' live-spectrum probe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { biquadCoeffs, biquadMagDb, eqBands, eqResponse, bandResponse, logFreqs, freqToX, xToFreq, dbToY, yToDb } from '../src/audio/dsp/eq-curve.js';
import { resolveEffectParams } from '../src/audio/effect-defs.js';
import { createEffect } from '../src/audio/effects.js';
import { MockContext } from './lib/mock-audio.js';

const SR = 48000;
const near = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

/** Gain (dB) of the difference equation measured with a steady sine — checks the closed-form response. */
function measured(c, f) {
  const n = Math.round(SR * 0.5);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, e = 0, m = 0;
  for (let i = 0; i < n; i++) {
    const x = Math.sin((2 * Math.PI * f * i) / SR);
    const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    if (i >= n / 2) { e += y * y; m++; } // RMS over whole periods (f divides 24 kHz for the test frequencies)
  }
  return 10 * Math.log10((2 * e) / m);
}

test('biquad response: closed form matches the filtered signal for every type', () => {
  for (const [type, f0, q, g] of [['peaking', 1000, 1.4, 6], ['peaking', 300, 0.5, -9], ['lowshelf', 200, 0, 5], ['highshelf', 5000, 0, -4], ['lowpass', 2000, 3, 0], ['highpass', 120, 0.7, 0], ['bandpass', 800, 2, 0], ['notch', 1500, 4, 0]]) {
    const c = biquadCoeffs(type, f0, q, g, SR);
    for (const f of [60, 500, 1000, 3000, 9000]) near(biquadMagDb(c, f, SR), measured(c, f), 0.05, `${type} @ ${f}`);
  }
});

test('biquad response: Web Audio conventions (bell gain at f0, shelves, low-pass Q in dB, notch)', () => {
  near(biquadMagDb(biquadCoeffs('peaking', 1000, 2, 9, SR), 1000, SR), 9, 1e-6, 'bell');
  near(biquadMagDb(biquadCoeffs('peaking', 1000, 2, 9, SR), 50, SR), 0, 0.1, 'bell skirt');
  const ls = biquadCoeffs('lowshelf', 300, 7, 6, SR); // Q ignored by shelves
  near(biquadMagDb(ls, 20, SR), 6, 0.05, 'low shelf DC');
  near(biquadMagDb(ls, 300, SR), 3, 0.05, 'low shelf midpoint');
  near(biquadMagDb(ls, 15000, SR), 0, 0.05, 'low shelf top');
  near(biquadMagDb(biquadCoeffs('highshelf', 3000, 1, -6, SR), 20000, SR), -6, 0.1, 'high shelf');
  near(biquadMagDb(biquadCoeffs('lowpass', 1000, 0, 0, SR), 1000, SR), 0, 1e-6, 'LP: Q 0 dB = 0 dB at the cutoff');
  near(biquadMagDb(biquadCoeffs('lowpass', 1000, 6, 0, SR), 1000, SR), 6, 1e-6, 'LP resonance in dB');
  assert.ok(biquadMagDb(biquadCoeffs('lowpass', 1000, 0, 0, SR), 8000, SR) < -30);
  assert.ok(biquadMagDb(biquadCoeffs('highpass', 1000, 0, 0, SR), 125, SR) < -30);
  assert.ok(biquadMagDb(biquadCoeffs('notch', 1000, 1, 0, SR), 1000, SR) < -60);
  near(biquadMagDb(biquadCoeffs('allpass', 1000, 1, 0, SR), 3000, SR), 0, 1e-6, 'allpass');
});

test('eq8 defaults are flat; bands sum; disabled bands do not count', () => {
  const p = resolveEffectParams({ type: 'eq8', params: {} });
  const bands = eqBands('eq8', p);
  assert.equal(bands.length, 8);
  assert.equal(bands[0].type, 'highpass');
  assert.ok(!bands[0].on && bands[1].on);
  assert.ok(!bands[0].hasGain && bands[0].hasQ && bands[1].hasGain && !bands[1].hasQ && bands[2].hasQ);
  const fr = logFreqs(64);
  for (const v of eqResponse(bands, fr, SR, p.output)) near(v, 0, 1e-9, 'flat');
  const p2 = { ...p, b3Gain: 6, b5Gain: -3, b8On: true, b8Freq: 12000 };
  const b2 = eqBands('eq8', p2);
  const sum = eqResponse(b2, fr, SR, 2);
  for (let i = 0; i < fr.length; i += 9) {
    const expect = 2 + bandResponse(b2[2], [fr[i]], SR)[0] + bandResponse(b2[4], [fr[i]], SR)[0] + bandResponse(b2[7], [fr[i]], SR)[0];
    near(sum[i], expect, 1e-9, `sum @ ${fr[i]}`);
  }
  near(eqResponse(b2, [300], SR, 0)[0], 6, 0.3, 'band 3 bell at 300 Hz');
});

test('eq3 bands follow its params; the display mapping round-trips', () => {
  const p = resolveEffectParams({ type: 'eq3', params: { low: 4, mid: -6, high: 3, midFreq: 800, midQ: 1.2 } });
  const b = eqBands('eq3', p);
  assert.deepEqual(b.map((x) => x.type), ['lowshelf', 'peaking', 'highshelf']);
  assert.equal(b[1].keys.q, 'midQ');
  assert.equal(b[0].keys.q, undefined);
  near(eqResponse(b, [800], SR)[0], -6, 0.6, 'mid at 800');
  near(eqResponse(b, [25], SR)[0], 4, 0.3, 'low');
  for (const f of [20, 63, 1000, 15000]) near(xToFreq(freqToX(f, 500), 500), f, 1e-6, 'x');
  for (const d of [-24, -6, 0, 12]) near(yToDb(dbToY(d, 150), 150), d, 1e-9, 'y');
  assert.equal(dbToY(40, 150), 0); // clamped to the display range
});

test('eq builders expose a lazily created post-EQ analyser probe', () => {
  const ctx = new MockContext({ sampleRate: SR });
  const param = (v) => ({ value: v, setTargetAtTime(x) { this.value = x; }, cancelScheduledValues() {}, setValueAtTime(x) { this.value = x; } });
  ctx.createBiquadFilter = () => { const n = ctx.createGain(); n.type = 'peaking'; n.frequency = param(350); n.Q = param(1); n.gain = param(0); return n; };
  for (const type of ['eq8', 'eq3']) {
    const fx = createEffect(ctx, { id: 'e1', type, params: {} });
    const pr = fx.probe;
    assert.ok(pr?.analyser, type);
    assert.equal(pr.sampleRate, SR);
    assert.equal(fx.probe.analyser, pr.analyser); // one analyser per effect
    assert.equal(pr.analyser.fftSize, 4096);
    fx.dispose?.();
  }
});
