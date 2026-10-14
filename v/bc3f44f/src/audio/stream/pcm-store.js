// IndexedDB cache of decoded PCM for long-sample streaming ('daw3-pcm' db). Works in windows and workers.
//   meta:   key -> { key, frames, channels, sampleRate, chunkFrames, peaks: {bucket, min: Float32Array, max}, usedAt }
//   chunks: `${key}:${idx}` -> Float32Array[] (one per channel, chunkFrames long except the last)
// A memory-backed store (createMemoryPcmStore) has the same API for tests / browsers without IndexedDB.
const DB = 'daw3-pcm';
const VERSION = 1;

function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

export function createIdbPcmStore(idb = globalThis.indexedDB) {
  let dbp = null;
  const open = () => {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const r = idb.open(DB, VERSION);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
          if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => { dbp = null; reject(r.error); };
      });
    }
    return dbp;
  };
  const tx = async (stores, mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let out;
      Promise.resolve(fn(t)).then((v) => { out = v; }, reject);
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('aborted'));
    });
  };
  return {
    getMeta: (key) => tx(['meta'], 'readonly', (t) => req(t.objectStore('meta').get(key))),
    putMeta: (meta) => tx(['meta'], 'readwrite', (t) => { t.objectStore('meta').put(meta); }),
    getChunk: (key, idx) => tx(['chunks'], 'readonly', (t) => req(t.objectStore('chunks').get(`${key}:${idx}`))),
    putChunk: (key, idx, data) => tx(['chunks'], 'readwrite', (t) => { t.objectStore('chunks').put(data, `${key}:${idx}`); }),
    async listMeta() { return tx(['meta'], 'readonly', (t) => req(t.objectStore('meta').getAll())); },
    async remove(key) {
      const meta = await this.getMeta(key);
      const n = meta ? Math.ceil(meta.frames / meta.chunkFrames) : 0;
      await tx(['meta', 'chunks'], 'readwrite', (t) => {
        t.objectStore('meta').delete(key);
        for (let i = 0; i < n; i++) t.objectStore('chunks').delete(`${key}:${i}`);
      });
    },
  };
}

export function createMemoryPcmStore() {
  const meta = new Map();
  const chunks = new Map();
  return {
    getMeta: async (key) => meta.get(key),
    putMeta: async (m) => { meta.set(m.key, m); },
    getChunk: async (key, idx) => chunks.get(`${key}:${idx}`),
    putChunk: async (key, idx, data) => { chunks.set(`${key}:${idx}`, data); },
    listMeta: async () => [...meta.values()],
    remove: async (key) => { const m = meta.get(key); meta.delete(key); if (m) for (let i = 0; i * m.chunkFrames < m.frames; i++) chunks.delete(`${key}:${i}`); },
  };
}

/** Peak overview accumulator (mono min/max per `bucket` frames) fed chunk by chunk. */
export function createPeakBuilder(frames, bucket = 256) {
  const nb = Math.max(1, Math.ceil(frames / bucket));
  const min = new Float32Array(nb), max = new Float32Array(nb);
  let pos = 0;
  return {
    add(channels) {
      const n = channels[0].length;
      const two = channels.length > 1;
      for (let i = 0; i < n; i++, pos++) {
        const s = two ? (channels[0][i] + channels[1][i]) * 0.5 : channels[0][i];
        const b = Math.floor(pos / bucket);
        if (s < min[b]) min[b] = s; else if (s > max[b]) max[b] = s;
      }
    },
    result: () => ({ bucket, min, max }),
  };
}

/**
 * Write a whole decoded / parsed source into the store in chunks. readFrames(from, count) -> Float32Array[].
 * Returns the meta record.
 */
export async function writePcm(store, key, { frames, channels, sampleRate, chunkFrames = 32768, readFrames }) {
  const peaks = createPeakBuilder(frames);
  for (let idx = 0, from = 0; from < frames; idx++, from += chunkFrames) {
    const data = readFrames(from, Math.min(chunkFrames, frames - from));
    peaks.add(data);
    await store.putChunk(key, idx, data);
  }
  const meta = { key, frames, channels, sampleRate, chunkFrames, peaks: peaks.result(), usedAt: Date.now() };
  await store.putMeta(meta);
  return meta;
}
