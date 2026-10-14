// Long-audio streaming: WAV range decoding, the PCM chunk store, and the 'daw3-stream' worklet processor (run in
// Node with a fake AudioWorkletGlobalScope).
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, wavInfo, readWavFrames } from '../src/io/wav.js';
import { createMemoryPcmStore, writePcm } from '../src/audio/stream/pcm-store.js';
import { isLongSample, STREAM_MIN_SECONDS } from '../src/audio/stream/streamer.js';

const sine = (n, f, sr, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / sr));

test('wavInfo / readWavFrames decode any range of a 16 / 24 / float WAV', () => {
  const L = sine(10000, 441, 44100), R = sine(10000, 882, 44100, 0.25);
  for (const bitDepth of [16, 24, 32]) {
    const ab = encodeWav([L, R], { bitDepth, sampleRate: 44100 });
    const info = wavInfo(ab);
    assert.equal(info.frames, 10000);
    assert.equal(info.channels, 2);
    const part = readWavFrames(ab, info, 4000, 1000);
    const tol = bitDepth === 16 ? 1 / 30000 : 1e-6;
    for (let i = 0; i < 1000; i++) {
      assert.ok(Math.abs(part[0][i] - L[4000 + i]) < tol);
      assert.ok(Math.abs(part[1][i] - R[4000 + i]) < tol);
    }
    assert.equal(readWavFrames(ab, info, 9990, 100)[0].length, 10, 'clamped at the end');
  }
  assert.equal(wavInfo(new Uint8Array([1, 2, 3]).buffer), null);
});

test('writePcm stores chunks + a peak overview; long-sample detection', async () => {
  const sr = 8000;
  const x = sine(70000, 50, sr);
  const store = createMemoryPcmStore();
  const meta = await writePcm(store, 'k1', { frames: x.length, channels: 1, sampleRate: sr, chunkFrames: 32768, readFrames: (f, n) => [x.slice(f, f + n)] });
  assert.equal(meta.frames, 70000);
  const c2 = await store.getChunk('k1', 2);
  assert.equal(c2[0].length, 70000 - 65536);
  assert.equal(c2[0][10], x[65546]);
  assert.ok(Math.abs(Math.max(...meta.peaks.max) - 0.5) < 1e-3);
  assert.equal(meta.peaks.min.length, Math.ceil(70000 / 256));
  await store.remove('k1');
  assert.equal(await store.getChunk('k1', 0), undefined);
  assert.equal(isLongSample({ duration: STREAM_MIN_SECONDS + 1 }), true);
  assert.equal(isLongSample({ duration: 5 }), false);
  assert.equal(isLongSample({ name: 'stem.wav', mime: 'audio/wav', data: 'A'.repeat(Math.ceil(176400 * 40 / 0.75)) }), true);
});

async function loadProcessor() {
  let Proc = null;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: (m) => this.sent.push(m), onmessage: null }; this.sent = []; } };
  globalThis.registerProcessor = (name, cls) => { Proc = cls; };
  globalThis.currentFrame = 0;
  await import(`../src/audio/stream/stream-processor.js?t=${Date.now()}`);
  return Proc;
}

test('stream processor: plays the right frames at the right time, prefetches, counts late chunks, ends', async () => {
  const Proc = await loadProcessor();
  const CF = 256;
  const src = Float32Array.from({ length: 2000 }, (_, i) => i / 2000);
  const chunkOf = (k) => [src.slice(k * CF, (k + 1) * CF)];
  const p = new Proc({ processorOptions: { channels: 1, chunkFrames: CF, frames: 2000, ratio: 1, startFrame: 256, offset: 300, length: 600 } });
  const requests = [];
  let deliver = true;
  const worker = { postMessage: (m) => { requests.push(m.need); if (deliver) worker.onmessage({ data: { chunk: m.need, data: chunkOf(m.need) } }); }, onmessage: null, close() {} };
  p.port.onmessage({ data: { port: worker } });
  assert.deepEqual(requests.slice(0, 4), [1, 2, 3, 4], 'prefetches from the chunk holding the offset');
  const out = [];
  const run = () => { const o = [new Float32Array(128)]; const alive = p.process([], [o]); out.push(...o[0]); globalThis.currentFrame += 128; return alive; };
  // frames 0..255: before the voice starts -> silence
  run(); run();
  assert.ok(out.slice(0, 256).every((v) => v === 0));
  // 600 frames from data frame 300
  while (globalThis.currentFrame < 256 + 600) run();
  for (let i = 0; i < 600; i++) assert.equal(out[256 + i], src[300 + i], `frame ${i}`);
  assert.equal(p.underruns, 0);
  assert.equal(run(), false, 'ends after its length');
  assert.ok(p.sent.some((m) => m.ended));

  // late chunk -> silence + underrun, playback continues once it arrives
  globalThis.currentFrame = 0;
  const q = new Proc({ processorOptions: { channels: 1, chunkFrames: CF, frames: 2000, ratio: 1, startFrame: 0, offset: 0 } });
  deliver = false;
  const w2 = { postMessage: () => {}, onmessage: null, close() {} };
  q.port.onmessage({ data: { port: w2 } });
  const o1 = [new Float32Array(128)];
  q.process([], [o1]);
  assert.equal(q.underruns, 1);
  assert.ok(o1[0].every((v) => v === 0));
  q.port.onmessage({ data: { chunk: 0, data: chunkOf(0) } });
  globalThis.currentFrame = 128;
  const o2 = [new Float32Array(128)];
  q.process([], [o2]);
  assert.equal(o2[0][5], src[133]);
  // stop message
  q.port.onmessage({ data: { stop: 200 } });
  globalThis.currentFrame = 256;
  assert.equal(q.process([], [[new Float32Array(128)]]), false);
});

test('stream processor: resamples when the file rate differs from the context rate', async () => {
  const Proc = await loadProcessor();
  const src = Float32Array.from({ length: 1000 }, (_, i) => i);
  const p = new Proc({ processorOptions: { channels: 1, chunkFrames: 512, frames: 1000, ratio: 0.5, startFrame: 0, offset: 0 } });
  const worker = { postMessage: (m) => worker.onmessage({ data: { chunk: m.need, data: [src.slice(m.need * 512, (m.need + 1) * 512)] } }), onmessage: null, close() {} };
  p.port.onmessage({ data: { port: worker } });
  const o = [new Float32Array(128)];
  p.process([], [o]);
  assert.equal(o[0][10], 5);
  assert.equal(o[0][11], 5.5);
});
