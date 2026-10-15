// Runs an AudioWorkletProcessor module in Node: fakes the AudioWorkletGlobalScope (AudioWorkletProcessor with a
// message port, registerProcessor, sampleRate, currentFrame) and renders blocks of 128 frames.
export async function loadProcessor(url, name, { sampleRate = 48000 } = {}) {
  const registry = {};
  globalThis.sampleRate = sampleRate;
  globalThis.currentFrame = 0;
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      const outbox = [];
      this.port = { onmessage: null, outbox, postMessage: (m) => outbox.push(m) };
    }
  };
  globalThis.registerProcessor = (n, cls) => { registry[n] = cls; };
  await import(`${url}?h=${Math.random()}`);
  const Cls = registry[name];
  if (!Cls) throw new Error(`processor ${name} not registered`);
  const proc = new Cls({});
  const send = (data) => proc.port.onmessage?.({ data });
  /** Render `frames` samples -> [Float32Array L, Float32Array R]. */
  const render = (frames) => {
    const L = new Float32Array(frames), R = new Float32Array(frames);
    for (let i = 0; i < frames; i += 128) {
      const l = new Float32Array(128), r = new Float32Array(128);
      proc.process([], [[l, r]], {});
      L.set(l.subarray(0, Math.min(128, frames - i)), i);
      R.set(r.subarray(0, Math.min(128, frames - i)), i);
      globalThis.currentFrame += 128;
    }
    return [L, R];
  };
  return { proc, send, render, sampleRate, outbox: proc.port.outbox };
}
