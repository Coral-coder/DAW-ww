import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  onsetEnvelope, detectTempo, makeGrid, analyzeTrack, detectKey, camelotOf, parseCamelot, camelotCompatible, camelotRelation,
  keyShiftToward, integratedLoudness, sliceGrid, sliceTransients, loopAt, extractRegion, snapToGrid, beatTime,
  timeStretch, warp, resample, pitchShift, detectSections, chromagram, syncRate, phaseAlign, crossfade, detectTransients,
} from '../src/audio/analysis/index.js';

const SR = 44100;

function rng(seed = 1) { let s = seed; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff * 2 - 1; }; }

/** Click track with an accented (low) downbeat. */
function clickTrack(bpm, { secs = 30, offset = 0.37, sr = SR } = {}) {
  const x = new Float32Array(Math.round(secs * sr));
  const spb = 60 / bpm, n = rng(3);
  for (let k = 0; ; k++) {
    const i0 = Math.round((offset + k * spb) * sr);
    if (i0 >= x.length) break;
    const down = k % 4 === 0, acc = down ? 1 : 0.5;
    for (let j = 0; j < 0.03 * sr && i0 + j < x.length; j++) {
      x[i0 + j] += acc * Math.exp(-j / (0.005 * sr)) * (0.6 * Math.sin(2 * Math.PI * (down ? 60 : 1000) * j / sr) + 0.4 * n());
    }
  }
  return x;
}

/** Sustained chords from MIDI note lists (with a couple of harmonics + bass root). */
function chordTrack(chords, { secsPer = 1, reps = 4, sr = SR } = {}) {
  const len = Math.round(chords.length * reps * secsPer * sr);
  const x = new Float32Array(len);
  const f = (m) => 440 * Math.pow(2, (m - 69) / 12);
  for (let r = 0; r < reps; r++) {
    chords.forEach((notes, ci) => {
      const i0 = Math.round((r * chords.length + ci) * secsPer * sr), n = Math.round(secsPer * sr);
      const all = [...notes, notes[0] - 12];
      for (let j = 0; j < n; j++) {
        const env = Math.min(1, j / 400, (n - j) / 400);
        let v = 0;
        for (const m of all) { const w = 2 * Math.PI * f(m) * j / sr; v += Math.sin(w) + 0.3 * Math.sin(2 * w) + 0.1 * Math.sin(3 * w); }
        x[i0 + j] += (0.15 * env * v) / all.length;
      }
    });
  }
  return x;
}

for (const bpm of [90, 124, 140, 174]) {
  test(`tempo: click track at ${bpm} BPM within ±1 BPM`, () => {
    const r = detectTempo(onsetEnvelope(clickTrack(bpm), SR));
    // 174: half-time (87) is the classic DnB ambiguity; the off-beat check should still pick 174.
    assert.ok(Math.abs(r.bpm - bpm) <= 1, `got ${r.bpm} for ${bpm}`);
    assert.ok(r.alternatives.some((a) => Math.abs(a - bpm / 2) < 1 || Math.abs(a - bpm * 2) < 2), 'offers ×2 / ÷2 alternatives');
  });
}

test('tempo: beat phase and accented downbeat are found', () => {
  const bpm = 124, offset = 0.37;
  const r = detectTempo(onsetEnvelope(clickTrack(bpm, { offset }), SR));
  const spb = 60 / bpm;
  const d = ((r.firstBeat - offset) % spb + spb) % spb;
  assert.ok(Math.min(d, spb - d) < 0.02, `beat phase off by ${d}`);
  assert.ok(Math.abs(r.downbeat - offset) < 0.02, `downbeat ${r.downbeat}`);
  const g = makeGrid(r.bpm, r.downbeat);
  assert.ok(g.anchor >= 0 && g.anchor < spb * 4);
});

test('tempo: drum loop with 8th-note hats at 124 is not doubled', () => {
  const sr = SR, secs = 20, bpm = 124, x = new Float32Array(secs * sr), n = rng(9), spb = 60 / bpm;
  for (let k = 0; k * spb / 2 < secs; k++) {
    const i0 = Math.round((0.2 + k * spb / 2) * sr);
    for (let j = 0; j < 0.15 * sr && i0 + j < x.length; j++) {
      if (k % 2 === 0) x[i0 + j] += Math.exp(-j / (0.06 * sr)) * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-j / (0.01 * sr))) * j / sr);
      x[i0 + j] += 0.3 * Math.exp(-j / (0.008 * sr)) * n();
    }
  }
  const r = detectTempo(onsetEnvelope(x, sr));
  assert.ok(Math.abs(r.bpm - bpm) <= 1, `got ${r.bpm}`);
});

test('key: C major I–IV–V–I progression', () => {
  const k = detectKey(chordTrack([[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67]]), SR);
  assert.equal(k.name, 'C major');
  assert.equal(k.camelot, '8B');
});

test('key: A minor i–iv–V–i progression', () => {
  const k = detectKey(chordTrack([[57, 60, 64], [62, 65, 69], [64, 68, 71], [57, 60, 64]]), SR);
  assert.equal(k.name, 'A minor');
  assert.equal(k.camelot, '8A');
});

test('key: F# minor and Eb major progressions', () => {
  assert.equal(detectKey(chordTrack([[54, 57, 61], [59, 62, 66], [61, 65, 68], [54, 57, 61]]), SR).name, 'F# minor');
  assert.equal(detectKey(chordTrack([[63, 67, 70], [68, 72, 75], [70, 74, 77], [63, 67, 70]]), SR).name, 'Eb major');
});

test('camelot: codes, parsing and compatibility', () => {
  assert.equal(camelotOf({ tonic: 0, mode: 'major' }), '8B');
  assert.equal(camelotOf({ tonic: 9, mode: 'minor' }), '8A');
  assert.equal(camelotOf({ tonic: 7, mode: 'major' }), '9B');
  assert.equal(camelotOf({ tonic: 11, mode: 'major' }), '1B');
  assert.equal(camelotOf({ tonic: 5, mode: 'major' }), '7B');
  assert.equal(camelotOf({ tonic: 4, mode: 'minor' }), '9A');
  for (let t = 0; t < 12; t++) for (const mode of ['major', 'minor']) {
    const p = parseCamelot(camelotOf({ tonic: t, mode }));
    assert.deepEqual([p.tonic, p.mode], [t, mode]);
  }
  assert.ok(camelotCompatible('8A', '8A'));
  assert.ok(camelotCompatible('8A', '9A'));
  assert.ok(camelotCompatible('8A', '7A'));
  assert.ok(camelotCompatible('12B', '1B'), 'wraps around the wheel');
  assert.ok(camelotCompatible('8A', '8B'), 'relative major/minor');
  assert.ok(!camelotCompatible('8A', '9B'));
  assert.ok(!camelotCompatible('8A', '3A'));
  assert.equal(camelotRelation('8A', '10A'), 'energy');
  assert.equal(parseCamelot('13A'), null);
});

test('camelot: key shift toward a target key', () => {
  // D minor (7A) -> A minor (8A) is already compatible: no shift
  assert.equal(keyShiftToward({ tonic: 2, mode: 'minor' }, { tonic: 9, mode: 'minor' }).semitones, 0);
  // C# minor (12A) -> A minor (8A): shifting by -4 lands on A minor exactly, smaller shifts must be compatible-only
  const s = keyShiftToward({ tonic: 1, mode: 'minor' }, { tonic: 9, mode: 'minor' });
  assert.ok(Math.abs(s.semitones) <= 4 && s.relation);
  const shifted = { tonic: (1 + s.semitones + 12) % 12, mode: 'minor' };
  assert.ok(camelotCompatible(shifted, { tonic: 9, mode: 'minor' }));
});

test('loudness: full-scale 1 kHz sine ≈ −3 LUFS, −20 dB ≈ −23 LUFS, silence = −Infinity', () => {
  const x = new Float32Array(SR * 3), y = new Float32Array(SR * 3);
  for (let i = 0; i < x.length; i++) { x[i] = Math.sin(2 * Math.PI * 1000 * i / SR); y[i] = 0.1 * x[i]; }
  assert.ok(Math.abs(integratedLoudness([x], SR) + 3.01) < 0.3, String(integratedLoudness([x], SR)));
  assert.ok(Math.abs(integratedLoudness([y], SR) + 23.01) < 0.3);
  assert.equal(integratedLoudness([new Float32Array(SR)], SR), -Infinity);
});

test('slicing: grid slices align to the beat grid', () => {
  const grid = makeGrid(124, 0.37);
  const spb = 60 / 124;
  const beats = sliceGrid(grid, { start: 1.0, unit: 'beat', size: 1, end: 1.0 + 8 * spb, duration: 30 });
  assert.ok(beats.length >= 7 && beats.length <= 8);
  for (const s of beats) {
    const idx = (s.start - grid.anchor) / spb;
    assert.ok(Math.abs(idx - Math.round(idx)) < 1e-6, 'slice starts on a beat');
    assert.ok(Math.abs(s.end - s.start - spb) < 1e-9);
  }
  const bars = sliceGrid(grid, { start: grid.anchor, unit: 'bar', size: 1, duration: 30 });
  for (const s of bars) { const b = (s.start - grid.anchor) / (spb * 4); assert.ok(Math.abs(b - Math.round(b)) < 1e-6); }
  assert.equal(bars[0].start, grid.anchor);
  const phrases = sliceGrid(grid, { unit: 'phrase', phraseBars: 8, duration: 60 });
  assert.ok(phrases.every((p) => Math.abs(p.end - p.start - spb * 32) < 1e-9));
  const loop = loopAt(grid, 5.03, 4);
  assert.ok(Math.abs(loop.end - loop.start - 16 * spb) < 1e-9);
  assert.ok(Math.abs(snapToGrid(grid, loop.start) - loop.start) < 1e-9);
  assert.ok(Math.abs(beatTime(grid, 0) - grid.anchor) < 1e-12);
});

test('slicing: transient slices start on detected hits and cover the region', () => {
  const x = clickTrack(120, { secs: 6, offset: 0.25 });
  const on = onsetEnvelope(x, SR);
  const hits = detectTransients(on.env, on.fps);
  assert.ok(hits.length >= 10 && hits.length <= 13, `${hits.length} hits`);
  for (const t of hits) { const d = ((t - 0.25) % 0.5 + 0.5) % 0.5; assert.ok(Math.min(d, 0.5 - d) < 0.02, `hit at ${t}`); }
  const grid = makeGrid(120, 0.25);
  const sl = sliceTransients(hits, { start: 0.25, end: 2.25, grid });
  assert.equal(sl[0].start, 0.25);
  assert.equal(sl.at(-1).end, 2.25);
  assert.equal(sl.length, 4);
  const reg = extractRegion([x, x], SR, 0.25, 0.75);
  assert.equal(reg.length, 2);
  assert.equal(reg[0].length, Math.round(0.5 * SR));
  assert.equal(reg[0][0], 0, 'faded in');
});

test('time-stretch: output length within 1% and pitch preserved', () => {
  const sr = SR, x = new Float32Array(sr * 2);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr);
  for (const f of [0.8, 124 / 128, 1.25, 1.5]) {
    const [y] = timeStretch([x], f, { sr });
    assert.ok(Math.abs(y.length - x.length * f) / (x.length * f) < 0.01);
    // zero crossings per second ≈ 880 (pitch kept)
    let zc = 0; for (let i = 1000; i < y.length - 1000; i++) if (y[i - 1] < 0 && y[i] >= 0) zc++;
    const hz = zc / ((y.length - 2000) / sr);
    assert.ok(Math.abs(hz - 440) < 10, `stretch ${f}: ${hz} Hz`);
  }
  const w = warp([x, x], { srcBpm: 128, dstBpm: 124, keepPitch: true, sr });
  assert.equal(w.length, 2);
  assert.ok(Math.abs(w[0].length - x.length * 128 / 124) <= 1);
  const v = warp([x], { srcBpm: 120, dstBpm: 240, keepPitch: false, sr });
  assert.ok(Math.abs(v[0].length - x.length / 2) <= 1);
  assert.equal(resample([x], 2)[0].length, x.length / 2);
  const [p] = pitchShift([x], 12, { sr });
  assert.equal(p.length, x.length);
  let zc = 0; for (let i = 1000; i < p.length - 1000; i++) if (p[i - 1] < 0 && p[i] >= 0) zc++;
  assert.ok(Math.abs(zc / ((p.length - 2000) / sr) - 880) < 20, 'octave up');
});

test('sections: a change of harmony + energy after 16 bars is a boundary on the phrase grid', () => {
  const bpm = 120, barSec = 2, sr = 22050;
  const a = chordTrack([[60, 64, 67]], { secsPer: barSec * 16, reps: 1, sr });
  const b = chordTrack([[62, 66, 69]], { secsPer: barSec * 16, reps: 1, sr });
  const x = new Float32Array(a.length + b.length); x.set(a); for (let i = 0; i < b.length; i++) x[a.length + i] = b[i] * 3;
  const grid = makeGrid(bpm, 0);
  const secs = detectSections({ grid, duration: x.length / sr, chroma: chromagram(x, sr) });
  assert.equal(secs[0].bar, 0);
  assert.ok(secs.some((s) => s.bar === 16), JSON.stringify(secs.map((s) => s.bar)));
  assert.ok(secs.find((s) => s.bar === 16).energy > secs[0].energy);
});

test('analyzeTrack: JSON-safe summary of a click track', () => {
  const x = clickTrack(128, { secs: 20 });
  const r = analyzeTrack([x, x], SR);
  assert.ok(Math.abs(r.bpm - 128) <= 1);
  assert.ok(r.grid && r.camelot && r.keyName && r.peaks.length === 600);
  assert.ok(Math.abs(r.duration - 20) < 1e-6);
  assert.doesNotThrow(() => JSON.stringify(r));
});

test('dj: sync rate, phase alignment and equal-power crossfader', () => {
  assert.equal(syncRate(120, 126), 1.05);
  const lead = makeGrid(124, 0.1), fol = makeGrid(128, 0.3);
  const t = phaseAlign(lead, 10.0, fol, 7.77);
  const lf = (((10.0 - lead.anchor) / (60 / 124)) % 1 + 1) % 1, ff = (((t - fol.anchor) / (60 / 128)) % 1 + 1) % 1;
  assert.ok(Math.abs(lf - ff) < 1e-9 || Math.abs(Math.abs(lf - ff) - 1) < 1e-9);
  assert.ok(Math.abs(t - 7.77) <= 60 / 128 / 2 + 1e-9);
  const c = crossfade(0);
  assert.ok(Math.abs(c.a * c.a + c.b * c.b - 1) < 1e-9);
  assert.deepEqual(crossfade(-1), { a: 1, b: 0 });
});

test('remix: region -> warped slices -> samples + replay pattern', async () => {
  const { planSlices, renderRegion, cutRendered, channelsToSample, slicePatternNotes, projectKeyOf, padKeyForSlice } = await import('../src/audio/remix.js');
  const x = clickTrack(128, { secs: 12, offset: 0.25 });
  const analysis = analyzeTrack([x, x], SR);
  const spb = 60 / analysis.bpm;
  const region = { start: analysis.grid.anchor, end: analysis.grid.anchor + 8 * spb };
  const slices = planSlices(analysis, region, 'beat');
  assert.equal(slices.length, 8);
  assert.ok(slices.every((s, i) => Math.abs(s.beat - i) < 1e-6 && Math.abs(s.beats - 1) < 1e-6));
  assert.equal(planSlices(analysis, region, 'half').length, 16);
  assert.ok(planSlices(analysis, region, 'transient').length >= 6);
  const r = renderRegion({ channels: [x, x], sampleRate: SR }, analysis, region, { projectBpm: 120, keepPitch: true });
  assert.ok(Math.abs(r.channels[0].length / SR - (8 * 60) / 120) < 0.01, 'loop now lasts 8 beats at 120');
  const parts = cutRendered(r, slices, region.start);
  assert.equal(parts.length, 8);
  assert.ok(parts.every((p) => Math.abs(p[0].length / SR - 0.5) < 0.002));
  const smp = channelsToSample(parts[0], SR, 'slice 1');
  assert.equal(smp.mime, 'audio/wav');
  assert.ok(smp.data.length > 1000 && Math.abs(smp.duration - 0.5) < 0.002);
  const notes = slicePatternNotes(slices, { target: 'drums' });
  assert.equal(notes[0].pitch, 36);
  assert.equal(notes[1].start, 1);
  assert.equal(padKeyForSlice(0), 'kick');
  assert.equal(slicePatternNotes(slices, { target: 'sampler' })[3].pitch, 63);
  assert.deepEqual(projectKeyOf({ key: { root: 9, scale: 'minor' } }), { tonic: 9, mode: 'minor' });
  const shifted = renderRegion({ channels: [x], sampleRate: SR }, { ...analysis, key: { tonic: 1, mode: 'minor' } }, region, { projectBpm: analysis.bpm, matchKey: true, projectKey: { tonic: 9, mode: 'minor' } });
  assert.ok(shifted.semitones !== 0);
});
