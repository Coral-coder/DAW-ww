// Warping streamed (long) samples: WarpRenderer on a sliding SourceWindow fed chunk by chunk must render exactly what
// it renders from the whole sample in memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TempoMap } from '../src/time/tempo-map.js';
import { clipCurve, normalizeMarkers } from '../src/audio/warp/markers.js';
import { WarpRenderer } from '../src/audio/warp/core.js';
import { SourceWindow } from '../src/audio/warp/window.js';
import { beatSlices } from '../src/audio/warp/player.js';

const SR = 44100;

function source(sec) {
  const n = Math.round(sec * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  let seed = 3; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  for (let i = 0; i < n; i++) { const t = i / SR; L[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) + (i % 11025 < 300 ? 0.5 * rnd() : 0); R[i] = 0.3 * Math.sin(2 * Math.PI * 331 * t); }
  return [L, R];
}

/** Render like worklet.js does for a streamed voice: 128-frame blocks, ensure() before each, chunks arrive 1 block late. */
function renderWindowed(opts, chs, chunkFrames) {
  const queue = [];
  const w = new SourceWindow({ channels: chs.length, frames: chs[0].length, chunkFrames, slots: 8, request: (k) => queue.push(k) });
  const r = new WarpRenderer({ ...opts, channels: w.channels, window: { mono: w.mono, frames: w.frames } });
  const out = [new Float32Array(r.total), new Float32Array(r.total)];
  let off = 0, misses = 0;
  while (!r.done) {
    const n = Math.min(128, r.total - off);
    // deliver what was requested so far, then (re)check: a miss would render silence in the worklet
    let ok = w.ensure(...r.neededRange(n));
    for (const k of queue.splice(0)) w.onChunk(k, chs.map((c) => c.slice(k * chunkFrames, (k + 1) * chunkFrames)));
    ok = w.ensure(...r.neededRange(n));
    if (!ok) misses++;
    r.base = w.base;
    r.process(out.map((o) => o.subarray(off, off + n)), n);
    off += n;
  }
  return { out, misses, moved: w.base };
}

for (const mode of ['beats', 'tones', 'complex', 'repitch']) {
  test(`windowed (streamed) source renders identically: ${mode}`, () => {
    const chs = source(30);
    const clip = { type: 'audio', start: 0, length: 60, offset: 0, sampleId: 's', warp: { mode, markers: normalizeMarkers([{ beat: 0, sec: 0 }, { beat: 60, sec: 30 }]), bpm: 120 } };
    const map = new TempoMap({ bpm: 120, points: [{ beat: 0, bpm: 120, curve: 'linear' }, { beat: 30, bpm: 90 }] });
    const b0 = 34; // start well into the sample (seek)
    const curve = clipCurve(clip, map, b0, 52).points;
    const opts = { mode, curve, srcRate: SR, outRate: 48000, slices: mode === 'beats' ? beatSlices(clip, null, 30) : [], transpose: mode === 'tones' ? 2 : 0, formants: mode === 'tones' };
    const ref = new WarpRenderer({ ...opts, channels: chs }).renderAll();
    const { out, misses, moved } = renderWindowed(opts, chs, 16384);
    assert.equal(misses, 0, 'no underruns');
    assert.ok(moved > 0, 'window moved along the sample');
    for (let c = 0; c < 2; c++) {
      let err = 0; for (let i = 0; i < ref[c].length; i++) err = Math.max(err, Math.abs(out[c][i] - ref[c][i]));
      assert.ok(err < 1e-6, `${mode} ch${c} max diff ${err}`);
    }
  });
}

test('SourceWindow: slides forward / back, keeps loaded chunks, reports misses until data arrives', () => {
  const req = [];
  const w = new SourceWindow({ channels: 1, frames: 100 * 10, chunkFrames: 10, slots: 4, ahead: 1, request: (k) => req.push(k) });
  assert.equal(w.ensure(55, 62), false);
  assert.equal(w.base, 40); // one chunk of history
  assert.deepEqual(req, [5, 6, 7]);
  for (const k of req) w.onChunk(k, [Float32Array.from({ length: 10 }, (_, i) => k * 10 + i)]);
  assert.equal(w.ensure(55, 62), true);
  assert.equal(w.channels[0][61 - w.base], 61);
  // still inside: no move; forward past the end: keeps chunk 7's data across the move
  w.ensure(70, 74);
  assert.equal(w.base, 40);
  w.ensure(80, 84);
  assert.equal(w.base, 70);
  assert.equal(w.channels[0][75 - w.base], 75);
  // backward seek far away: refills
  assert.equal(w.ensure(5, 8), false);
  assert.equal(w.base, 0);
  // beatSlices covers long clips (more than 4096 16ths)
  const sl = beatSlices({ warp: { mode: 'beats', markers: [{ beat: 0, sec: 0 }, { beat: 2, sec: 1 }] } }, null, 600);
  assert.ok(sl[sl.length - 1] > 599, `last slice ${sl[sl.length - 1]}`);
});
