// Stream worker: decodes / caches long samples as PCM chunks in IndexedDB and serves chunks to the
// 'daw3-stream' AudioWorklet voices (stream-processor.js) over MessagePorts. Module worker (see streamer.js).
//
// main -> worker:  { id, cmd: 'lookup', key }                          -> { id, meta | null }
//                  { id, cmd: 'wav', key, bytes, chunkFrames }         -> { id, meta } (parses WAV, writes chunks)
//                  { id, cmd: 'begin', key, frames, channels, sampleRate, chunkFrames }
//                  { cmd: 'chunk', key, idx, data }                     (main-thread-decoded audio, chunk by chunk)
//                  { id, cmd: 'end', key }                              -> { id, meta }
//                  { cmd: 'serve', key, port }                          (a voice's port: answers { need: idx })
//                  { id, cmd: 'evict', keep: [keys] }                   -> { id, removed }
import { createIdbPcmStore, createPeakBuilder, writePcm } from './pcm-store.js';
import { wavInfo, readWavFrames } from '../../io/wav.js';

const store = createIdbPcmStore();
const lru = new Map(); // `${key}:${idx}` -> Float32Array[] (hot chunks shared by voices)
const LRU_MAX = 48;
const pending = new Map(); // key -> { meta, peaks, idx }

async function chunk(key, idx) {
  const k = `${key}:${idx}`;
  let d = lru.get(k);
  if (d) { lru.delete(k); lru.set(k, d); return d; }
  d = await store.getChunk(key, idx);
  if (d) { lru.set(k, d); if (lru.size > LRU_MAX) lru.delete(lru.keys().next().value); }
  return d;
}

// messages are handled one at a time, in order (chunks of a stream must be stored before its 'end')
let queue = Promise.resolve();
self.onmessage = (e) => { queue = queue.then(() => handle(e)); };

async function handle(e) {
  const m = e.data;
  const reply = (v) => self.postMessage({ id: m.id, ...v });
  try {
    if (m.cmd === 'lookup') {
      const meta = await store.getMeta(m.key);
      if (meta) { meta.usedAt = Date.now(); store.putMeta(meta).catch(() => {}); }
      reply({ meta: meta || null });
    } else if (m.cmd === 'wav') {
      const info = wavInfo(m.bytes);
      if (!info) throw new Error('not a WAV');
      const meta = await writePcm(store, m.key, {
        frames: info.frames, channels: info.channels, sampleRate: info.sampleRate, chunkFrames: m.chunkFrames,
        readFrames: (from, count) => readWavFrames(m.bytes, info, from, count),
      });
      reply({ meta });
    } else if (m.cmd === 'begin') {
      pending.set(m.key, { meta: { key: m.key, frames: m.frames, channels: m.channels, sampleRate: m.sampleRate, chunkFrames: m.chunkFrames }, peaks: createPeakBuilder(m.frames) });
      reply({ ok: true });
    } else if (m.cmd === 'chunk') {
      const p = pending.get(m.key);
      if (!p) return;
      p.peaks.add(m.data);
      await store.putChunk(m.key, m.idx, m.data);
    } else if (m.cmd === 'end') {
      const p = pending.get(m.key);
      pending.delete(m.key);
      if (!p) throw new Error('no pending stream');
      const meta = { ...p.meta, peaks: p.peaks.result(), usedAt: Date.now() };
      await store.putMeta(meta);
      reply({ meta });
    } else if (m.cmd === 'serve') {
      const port = m.port;
      port.onmessage = async (ev) => {
        const idx = ev.data?.need;
        if (idx == null) return;
        try {
          const d = await chunk(m.key, idx);
          if (d) port.postMessage({ chunk: idx, data: d });
        } catch { /* the voice plays silence for this chunk */ }
      };
    } else if (m.cmd === 'evict') {
      const keep = new Set(m.keep || []);
      const all = await store.listMeta();
      // keep what the project uses; drop the rest when unused for a week
      const old = all.filter((x) => !keep.has(x.key) && Date.now() - (x.usedAt || 0) > 7 * 864e5);
      for (const x of old) await store.remove(x.key);
      reply({ removed: old.length });
    }
  } catch (err) {
    reply({ error: String(err?.message || err) });
  }
}
