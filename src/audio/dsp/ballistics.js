// Level-meter ballistics and scales (pure JS, Node-testable; used by the mixer strip meters).
//
//   METER_MODES                         [{id, label, short, kind, …}] — digital peak, RMS, VU, PPM (BBC / EBU / DIN /
//                                       Nordic), K-system (K-20 / K-14 / K-12)
//   new Ballistics(mode, sampleRate, opts)
//       .process(samples[, from, to])   run the detector sample by sample
//       .idle(seconds)                  silence for `seconds` (fall-back without per-sample work where it is exact)
//       .feed(block, dt)                analyser block of the most recent samples, `dt` s after the previous feed:
//                                       processes only the samples not seen before; a longer gap idles first
//       .db                             reading in "sine-peak dBFS": a steady sine whose peak is at X dBFS reads X on
//                                       every meter except plain RMS (which reads X − 3.01, the true RMS)
//   meterScale(mode, opts)              {lo, hi (dBFS), ticks: [{db, label}], zones: [{from, to, level}], unit,
//                                       pos(db) -> 0…1, label(db) -> reading in the meter's own units}
//
// Ballistics:
//   peak   instant attack, fall 20 dB in 1.7 s (IEC 60268-18 digital meter)
//   rms    true RMS, exponential average, 300 ms time constant
//   vu     full-wave rectified average into a 2nd-order system: 99 % of the reading after 300 ms, ~1.5 % overshoot
//          (IEC 60268-17 / ANSI C16.5); 0 VU = a sine at `vuRef` dBFS peak (default −18)
//   ppm    quasi-peak: attack calibrated so a tone burst as long as the integration time reads 2 dB under the steady
//          tone (IEC 60268-10 definition), log-linear fall. Type I (DIN 45406, Nordic N9): 5 ms, 20 dB in 1.7 s.
//          Type II (BBC IIa, EBU IIb): 10 ms, 24 dB in 2.8 s. Scales reference the alignment level `align`
//          (default −18 dBFS, EBU R68).
//   k      Bob Katz K-system: RMS (AES-17 sine-calibrated, 600 ms) with 0 on the scale at −K dBFS.

const LN10_20 = Math.LN10 / 20;
const dbOf = (lin) => (lin > 1e-10 ? 20 * Math.log10(lin) : -200);

export const METER_MODES = [
  { id: 'peak', label: 'Digital peak', short: 'PK', kind: 'peak', fall: 20 / 1.7, help: 'Sample peak, instant attack, 20 dB / 1.7 s fall (IEC 60268-18)' },
  { id: 'rms', label: 'RMS', short: 'RMS', kind: 'rms', tau: 0.3, help: 'True RMS level, 300 ms averaging' },
  { id: 'vu', label: 'VU', short: 'VU', kind: 'vu', help: 'Volume-unit meter: rectified average, 300 ms rise with slight overshoot; 0 VU = reference level' },
  { id: 'ppm-bbc', label: 'PPM BBC (IIa)', short: 'BBC', kind: 'ppm', integ: 0.010, fall: 24 / 2.8, scale: 'bbc', help: 'BBC quasi-peak meter: 10 ms integration, 24 dB / 2.8 s fall, marks 1–7 (4 = alignment)' },
  { id: 'ppm-ebu', label: 'PPM EBU (IIb)', short: 'EBU', kind: 'ppm', integ: 0.010, fall: 24 / 2.8, scale: 'ebu', help: 'EBU quasi-peak meter: 10 ms integration, 24 dB / 2.8 s fall, −12…+12 dB around TEST (alignment)' },
  { id: 'ppm-din', label: 'PPM DIN (I)', short: 'DIN', kind: 'ppm', integ: 0.005, fall: 20 / 1.7, scale: 'din', help: 'DIN 45406 quasi-peak meter: 5 ms integration, 20 dB / 1.7 s fall, −50…+5 dB (0 = permitted maximum, alignment + 9 dB)' },
  { id: 'ppm-nordic', label: 'PPM Nordic (I)', short: 'NOR', kind: 'ppm', integ: 0.005, fall: 20 / 1.7, scale: 'nordic', help: 'Nordic N9 quasi-peak meter: 5 ms integration, 20 dB / 1.7 s fall, −36…+12 dB around TEST (alignment)' },
  { id: 'k20', label: 'K-20', short: 'K20', kind: 'k', k: 20, tau: 0.6, help: 'K-system K-20 (film, wide dynamics): 0 = −20 dBFS RMS' },
  { id: 'k14', label: 'K-14', short: 'K14', kind: 'k', k: 14, tau: 0.6, help: 'K-system K-14 (pop / rock mastering): 0 = −14 dBFS RMS' },
  { id: 'k12', label: 'K-12', short: 'K12', kind: 'k', k: 12, tau: 0.6, help: 'K-system K-12 (broadcast): 0 = −12 dBFS RMS' },
];
export const meterMode = (id) => METER_MODES.find((m) => m.id === id) || METER_MODES[0];
export const METER_DEFAULTS = { vuRef: -18, align: -18 };

// ---------------------------------------------------------------- VU: 2nd-order step response
export const VU_ZETA = 0.8; // overshoot exp(-πζ/√(1-ζ²)) ≈ 1.5 %
/** Continuous step response of the VU system (ζ = VU_ZETA) at time t for natural frequency w. */
export function vuStep(t, w, zeta = VU_ZETA) {
  const wd = w * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + (zeta / Math.sqrt(1 - zeta * zeta)) * Math.sin(wd * t));
}
/** Natural frequency (rad/s) for which the step response first reaches 99 % at exactly 300 ms. */
export const VU_OMEGA = (() => {
  let t = 0;
  while (vuStep(t, 1) < 0.99) t += 1e-4;
  // refine between t - 1e-4 and t
  let a = t - 1e-4, b = t;
  for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (vuStep(m, 1) < 0.99) a = m; else b = m; }
  return ((a + b) / 2) / 0.3;
})();

// ---------------------------------------------------------------- PPM attack calibration
const ppmCache = new Map();
/** Release factor per sample for a log-linear fall of `dbPerSec`. */
const fallCoef = (dbPerSec, sr) => Math.exp(-(dbPerSec / sr) * LN10_20);
/** Reading of a quasi-peak detector (attack coefficient `a`, release factor `kf`) after `sec` of a unit sine. */
function toneReading(a, kf, sr, sec, freq) {
  let env = 0;
  const w = (2 * Math.PI * freq) / sr;
  const n = Math.round(sec * sr);
  for (let i = 0; i < n; i++) { const r = Math.abs(Math.sin(w * i)); env = r > env ? env + (r - env) * a : env * kf; }
  return env;
}
/**
 * Quasi-peak detector calibration -> {a, gain}: attack coefficient (per sample) such that a 5 kHz tone burst lasting
 * `integ` seconds reads 2 dB below the steady tone (IEC 60268-10 integration time), and the gain that makes a steady
 * 1 kHz sine read its peak level.
 */
export function ppmAttack(integ, sr, fallDbPerSec) {
  const key = `${integ}|${sr}|${fallDbPerSec}`;
  if (ppmCache.has(key)) return ppmCache.get(key);
  const kf = fallCoef(fallDbPerSec, sr);
  const want = Math.pow(10, -2 / 20);
  let lo = 1e-6, hi = 1; // reading grows with a
  for (let i = 0; i < 40; i++) {
    const m = Math.sqrt(lo * hi);
    if (toneReading(m, kf, sr, integ, 5000) / toneReading(m, kf, sr, 0.5, 5000) < want) lo = m; else hi = m;
  }
  const a = Math.sqrt(lo * hi);
  const out = { a, gain: 1 / toneReading(a, kf, sr, 0.5, 1000) };
  ppmCache.set(key, out);
  return out;
}

// ---------------------------------------------------------------- detector
export class Ballistics {
  constructor(mode = 'peak', sampleRate = 48000, opts = {}) {
    this.mode = meterMode(mode);
    this.sr = sampleRate;
    this.opts = { ...METER_DEFAULTS, ...opts };
    const m = this.mode;
    if (m.kind === 'peak') this.kf = fallCoef(m.fall, sampleRate);
    if (m.kind === 'rms' || m.kind === 'k') this.a = 1 - Math.exp(-1 / (m.tau * sampleRate));
    if (m.kind === 'ppm') { this.kf = fallCoef(m.fall, sampleRate); const c = ppmAttack(m.integ, sampleRate, m.fall); this.a = c.a; this.gain = c.gain; }
    if (m.kind === 'vu') { this.w = VU_OMEGA; this.dt = 1 / sampleRate; }
    this.reset();
  }
  reset() { this.env = 0; this.v = 0; this.peak = 0; }

  process(x, from = 0, to = x.length) {
    const k = this.mode.kind;
    let env = this.env, pk = this.peak;
    if (k === 'peak') {
      const kf = this.kf;
      for (let i = from; i < to; i++) { const r = x[i] < 0 ? -x[i] : x[i]; env *= kf; if (r > env) env = r; if (r > pk) pk = r; }
    } else if (k === 'rms' || k === 'k') {
      const a = this.a;
      for (let i = from; i < to; i++) { const s = x[i]; env += (s * s - env) * a; const r = s < 0 ? -s : s; if (r > pk) pk = r; }
    } else if (k === 'ppm') {
      const a = this.a, kf = this.kf;
      for (let i = from; i < to; i++) { const r = x[i] < 0 ? -x[i] : x[i]; env = r > env ? env + (r - env) * a : env * kf; if (r > pk) pk = r; }
    } else if (k === 'vu') {
      // y'' + 2ζω y' + ω² y = ω² |x|   (semi-implicit Euler at audio rate: ω·dt ≈ 3e-4, exact to well under 0.01 dB)
      const w2 = this.w * this.w, c = 2 * VU_ZETA * this.w, dt = this.dt;
      let v = this.v;
      for (let i = from; i < to; i++) { const r = x[i] < 0 ? -x[i] : x[i]; v += dt * (w2 * (r - env) - c * v); env += dt * v; if (r > pk) pk = r; }
      this.v = v;
    }
    this.env = env;
    this.peak = pk;
    return this;
  }

  /** `seconds` of digital silence. */
  idle(seconds) {
    const n = Math.max(0, Math.round(seconds * this.sr));
    if (!n) return this;
    const k = this.mode.kind;
    if (k === 'peak' || k === 'ppm') this.env *= Math.pow(this.kf, n);
    else if (k === 'rms' || k === 'k') this.env *= Math.pow(1 - this.a, n);
    else if (k === 'vu') {
      if (n > this.sr * 3) { this.env = 0; this.v = 0; } else { const z = new Float32Array(Math.min(n, 4096)); for (let left = n; left > 0; left -= z.length) this.process(z, 0, Math.min(z.length, left)); }
    }
    return this;
  }

  /**
   * Feed the latest analyser block (`block` = the most recent block.length samples) `dt` seconds after the previous
   * feed: only the new samples are processed; when more time passed than the block covers, the gap counts as silence.
   */
  feed(block, dt) {
    const n = Math.max(0, Math.round(dt * this.sr));
    const len = block.length;
    if (n > len) { this.idle((n - len) / this.sr); this.process(block); }
    else this.process(block, len - n, len);
    return this;
  }

  /** Reading in sine-peak dBFS (see the header). */
  get db() {
    const k = this.mode.kind;
    if (k === 'peak') return dbOf(this.env);
    if (k === 'ppm') return dbOf(this.env * this.gain);
    if (k === 'rms') return dbOf(Math.sqrt(Math.max(0, this.env)));
    if (k === 'k') return dbOf(Math.sqrt(Math.max(0, this.env)) * Math.SQRT2); // AES-17: sine reads its peak level
    if (k === 'vu') return dbOf(Math.max(0, this.env) * (Math.PI / 2)); // rectified average of a sine = 2/π · peak
    return -200;
  }
  /** Linear amplitude of the reading. */
  get level() { const d = this.db; return d <= -199 ? 0 : Math.pow(10, d / 20); }
  /** Sample peak seen since the last takePeak() (for clip LEDs / peak hold). */
  takePeak() { const p = this.peak; this.peak = 0; return p; }
}

/** Two detectors (L / R) plus a fast digital-peak pair for the secondary bar of averaging meters. */
export class StereoBallistics {
  constructor(mode, sampleRate, opts = {}) {
    this.mode = meterMode(mode);
    this.ch = [new Ballistics(mode, sampleRate, opts), new Ballistics(mode, sampleRate, opts)];
    this.fast = this.mode.kind === 'peak' ? null : [new Ballistics('peak', sampleRate), new Ballistics('peak', sampleRate)];
  }
  feed(l, r, dt) {
    this.ch[0].feed(l, dt); this.ch[1].feed(r || l, dt);
    if (this.fast) { this.fast[0].feed(l, dt); this.fast[1].feed(r || l, dt); }
    return this;
  }
  idle(sec) { for (const b of this.ch) b.idle(sec); if (this.fast) for (const b of this.fast) b.idle(sec); return this; }
  read() {
    const [a, b] = this.ch;
    const pa = a.takePeak(), pb = b.takePeak();
    if (this.fast) { this.fast[0].takePeak(); this.fast[1].takePeak(); }
    return {
      db: [a.db, b.db],
      peakDb: this.fast ? [this.fast[0].db, this.fast[1].db] : [a.db, b.db],
      samplePeak: [pa, pb],
    };
  }
}

// ---------------------------------------------------------------- scales
const fmt = (v, d = 0) => (v > 0.05 ? '+' : v < -0.05 ? '−' : '') + Math.abs(v).toFixed(d);

/**
 * Display scale of a mode. All positions are in sine-peak dBFS (the detector's `db`); labels and readings are in the
 * meter's own units. opts: {vuRef = −18 (dBFS of 0 VU), align = −18 (dBFS of the PPM alignment / TEST level)}.
 */
export function meterScale(modeId, opts = {}) {
  const m = meterMode(modeId);
  const { vuRef, align } = { ...METER_DEFAULTS, ...opts };
  let lo, hi, ticks, zones, unit, label;
  const rel = (ref, list, lab = (d) => fmt(d)) => list.map((d) => ({ db: ref + d, label: lab(d) }));
  switch (m.kind === 'ppm' ? m.scale : m.kind) {
    case 'vu':
      lo = vuRef - 20; hi = vuRef + 3; unit = 'VU';
      ticks = rel(vuRef, [-20, -10, -7, -5, -3, -1, 0, 1, 2, 3]);
      zones = [{ from: lo, to: vuRef, level: 'ok' }, { from: vuRef, to: hi, level: 'hot' }];
      label = (db) => fmt(db - vuRef, 1);
      break;
    case 'bbc': {
      // marks 1–7: 4 = alignment, 4 dB per mark from 2 to 7, mark 1 six dB under mark 2
      lo = align - 14; hi = align + 12; unit = 'PPM';
      ticks = [1, 2, 3, 4, 5, 6, 7].map((k) => ({ db: align + (k === 1 ? -14 : (k - 4) * 4), label: String(k) }));
      zones = [{ from: lo, to: align + 8, level: 'ok' }, { from: align + 8, to: hi, level: 'hot' }]; // mark 6 = permitted maximum
      label = (db) => { const d = db - align; const k = d <= -8 ? 1 + (d + 14) / 6 : 4 + d / 4; return Math.max(0, k).toFixed(1); };
      break;
    }
    case 'ebu':
      lo = align - 12; hi = align + 12; unit = 'dB';
      ticks = rel(align, [-12, -8, -4, 0, 4, 8, 12], (d) => (d === 0 ? 'TEST' : fmt(d)));
      zones = [{ from: lo, to: align + 9, level: 'ok' }, { from: align + 9, to: hi, level: 'hot' }];
      label = (db) => fmt(db - align, 1);
      break;
    case 'din': {
      const pml = align + 9; // 0 dB on a DIN meter = permitted maximum level
      lo = pml - 50; hi = pml + 5; unit = 'dB';
      ticks = rel(pml, [-50, -40, -30, -20, -10, -5, 0, 5]);
      zones = [{ from: lo, to: pml, level: 'ok' }, { from: pml, to: hi, level: 'hot' }];
      label = (db) => fmt(db - pml, 1);
      break;
    }
    case 'nordic':
      lo = align - 36; hi = align + 12; unit = 'dB';
      ticks = rel(align, [-36, -30, -24, -18, -12, -6, 0, 6, 9, 12], (d) => (d === 0 ? 'TEST' : fmt(d)));
      zones = [{ from: lo, to: align + 9, level: 'ok' }, { from: align + 9, to: hi, level: 'hot' }];
      label = (db) => fmt(db - align, 1);
      break;
    case 'k': {
      const ref = -m.k;
      lo = ref - 40; hi = 0; unit = m.label;
      ticks = rel(ref, [-40, -30, -20, -10, -6, 0, 4, ...(m.k >= 14 ? [8] : []), m.k].filter((d) => ref + d >= lo && ref + d <= 0));
      zones = [{ from: lo, to: ref, level: 'ok' }, { from: ref, to: ref + 4, level: 'warn' }, { from: ref + 4, to: 0, level: 'hot' }];
      label = (db) => fmt(db - ref, 1);
      break;
    }
    default: // peak / rms in dBFS
      lo = -60; hi = m.kind === 'rms' ? 0 : 6; unit = 'dBFS';
      ticks = [-60, -48, -36, -24, -18, -12, -6, -3, 0].map((d) => ({ db: d, label: String(d) }));
      zones = [{ from: lo, to: -18, level: 'ok' }, { from: -18, to: -6, level: 'mid' }, { from: -6, to: 0, level: 'warn' }, { from: 0, to: hi, level: 'hot' }];
      label = (db) => (db <= -199 ? '−∞' : fmt(db, 1));
  }
  const pos = (db) => (db <= lo ? 0 : db >= hi ? 1 : (db - lo) / (hi - lo));
  return { mode: m, lo, hi, ticks, zones, unit, pos, label };
}
