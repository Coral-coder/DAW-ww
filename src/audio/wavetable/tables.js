// Wavetable data: frames, spectra, band-limited mipmaps, morph reads and compact project storage.
// Pure (Node-safe). A wavetable is an ordered list of single-cycle frames of FRAME_SIZE samples; the
// oscillator morphs between neighbouring frames (position 0..1) and reads one mipmap level per octave
// so no harmonic ever exceeds Nyquist (src/audio/wavetable/processor.js).
import { fft } from '../dsp/fft.js';

export const FRAME_SIZE = 2048;
export const MAX_HARMONIC = FRAME_SIZE / 2 - 1; // highest harmonic a frame can hold (bin N/2 is dropped)
export const MAX_FRAMES = 256;
/** Harmonic limit of each mipmap level: 1024, 512, … 1 (11 levels). */
export const MIP_HARMONICS = [1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1];
/** Samples per cycle of a level: ≥ 8 samples per period of its top harmonic, ≥ 256 (interpolation images < −70 dB). */
export const mipSize = (harm) => Math.max(256, Math.min(FRAME_SIZE, 8 * harm));

// ------------------------------------------------------------------------------------------- spectra
/**
 * Frame from harmonic amplitudes (index k = harmonic k, [0] ignored) and optional phases (radians), sine phase
 * convention: x(t) = Σ a_k sin(2π k t + φ_k). Band-limited by construction. -> Float32Array(size)
 */
export function frameFromHarmonics(amps, phases = null, size = FRAME_SIZE) {
  const re = new Float64Array(size), im = new Float64Array(size);
  const top = Math.min(amps.length - 1, size / 2 - 1);
  for (let k = 1; k <= top; k++) {
    const a = amps[k];
    if (!a) continue;
    const ph = (phases ? phases[k] || 0 : 0) - Math.PI / 2; // sin = cos(θ - π/2)
    re[k] = (a / 2) * Math.cos(ph); im[k] = (a / 2) * Math.sin(ph);
    re[size - k] = re[k]; im[size - k] = -im[k];
  }
  fft(re, im, true);
  const out = new Float32Array(size);
  for (let i = 0; i < size; i++) out[i] = re[i];
  return out;
}

/** Harmonic amplitudes / phases of a frame (sine convention, k = 1..N/2-1). -> {amps, phases, dc} */
export function harmonicsOf(frame) {
  const n = frame.length;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = frame[i];
  fft(re, im, false);
  const amps = new Float32Array(n / 2), phases = new Float32Array(n / 2);
  for (let k = 1; k < n / 2; k++) {
    amps[k] = (2 / n) * Math.hypot(re[k], im[k]);
    phases[k] = Math.atan2(im[k], re[k]) + Math.PI / 2;
  }
  return { amps, phases, dc: re[0] / n };
}

/**
 * Band-limit a periodic function f(phase 0..1) into a frame: sampled `oversample`× finer, transformed, every bin
 * above the frame's Nyquist dropped (no generation aliasing for hard edges / folding / sync shapes).
 */
export function bandlimit(f, { size = FRAME_SIZE, oversample = 4, maxHarmonic = size / 2 - 1 } = {}) {
  const n = size * oversample;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = f(i / n);
  fft(re, im, false);
  const out = new Float64Array(size), oi = new Float64Array(size);
  const top = Math.min(maxHarmonic, size / 2 - 1);
  for (let k = 1; k <= top; k++) {
    out[k] = re[k] / oversample; oi[k] = im[k] / oversample;
    out[size - k] = re[n - k] / oversample; oi[size - k] = im[n - k] / oversample;
  }
  fft(out, oi, true);
  const res = new Float32Array(size);
  for (let i = 0; i < size; i++) res[i] = out[i] / size;
  return res;
}

/** Resample a single cycle of any length to `size` samples (band-limited through the spectrum). */
export function resampleCycle(cycle, size = FRAME_SIZE) {
  const n = cycle.length;
  if (n === size) return Float32Array.from(cycle);
  // spectral resampling on the next power of two (linear pre-stretch keeps arbitrary lengths cheap)
  let m = 1;
  while (m < Math.max(n, size)) m <<= 1;
  const tmp = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const x = (i / m) * n, i0 = Math.floor(x), fr = x - i0;
    tmp[i] = cycle[i0 % n] * (1 - fr) + cycle[(i0 + 1) % n] * fr;
  }
  const im = new Float64Array(m);
  fft(tmp, im, false);
  const re2 = new Float64Array(size), im2 = new Float64Array(size);
  const top = Math.min(size / 2 - 1, m / 2 - 1, Math.floor(n / 2) - 1);
  for (let k = 1; k <= top; k++) {
    re2[k] = tmp[k] * (size / m); im2[k] = im[k] * (size / m);
    re2[size - k] = tmp[m - k] * (size / m); im2[size - k] = im[m - k] * (size / m);
  }
  fft(re2, im2, true);
  const out = new Float32Array(size);
  for (let i = 0; i < size; i++) out[i] = re2[i] / size;
  return out;
}

// ------------------------------------------------------------------------------------------- frame edits
export function removeDC(frame) {
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i];
  const m = s / frame.length;
  const out = new Float32Array(frame.length);
  for (let i = 0; i < frame.length; i++) out[i] = frame[i] - m;
  return out;
}

export function peakOf(frames) {
  let p = 0;
  for (const f of frames) for (let i = 0; i < f.length; i++) { const a = Math.abs(f[i]); if (a > p) p = a; }
  return p;
}

/** Scale so the loudest sample of the whole table is ±target (one gain for every frame: morphs keep their balance). */
export function normalizeFrames(frames, target = 1) {
  const p = peakOf(frames);
  if (!(p > 1e-9)) return frames.map((f) => Float32Array.from(f));
  const g = target / p;
  return frames.map((f) => { const o = new Float32Array(f.length); for (let i = 0; i < f.length; i++) o[i] = f[i] * g; return o; });
}

/** Normalize one frame on its own. */
export function normalizeFrame(frame, target = 1) { return normalizeFrames([frame], target)[0]; }

/** Time-domain crossfade of two frames (t 0..1). */
export function mixFrames(a, b, t) {
  const o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = a[i] + (b[i] - a[i]) * t;
  return o;
}

/** n frames morphing through `keys` (frames), evenly spaced. */
export function morphKeys(keys, n = 64) {
  if (keys.length === 1) return Array.from({ length: n }, () => Float32Array.from(keys[0]));
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * (keys.length - 1);
    const j = Math.min(keys.length - 2, Math.floor(x));
    out.push(mixFrames(keys[j], keys[j + 1], x - j));
  }
  return out;
}

// ------------------------------------------------------------------------------------------- mipmaps
/**
 * Band-limited mipmaps of a table: { frames: F, levels: [{ harmonics, size, data: Float32Array(F*size) }] }.
 * Level k keeps harmonics 1..MIP_HARMONICS[k] (DC is always removed) at mipSize() samples per cycle.
 */
export function buildMipmaps(frames) {
  const F = frames.length;
  const levels = MIP_HARMONICS.map((harmonics) => ({ harmonics, size: mipSize(harmonics), data: new Float32Array(F * mipSize(harmonics)) }));
  const N = FRAME_SIZE;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let f = 0; f < F; f++) {
    const src = frames[f];
    re.fill(0); im.fill(0);
    for (let i = 0; i < N; i++) re[i] = src[i % src.length] || 0;
    fft(re, im, false);
    for (const lv of levels) {
      const S = lv.size, H = Math.min(lv.harmonics, S / 2 - 1, N / 2 - 1);
      const r2 = new Float64Array(S), i2 = new Float64Array(S);
      for (let k = 1; k <= H; k++) {
        r2[k] = re[k]; i2[k] = im[k];
        r2[S - k] = re[N - k]; i2[S - k] = im[N - k];
      }
      fft(r2, i2, true);
      const off = f * S;
      for (let i = 0; i < S; i++) lv.data[off + i] = r2[i] / N;
    }
  }
  return { frames: F, levels };
}

/**
 * Mipmap level for a fundamental of `freq` Hz (×`mult` for warps that raise the effective frequency): the
 * richest level whose top harmonic stays below Nyquist.
 */
export function mipLevel(freq, sampleRate, mult = 1) {
  const f = Math.abs(freq * mult);
  if (!(f > 0)) return 0;
  const k = Math.ceil(Math.log2((MIP_HARMONICS[0] * f) / (sampleRate / 2)) - 1e-9);
  return Math.max(0, Math.min(MIP_HARMONICS.length - 1, k));
}

/** Linear-interpolated read of frame `fi` of a level at phase 0..1. */
export function readLevel(level, fi, phase) {
  const S = level.size;
  const x = (phase - Math.floor(phase)) * S;
  const i0 = Math.floor(x), fr = x - i0;
  const off = fi * S;
  const a = level.data[off + i0], b = level.data[off + ((i0 + 1) & (S - 1))];
  return a + (b - a) * fr;
}

/** Morphed read: position 0..1 across the frames, crossfading the two neighbours. */
export function readMorph(mips, level, pos, phase) {
  const lv = mips.levels[level];
  const F = mips.frames;
  const x = Math.max(0, Math.min(1, pos)) * (F - 1);
  const f0 = Math.min(F - 1, Math.floor(x));
  const f1 = Math.min(F - 1, f0 + 1);
  const t = x - f0;
  const a = readLevel(lv, f0, phase);
  return t > 0 ? a + (readLevel(lv, f1, phase) - a) * t : a;
}

// ------------------------------------------------------------------------------------------- storage
/** FNV-1a (32-bit) of a byte array -> 8 hex chars. */
export function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64) {
  if (typeof Buffer !== 'undefined') { const b = Buffer.from(b64, 'base64'); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** 16-bit little-endian PCM of the frames (resampled to FRAME_SIZE). */
function framesToInt16(frames) {
  const F = frames.length;
  const out = new Int16Array(F * FRAME_SIZE);
  frames.forEach((fr, f) => {
    const src = fr.length === FRAME_SIZE ? fr : resampleCycle(fr);
    for (let i = 0; i < FRAME_SIZE; i++) out[f * FRAME_SIZE + i] = Math.round(Math.max(-1, Math.min(1, src[i])) * 32767);
  });
  return out;
}
const leBytes = (i16) => {
  const b = new Uint8Array(i16.length * 2);
  for (let i = 0; i < i16.length; i++) { b[2 * i] = i16[i] & 0xff; b[2 * i + 1] = (i16[i] >> 8) & 0xff; }
  return b;
};

/**
 * Compact project entry for a user table: { id: 'u_<hash>', name, frameSize, frames, data (base64 int16 LE), hash }.
 * The id is the content hash, so importing the same table twice stores it once.
 */
export function encodeTable(name, frames) {
  const list = frames.slice(0, MAX_FRAMES);
  const pcm = normalizeFrames(list.map(removeDC));
  const bytes = leBytes(framesToInt16(pcm));
  const hash = fnv1a(bytes) + list.length.toString(16);
  return { id: 'u_' + hash, name: String(name || 'Wavetable').slice(0, 80), frameSize: FRAME_SIZE, frames: list.length, data: toBase64(bytes), hash };
}

/** Frames (Float32Array[]) of a stored table. */
export function decodeTable(entry) {
  if (!entry?.data) return null;
  const bytes = fromBase64(entry.data);
  const size = entry.frameSize || FRAME_SIZE;
  const F = Math.max(1, Math.min(MAX_FRAMES, entry.frames || Math.floor(bytes.length / (2 * size))));
  const frames = [];
  for (let f = 0; f < F; f++) {
    const fr = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      const j = 2 * (f * size + i);
      if (j + 1 >= bytes.length) break;
      let v = bytes[j] | (bytes[j + 1] << 8);
      if (v >= 0x8000) v -= 0x10000;
      fr[i] = v / 32767;
    }
    frames.push(size === FRAME_SIZE ? fr : resampleCycle(fr));
  }
  return frames;
}

/** Add a table to project.wavetables (dedupe by content). Mutates `project` (a store draft). -> id */
export function addProjectTable(project, name, frames) {
  const e = encodeTable(name, frames);
  project.wavetables ||= {};
  if (!project.wavetables[e.id]) project.wavetables[e.id] = e;
  return e.id;
}

export const isUserTable = (id) => typeof id === 'string' && id.startsWith('u_');

/** Ids of the user tables the project's instruments reference. */
export function referencedTables(project) {
  const used = new Set();
  const scan = (params) => { for (const k of ['osc1Table', 'osc2Table']) if (isUserTable(params?.[k])) used.add(params[k]); };
  for (const t of project?.tracks || []) if (t.instrument?.type === 'wavetable') scan(t.instrument.params);
  return used;
}

/** Validated project.wavetables (drops malformed entries; keeps only referenced ones when prune). */
export function sanitizeWavetables(map, used = null) {
  const out = {};
  for (const [id, e] of Object.entries(map || {})) {
    if (!e || typeof e !== 'object' || typeof e.data !== 'string' || !isUserTable(id)) continue;
    if (used && !used.has(id)) continue;
    out[id] = { id, name: String(e.name || 'Wavetable'), frameSize: Number(e.frameSize) || FRAME_SIZE, frames: Math.max(1, Math.min(MAX_FRAMES, Number(e.frames) || 1)), data: e.data, hash: e.hash || id.slice(2) };
  }
  return out;
}
