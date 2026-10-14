// AudioWorklet: sample-accurate input capture + input peak meters (one node per open input source).
// Messages in:  {cmd:'start'} | {cmd:'stop'}
// Messages out: {type:'peaks', peaks:[per channel 0..1+], frame} ~every 1024 frames (meters / clip detection)
//               {type:'chunk', frame (context frame of data[c][0]), data: Float32Array[] } while recording
//               {type:'stopped', frame}
/* global sampleRate, currentFrame, registerProcessor, AudioWorkletProcessor */
const CHUNK = 8192;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = Math.max(1, options?.processorOptions?.channels || 1);
    this.rec = false;
    this.buf = null;
    this.fill = 0;
    this.bufFrame = 0;
    this.peaks = new Float32Array(this.channels);
    this.meterFrames = 0;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.cmd === 'start') { this.rec = true; this.buf = null; this.fill = 0; }
      else if (m.cmd === 'stop') { this.flush(); this.rec = false; this.port.postMessage({ type: 'stopped', frame: currentFrame }); }
    };
  }

  flush() {
    if (!this.buf || !this.fill) return;
    const data = this.buf.map((d) => d.slice(0, this.fill));
    this.port.postMessage({ type: 'chunk', frame: this.bufFrame, data }, data.map((d) => d.buffer));
    this.buf = null;
    this.fill = 0;
  }

  process(inputs, outputs) {
    const inp = inputs[0] || [];
    const n = inp[0]?.length || 128;
    for (let c = 0; c < this.channels; c++) {
      const d = inp[c];
      if (!d) continue;
      let m = this.peaks[c];
      for (let i = 0; i < d.length; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > m) m = a; }
      this.peaks[c] = m;
    }
    this.meterFrames += n;
    if (this.meterFrames >= 1024) {
      this.port.postMessage({ type: 'peaks', peaks: Array.from(this.peaks), frame: currentFrame });
      this.peaks.fill(0);
      this.meterFrames = 0;
    }
    if (this.rec) {
      if (!this.buf) { this.buf = Array.from({ length: this.channels }, () => new Float32Array(CHUNK)); this.fill = 0; this.bufFrame = currentFrame; }
      const room = CHUNK - this.fill;
      const k = Math.min(room, n);
      for (let c = 0; c < this.channels; c++) {
        const d = inp[c] || inp[0];
        if (d) this.buf[c].set(k === n ? d : d.subarray(0, k), this.fill);
      }
      this.fill += k;
      if (this.fill >= CHUNK) {
        this.flush();
        if (k < n) { // rest of this block starts the next chunk
          this.buf = Array.from({ length: this.channels }, () => new Float32Array(CHUNK));
          this.bufFrame = currentFrame + k;
          for (let c = 0; c < this.channels; c++) { const d = inp[c] || inp[0]; if (d) this.buf[c].set(d.subarray(k), 0); }
          this.fill = n - k;
        }
      }
    }
    // silent output keeps the node pulled by the renderer
    const out = outputs[0];
    if (out) for (const ch of out) ch.fill(0);
    return true;
  }
}

registerProcessor('daw3-capture', CaptureProcessor);
void sampleRate;
