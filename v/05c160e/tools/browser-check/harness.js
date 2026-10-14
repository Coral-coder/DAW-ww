// Page-side helpers for the browser checks (served with the repo; imported by page.evaluate code).
import { Store } from '/src/core/store.js';
import { createProject, createTrack, createClip } from '/src/core/model.js';
import { AudioEngine } from '/src/audio/engine.js';
import { encodeWav } from '/src/io/wav.js';
import { arrayBufferToBase64 } from '/src/io/samples.js';

export { Store, createProject, createTrack, createClip, AudioEngine };

/** Project sample from Float32Array channels (16-bit WAV, base64 — like an imported file). */
export function wavSample(id, channels, sampleRate, name = id + '.wav') {
  const bytes = encodeWav(channels, { sampleRate, bitDepth: 16 });
  const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
  return { id, name, mime: 'audio/wav', data: arrayBufferToBase64(buf), duration: channels[0].length / sampleRate };
}

/** Engine on a fresh store holding `project`. Resolves once the AudioContext exists. */
export async function makeEngine(project) {
  const store = new Store(project);
  const engine = new AudioEngine(store);
  await engine.init();
  return { store, engine };
}

const recLoaded = new WeakMap();
/**
 * Sample-accurate capture of `node`'s output (first channel) from now on: { stop() -> {data: Float32Array,
 * startTime (ctx time of data[0])} }. Uses a tiny AudioWorklet recorder (needs the worklet fix, browser.mjs).
 */
export async function captureOutput(ctx, node, { channel = 0 } = {}) {
  if (!recLoaded.has(ctx)) {
    const src = `registerProcessor('bc-rec', class extends AudioWorkletProcessor {
      constructor() { super(); this.on = true; this.port.onmessage = () => { this.on = false; this.port.postMessage({ end: true }); }; }
      process(i) { if (!this.on) return false; const c = i[0] && i[0][${channel}]; this.port.postMessage({ f: currentFrame, d: c ? c.slice() : new Float32Array(128) }); return true; }
    });`;
    recLoaded.set(ctx, ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))));
  }
  await recLoaded.get(ctx);
  const rec = new AudioWorkletNode(ctx, 'bc-rec', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
  const blocks = [];
  let done;
  const ended = new Promise((r) => { done = r; });
  rec.port.onmessage = (e) => { if (e.data.end) done(); else blocks.push(e.data); };
  node.connect(rec);
  const sink = ctx.createGain(); sink.gain.value = 0; rec.connect(sink); sink.connect(ctx.destination); // keep it pulled
  return {
    async stop() {
      rec.port.postMessage('stop');
      await ended;
      try { node.disconnect(rec); } catch { /* */ }
      rec.disconnect(); sink.disconnect();
      if (!blocks.length) return { data: new Float32Array(0), startTime: ctx.currentTime };
      const f0 = blocks[0].f, n = blocks[blocks.length - 1].f + 128 - f0;
      const data = new Float32Array(n);
      for (const b of blocks) data.set(b.d, b.f - f0);
      return { data, startTime: f0 / ctx.sampleRate };
    },
  };
}

/** Onset times (s, relative to data[0]): rising crossings of a 64-sample RMS envelope over 12 % of its max. */
export function onsets(x, sr, { thresh = 0.12, gap = 0.05 } = {}) {
  const hop = 64, out = [], env = [];
  let prev = 0, max = 0, last = -1;
  for (let i = 0; i + hop <= x.length; i += hop) { let s = 0; for (let j = 0; j < hop; j++) s += x[i + j] ** 2; env.push(Math.sqrt(s / hop)); max = Math.max(max, env[env.length - 1]); }
  env.forEach((e, k) => { const t = (k * hop) / sr; if (e > max * thresh && prev <= max * thresh && t - last > gap) { out.push(t); last = t; } prev = e; });
  return out;
}

/** The drum loop of tests/warp.test.js: decaying hits on every 8th note at `bpm`. */
export function drumLoop(bpm, beats, sr) {
  const spb = 60 / bpm, len = Math.round(beats * spb * sr);
  const x = new Float32Array(len);
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
  for (let k = 0; k < beats * 2; k++) {
    const i0 = Math.round(((k * spb) / 2) * sr), acc = k % 2 ? 0.45 : 1;
    for (let j = 0; j < 0.08 * sr && i0 + j < len; j++) x[i0 + j] += acc * Math.exp(-j / (0.012 * sr)) * (0.6 * Math.sin((2 * Math.PI * (k % 4 ? 900 : 70) * j) / sr) + 0.4 * rnd());
  }
  return x;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
