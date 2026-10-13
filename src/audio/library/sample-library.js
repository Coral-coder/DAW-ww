// Remote sample library: fetch -> decode -> cache for samples hosted on GitHub (the same
// sources Strudel uses: tidal-drum-machines, Dirt-Samples, VCSL, dough-samples).
//
//  * URL helpers (pure, Node-safe): githubPath('github:owner/repo[/ref]'), normalizeUrl, rawToJsdelivr,
//    jsdelivrToRaw, mirrorsFor, processSampleMap (strudel.json maps), sampleIndex, closestNoteKey.
//  * SampleLibrary (browser): raw bytes are cached in memory and in Cache Storage (reloads are instant and
//    work offline), decoded AudioBuffers are cached per sample rate. Fetching is concurrency-limited, tries
//    each mirror in turn (raw.githubusercontent.com first — jsDelivr refuses GitHub repos > 50 MB, which
//    includes tidal-drum-machines and Dirt-Samples — then cdn.jsdelivr.net/gh), remembers mirrors that fail
//    per repo, and reports progress through `library.on('progress', fn)`.
//
// Nothing here touches window / AudioContext at import time.

export const RAW_HOST = 'https://raw.githubusercontent.com/';
export const JSDELIVR_HOST = 'https://cdn.jsdelivr.net/gh/';
export const CACHE_NAME = 'dawww-samples-v1';

// ------------------------------------------------------------------------------- pure URL helpers

/** 'github:owner/repo[/ref][/sub/dir]' -> 'https://raw.githubusercontent.com/owner/repo/ref/sub/dir/' + subpath (ref defaults to main). */
export function githubPath(pseudo, subpath = '') {
  const s = String(pseudo || '');
  if (!s.startsWith('github:')) throw new Error('expected "github:" at the start of the pseudo URL');
  let path = s.slice('github:'.length).replace(/^\/+/, '');
  if (path.endsWith('/')) path = path.slice(0, -1);
  if (path.split('/').length === 2) path += '/main';
  return `${RAW_HOST}${path}/${subpath}`;
}

/** Resolve the base URL forms Strudel accepts ('github:…', 'bubo:repo', plain https). */
export function resolveBase(base) {
  let b = String(base || '');
  if (b.startsWith('bubo:')) b = `github:Bubobubobubobubo/dough-${b.slice(5)}`;
  if (b.startsWith('github:')) b = githubPath(b, '');
  return b;
}

/** Percent-encode spaces, '#', etc. without double-encoding existing %xx escapes. */
export function normalizeUrl(url) {
  const s = String(url || '');
  let dec = s;
  try { dec = decodeURI(s); } catch { dec = s; }
  return encodeURI(dec).replace(/#/g, '%23');
}

const RAW_RE = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.*)$/;
const JSD_RE = /^https:\/\/cdn\.jsdelivr\.net\/gh\/([^/]+)\/([^/@]+)@([^/]+)\/(.*)$/;

/** raw.githubusercontent URL -> jsDelivr GitHub mirror URL (null if not a raw GitHub URL). */
export function rawToJsdelivr(url) {
  const m = RAW_RE.exec(String(url));
  return m ? `${JSDELIVR_HOST}${m[1]}/${m[2]}@${m[3]}/${m[4]}` : null;
}
/** jsDelivr GitHub mirror URL -> raw.githubusercontent URL (null if not a jsDelivr gh URL). */
export function jsdelivrToRaw(url) {
  const m = JSD_RE.exec(String(url));
  return m ? `${RAW_HOST}${m[1]}/${m[2]}/${m[3]}/${m[4]}` : null;
}
/** Canonical cache key of a sample URL (jsDelivr URLs are keyed by their raw equivalent). */
export function canonicalUrl(url) {
  const n = normalizeUrl(url);
  return jsdelivrToRaw(n) || n;
}
/** 'owner/repo' of a GitHub-hosted URL (raw or jsDelivr), else the host. */
export function repoOf(url) {
  const c = canonicalUrl(url);
  const m = RAW_RE.exec(c);
  if (m) return `${m[1]}/${m[2]}`;
  try { return new URL(c).host; } catch { return ''; }
}
/** Candidate URLs to try, in order. order: list of 'raw' | 'jsdelivr'. */
export function mirrorsFor(url, order = ['raw', 'jsdelivr'], skip = new Set()) {
  const raw = canonicalUrl(url);
  const jsd = rawToJsdelivr(raw);
  if (!jsd) return [raw];
  const out = [];
  for (const m of order) {
    if (skip.has(m)) continue;
    if (m === 'raw') out.push(raw);
    else if (m === 'jsdelivr') out.push(jsd);
  }
  return out.length ? out : [raw];
}

/**
 * Expand a strudel.json-style sample map into full URLs (same rules as Strudel's processSampleMap):
 *   { _base, name: 'file' | ['file', …] | { note: 'file' | ['file', …], _base? } }
 * Returns { name: string[] | { note: string[] } } (keys keep their case; `_…` keys are skipped).
 */
export function processSampleMap(map, baseUrl) {
  const out = {};
  if (!map || typeof map !== 'object') return out;
  const rootBase = resolveBase(baseUrl ?? map._base ?? '');
  for (const [key, raw] of Object.entries(map)) {
    if (key.startsWith('_')) continue;
    let value = raw;
    if (typeof value === 'string') value = [value];
    if (!value || typeof value !== 'object') continue;
    const base = value._base ? resolveBase(value._base) : rootBase;
    const full = (f) => normalizeUrl(/^[a-z]+:\/\//i.test(f) ? f : base + f);
    if (Array.isArray(value)) out[key] = value.filter((f) => typeof f === 'string').map(full);
    else {
      const notes = {};
      for (const [note, files] of Object.entries(value)) {
        if (note.startsWith('_')) continue;
        const list = typeof files === 'string' ? [files] : Array.isArray(files) ? files : [];
        if (list.length) notes[note] = list.map(full);
      }
      out[key] = notes;
    }
  }
  return out;
}

/** Strudel's getSoundIndex: round(n) modulo count (negative wraps). */
export function sampleIndex(n, count) {
  if (!(count > 0)) return 0;
  const i = Math.round(Number.isFinite(Number(n)) ? Number(n) : 0);
  return ((i % count) + count) % count;
}

const PCS = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
/** Note key of a sample map ('C4', 'Ds1', 'fs2', 'Bb3', '60') -> midi number (C4 = 60), or null. */
export function noteKeyToMidi(key) {
  const s = String(key).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = /^([a-gA-G])([#sbf]*)(-?\d+)$/.exec(s);
  if (!m) return null;
  let pc = PCS[m[1].toLowerCase()];
  for (const ch of m[2]) pc += ch === 'b' || ch === 'f' ? -1 : 1;
  return (Number(m[3]) + 1) * 12 + pc;
}

/** Closest key of a note-keyed bank to `midi` -> { key, transpose (semitones to shift) } */
export function closestNoteKey(bank, midi) {
  let best = null, bestD = Infinity, bestM = 0;
  for (const k of Object.keys(bank || {})) {
    const km = noteKeyToMidi(k);
    if (km == null) continue;
    const d = Math.abs(km - midi);
    if (d < bestD) { bestD = d; best = k; bestM = km; }
  }
  return best == null ? null : { key: best, transpose: midi - bestM };
}

/**
 * Pick the URL to play from an expanded bank entry (array or note-keyed object), Strudel-style.
 * midi: target pitch (default 36 = no transposition for array banks). -> { url, index, transpose } | null
 */
export function pickSample(bank, { n = 0, midi = null } = {}) {
  if (!bank) return null;
  if (Array.isArray(bank)) {
    if (!bank.length) return null;
    const index = sampleIndex(n, bank.length);
    return { url: bank[index], index, transpose: midi == null ? 0 : midi - 36 };
  }
  const c = closestNoteKey(bank, midi == null ? 36 : midi);
  if (!c) return null;
  const list = bank[c.key];
  const index = sampleIndex(n, list.length);
  return { url: list[index], index, transpose: c.transpose };
}

// ------------------------------------------------------------------------------- library (browser)

const lsGet = (k) => { try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; } };
const lsSet = (k, v) => { try { globalThis.localStorage?.setItem(k, v); } catch { /* private mode */ } };
const MIRROR_LS = 'dawww-sample-mirror-fail';

export class SampleLibrary {
  constructor({ concurrency = 6, timeoutMs = 20000, order = ['raw', 'jsdelivr'] } = {}) {
    this.concurrency = concurrency;
    this.timeoutMs = timeoutMs;
    this.order = order;
    this.bytes = new Map(); // canonical url -> Promise<ArrayBuffer>
    this.decoded = new Map(); // `${rate}|${url}` -> AudioBuffer
    this.decoding = new Map(); // `${rate}|${url}` -> Promise<AudioBuffer|null>
    this.failures = new Map(); // canonical url -> { time, error }
    this.jsonCache = new Map(); // url -> Promise<object>
    this.listeners = new Map();
    this.queue = [];
    this.active = 0;
    this.stats = { requested: 0, done: 0, failed: 0, fromCache: 0, bytes: 0 };
    this.retryAfterMs = 30000;
    this.mirrorFail = new Map(); // `${mirror}|${repo}` -> count
    try { for (const [k, v] of Object.entries(JSON.parse(lsGet(MIRROR_LS) || '{}'))) this.mirrorFail.set(k, v); } catch { /* */ }
  }

  // -- events
  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }
  emit(type, data) { for (const fn of this.listeners.get(type) || []) { try { fn(data); } catch (e) { console.warn('[samples]', e); } } }
  _progress(url, status) {
    this.emit('progress', { url, status, ...this.stats, pending: this.stats.requested - this.stats.done - this.stats.failed });
  }

  /** Mirror preference, e.g. ['jsdelivr', 'raw']. */
  setMirrorOrder(order) { if (Array.isArray(order) && order.length) this.order = order.slice(); }

  /** Mirror order for a URL: mirrors that keep failing for its repo are tried last (never dropped). */
  _orderFor(url) {
    const repo = repoOf(url);
    const bad = (m) => (this.mirrorFail.get(`${m}|${repo}`) || 0) >= 2;
    return [...this.order.filter((m) => !bad(m)), ...this.order.filter(bad)];
  }
  _markMirror(mirror, url, ok) {
    const k = `${mirror}|${repoOf(url)}`;
    const n = ok ? 0 : (this.mirrorFail.get(k) || 0) + 1;
    if ((this.mirrorFail.get(k) || 0) === n) return;
    if (n) this.mirrorFail.set(k, n); else this.mirrorFail.delete(k);
    lsSet(MIRROR_LS, JSON.stringify(Object.fromEntries(this.mirrorFail)));
  }

  async _cache() {
    try {
      if (!globalThis.caches?.open) return null;
      if (!this._cacheP) this._cacheP = globalThis.caches.open(CACHE_NAME).catch(() => null);
      return await this._cacheP;
    } catch { return null; }
  }

  _slot(fn) {
    return new Promise((resolve, reject) => {
      const run = () => {
        this.active++;
        Promise.resolve().then(fn).then(resolve, reject).finally(() => {
          this.active--;
          const next = this.queue.shift();
          if (next) next();
        });
      };
      if (this.active < this.concurrency) run(); else this.queue.push(run);
    });
  }

  async _fetchNetwork(url) {
    const tried = [];
    for (const candidate of mirrorsFor(url, this._orderFor(url))) {
      const mirror = candidate.startsWith(JSDELIVR_HOST) ? 'jsdelivr' : candidate.startsWith(RAW_HOST) ? 'raw' : 'direct';
      let timer = null;
      try {
        const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
        if (ac) timer = setTimeout(() => ac.abort(), this.timeoutMs);
        const res = await fetch(candidate, { signal: ac?.signal, mode: 'cors', credentials: 'omit' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (!buf.byteLength) throw new Error('empty response');
        if (mirror !== 'direct') this._markMirror(mirror, url, true);
        return { buf, type: res.headers.get('content-type') || '' };
      } catch (e) {
        tried.push(`${mirror}: ${e?.name === 'AbortError' ? 'timeout' : e?.message || e}`);
        if (mirror !== 'direct') this._markMirror(mirror, url, false);
      } finally { clearTimeout(timer); }
    }
    throw new Error(`could not fetch ${url} (${tried.join('; ')})`);
  }

  /** Raw file bytes (memory -> Cache Storage -> network). Rejects on failure. */
  fetchBytes(url) {
    const key = canonicalUrl(url);
    const hit = this.bytes.get(key);
    if (hit) return hit;
    const f = this.failures.get(key);
    if (f && Date.now() - f.time < this.retryAfterMs) return Promise.reject(f.error);
    this.stats.requested++;
    const p = this._slot(async () => {
      const cache = await this._cache();
      if (cache) {
        try {
          const r = await cache.match(key);
          if (r) {
            const b = await r.arrayBuffer();
            if (b.byteLength) { this.stats.fromCache++; return b; }
          }
        } catch { /* corrupt entry — refetch */ }
      }
      const { buf, type } = await this._fetchNetwork(key);
      if (cache) {
        try { await cache.put(key, new Response(buf.slice(0), { headers: { 'content-type': type || 'application/octet-stream' } })); } catch { /* quota */ }
      }
      return buf;
    }).then((buf) => {
      this.stats.done++;
      this.stats.bytes += buf.byteLength;
      this.failures.delete(key);
      this._progress(key, 'loaded');
      return buf;
    }, (e) => {
      this.stats.failed++;
      this.bytes.delete(key);
      const error = e instanceof Error ? e : new Error(String(e));
      this.failures.set(key, { time: Date.now(), error });
      this._progress(key, 'failed');
      this.emit('error', { url: key, error });
      throw error;
    });
    this.bytes.set(key, p);
    return p;
  }

  /** JSON document (e.g. a strudel.json map), cached like samples. */
  fetchJson(url) {
    const key = canonicalUrl(url);
    if (!this.jsonCache.has(key)) {
      const p = this.fetchBytes(key).then((b) => JSON.parse(new TextDecoder().decode(b)));
      p.catch(() => this.jsonCache.delete(key));
      this.jsonCache.set(key, p);
    }
    return this.jsonCache.get(key);
  }

  /** Decoded buffer if already available for this context's sample rate (sync), else null. */
  get(ctx, url) {
    const rate = typeof ctx === 'number' ? ctx : ctx?.sampleRate;
    return this.decoded.get(`${rate}|${canonicalUrl(url)}`) || null;
  }
  /** True when the URL recently failed to load (callers fall back to synthesized sounds). */
  hasFailed(url) {
    const f = this.failures.get(canonicalUrl(url));
    return !!f && Date.now() - f.time < this.retryAfterMs;
  }
  isLoading(ctx, url) { return this.decoding.has(`${ctx.sampleRate}|${canonicalUrl(url)}`) && !this.get(ctx, url); }

  /** Fetch + decode for ctx (AudioContext or OfflineAudioContext). Resolves AudioBuffer, or null on failure. */
  load(ctx, url) {
    const key = canonicalUrl(url);
    const dk = `${ctx.sampleRate}|${key}`;
    const done = this.decoded.get(dk);
    if (done) return Promise.resolve(done);
    let p = this.decoding.get(dk);
    if (p) return p;
    p = this.fetchBytes(key).then((bytes) => new Promise((resolve, reject) => {
      const q = ctx.decodeAudioData(bytes.slice(0), resolve, reject);
      if (q && typeof q.then === 'function') q.then(resolve, reject);
    })).then((buf) => {
      this.decoded.set(dk, buf);
      this.emit('decoded', { url: key, sampleRate: ctx.sampleRate });
      return buf;
    }, (e) => {
      this.decoding.delete(dk);
      if (!this.failures.has(key)) this.failures.set(key, { time: Date.now(), error: e });
      return null;
    });
    this.decoding.set(dk, p);
    return p;
  }

  /**
   * Load many URLs for ctx. onProgress({done, failed, total}). Resolves { loaded, failed } (never rejects).
   * timeoutMs bounds the whole batch (unfinished URLs count as failed for this call; they keep loading).
   */
  async preload(ctx, urls, { onProgress, timeoutMs = 0 } = {}) {
    const list = [...new Set((urls || []).filter(Boolean).map(canonicalUrl))];
    let done = 0, failed = 0;
    const jobs = list.map((u) => this.load(ctx, u).then((b) => { if (b) done++; else failed++; onProgress?.({ done, failed, total: list.length, url: u }); }));
    if (timeoutMs > 0) {
      let timer;
      await Promise.race([Promise.all(jobs), new Promise((r) => { timer = setTimeout(r, timeoutMs); })]);
      clearTimeout(timer);
    } else await Promise.all(jobs);
    return { loaded: done, failed: list.length - done, total: list.length };
  }

  /** Drop decoded buffers (bytes stay in Cache Storage). */
  clearMemory() { this.decoded.clear(); this.decoding.clear(); this.bytes.clear(); this.jsonCache.clear(); }
  /** Delete the persistent cache too. */
  async clearPersistent() {
    this.clearMemory();
    try { await globalThis.caches?.delete(CACHE_NAME); } catch { /* */ }
    this._cacheP = null;
  }
  /** Approximate persistent cache stats { entries }. */
  async cacheInfo() {
    const c = await this._cache();
    if (!c) return { entries: 0, available: false };
    try { return { entries: (await c.keys()).length, available: true }; } catch { return { entries: 0, available: true }; }
  }
}

/** Shared app-wide library instance (lazy: does nothing until used). */
export const library = new SampleLibrary();
if (typeof window !== 'undefined') {
  // debugging / automation handle
  try { window.__dawwwSamples = library; } catch { /* */ }
}
