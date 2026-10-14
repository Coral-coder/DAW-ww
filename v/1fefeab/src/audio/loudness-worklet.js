// AudioWorklet processor 'daw3-loudness' (see meters.js): K-weighted 100 ms energy blocks, 4x true peak and
// stereo correlation sums, posted to the main thread 10x per second. Self-contained (no imports).
const PH = 4, TAPS = 12;
function kernel() {
  const N = TAPS * PH, h = new Float64Array(N), c = (N - 1) / 2;
  for (let i = 0; i < N; i++) {
    const x = (i - c) / PH;
    const s = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = 0.35875 - 0.48829 * Math.cos((2 * Math.PI * i) / (N - 1)) + 0.14128 * Math.cos((4 * Math.PI * i) / (N - 1)) - 0.01168 * Math.cos((6 * Math.PI * i) / (N - 1));
    h[i] = s * w;
  }
  const out = [];
  for (let p = 0; p < PH; p++) { const k = new Float64Array(TAPS); let sum = 0; for (let t = 0; t < TAPS; t++) { k[t] = h[t * PH + p]; sum += k[t]; } for (let t = 0; t < TAPS; t++) k[t] /= sum; out.push(k); }
  return out;
}
class Daw3Loudness extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.k = opts.processorOptions.coeffs;
    this.hop = Math.round(sampleRate / 10);
    this.st = [0, 1].map(() => this.k.map(() => ({ x1: 0, x2: 0, y1: 0, y2: 0 })));
    this.hist = [new Float64Array(TAPS), new Float64Array(TAPS)];
    this.hp = 0;
    this.ker = kernel();
    this.reset();
    this.port.onmessage = (e) => { if (e.data === 'reset') this.reset(); };
  }
  reset() { this.n = 0; this.e = [0, 0]; this.tp = 0; this.lr = 0; this.ll = 0; this.rr = 0; }
  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp.length) return true;
    const L = inp[0], R = inp[1] || inp[0];
    const len = L.length;
    for (let i = 0; i < len; i++) {
      const xs = [L[i], R[i]];
      for (let c = 0; c < 2; c++) {
        let x = xs[c];
        const st = this.st[c];
        for (let s = 0; s < this.k.length; s++) {
          const q = this.k[s], z = st[s];
          const y = q.b0 * x + q.b1 * z.x1 + q.b2 * z.x2 - q.a1 * z.y1 - q.a2 * z.y2;
          z.x2 = z.x1; z.x1 = x; z.y2 = z.y1; z.y1 = y; x = y;
        }
        this.e[c] += x * x;
        const hh = this.hist[c];
        hh[this.hp] = xs[c];
        for (let p = 0; p < PH; p++) {
          const kk = this.ker[p];
          let acc = 0;
          for (let t = 0; t < TAPS; t++) acc += kk[t] * hh[(this.hp - t + TAPS) % TAPS];
          const a = acc < 0 ? -acc : acc;
          if (a > this.tp) this.tp = a;
        }
      }
      this.hp = (this.hp + 1) % TAPS;
      this.lr += L[i] * R[i]; this.ll += L[i] * L[i]; this.rr += R[i] * R[i];
      if (++this.n >= this.hop) {
        this.port.postMessage({ e: (this.e[0] + this.e[1]) / this.n, tp: this.tp, lr: this.lr, ll: this.ll, rr: this.rr });
        this.reset();
      }
    }
    return true;
  }
}
registerProcessor('daw3-loudness', Daw3Loudness);
