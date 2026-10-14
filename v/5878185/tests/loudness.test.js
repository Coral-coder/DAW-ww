// Loudness metering (ITU-R BS.1770-4 / EBU R128 / EBU Tech 3341 + 3342 style synthetic signals) and normalisation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureLoudness, LoudnessMeter, subblockEnergies, kWeighting, normalizeLoudness, correlation, LOUDNESS_PRESETS } from '../src/audio/dsp/loudness.js';
import { truePeakDb } from '../src/audio/dsp/truepeak.js';

const SR = 48000;
/** Stereo sine segments: [[dBFS (peak), seconds], …] at `freq`. */
function tone(segments, { freq = 1000, sr = SR, phaseR = 0 } = {}) {
  const n = Math.round(segments.reduce((a, [, s]) => a + s * sr, 0));
  const l = new Float32Array(n), r = new Float32Array(n);
  let i = 0;
  for (const [db, sec] of segments) {
    const a = db == null ? 0 : Math.pow(10, db / 20);
    const m = Math.round(sec * sr);
    for (let k = 0; k < m; k++, i++) {
      const ph = (2 * Math.PI * freq * i) / sr;
      l[i] = a * Math.sin(ph);
      r[i] = a * Math.sin(ph + phaseR);
    }
  }
  return [l, r];
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a.toFixed(3)} vs ${b} (±${tol})`);

test('K-weighting: 48 kHz coefficients match BS.1770-4 table', () => {
  const [s, h] = kWeighting(48000);
  near(s.b0, 1.53512485958697, 1e-9, 'shelf b0');
  near(s.b1, -2.69169618940638, 1e-9, 'shelf b1');
  near(s.b2, 1.19839281085285, 1e-9, 'shelf b2');
  near(s.a1, -1.69065929318241, 1e-9, 'shelf a1');
  near(s.a2, 0.73248077421585, 1e-9, 'shelf a2');
  near(h.a1, -1.99004745483398, 1e-9, 'hp a1');
  near(h.a2, 0.99007225036621, 1e-9, 'hp a2');
});

test('EBU 3341 #1/#2: 1 kHz stereo sine at −23 / −33 dBFS reads −23 / −33 LUFS (±0.1)', () => {
  for (const db of [-23, -33]) {
    const m = measureLoudness(tone([[db, 20]]), SR);
    near(m.integrated, db, 0.1, 'integrated');
    near(m.momentaryMax, db, 0.1, 'momentary');
    near(m.shortTermMax, db, 0.1, 'short-term');
  }
  // other sample rates
  for (const sr of [44100, 96000]) near(measureLoudness(tone([[-23, 10]], { sr }), sr).integrated, -23, 0.1, `${sr} Hz`);
});

test('EBU 3341 #3/#4/#5: gating (−36/−23/−36, −72/−36/−23/−36/−72, −26/−20/−26) = −23 LUFS (±0.1)', () => {
  near(measureLoudness(tone([[-36, 10], [-23, 60], [-36, 10]]), SR).integrated, -23, 0.1, '#3');
  near(measureLoudness(tone([[-72, 10], [-36, 10], [-23, 60], [-36, 10], [-72, 10]]), SR).integrated, -23, 0.1, '#4');
  near(measureLoudness(tone([[-26, 20], [-20, 20.1], [-26, 20]]), SR).integrated, -23, 0.1, '#5');
});

test('EBU 3342: loudness range of stepped tones (10 LU and 5 LU)', () => {
  near(measureLoudness(tone([[-20, 20], [-30, 20]]), SR).lra, 10, 0.1, 'LRA #1');
  near(measureLoudness(tone([[-20, 20], [-15, 20]]), SR).lra, 5, 0.1, 'LRA #2');
  near(measureLoudness(tone([[-23, 30]]), SR).lra, 0, 0.1, 'steady tone');
});

test('streaming LoudnessMeter equals the offline measurement', () => {
  const ch = tone([[-36, 10], [-23, 30], [-36, 10]]);
  const sub = subblockEnergies(ch, SR);
  const m = new LoudnessMeter();
  for (const e of sub) m.push(e);
  near(m.integrated, measureLoudness(ch, SR).integrated, 0.01, 'integrated');
  near(m.momentary, -36, 0.1, 'momentary at the end');
  near(m.shortTerm, -36, 0.1, 'short-term at the end');
  near(m.maxMomentary, -23, 0.1, 'max momentary');
  m.reset();
  assert.equal(m.integrated, -Infinity);
});

test('true peak and correlation', () => {
  // a sine at fs/4 sampled 45° off its peaks: sample peak −3 dB, true peak 0 dB
  const n = 4800, l = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = Math.sin((Math.PI / 2) * i + Math.PI / 4);
  near(truePeakDb([l]), 0, 0.2, 'true peak');
  const [a, b] = tone([[-10, 1]]);
  near(correlation(a, b), 1, 1e-6, 'mono');
  near(correlation(a, a.map((x) => -x)), -1, 1e-6, 'anti-phase');
  const [, q] = tone([[-10, 1]], { phaseR: Math.PI / 2 });
  near(correlation(a, q), 0, 0.01, 'quadrature');
});

test('normalisation to delivery targets with a true-peak ceiling', () => {
  const sig = tone([[-30, 8]]);
  for (const target of [-14, -16, -23]) {
    const r = normalizeLoudness(sig, SR, { mode: 'lufs', target, ceiling: -1 });
    near(r.after.integrated, target, 0.1, `LUFS ${target}`);
    assert.ok(r.after.truePeakDb <= -1 + 0.05, `TP ${r.after.truePeakDb}`);
  }
  // a loud target the ceiling fights with: still on target, never over the ceiling
  const r = normalizeLoudness(tone([[-30, 8]]), SR, { mode: 'lufs', target: -8, ceiling: -1 });
  assert.ok(r.after.truePeakDb <= -0.95, `TP ${r.after.truePeakDb}`);
  near(r.after.integrated, -8, 0.5, 'loud target');
  const p = normalizeLoudness(sig, SR, { mode: 'peak', target: -1 });
  near(p.after.truePeakDb, -1, 0.05, 'peak');
  assert.ok(LOUDNESS_PRESETS.find((x) => x.id === 'ebu').lufs === -23);
});
