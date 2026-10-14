// AudioWorkletProcessor 'daw3-stream': plays one long sample from PCM chunks streamed in by the stream worker
// (see streamer.js). Each node is one voice (one audio-clip play); it keeps a small ring of decoded chunks, asks the
// worker for the next ones ahead of the play head, and outputs silence (counting an underrun) if a chunk is late.
//
// processorOptions: { channels, chunkFrames, frames, ratio (data rate / context rate), startFrame (context frame
//                     the voice starts), offset (data frame to start from), length (context frames to play) }
// port messages in:  { port } (MessagePort to the worker), { chunk: idx, data: Float32Array[] }, { stop: ctxFrame }
// port messages out: { need: idx } (to the worker port), { ended: true, underruns } (to the main thread)
const AHEAD = 3; // chunks requested ahead of the play head

class StreamProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.ch = o.channels || 2;
    this.cf = o.chunkFrames;
    this.frames = o.frames;
    this.ratio = o.ratio || 1;
    this.start = o.startFrame || 0;
    this.offset = o.offset || 0;
    this.end = this.start + (o.length || Infinity);
    this.stopAt = Infinity;
    this.chunks = new Map(); // idx -> Float32Array[]
    this.requested = new Set();
    this.worker = null;
    this.underruns = 0;
    this.done = false;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.port) { this.worker = m.port; this.worker.onmessage = (ev) => this.onChunk(ev.data); this.prefetch(this.offset); }
      else if (m.chunk != null) this.onChunk(m);
      else if (m.stop != null) this.stopAt = m.stop;
    };
  }

  onChunk(m) {
    if (m.chunk == null) return;
    this.chunks.set(m.chunk, m.data);
  }

  prefetch(pos) {
    if (!this.worker) return;
    const first = Math.max(0, Math.floor(pos / this.cf));
    for (let k = first; k <= first + AHEAD && k * this.cf < this.frames; k++) {
      if (!this.chunks.has(k) && !this.requested.has(k)) { this.requested.add(k); this.worker.postMessage({ need: k }); }
    }
    // drop chunks behind the play head
    for (const k of this.chunks.keys()) if (k < first - 1) { this.chunks.delete(k); this.requested.delete(k); }
  }

  sampleAt(c, pos) {
    const k = Math.floor(pos / this.cf);
    const d = this.chunks.get(k);
    if (!d) return null;
    return d[Math.min(c, d.length - 1)][pos - k * this.cf] ?? 0;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    const f0 = currentFrame; // eslint-disable-line no-undef
    if (this.done) return false;
    const last = Math.min(this.end, this.stopAt);
    if (f0 >= last) { this.finish(); return false; }
    let missing = false;
    for (let i = 0; i < n; i++) {
      const f = f0 + i;
      if (f < this.start || f >= last) continue;
      const pos = this.offset + (f - this.start) * this.ratio;
      if (pos >= this.frames - 1) { this.stopAt = Math.min(this.stopAt, f); break; }
      const ip = Math.floor(pos);
      const fr = pos - ip;
      for (let c = 0; c < out.length; c++) {
        const a = this.sampleAt(c, ip);
        if (a == null) { missing = true; break; }
        if (fr === 0) { out[c][i] = a; continue; }
        const b = this.sampleAt(c, ip + 1);
        out[c][i] = b == null ? a : a + (b - a) * fr; // linear interpolation (only when rates differ)
      }
      if (missing) break;
    }
    if (missing) this.underruns++;
    const head = this.offset + Math.max(0, f0 + n - this.start) * this.ratio;
    this.prefetch(head);
    return true;
  }

  finish() {
    if (this.done) return;
    this.done = true;
    this.port.postMessage({ ended: true, underruns: this.underruns });
    try { this.worker?.close(); } catch { /* */ }
  }
}

registerProcessor('daw3-stream', StreamProcessor);
