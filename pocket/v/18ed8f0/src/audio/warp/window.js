// Sliding source window for warping long streamed samples (pure; used by worklet.js, Node-tested).
// Holds `slots` consecutive PCM chunks (stream worker chunks, chunkFrames each) per channel plus their mono mix in
// fixed Float32Arrays — the WarpRenderer reads them directly with renderer.base = window.base.
//
//   const w = new SourceWindow({ channels, frames, chunkFrames, slots = 12, ahead = 4, request(idx) })
//   w.ensure(lo, hi) -> true when source frames [lo, hi] are loaded (moves the window / requests chunks as needed)
//   w.onChunk(idx, data: Float32Array[])   a requested chunk arrived
//   w.base                                 source frame of channels[c][0]
export class SourceWindow {
  constructor({ channels = 1, frames, chunkFrames, slots = 12, ahead = 4, request }) {
    this.nch = Math.max(1, channels);
    this.frames = frames;
    this.cf = chunkFrames;
    this.K = slots;
    this.ahead = ahead;
    this.request = request || (() => {});
    this.nChunks = Math.ceil(frames / chunkFrames);
    const len = this.K * this.cf;
    this.channels = Array.from({ length: this.nch }, () => new Float32Array(len));
    this.mono = this.nch > 1 ? new Float32Array(len) : this.channels[0];
    this.first = 0; // chunk index in slot 0
    this.loaded = new Set(); // chunk indices present in the window
    this.cache = new Map(); // idx -> data (arrived, maybe outside the window yet)
    this.requested = new Set();
    this.misses = 0;
  }

  get base() { return this.first * this.cf; }

  _fill(k) {
    const j = k - this.first;
    if (j < 0 || j >= this.K) return;
    const d = this.cache.get(k);
    const o = j * this.cf;
    if (!d) { for (const ch of this.channels) ch.fill(0, o, o + this.cf); if (this.mono !== this.channels[0]) this.mono.fill(0, o, o + this.cf); this.loaded.delete(k); return; }
    const n = Math.min(this.cf, d[0].length);
    for (let c = 0; c < this.nch; c++) { const src = d[Math.min(c, d.length - 1)]; this.channels[c].set(n === src.length ? src : src.subarray(0, n), o); if (n < this.cf) this.channels[c].fill(0, o + n, o + this.cf); }
    if (this.mono !== this.channels[0]) {
      const m = this.mono, inv = 1 / this.nch;
      for (let i = 0; i < this.cf; i++) { let v = 0; for (let c = 0; c < this.nch; c++) v += this.channels[c][o + i]; m[o + i] = v * inv; }
    }
    this.loaded.add(k);
  }

  _move(first) {
    const d = first - this.first;
    if (d === 0) return;
    const keep = Math.abs(d) < this.K;
    if (keep && d > 0) {
      for (const a of this.mono === this.channels[0] ? this.channels : [...this.channels, this.mono]) a.copyWithin(0, d * this.cf);
    } else if (keep && d < 0) {
      for (const a of this.mono === this.channels[0] ? this.channels : [...this.channels, this.mono]) a.copyWithin(-d * this.cf, 0, (this.K + d) * this.cf);
    }
    const old = this.first;
    this.first = first;
    for (const k of [...this.loaded]) if (k < first || k >= first + this.K) this.loaded.delete(k);
    for (let k = first; k < first + this.K; k++) {
      const wasIn = keep && k >= old && k < old + this.K;
      if (!wasIn) this._fill(k);
    }
    // forget cached chunks well behind the window
    for (const k of this.cache.keys()) if (k < first - 1 || k >= first + this.K + this.ahead + 2) { this.cache.delete(k); this.requested.delete(k); }
  }

  ensure(lo, hi) {
    const klo = Math.max(0, Math.floor(lo / this.cf)), khi = Math.min(this.nChunks - 1, Math.floor(Math.max(lo, hi) / this.cf));
    if (klo < this.first || khi >= this.first + this.K) {
      // one chunk of history behind the low end (WSOLA / slices look back a little)
      let first = Math.max(0, klo - 1);
      if (khi >= first + this.K) first = khi - this.K + 1;
      this._move(first);
    }
    for (let k = klo; k <= Math.min(this.nChunks - 1, khi + this.ahead); k++) {
      if (!this.cache.has(k) && !this.requested.has(k)) { this.requested.add(k); this.request(k); }
    }
    for (let k = klo; k <= khi; k++) if (!this.loaded.has(k)) { this.misses++; return false; }
    return true;
  }

  onChunk(k, data) {
    if (k < this.first - 1 || k >= this.first + this.K + this.ahead + 2) { this.requested.delete(k); return; }
    this.cache.set(k, data);
    if (k >= this.first && k < this.first + this.K) this._fill(k);
  }
}
