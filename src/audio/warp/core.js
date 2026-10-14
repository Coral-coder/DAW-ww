// Streaming warp renderer (pure; runs in the AudioWorklet processor, on the main thread for the offline cache /
// no-worklet fallback, and under Node for tests). It follows a source curve s(t) (markers.js clipCurve: output
// seconds -> sample seconds) and produces audio block by block:
//
//   repitch  — resample along s(t) (speed and pitch follow the tempo, like tape / a turntable)
//   beats    — slice-and-stretch: every slice (transient) starts exactly where the curve puts it and plays at its
//              own speed; a slice is faded out where the next one begins in the source (slower tempo -> gap) or
//              cross-faded out when the next slice starts (faster tempo). Exact onset timing, no smearing.
//   tones    — WSOLA: Hann grains (≈50 ms, 2× overlap) whose source position follows s(t) within ±12 ms, chosen by
//              waveform similarity with the previous grain's natural continuation (pitch & timbre preserved)
//   complex  — WSOLA with longer grains (≈90 ms) at 4× overlap and a finer search: smoother on full mixes / pads
//   transpose (beats / tones / complex): grains are read resampled by 2^(st/12); `formants` keeps the spectral
//              envelope in tones / complex: per grain an LPC envelope is removed (residual), the residual is
//              resampled, and the original envelope is re-applied.
//
// new WarpRenderer({ channels: Float32Array[], srcRate, outRate, curve: [{t, s}], mode, transpose, formants,
//                    quality, slices: [sec] }) ; .process(outs: Float32Array[], frames) -> frames written; .done

import { curveAt, curveTimeAt } from './markers.js';

const QUALITY = {
  tones: { draft: [0.04, 2, 0.008, 8], normal: [0.05, 2, 0.012, 4], high: [0.06, 2, 0.015, 2] },
  complex: { draft: [0.07, 4, 0.006, 8], normal: [0.09, 4, 0.008, 4], high: [0.11, 4, 0.01, 2] },
};

/** Cubic (Catmull-Rom) read of x at fractional index p (0 outside). */
function readCubic(x, p) {
  const k = Math.floor(p);
  if (k < -1 || k > x.length) return 0;
  const f = p - k;
  const xm = k - 1 >= 0 && k - 1 < x.length ? x[k - 1] : 0;
  const x0 = k >= 0 && k < x.length ? x[k] : 0;
  const x1 = k + 1 >= 0 && k + 1 < x.length ? x[k + 1] : 0;
  const x2 = k + 2 >= 0 && k + 2 < x.length ? x[k + 2] : 0;
  return x0 + 0.5 * f * (x1 - xm + f * (2 * xm - 5 * x0 + 4 * x1 - x2 + f * (3 * (x0 - x1) + x2 - xm)));
}
const readLin = (x, p) => {
  const k = Math.floor(p);
  if (k < 0 || k >= x.length) return 0;
  const f = p - k;
  return k + 1 < x.length ? x[k] + (x[k + 1] - x[k]) * f : x[k] * (1 - f);
};

/** LPC coefficients a[1..p] (A(z) = 1 + Σ a_i z^-i) of a windowed frame (autocorrelation + Levinson-Durbin). */
export function lpc(frame, order) {
  const n = frame.length;
  const r = new Float64Array(order + 1);
  for (let lag = 0; lag <= order; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += frame[i] * frame[i - lag];
    // lag window (≈ 60 Hz Gaussian bandwidth expansion) keeps the filter well-conditioned
    r[lag] = s * Math.exp(-0.5 * (lag * 0.0085) ** 2);
  }
  r[0] *= 1.0001;
  r[0] += 1e-9;
  const a = new Float64Array(order + 1);
  a[0] = 1;
  let err = r[0];
  for (let i = 1; i <= order; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / err;
    const prev = a.slice();
    for (let j = 1; j < i; j++) a[j] = prev[j] + k * prev[i - j];
    a[i] = k;
    err *= 1 - k * k;
    if (err <= 1e-12) break;
  }
  return a;
}

export class WarpRenderer {
  constructor(o) {
    this.ch = o.channels;
    this.nch = this.ch.length;
    this.srcRate = o.srcRate || o.outRate;
    this.outRate = o.outRate;
    this.curve = o.curve && o.curve.length ? o.curve : [{ t: 0, s: 0 }];
    this.duration = this.curve[this.curve.length - 1].t;
    this.total = Math.max(0, Math.round(this.duration * this.outRate));
    this.mode = o.mode || 'tones';
    this.P = Math.pow(2, (Number(o.transpose) || 0) / 12);
    this.formants = !!o.formants && Math.abs(this.P - 1) > 1e-4;
    this.n = 0; // output frames produced
    this.hint = { i: 0 };
    this.done = this.total === 0;
    this.srcLen = this.ch[0]?.length || 0;
    if (this.mode === 'beats') this._initBeats(o.slices || []);
    else if (this.mode === 'tones' || this.mode === 'complex') this._initWsola(o.quality || 'normal');
  }

  /** Source seconds at output seconds t. */
  s(t) { return curveAt(this.curve, t, this.hint); }

  process(outs, frames) {
    if (this.done) return 0;
    const n = Math.min(frames, this.total - this.n);
    if (this.mode === 'repitch' || this.mode === 'off') this._repitch(outs, n);
    else if (this.mode === 'beats') this._beats(outs, n);
    else this._wsola(outs, n);
    this.n += n;
    if (this.n >= this.total) this.done = true;
    return n;
  }

  /** Render everything into new Float32Arrays (offline cache / fallback). */
  renderAll(maxFrames = Infinity) {
    const len = Math.min(this.total, maxFrames);
    const outs = Array.from({ length: Math.max(2, this.nch) }, () => new Float32Array(len));
    const B = 4096;
    for (let off = 0; off < len;) {
      const n = Math.min(B, len - off);
      const views = outs.map((o) => o.subarray(off, off + n));
      this.process(views, n);
      off += n;
    }
    return outs;
  }

  // ---------------------------------------------------------------- repitch
  _repitch(outs, n) {
    const ratio = this.srcRate;
    for (let i = 0; i < n; i++) {
      const p = this.s((this.n + i) / this.outRate) * ratio;
      for (let c = 0; c < outs.length; c++) outs[c][i] = readCubic(this.ch[Math.min(c, this.nch - 1)], p);
    }
  }

  // ---------------------------------------------------------------- beats (slice & stretch)
  _initBeats(slices) {
    const s = [...new Set([0, ...slices.filter((x) => x > 0.005)].map((x) => Math.round(x * 1e5) / 1e5))].sort((a, b) => a - b);
    this.slices = s;
    this.sliceT = s.map((x) => curveTimeAt(this.curve, x)); // output time each slice starts
    this.fadeOut = Math.max(16, Math.round(0.004 * this.srcRate)); // source samples faded before the next slice
    this.xfade = Math.max(8, Math.round(0.002 * this.outRate)); // output samples to fade a cut slice
    this.sj = 0;
  }
  _sliceSample(j, t, c) {
    const st = this.slices[j];
    const pos = st + (t - this.sliceT[j]) * this.P; // seconds in the source
    if (pos < 0) return 0;
    const next = this.slices[j + 1] ?? Infinity;
    const p = pos * this.srcRate;
    const left = (next - pos) * this.srcRate;
    if (left <= 0) return 0;
    const g = left < this.fadeOut ? left / this.fadeOut : 1;
    return g * readCubic(this.ch[Math.min(c, this.nch - 1)], p);
  }
  _beats(outs, n) {
    const S = this.slices, T = this.sliceT;
    for (let i = 0; i < n; i++) {
      const t = (this.n + i) / this.outRate;
      // slice whose start time has passed (by output time: exact onset placement)
      while (this.sj + 1 < S.length && T[this.sj + 1] <= t) this.sj++;
      while (this.sj > 0 && T[this.sj] > t) this.sj--;
      const j = this.sj;
      const since = (t - T[j]) * this.outRate;
      for (let c = 0; c < outs.length; c++) {
        let v = this._sliceSample(j, t, c);
        if (j > 0 && since < this.xfade) v += (1 - since / this.xfade) * this._sliceSample(j - 1, t, c);
        outs[c][i] = v;
      }
    }
  }

  // ---------------------------------------------------------------- WSOLA (tones / complex)
  _initWsola(quality) {
    const q = (QUALITY[this.mode] || QUALITY.tones)[quality] || QUALITY[this.mode].normal;
    let N = Math.max(256, Math.round(q[0] * this.outRate));
    N += N % 4 ? 4 - (N % 4) : 0;
    this.N = N;
    this.ov = q[1];
    this.Hs = N / this.ov;
    this.tol = Math.max(16, Math.round(q[2] * this.srcRate));
    this.D = q[3]; // correlation decimation
    this.win = new Float32Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); // periodic Hann: Σ = ov/2
    this.norm = 2 / this.ov;
    this.r = this.P * (this.srcRate / this.outRate); // source samples per output sample inside a grain
    this.mono = this.nch > 1 ? (() => { const m = new Float32Array(this.srcLen); for (const x of this.ch) for (let i = 0; i < m.length; i++) m[i] += x[i] / this.nch; return m; })() : this.ch[0];
    // accumulator: acc[c][i] = output sample (accBase + i)
    this.accLen = N * 2;
    this.acc = Array.from({ length: Math.max(2, this.nch) }, () => new Float32Array(this.accLen));
    this.accBase = -(N - this.Hs); // first grain starts here
    this.k = 0; // next grain index
    this.prevA = null;
    this.order = Math.max(8, Math.min(32, Math.round(this.srcRate / 2500) + 2));
    this.gbuf = new Float32Array(N);
  }
  /** Output sample index where grain k starts. */
  _gStart(k) { return k * this.Hs - (this.N - this.Hs); }

  _wsola(outs, n) {
    const end = this.n + n; // produce samples [this.n, end)
    // a sample is final once every grain covering it was added: grains are added while they start before `end`
    while (this._gStart(this.k) < end) this._grain();
    for (let i = 0; i < n; i++) {
      const idx = this.n + i - this.accBase;
      for (let c = 0; c < outs.length; c++) outs[c][i] = this.acc[c][idx] * this.norm;
    }
    // drop the samples just output (everything before `end` is final)
    this._shift(end - this.accBase);
  }
  _shift(d) {
    if (d <= 0) return;
    for (const a of this.acc) { if (d >= a.length) a.fill(0); else { a.copyWithin(0, d); a.fill(0, a.length - d); } }
    this.accBase += d;
  }

  _corr(a0, b0, len) {
    const m = this.mono, r = this.r, D = this.D;
    let s = 0;
    for (let i = 0; i < len; i += D) {
      const ia = Math.floor(a0 + i * r), ib = Math.floor(b0 + i * r);
      if (ia < 0 || ib < 0 || ia >= m.length || ib >= m.length) continue;
      s += m[ia] * m[ib];
    }
    return s;
  }

  _grain() {
    const { N, Hs, r } = this;
    const o = this._gStart(this.k);
    // nominal source start: the grain centre follows the curve
    const tc = (o + N / 2) / this.outRate;
    const nominal = this.s(tc) * this.srcRate - (N / 2) * r;
    let a = nominal;
    if (this.prevA != null) {
      const target = this.prevA + Hs * r; // natural continuation of the previous grain
      if (Math.abs(target - nominal) < this.tol * 4) {
        const len = N - Hs; // overlapping part
        let best = -Infinity, bestD = 0;
        const coarse = Math.max(2, this.D);
        for (let d = -this.tol; d <= this.tol; d += coarse) { const v = this._corr(nominal + d, target, len); if (v > best) { best = v; bestD = d; } }
        const c0 = bestD;
        for (let d = c0 - coarse + 1; d < c0 + coarse; d++) { if (d < -this.tol || d > this.tol || d === c0) continue; const v = this._corr(nominal + d, target, len); if (v > best) { best = v; bestD = d; } }
        a = nominal + bestD;
      }
    }
    this.prevA = a;
    // make room in the accumulator (grow: samples before `o` may not have been output yet)
    const need = o + N - this.accBase;
    if (need > this.accLen) {
      this.accLen = Math.ceil(need * 1.5);
      this.acc = this.acc.map((old) => { const z = new Float32Array(this.accLen); z.set(old); return z; });
    }
    const base = o - this.accBase;
    const w = this.win, g = this.gbuf;
    let A = null;
    if (this.formants) {
      // LPC on the source span the grain reads (mono, Hann-windowed)
      const L = Math.min(4096, Math.max(64, Math.round(N * r)));
      const fr = new Float32Array(L);
      for (let i = 0; i < L; i++) fr[i] = readLin(this.mono, a + i * (N * r / L)) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / L));
      A = lpc(fr, this.order);
    }
    for (let c = 0; c < this.acc.length; c++) {
      const x = this.ch[Math.min(c, this.nch - 1)];
      if (A) this._formantGrain(x, a, A, g);
      else for (let i = 0; i < N; i++) g[i] = readCubic(x, a + i * r);
      const acc = this.acc[c];
      for (let i = 0; i < N; i++) { const j = base + i; if (j >= 0 && j < acc.length) acc[j] += w[i] * g[i]; }
    }
    this.k++;
  }

  /** Grain with the source's spectral envelope kept: residual (A(z)·x) resampled by r, then 1/A(z). */
  _formantGrain(x, a, A, g) {
    const { N, r, order: p } = this;
    const warm = 2 * p;
    const s0 = Math.floor(a) - p - 2;
    const span = Math.ceil((N + warm) * r) + p + 8;
    const res = new Float32Array(span);
    for (let m = 0; m < span; m++) {
      const idx = s0 + m;
      let v = idx >= 0 && idx < x.length ? x[idx] : 0;
      for (let i = 1; i <= p; i++) { const k = idx - i; if (k >= 0 && k < x.length) v += A[i] * x[k]; }
      res[m] = v;
    }
    // synthesis 1/A(z) at the output rate, warmed up for `warm` samples before the grain
    const hist = new Float64Array(p);
    let h = 0;
    for (let i = -warm; i < N; i++) {
      const e = readCubic(res, a + i * r - s0);
      let y = e;
      for (let k = 1; k <= p; k++) y -= A[k] * hist[(h - k + p * 4) % p];
      hist[h % p] = y; h++;
      if (i >= 0) g[i] = y;
    }
  }
}

/** One-shot offline warp (cache / export / tests). -> Float32Array[] of round(curve duration · outRate) frames. */
export function renderWarp(opts) { return new WarpRenderer(opts).renderAll(); }
