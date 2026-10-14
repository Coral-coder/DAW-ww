// Recording capture taps: worklet chunk frames (Chromium's stale first-quantum currentFrame) and the
// ScriptProcessor fallback's pilot-channel frame recovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pilotFrame } from '../src/record/inputs.js';

test('pilotFrame: absolute frame from the pilot ramp, any wrap count, null before the pilot starts', () => {
  const L = 65536, DIV = 131072, f0 = 48123;
  const v = (frame) => ((((frame - f0) % L) + L) % L + 1) / DIV;
  for (const frame of [f0, f0 + 1, f0 + 1000, f0 + L - 1, f0 + L, f0 + 5 * L + 777, f0 + 40 * L + 12345]) {
    for (const err of [-30000, -2304, 0, 1500, 30000]) assert.equal(pilotFrame(Math.fround(v(frame)), f0, frame + err), frame);
  }
  assert.equal(pilotFrame(0, f0, 1e6), null);
});

test('capture worklet: a chunk that starts on the first (stale-currentFrame) quantum gets the true frame', async () => {
  let Proc = null;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { posted: [], postMessage(m) { this.posted.push(m); } }; } };
  globalThis.registerProcessor = (name, cls) => { if (name === 'daw3-capture') Proc = cls; };
  globalThis.sampleRate = 48000;
  try {
    await import(`../src/record/capture-processor.js?t=${Date.now()}`);
    const p = new Proc({ processorOptions: { channels: 1 } });
    p.port.onmessage({ data: { cmd: 'start' } });
    const T0 = 1024; // true frame of the first quantum; Chromium reports 0 there
    for (let q = 0; q < 80; q++) {
      globalThis.currentFrame = q === 0 ? 0 : T0 + q * 128;
      const blk = new Float32Array(128); blk[0] = q; // tag each quantum
      p.process([[blk]], [[new Float32Array(128)]]);
    }
    globalThis.currentFrame = T0 + 80 * 128;
    p.port.onmessage({ data: { cmd: 'stop' } });
    const chunks = p.port.posted.filter((m) => m.type === 'chunk');
    assert.equal(chunks[0].frame, T0);
    for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i].frame, chunks[i - 1].frame + chunks[i - 1].data[0].length, 'contiguous');
    // quantum q sits at frame T0 + 128 q
    const c1 = chunks[1];
    const q = c1.data[0][0];
    assert.equal(c1.frame, T0 + q * 128);
  } finally {
    delete globalThis.AudioWorkletProcessor; delete globalThis.registerProcessor; delete globalThis.sampleRate; delete globalThis.currentFrame;
  }
});
