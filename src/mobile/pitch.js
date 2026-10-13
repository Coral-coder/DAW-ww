// Hum / whistle to notes — pure DSP (Node-safe, no Web Audio): YIN pitch detection (FFT-accelerated difference
// function), frame tracking, note segmentation (energy onsets + pitch stability, glide merge, octave-error
// correction, confidence gating), tempo-grid quantization and scale snapping.
//
//   const frames = trackPitch(samples, sampleRate)          [{time, freq, conf, rms}]
//   const notes  = segmentNotes(frames)                      [{start, dur, midi (float), pitch, vel, conf}] (seconds)
//   const beats  = quantizeNotes(notes, {bpm, grid: 0.25})   [{pitch, start, dur, vel}] (beats)
//   snapNotesToScale(beats, root, scale)

export const MIN_FREQ = 70; // hum: ~80 Hz (low male voice) with some margin
export const MAX_FREQ = 3200; // whistle: up to ~3 kHz

export const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);
export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const centsBetween = (f, ref) => 1200 * Math.log2(f / ref);

// ------------------------------------------------------------------------------------------------ FFT
const twiddles = new Map();
function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  let tw = twiddles.get(n);
  if (!tw) {
    tw = { c: new Float64Array(n / 2), s: new Float64Array(n / 2) };
    for (let k = 0; k < n / 2; k++) { tw.c[k] = Math.cos((2 * Math.PI * k) / n); tw.s[k] = Math.sin((2 * Math.PI * k) / n); }
    twiddles.set(n, tw);
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const wr = tw.c[k * step], wi = sign * tw.s[k * step];
        const a = i + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

/** Analysis geometry for a sample rate: integration window W, lag range, frame length. */
export function yinGeometry(sampleRate, { minFreq = MIN_FREQ, maxFreq = MAX_FREQ } = {}) {
  const tauMax = Math.ceil(sampleRate / minFreq) + 2;
  const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq) - 1);
  const W = Math.max(tauMax, nextPow2(Math.round(sampleRate * 0.02)));
  return { W, tauMin, tauMax, frameLength: W + tauMax };
}

/**
 * YIN on one frame (buf[offset .. offset + W + tauMax)). Returns {freq, conf (0..1), rms}; freq 0 = unvoiced.
 * Difference function via FFT cross-correlation + prefix energy sums (O(N log N) per frame).
 */
export function yin(buf, sampleRate, opts = {}) {
  const { threshold = 0.15, offset = 0 } = opts;
  const g = opts.geometry || yinGeometry(sampleRate, opts);
  const { W, tauMin } = g;
  const tauMax = Math.min(g.tauMax, buf.length - offset - W);
  if (tauMax <= tauMin + 2) return { freq: 0, conf: 0, rms: 0 };
  const L = W + tauMax;
  const N = nextPow2(L);
  const aRe = new Float64Array(N), aIm = new Float64Array(N), bRe = new Float64Array(N), bIm = new Float64Array(N);
  const pre = new Float64Array(L + 1);
  for (let i = 0; i < L; i++) {
    const x = buf[offset + i];
    bRe[i] = x;
    if (i < W) aRe[i] = x;
    pre[i + 1] = pre[i] + x * x;
  }
  const e0 = pre[W];
  const rms = Math.sqrt(e0 / W);
  if (e0 < 1e-10) return { freq: 0, conf: 0, rms };
  fft(aRe, aIm); fft(bRe, bIm);
  for (let k = 0; k < N; k++) { // conj(A) * B
    const r = aRe[k] * bRe[k] + aIm[k] * bIm[k];
    const im = aRe[k] * bIm[k] - aIm[k] * bRe[k];
    aRe[k] = r; aIm[k] = im;
  }
  fft(aRe, aIm, true);
  // cumulative-mean-normalized difference d'(tau)
  const dn = new Float64Array(tauMax + 1);
  dn[0] = 1;
  let cum = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    const d = Math.max(0, e0 + (pre[tau + W] - pre[tau]) - 2 * aRe[tau]);
    cum += d;
    dn[tau] = cum > 0 ? (d * tau) / cum : 1;
  }
  let tau = -1;
  for (let t = tauMin; t < tauMax; t++) {
    if (dn[t] < threshold) {
      while (t + 1 < tauMax && dn[t + 1] < dn[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) { // no dip under the threshold: global minimum, low confidence
    let best = tauMin;
    for (let t = tauMin; t < tauMax; t++) if (dn[t] < dn[best]) best = t;
    tau = best;
  }
  if (tau <= tauMin || tau >= tauMax) return { freq: 0, conf: 0, rms };
  const s0 = dn[tau - 1], s1 = dn[tau], s2 = dn[tau + 1];
  const den = s0 + s2 - 2 * s1;
  const shift = den > 0 ? Math.max(-1, Math.min(1, (s0 - s2) / (2 * den))) : 0;
  const conf = Math.max(0, Math.min(1, 1 - s1));
  return { freq: sampleRate / (tau + shift), conf, rms };
}

/** Pitch track of a whole recording: frames every `hopSec` -> [{time (frame centre, s), freq, conf, rms}]. */
export function trackPitch(samples, sampleRate, opts = {}) {
  const geometry = yinGeometry(sampleRate, opts);
  const hop = Math.max(1, Math.round(sampleRate * (opts.hopSec ?? 0.01)));
  const out = [];
  for (let off = 0; off + geometry.frameLength <= samples.length; off += hop) {
    const r = yin(samples, sampleRate, { ...opts, geometry, offset: off });
    out.push({ time: (off + geometry.W / 2) / sampleRate, ...r });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ segmentation
function median(arr) {
  if (!arr.length) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Pitch frames -> notes (seconds). opts: {minConf 0.6, minRms (absolute gate), relGate 0.08 (of the loudest frame),
 * minNoteSec 0.08, maxGapSec 0.05, jump 0.7 semitones (pitch change that starts a new note), stableSec 0.04
 * (how long the new pitch must hold), octaveRunSec 0.12 (shorter octave jumps are folded back as errors)}.
 */
export function segmentNotes(frames, opts = {}) {
  if (!frames?.length) return [];
  const hop = frames.length > 1 ? frames[1].time - frames[0].time : 0.01;
  const minConf = opts.minConf ?? 0.6;
  const maxRms = frames.reduce((m, f) => Math.max(m, f.rms || 0), 0);
  const gate = Math.max(opts.minRms ?? 0.003, maxRms * (opts.relGate ?? 0.08));
  const jump = opts.jump ?? 0.7;
  const stableN = Math.max(2, Math.round((opts.stableSec ?? 0.04) / hop));
  const maxGapN = Math.max(1, Math.round((opts.maxGapSec ?? 0.05) / hop));
  const minNote = opts.minNoteSec ?? 0.08;
  const n = frames.length;
  const midi = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    if (f.freq > 0 && f.conf >= minConf && f.rms >= gate) midi[i] = freqToMidi(f.freq);
  }
  // octave-error correction: short runs ~12/24 semitones off the local median fold back
  const R = 6;
  const flagged = new Int8Array(n);
  const localMed = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(midi[i])) continue;
    const win = [];
    for (let j = Math.max(0, i - R); j <= Math.min(n - 1, i + R); j++) if (!Number.isNaN(midi[j])) win.push(midi[j]);
    const med = median(win);
    localMed[i] = med;
    const k = Math.round((midi[i] - med) / 12);
    if (k !== 0 && Math.abs(midi[i] - med - 12 * k) < 1.5) flagged[i] = k;
  }
  const maxOctRun = Math.max(2, Math.round((opts.octaveRunSec ?? 0.12) / hop));
  for (let i = 0; i < n;) {
    if (!flagged[i]) { i++; continue; }
    let j = i;
    while (j < n && flagged[j] === flagged[i]) j++;
    if (j - i <= maxOctRun) for (let q = i; q < j; q++) midi[q] -= 12 * flagged[q];
    i = j;
  }
  // 3-point median smoothing (kills single-frame glitches)
  const sm = Float64Array.from(midi);
  for (let i = 1; i < n - 1; i++) {
    const t = [midi[i - 1], midi[i], midi[i + 1]];
    if (t.every((x) => !Number.isNaN(x))) sm[i] = median(t);
  }

  const raw = [];
  let cur = null, gap = 0, cand = [];
  const close = (endIdx) => { if (cur) { cur.end = endIdx; raw.push(cur); } cur = null; cand = []; };
  const open = (i) => { cur = { first: i, idx: [i], peak: frames[i].rms, onset: true }; cand = []; };
  for (let i = 0; i < n; i++) {
    const m = sm[i];
    if (Number.isNaN(m)) {
      gap++;
      if (cur && gap > maxGapN) close(i - gap + 1);
      continue;
    }
    const gapBefore = gap;
    gap = 0;
    if (!cur) { open(i); continue; }
    // energy onset: re-attack after a dip (repeated notes on the same pitch)
    let minRecent = Infinity;
    for (let j = Math.max(cur.first, i - 4); j < i; j++) minRecent = Math.min(minRecent, frames[j].rms);
    if (gapBefore === 0 && frames[i].rms > 2 * minRecent && minRecent < 0.5 * cur.peak && i - cur.first > stableN) {
      close(i);
      open(i);
      continue;
    }
    const ref = median(cur.idx.slice(-25).map((q) => sm[q])); // ~a vibrato period: vibrato never reads as a new note
    if (Math.abs(m - ref) > jump) {
      cand.push(i);
      const tail = cand.slice(-stableN).map((q) => sm[q]);
      if (cand.length >= stableN && Math.max(...tail) - Math.min(...tail) <= 0.5) {
        // the new pitch holds: the note changes where the move away began
        const startAt = cand[0];
        cur.idx = cur.idx.filter((q) => q < startAt);
        const moved = cand.slice();
        close(startAt);
        cur = { first: startAt, idx: moved, peak: Math.max(...moved.map((q) => frames[q].rms)), onset: false };
      }
      continue;
    }
    // back near the reference: the excursion was vibrato / a scoop — keep it in this note
    for (const q of cand) cur.idx.push(q);
    cand = [];
    cur.idx.push(i);
    cur.peak = Math.max(cur.peak, frames[i].rms);
  }
  if (cur) { for (const q of cand) cur.idx.push(q); close(n); }

  let notes = raw.map((r) => {
    const vals = r.idx.map((q) => sm[q]).filter((x) => !Number.isNaN(x));
    const med0 = median(vals);
    const core = vals.filter((x) => Math.abs(x - med0) <= 0.5);
    const mid = median(core.length ? core : vals);
    const start = frames[r.first].time - hop / 2;
    const lastIdx = Math.max(r.first, (r.end ?? n) - 1);
    const end = frames[Math.min(n - 1, lastIdx)].time + hop / 2;
    const confs = r.idx.map((q) => frames[q].conf);
    return { start, dur: end - start, midi: mid, pitch: Math.round(mid), peak: r.peak, onset: r.onset, conf: confs.reduce((a, b) => a + b, 0) / (confs.length || 1) };
  }).filter((x) => Number.isFinite(x.midi));
  // glide merge: neighbours on the same pitch with (almost) no gap and no re-attack are one note
  const merged = [];
  for (const nt of notes) {
    const prev = merged[merged.length - 1];
    if (prev && !nt.onset && (Math.abs(prev.midi - nt.midi) < 0.5 || Math.round(prev.midi) === Math.round(nt.midi)) && nt.start - (prev.start + prev.dur) < 0.06) {
      prev.dur = nt.start + nt.dur - prev.start;
      prev.peak = Math.max(prev.peak, nt.peak);
      continue;
    }
    merged.push({ ...nt });
  }
  notes = merged.filter((x) => x.dur >= minNote);
  const loud = notes.reduce((m, x) => Math.max(m, x.peak), 0) || 1;
  return notes.map(({ start, dur, midi: m, pitch, peak, conf }) => ({
    start: +start.toFixed(4), dur: +dur.toFixed(4), midi: +m.toFixed(3), pitch,
    vel: +Math.max(0.35, Math.min(1, 0.45 + 0.55 * (peak / loud))).toFixed(2), conf: +conf.toFixed(2),
  }));
}

// ------------------------------------------------------------------------------------------------ musical cleanup
/** Grid choices offered in the Hum sheet (beats). */
export const GRIDS = [
  { value: 0.5, label: '1/8' }, { value: 0.25, label: '1/16' }, { value: 1 / 3, label: '1/8T' }, { value: 1 / 6, label: '1/16T' }, { value: 0, label: 'Off' },
];

/**
 * Seconds -> beats on the tempo grid. opts {bpm, grid (beats, 0 = off), startSec (time of beat 0 in the take)}.
 * Monophonic: a note never overlaps the next one; two notes landing on the same step keep the longer.
 */
export function quantizeNotes(notes, { bpm = 120, grid = 0.25, startSec = 0 } = {}) {
  const bps = bpm / 60;
  const q = (b) => (grid > 0 ? Math.round(b / grid) * grid : b);
  let out = notes.map((nt) => {
    const sb = (nt.start - startSec) * bps, eb = (nt.start + nt.dur - startSec) * bps;
    const s = Math.max(0, q(sb));
    const e = Math.max(s + (grid > 0 ? grid : 0.05), q(eb));
    return { pitch: nt.pitch, start: s, dur: e - s, vel: nt.vel ?? 0.8, midi: nt.midi, _len: nt.dur };
  }).sort((a, b) => a.start - b.start);
  const res = [];
  for (const nt of out) {
    const prev = res[res.length - 1];
    if (prev && Math.abs(prev.start - nt.start) < 1e-6) { if (nt._len > prev._len) res[res.length - 1] = nt; continue; }
    res.push(nt);
  }
  for (let i = 0; i < res.length - 1; i++) if (res[i].start + res[i].dur > res[i + 1].start) res[i].dur = res[i + 1].start - res[i].start;
  out = res.map(({ pitch, start, dur, vel, midi }) => ({ pitch, start: +start.toFixed(5), dur: +dur.toFixed(5), vel, ...(midi !== undefined ? { midi } : {}) }));
  return out;
}

const mod12 = (x) => ((x % 12) + 12) % 12;
/** Nearest pitch of the scale (pcs = pitch classes) to a fractional MIDI pitch. */
export function snapPitch(midiFloat, pcs) {
  const set = new Set(pcs.map(mod12));
  const base = Math.round(midiFloat);
  let best = base, bestD = Infinity;
  for (let d = -6; d <= 6; d++) {
    const c = base + d;
    if (!set.has(mod12(c))) continue;
    const dist = Math.abs(c - midiFloat);
    if (dist < bestD - 1e-9) { best = c; bestD = dist; }
  }
  return best;
}

/** Snap notes ({pitch, midi?}) to a key's scale pitch classes (uses the fractional pitch when known). */
export function snapNotesToScale(notes, pcs) {
  return notes.map((nt) => ({ ...nt, pitch: snapPitch(nt.midi ?? nt.pitch, pcs) }));
}

/** Octave shift (multiple of 12) that moves the median pitch nearest to `target` (e.g. 64 lead, 40 bass). */
export function octaveShiftFor(pitches, target = 64) {
  if (!pitches.length) return 0;
  return Math.round((target - median(pitches)) / 12) * 12;
}

/** Strip analysis-only fields -> notes ready for the pattern. */
export function toPatternNotes(notes, { shift = 0, length = Infinity } = {}) {
  return notes.filter((nt) => nt.start < length).map((nt) => ({
    pitch: Math.max(0, Math.min(127, nt.pitch + shift)), start: nt.start, dur: Math.min(nt.dur, length - nt.start), vel: nt.vel ?? 0.8,
  }));
}
