// Loudness statistics on top of dsp/loudness.js (pure JS, Node-testable): short-term histogram, PLR / PSR, the
// "DR" dynamic-range figure, delivery-target checks and the full analysis of a finished render (export report).
//
//   new LoudnessHistogram({lo, hi, step})  add(lufs), bins, count, percentile(p), peakBin()
//   plr(truePeakDb, integrated)            peak-to-loudness ratio (LU) — null when either is not finite
//   psr(truePeakDb, shortTerm)             peak-to-short-term-loudness ratio (true peak over the same 3 s)
//   new PeakWindow(n)                      running max of the last n block peaks (3 s of 100 ms blocks for PSR)
//   drOf(blocks) / new DynamicRange()      DR (crest of the loudest 20 % of 3 s blocks vs. the 2nd-highest peak,
//                                          per channel, averaged) from {rms: [l, r], peak: [l, r]} blocks
//   checkTarget({integrated, truePeakDb}, target)  -> {status: 'pass'|'adjust'|'none', …} (see below)
//   analyzeRender(channels, sampleRate)    -> everything the export report shows
import { subblockEnergies, integratedOf, lraOf, loudnessOf, ABS_GATE } from './loudness.js';
import { truePeakEnvelope } from './truepeak.js';
import { analyzeUtility } from './utility-meters.js';
import { fft } from './fft.js';

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const dbOf = (lin) => (lin > 0 ? 20 * Math.log10(lin) : -Infinity);

// ---------------------------------------------------------------- histogram
/** Distribution of loudness values (short-term LUFS) in `step` LU bins from lo to hi; values below lo are ignored. */
export class LoudnessHistogram {
  constructor({ lo = -60, hi = 0, step = 1 } = {}) {
    this.lo = lo; this.hi = hi; this.step = step;
    this.bins = new Uint32Array(Math.ceil((hi - lo) / step));
    this.count = 0;
  }
  reset() { this.bins.fill(0); this.count = 0; }
  /** Bin index of a value (values ≥ hi go to the top bin), -1 when below `lo` / not finite. */
  index(v) {
    if (!fin(v) || v < this.lo) return -1;
    return Math.min(this.bins.length - 1, Math.floor((v - this.lo) / this.step));
  }
  add(v) { const i = this.index(v); if (i >= 0) { this.bins[i]++; this.count++; } return this; }
  /** Centre (LUFS) of bin i. */
  centre(i) { return this.lo + (i + 0.5) * this.step; }
  /** Value below which p % of the counted values fall (bin-centre resolution). */
  percentile(p) {
    if (!this.count) return null;
    const want = (p / 100) * this.count;
    let acc = 0;
    for (let i = 0; i < this.bins.length; i++) { acc += this.bins[i]; if (acc >= want && this.bins[i]) return this.centre(i); }
    return this.centre(this.bins.length - 1);
  }
  /** Index of the most populated bin (-1 when empty). */
  peakBin() {
    let m = -1, best = 0;
    for (let i = 0; i < this.bins.length; i++) if (this.bins[i] > best) { best = this.bins[i]; m = i; }
    return m;
  }
}

// ---------------------------------------------------------------- PLR / PSR
export const plr = (truePeakDb, integrated) => (fin(truePeakDb) && fin(integrated) ? truePeakDb - integrated : null);
export const psr = (truePeakDb, shortTerm) => (fin(truePeakDb) && fin(shortTerm) ? truePeakDb - shortTerm : null);

/** Running maximum of the last `n` values (linear block peaks). */
export class PeakWindow {
  constructor(n = 30) { this.n = n; this.v = []; }
  push(x) { this.v.push(x || 0); if (this.v.length > this.n) this.v.shift(); return this; }
  get max() { let m = 0; for (const x of this.v) if (x > m) m = x; return m; }
  get maxDb() { return dbOf(this.max); }
  reset() { this.v = []; }
}

// ---------------------------------------------------------------- DR
/**
 * DR value of 3 s blocks {rms: [l, r] (already ×√2, i.e. sine-calibrated), peak: [l, r]}: per channel the RMS of the
 * loudest 20 % of blocks against the second-highest block peak, DR = mean over channels (dB). null with < 1 block.
 */
export function drOf(blocks) {
  if (!blocks.length) return null;
  const nCh = blocks[0].rms.length;
  let sum = 0, used = 0;
  for (let c = 0; c < nCh; c++) {
    const rms = blocks.map((b) => b.rms[c]).sort((a, b) => b - a);
    const pk = blocks.map((b) => b.peak[c]).sort((a, b) => b - a);
    const top = Math.max(1, Math.floor(rms.length * 0.2));
    let e = 0;
    for (let i = 0; i < top; i++) e += rms[i] * rms[i];
    const r20 = Math.sqrt(e / top);
    const p2 = pk.length > 1 ? pk[1] : pk[0];
    if (r20 > 0 && p2 > 0) { sum += 20 * Math.log10(p2 / r20); used++; }
  }
  return used ? sum / used : null;
}

/** Streaming DR from 100 ms blocks {n, ss: [l, r] (sum of squares), pk: [l, r] (sample peak)}. */
export class DynamicRange {
  constructor(blocksPer = 30) { this.per = blocksPer; this.reset(); }
  reset() { this.blocks = []; this.acc = null; }
  push({ n, ss, pk }) {
    if (!this.acc) this.acc = { k: 0, n: 0, ss: [0, 0], pk: [0, 0] };
    const a = this.acc;
    a.k++; a.n += n;
    for (let c = 0; c < 2; c++) { a.ss[c] += ss[c] ?? ss[0]; a.pk[c] = Math.max(a.pk[c], pk[c] ?? pk[0]); }
    if (a.k >= this.per) {
      this.blocks.push({ rms: a.ss.map((s) => Math.sqrt((2 * s) / a.n)), peak: [...a.pk] });
      this.acc = null;
    }
    return this;
  }
  get value() { return drOf(this.blocks); }
}

/** DR of finished channels (3 s blocks; a final partial block counts when ≥ 1 s). */
export function dynamicRange(channels, sampleRate) {
  const len = Math.round(sampleRate * 3);
  const n = channels[0]?.length || 0;
  const blocks = [];
  for (let o = 0; o < n; o += len) {
    const e = Math.min(n, o + len);
    if (e - o < sampleRate && blocks.length) break;
    const rms = [], peak = [];
    for (const ch of channels.length > 1 ? channels.slice(0, 2) : [channels[0], channels[0]]) {
      let s = 0, p = 0;
      for (let i = o; i < e; i++) { const x = ch[i]; s += x * x; const a = x < 0 ? -x : x; if (a > p) p = a; }
      rms.push(Math.sqrt((2 * s) / (e - o))); peak.push(p);
    }
    blocks.push({ rms, peak });
  }
  return drOf(blocks);
}

// ---------------------------------------------------------------- delivery targets
/**
 * Check a measurement against a delivery target (LOUDNESS_PRESETS entry: lufs, ceiling, tol, kind, normalize).
 * -> {status: 'pass' | 'adjust' | 'none', delta (LU, measured − target), gainDb (to reach the target),
 *     loudnessOk, peakOk, playbackGainDb (what a normalising platform applies; null when it plays as is),
 *     playbackPeakDb (true peak after that), message}
 * pass = integrated within ±tol of the target and true peak ≤ ceiling. Streaming services that turn loud masters
 * down report how much; platforms that also turn quiet masters up only do so while the true peak stays under their
 * ceiling (else the master plays quieter than the target).
 */
export function checkTarget(m, t) {
  const I = m?.integrated, tp = m?.truePeakDb;
  if (!t || !fin(I)) return { status: 'none', delta: null, gainDb: null, loudnessOk: false, peakOk: fin(tp) ? tp <= (t?.ceiling ?? 0) + 0.05 : true, playbackGainDb: null, playbackPeakDb: null, message: 'Not measured yet' };
  const tol = t.tol ?? 1;
  const delta = I - t.lufs;
  const loudnessOk = Math.abs(delta) <= tol + 1e-9;
  const peakOk = !fin(tp) || tp <= t.ceiling + 0.05;
  let playbackGainDb = null;
  if (t.normalize === 'down') playbackGainDb = Math.min(0, -delta);
  else if (t.normalize === 'both') playbackGainDb = delta > 0 ? -delta : Math.min(-delta, fin(tp) ? Math.max(0, t.ceiling - tp) : -delta);
  const playbackPeakDb = playbackGainDb != null && fin(tp) ? tp + playbackGainDb : null;
  const status = loudnessOk && peakOk ? 'pass' : 'adjust';
  const f1 = (x) => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(1);
  const parts = [];
  if (!loudnessOk) {
    if (playbackGainDb != null && delta > 0) parts.push(`${f1(delta)} LU loud — played ${f1(playbackGainDb)} dB`);
    else if (playbackGainDb != null && delta < 0 && playbackGainDb < -delta - 0.05) parts.push(`${f1(delta)} LU quiet — only ${f1(playbackGainDb)} dB of peak headroom to turn it up`);
    else parts.push(`${f1(delta)} LU ${delta > 0 ? 'over' : 'under'} target`);
  }
  if (!peakOk) parts.push(`true peak ${f1(tp - t.ceiling)} dB over ${t.ceiling} dBTP`);
  return { status, delta, gainDb: -delta, loudnessOk, peakOk, playbackGainDb, playbackPeakDb, message: parts.length ? parts.join(' · ') : `Within ±${tol} LU, peak OK` };
}

// ---------------------------------------------------------------- render analysis (export report)
function windows(sub, len) {
  const out = [];
  let acc = 0;
  for (let i = 0; i < sub.length; i++) {
    acc += sub[i];
    if (i >= len) acc -= sub[i - len];
    if (i >= len - 1) out.push(acc / len);
  }
  return out;
}

/** Long-term average spectrum (dB, Hann, mono sum) at `points` log-spaced frequencies from 20 Hz to 20 kHz. */
export function averageSpectrum(channels, sampleRate, { size = 4096, maxFrames = 300, points = 64 } = {}) {
  const n = channels[0]?.length || 0;
  const frames = Math.max(0, Math.floor((n - size) / (size / 2)) + 1);
  const pow = new Float64Array(size / 2);
  const win = new Float64Array(size);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  const step = frames > maxFrames ? frames / maxFrames : 1;
  let used = 0;
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let f = 0; f < frames; f += step) {
    const o = Math.floor(f) * (size / 2);
    for (let i = 0; i < size; i++) {
      let s = 0;
      for (const ch of channels) s += ch[o + i];
      re[i] = (s / channels.length) * win[i]; im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < size / 2; k++) pow[k] += re[k] * re[k] + im[k] * im[k];
    used++;
  }
  const binHz = sampleRate / size;
  const norm = used ? 16 / (used * size * size) : 1; // Hann: a full-scale sine peaks at N/4 -> 0 dB
  const out = [];
  for (let p = 0; p < points; p++) {
    const f0 = 20 * Math.pow(1000, p / points), f1 = 20 * Math.pow(1000, (p + 1) / points);
    const b0 = Math.max(1, Math.floor(f0 / binHz)), b1 = Math.max(b0 + 1, Math.ceil(f1 / binHz));
    let mx = 0;
    for (let b = b0; b < b1 && b < pow.length; b++) if (pow[b] > mx) mx = pow[b];
    out.push({ f: Math.sqrt(f0 * f1), db: mx > 0 ? Math.max(-140, 10 * Math.log10(mx * norm)) : -140 });
  }
  return out;
}

/**
 * Everything the export report shows about finished channels:
 * {integrated, lra, truePeakDb, samplePeakDb, momentaryMax, shortTermMax, plr, psrMin, dr, clips, dcOffset (worst |dc|,
 *  linear), dcDb, dc: [l, r], bits, duration, shortTerm: [LUFS every 100 ms (3 s windows)], momentary: [LUFS every
 *  100 ms], histogram: {lo, step, bins}, spectrum: [{f, db}]}
 */
export function analyzeRender(channels, sampleRate) {
  const sub = subblockEnergies(channels, sampleRate);
  const mom = windows(sub, 4);
  const st = windows(sub, 30);
  const env = truePeakEnvelope(channels);
  const hop = Math.round(sampleRate / 10);
  const blockTp = new Float64Array(sub.length);
  let tp = 0;
  for (let i = 0; i < env.length; i++) { if (env[i] > tp) tp = env[i]; const b = Math.floor(i / hop); if (b < blockTp.length && env[i] > blockTp[b]) blockTp[b] = env[i]; }
  let sp = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) { const a = ch[i] < 0 ? -ch[i] : ch[i]; if (a > sp) sp = a; }
  const integrated = integratedOf(mom);
  const truePeakDb = dbOf(tp);
  // PSR per 3 s window (true peak over the same window), lowest over the gated windows
  let psrMin = null;
  const win = new PeakWindow(30);
  for (let i = 0; i < blockTp.length; i++) {
    win.push(blockTp[i]);
    if (i >= 29) {
      const L = loudnessOf(st[i - 29]);
      if (L > ABS_GATE) { const v = win.maxDb - L; if (psrMin == null || v < psrMin) psrMin = v; }
    }
  }
  const hist = new LoudnessHistogram();
  for (const e of st) { const L = loudnessOf(e); if (L > ABS_GATE) hist.add(L); }
  const util = analyzeUtility(channels.length > 1 ? channels : [channels[0], channels[0]]);
  return {
    integrated, lra: lraOf(st), truePeakDb, samplePeakDb: dbOf(sp),
    momentaryMax: mom.length ? loudnessOf(Math.max(...mom)) : -Infinity,
    shortTermMax: st.length ? loudnessOf(Math.max(...st)) : -Infinity,
    plr: plr(truePeakDb, integrated), psrMin, dr: dynamicRange(channels, sampleRate),
    clips: util.clips, dc: util.dc, dcOffset: Math.max(Math.abs(util.dc[0]), Math.abs(util.dc[1])), dcDb: util.dcDb, bits: util.bits,
    duration: (channels[0]?.length || 0) / sampleRate,
    shortTerm: st.map(loudnessOf), momentary: mom.map(loudnessOf),
    histogram: { lo: hist.lo, step: hist.step, bins: [...hist.bins] },
    spectrum: averageSpectrum(channels, sampleRate),
  };
}

/** Report rows ([label, value]) of analyzeRender() output, plus an optional target check. */
export function analysisRows(a, target = null) {
  const f1 = (x, u) => (fin(x) ? `${x.toFixed(1)} ${u}` : `−∞ ${u}`);
  const rows = [
    ['PLR', a.plr != null ? `${a.plr.toFixed(1)} LU` : '—'],
    ['PSR (min)', a.psrMin != null ? `${a.psrMin.toFixed(1)} LU` : '—'],
    ['Dynamic range', a.dr != null ? `DR${Math.round(a.dr)} (${a.dr.toFixed(1)} dB)` : '—'],
    ['Clips', a.clips.total ? `${a.clips.total} (longest run ${a.clips.longest} samples)` : 'none'],
    ['DC offset', fin(a.dcDb) ? `${(a.dcOffset * 100).toFixed(3)} % (${a.dcDb.toFixed(1)} dBFS)` : 'none'],
  ];
  if (target) {
    const c = checkTarget(a, target);
    rows.push([`Target ${target.label}`, `${c.status === 'pass' ? 'PASS' : c.status === 'adjust' ? 'ADJUST' : '—'} · ${c.message}`]);
  }
  return rows;
}

/** JSON-ready report object (series rounded to 0.1 LU, spectrum to 0.1 dB). */
export function analysisJson(a, extra = {}) {
  const r1 = (x) => (fin(x) ? Math.round(x * 10) / 10 : null);
  return {
    ...extra,
    integratedLufs: r1(a.integrated), lraLu: r1(a.lra), truePeakDbtp: r1(a.truePeakDb), samplePeakDbfs: r1(a.samplePeakDb),
    maxMomentaryLufs: r1(a.momentaryMax), maxShortTermLufs: r1(a.shortTermMax), plrLu: r1(a.plr), psrMinLu: r1(a.psrMin), dr: r1(a.dr),
    clips: a.clips, dcOffset: a.dc.map((x) => Math.round(x * 1e6) / 1e6), bits: { effective: a.bits.effective, float: a.bits.float, verdict: a.bits.verdict },
    durationSec: Math.round(a.duration * 1000) / 1000,
    shortTermLufs: a.shortTerm.filter((_, i) => i % 10 === 0).map(r1), // one value per second
    histogram: a.histogram,
    spectrum: a.spectrum.map((p) => ({ hz: Math.round(p.f), db: r1(p.db) })),
  };
}
