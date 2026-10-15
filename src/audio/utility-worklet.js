// AudioWorklet processor 'daw3-utility' (see utility-meter.js): per 100 ms block the DC sums, the 24-bit usage mask and
// whether finer (float) detail is present; running clip-event totals (runs of ≥ minRun consecutive samples at or above
// full scale, per channel, across block boundaries). Self-contained (no imports); the same statistics are computed by
// src/audio/dsp/utility-meters.js, which also interprets them.
class Daw3Utility extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = (opts && opts.processorOptions) || {};
    this.level = o.level || 32767 / 32768;
    this.minRun = Math.max(1, o.minRun || 3);
    this.hop = Math.round(sampleRate / 10);
    this.clear();
    this.block();
    this.port.onmessage = (e) => { if (e.data === 'reset') { this.clear(); this.block(); } };
  }
  clear() { this.run = [0, 0]; this.clips = [0, 0]; this.longest = 0; this.overs = 0; }
  block() { this.n = 0; this.sum = [0, 0]; this.mask = 0; this.frac = false; }
  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp.length) return true;
    const L = inp[0], R = inp[1] || inp[0];
    const len = L.length;
    const lv = this.level, mr = this.minRun;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < 2; c++) {
        const x = c ? R[i] : L[i];
        this.sum[c] += x;
        const s = x * 8388608;
        let v = Math.round(s);
        if (v !== s) this.frac = true;
        if (v < 0) v = -v;
        if (v > 8388607) v = 8388607;
        this.mask |= v;
        const a = x < 0 ? -x : x;
        if (a >= lv) {
          if (a > 1) this.overs++;
          const r = ++this.run[c];
          if (r === mr) this.clips[c]++;
          if (r > this.longest) this.longest = r;
        } else this.run[c] = 0;
      }
      if (++this.n >= this.hop) {
        this.port.postMessage({ n: this.n, sum: this.sum, mask: this.mask, frac: this.frac, clips: [this.clips[0], this.clips[1]], longest: this.longest, overs: this.overs });
        this.block();
      }
    }
    return true;
  }
}
registerProcessor('daw3-utility', Daw3Utility);
