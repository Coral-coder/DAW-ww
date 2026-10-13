import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yin, trackPitch, segmentNotes, quantizeNotes, snapNotesToScale, snapPitch, octaveShiftFor, centsBetween, midiToFreq, yinGeometry, toPatternNotes } from '../src/mobile/pitch.js';
import { scalePitchClasses } from '../src/theory/scales.js';

const SR = 44100;
function rng(seed = 1) { return () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }; }
/** Synth: freq(t) function, harmonic amplitudes, noise level, amplitude envelope(t). */
function synth(dur, freqAt, { harm = [1], noise = 0, amp = () => 0.5, seed = 3, sr = SR } = {}) {
  const n = Math.round(dur * sr);
  const out = new Float32Array(n);
  const r = rng(seed);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    ph += (2 * Math.PI * freqAt(t)) / sr;
    let s = 0;
    for (let k = 0; k < harm.length; k++) s += harm[k] * Math.sin((k + 1) * ph);
    out[i] = amp(t) * s + noise * (r() * 2 - 1);
  }
  return out;
}
const HUM = [1, 0.7, 0.5, 0.3, 0.2, 0.1]; // voice-like harmonic stack

test('pitch: YIN finds sines and whistles 500–3000 Hz within ±10 cents', () => {
  for (const sr of [44100, 48000]) {
    const g = yinGeometry(sr);
    for (const f of [500, 740, 1000, 1500, 2000, 2637, 3000]) {
      const buf = synth(g.frameLength / sr + 0.01, () => f, { harm: [1, 0.08], noise: 0.01, sr });
      const r = yin(buf, sr, { geometry: g });
      assert.ok(Math.abs(centsBetween(r.freq, f)) <= 10, `${f} Hz @${sr}: got ${r.freq.toFixed(2)} (${centsBetween(r.freq, f).toFixed(1)} c)`);
      assert.ok(r.conf > 0.8, `confidence ${r.conf}`);
    }
  }
});

test('pitch: hum-like tones 80–300 Hz with harmonics + noise within ±10 cents (no octave errors)', () => {
  for (const f of [80, 98, 110, 147, 196, 220, 262, 300]) {
    for (const harm of [HUM, [0.4, 1, 0.6, 0.4, 0.2]]) { // also: 2nd harmonic louder than the fundamental
      const g = yinGeometry(SR);
      const buf = synth(g.frameLength / SR + 0.01, () => f, { harm, noise: 0.05, seed: f });
      const r = yin(buf, SR, { geometry: g });
      assert.ok(Math.abs(centsBetween(r.freq, f)) <= 10, `${f} Hz: got ${r.freq.toFixed(2)} (${centsBetween(r.freq, f).toFixed(1)} c)`);
    }
  }
});

test('pitch: silence and noise are unvoiced / low confidence', () => {
  const g = yinGeometry(SR);
  assert.equal(yin(new Float32Array(g.frameLength), SR, { geometry: g }).freq, 0);
  const noise = synth(g.frameLength / SR + 0.01, () => 0, { harm: [0], noise: 0.3 });
  const frames = trackPitch(noise, SR);
  assert.equal(segmentNotes(frames).length, 0);
});

/** C4 D4 E4 G4, 0.4 s each with 40 ms glides and ±30 cent vibrato, hummed with harmonics + noise. */
function melody({ glide = 0.04, vibrato = 30, gaps = false, octaveGlitch = false } = {}) {
  const pitches = [60, 62, 64, 67];
  const noteDur = 0.4, lead = 0.15;
  const fAt = (t) => {
    const tt = t - lead;
    const i = Math.max(0, Math.min(pitches.length - 1, Math.floor(tt / noteDur)));
    let m = pitches[i];
    const into = tt - i * noteDur;
    if (i > 0 && into < glide) m = pitches[i - 1] + (pitches[i] - pitches[i - 1]) * (into / glide);
    m += (vibrato / 100) * Math.sin(2 * Math.PI * 5.5 * t);
    if (octaveGlitch && tt > 0.62 && tt < 0.66) m += 12;
    return midiToFreq(m);
  };
  const total = lead + noteDur * pitches.length + 0.15;
  const amp = (t) => {
    const tt = t - lead;
    if (tt < 0 || tt > noteDur * pitches.length) return 0;
    if (gaps) { const into = tt % noteDur; if (into > noteDur - 0.06) return 0; }
    return 0.4 * Math.min(1, tt / 0.02);
  };
  return { buf: synth(total, fAt, { harm: HUM, noise: 0.02, amp }), pitches, onsets: pitches.map((_, i) => lead + i * noteDur), noteDur };
}

test('pitch: a hummed melody with glides + vibrato segments into the right notes and onsets', () => {
  for (const variant of [{}, { gaps: true }, { glide: 0.08, vibrato: 40 }, { octaveGlitch: true }]) {
    const { buf, pitches, onsets } = melody(variant);
    const notes = segmentNotes(trackPitch(buf, SR));
    assert.deepEqual(notes.map((n) => n.pitch), pitches, JSON.stringify(variant) + ' ' + JSON.stringify(notes));
    notes.forEach((n, i) => assert.ok(Math.abs(n.start - onsets[i]) < 0.06, `${JSON.stringify(variant)} onset ${i}: ${n.start} vs ${onsets[i]}`));
  }
});

test('pitch: repeated notes on one pitch split on the re-attack', () => {
  const amp = (t) => (t < 0.1 || t > 1.3 ? 0 : (t > 0.48 && t < 0.52) || (t > 0.88 && t < 0.92) ? 0.06 : 0.4);
  const buf = synth(1.4, () => midiToFreq(57), { harm: HUM, noise: 0.01, amp });
  const notes = segmentNotes(trackPitch(buf, SR));
  assert.equal(notes.length, 3, JSON.stringify(notes));
  assert.ok(notes.every((n) => n.pitch === 57));
});

test('pitch: whistled melody (high register) segments too', () => {
  const ps = [84, 88, 91, 96];
  const fAt = (t) => midiToFreq(ps[Math.min(3, Math.floor(Math.max(0, t - 0.1) / 0.3))]);
  const amp = (t) => (t < 0.1 || t > 1.3 ? 0 : 0.3);
  const notes = segmentNotes(trackPitch(synth(1.45, fAt, { harm: [1, 0.05], noise: 0.02, amp }), SR));
  assert.deepEqual(notes.map((n) => n.pitch), ps);
});

test('pitch: quantize to 1/16, 1/8 and triplet grids; monophonic cleanup', () => {
  const bpm = 120; // 0.5 s per beat
  const notes = [{ start: 0.01, dur: 0.24, pitch: 60, midi: 60.2 }, { start: 0.26, dur: 0.2, pitch: 62 }, { start: 0.52, dur: 0.6, pitch: 64 }];
  assert.deepEqual(quantizeNotes(notes, { bpm, grid: 0.25 }).map((n) => [n.pitch, n.start, n.dur]), [[60, 0, 0.5], [62, 0.5, 0.5], [64, 1, 1.25]]);
  assert.deepEqual(quantizeNotes(notes, { bpm, grid: 0.5 }).map((n) => [n.pitch, n.start, n.dur]), [[60, 0, 0.5], [62, 0.5, 0.5], [64, 1, 1]]);
  const trip = quantizeNotes([{ start: 0.17, dur: 0.15, pitch: 60 }], { bpm, grid: 1 / 3 });
  assert.ok(Math.abs(trip[0].start - 1 / 3) < 1e-4 && Math.abs(trip[0].dur - 1 / 3) < 1e-4);
  // two notes on the same step: the longer wins; overlaps are trimmed
  const q = quantizeNotes([{ start: 0, dur: 0.05, pitch: 61 }, { start: 0.02, dur: 0.6, pitch: 60 }, { start: 0.5, dur: 0.3, pitch: 62 }], { bpm, grid: 0.25 });
  assert.deepEqual(q.map((n) => [n.pitch, n.start, n.dur]), [[60, 0, 1], [62, 1, 0.5]]);
  // startSec offset
  assert.equal(quantizeNotes([{ start: 1.0, dur: 0.5, pitch: 60 }], { bpm, grid: 0.25, startSec: 0.5 })[0].start, 1);
});

test('pitch: scale snap uses the fractional pitch; octave shift; pattern notes', () => {
  const cMaj = scalePitchClasses(0, 'major');
  assert.equal(snapPitch(61.3, cMaj), 62); // C#+30c is nearer D
  assert.equal(snapPitch(60.7, cMaj), 60);
  assert.equal(snapPitch(65.8, cMaj), 65);
  const aMin = scalePitchClasses(9, 'minor');
  assert.deepEqual(snapNotesToScale([{ pitch: 61, midi: 60.9 }, { pitch: 68 }], aMin).map((n) => n.pitch), [60, 67]);
  assert.equal(octaveShiftFor([88, 91, 96], 64), -24);
  assert.equal(octaveShiftFor([48, 50], 64), 12);
  assert.deepEqual(toPatternNotes([{ pitch: 90, start: 3.5, dur: 1, vel: 0.9 }], { shift: -24, length: 4 }), [{ pitch: 66, start: 3.5, dur: 0.5, vel: 0.9 }]);
});
