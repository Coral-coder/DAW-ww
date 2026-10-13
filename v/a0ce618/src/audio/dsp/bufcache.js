// Global cache for procedurally generated sample tables (PADsynth pads, Karplus-Strong plucks,
// additive pianos). AudioBuffers are context independent, so a table computed for the live
// AudioContext is reused by OfflineAudioContext renders (and vice versa). LRU by byte budget.

const MAX_BYTES = 160 * 1024 * 1024;
const store = new Map(); // key -> { buf, bytes }
let bytes = 0;

/** Make an AudioBuffer from Float32Array channel data (works without a context). */
export function makeBuffer(channels, sampleRate, ctx) {
  const length = channels[0].length;
  let buf;
  try {
    buf = new AudioBuffer({ length, sampleRate, numberOfChannels: channels.length });
  } catch {
    buf = ctx.createBuffer(channels.length, length, sampleRate);
  }
  channels.forEach((d, i) => {
    if (buf.copyToChannel) buf.copyToChannel(d, i);
    else buf.getChannelData(i).set(d);
  });
  return buf;
}

/** Cached generator: get(key) or build() -> AudioBuffer. */
export function cachedBuffer(key, build) {
  const hit = store.get(key);
  if (hit) { store.delete(key); store.set(key, hit); return hit.buf; }
  const buf = build();
  if (!buf) return null;
  const b = buf.length * buf.numberOfChannels * 4;
  store.set(key, { buf, bytes: b });
  bytes += b;
  while (bytes > MAX_BYTES && store.size > 1) {
    const [k, v] = store.entries().next().value;
    store.delete(k);
    bytes -= v.bytes;
  }
  return buf;
}
export function hasBuffer(key) { return store.has(key); }

// Background pre-generation for realtime contexts (idle slices, never during offline renders).
const queue = [];
let pumping = false;
function pump() {
  pumping = true;
  const t0 = Date.now();
  while (queue.length && Date.now() - t0 < 12) {
    const job = queue.shift();
    try { job(); } catch { /* ignore */ }
  }
  if (queue.length) setTimeout(pump, 30);
  else pumping = false;
}
/** Queue a cheap-to-skip warmup job (no-op in Node). */
export function warmLater(job) {
  if (typeof setTimeout === 'undefined') return;
  if (queue.length > 400) return;
  queue.push(job);
  if (!pumping) setTimeout(pump, 50);
}
