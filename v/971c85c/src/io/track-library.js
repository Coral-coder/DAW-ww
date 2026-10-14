// Music library for the Decks view: imported tracks (original file bytes + analysis) persisted in
// IndexedDB ('daw3-tracks'), decoded on demand, analysed in a Web Worker (main-thread fallback).
// Works in the browser and the Mac app; without IndexedDB it keeps tracks in memory only.
import { Emitter, uid } from '../core/util.js';
import { analyzeTrack } from '../audio/analysis/index.js';

export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'wave', 'flac', 'm4a', 'aac', 'mp4', 'ogg', 'oga', 'opus', 'aif', 'aiff', 'webm'];
export const isAudioFileName = (name) => AUDIO_EXTENSIONS.includes(String(name || '').split('.').pop().toLowerCase());
export const trackTitle = (fileName) => String(fileName || 'Track').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || 'Track';

/** Collect audio Files from a drop (files and folders, recursively). */
export async function filesFromDataTransfer(dt) {
  const out = [];
  const entries = [...(dt?.items || [])].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...(dt?.files || [])].filter((f) => isAudioFileName(f.name));
  const walk = async (entry, depth = 0) => {
    if (depth > 6 || out.length > 500) return;
    if (entry.isFile) {
      if (!isAudioFileName(entry.name)) return;
      const f = await new Promise((res) => entry.file(res, () => res(null)));
      if (f) out.push(f);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res) => reader.readEntries(res, () => res([])));
        if (!batch.length) break;
        for (const e of batch) await walk(e, depth + 1);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

const DB = 'daw3-tracks';
const hasIdb = () => typeof indexedDB !== 'undefined' && indexedDB !== null;
let dbp = null;
function openDb() {
  if (!hasIdb()) return Promise.reject(new Error('no IndexedDB'));
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbp = null; reject(req.error); };
    });
  }
  return dbp;
}
function tx(storeName, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const req = fn(t.objectStore(storeName));
    let result;
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export class TrackLibrary extends Emitter {
  constructor() {
    super();
    this.tracks = new Map(); // id -> { id, name, fileName, size, mime, addedAt, analysis, status, progress, error }
    this._bytes = new Map(); // in-memory fallback / cache of file bytes
    this._audio = new Map(); // id -> { channels, sampleRate, duration } (small LRU)
    this._worker = undefined;
    this._jobs = new Map();
    this.ready = this._load();
  }

  async _load() {
    try {
      const rows = await tx('meta', 'readonly', (s) => s.getAll());
      for (const r of rows || []) this.tracks.set(r.id, { ...r, status: r.analysis ? 'ready' : 'pending' });
      this.emit('change');
      for (const t of this.tracks.values()) if (!t.analysis) this.analyze(t.id).catch(() => {});
    } catch { /* memory-only */ }
  }

  list() { return [...this.tracks.values()].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)); }
  get(id) { return this.tracks.get(id) || null; }

  _meta(t) { const { status, progress, error, _analyzing, ...rest } = t; return rest; }
  _saveMeta(t) { return tx('meta', 'readwrite', (s) => s.put(this._meta(t))).catch(() => {}); }

  /** Import File/Blob objects (non-audio names are skipped). Resolves to the new track records. */
  async addFiles(files) {
    const added = [];
    for (const f of files || []) {
      if (f.name && !isAudioFileName(f.name) && !String(f.type).startsWith('audio/')) continue;
      const dup = [...this.tracks.values()].find((t) => t.fileName === f.name && t.size === f.size);
      if (dup) { added.push(dup); continue; }
      const bytes = await f.arrayBuffer();
      const t = { id: uid('trk'), name: trackTitle(f.name), fileName: f.name || 'track', size: f.size ?? bytes.byteLength, mime: f.type || '', path: f.nativePath || null, addedAt: Date.now(), analysis: null, status: 'pending', progress: 0 };
      this.tracks.set(t.id, t);
      this._bytes.set(t.id, bytes);
      await tx('audio', 'readwrite', (s) => s.put({ id: t.id, bytes })).catch(() => {});
      await this._saveMeta(t);
      added.push(t);
      this.emit('change');
    }
    for (const t of added) if (!t.analysis) this.analyze(t.id).catch(() => {});
    return added;
  }

  async remove(id) {
    this.tracks.delete(id); this._bytes.delete(id); this._audio.delete(id);
    await tx('meta', 'readwrite', (s) => s.delete(id)).catch(() => {});
    await tx('audio', 'readwrite', (s) => s.delete(id)).catch(() => {});
    this.emit('change');
  }

  /** Patch the stored analysis (e.g. BPM ×2, moved downbeat) and persist it. */
  updateAnalysis(id, patch) {
    const t = this.tracks.get(id);
    if (!t?.analysis) return;
    t.analysis = { ...t.analysis, ...patch };
    this._saveMeta(t);
    this.emit('change', id);
  }

  async _getBytes(id) {
    if (this._bytes.has(id)) return this._bytes.get(id);
    const row = await tx('audio', 'readonly', (s) => s.get(id)).catch(() => null);
    if (!row?.bytes) throw new Error('Audio data missing — re-import the file.');
    return row.bytes;
  }

  /** Decoded audio { channels: Float32Array[], sampleRate, duration }. */
  async getAudio(id) {
    if (this._audio.has(id)) { const a = this._audio.get(id); this._audio.delete(id); this._audio.set(id, a); return a; }
    const bytes = await this._getBytes(id);
    const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!OAC) throw new Error('Audio decoding is not available here.');
    const ctx = new OAC(2, 1, 44100);
    const buf = await ctx.decodeAudioData(bytes.slice(0));
    const channels = [];
    for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) channels.push(buf.getChannelData(c));
    const audio = { channels, sampleRate: buf.sampleRate, duration: buf.duration };
    this._audio.set(id, audio);
    while (this._audio.size > 4) this._audio.delete(this._audio.keys().next().value);
    return audio;
  }

  _getWorker() {
    if (this._worker !== undefined) return this._worker;
    try {
      this._worker = new Worker(new URL('../audio/analysis/worker.js', import.meta.url), { type: 'module' });
      this._worker.onmessage = (e) => {
        const { id, result, error, progress } = e.data || {};
        const job = this._jobs.get(id);
        if (!job) return;
        if (progress != null) { job.onProgress(progress); return; }
        this._jobs.delete(id);
        if (error) job.reject(new Error(error)); else job.resolve(result);
      };
      this._worker.onerror = (e) => { for (const j of this._jobs.values()) j.reject(new Error(e.message || 'analysis worker failed')); this._jobs.clear(); this._worker = null; };
    } catch { this._worker = null; }
    return this._worker;
  }

  _runAnalysis(audio, onProgress) {
    const w = this._getWorker();
    if (!w) return new Promise((r) => setTimeout(r, 0)).then(() => analyzeTrack(audio.channels, audio.sampleRate, { onProgress }));
    const jobId = uid('job');
    return new Promise((resolve, reject) => {
      this._jobs.set(jobId, { resolve, reject, onProgress });
      const channels = audio.channels.map((c) => c.slice());
      w.postMessage({ id: jobId, channels, sampleRate: audio.sampleRate }, channels.map((c) => c.buffer));
    }).catch(() => analyzeTrack(audio.channels, audio.sampleRate, { onProgress })); // worker unavailable (file://, CSP…)
  }

  /** (Re-)analyse a track: BPM / grid, key / Camelot, loudness, energy, sections. */
  async analyze(id) {
    const t = this.tracks.get(id);
    if (!t) return null;
    if (t._analyzing) return t._analyzing;
    t.status = 'analyzing'; t.progress = 0; t.error = null;
    this.emit('change', id);
    t._analyzing = (async () => {
      try {
        const audio = await this.getAudio(id);
        const analysis = await this._runAnalysis(audio, (p) => { t.progress = p; this.emit('progress', id); });
        t.analysis = analysis; t.status = 'ready';
        delete t._analyzing;
        await this._saveMeta(t);
        this.emit('change', id);
        return analysis;
      } catch (e) {
        t.status = 'error'; t.error = e.message; delete t._analyzing;
        this.emit('change', id);
        throw e;
      }
    })();
    return t._analyzing;
  }
}
