// Wavetable import (pure, Node-safe): WAV parsing (PCM 8/16/24/32-bit, float 32/64, extensible), Serum "clm "
// chunk detection, single-cycle / multi-frame splitting and resynthesis of arbitrary audio into frames via FFT.
import { fft } from '../dsp/fft.js';
import { FRAME_SIZE, MAX_FRAMES, resampleCycle, frameFromHarmonics } from './tables.js';

const ascii = (dv, off, n) => { let s = ''; for (let i = 0; i < n && off + i < dv.byteLength; i++) s += String.fromCharCode(dv.getUint8(off + i)); return s; };

/**
 * Parse a RIFF/WAVE file. -> { sampleRate, channels, bits, format, data: Float32Array[] (per channel), clm: {frameSize, raw}|null, chunks: [id] }
 * Throws on anything that is not a readable WAV.
 */
export function parseWav(buf) {
  const ab = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const dv = new DataView(ab);
  if (dv.byteLength < 12 || ascii(dv, 0, 4) !== 'RIFF' && ascii(dv, 0, 4) !== 'RF64' || ascii(dv, 8, 4) !== 'WAVE') throw new Error('Not a WAV file');
  let off = 12, fmt = null, dataOff = -1, dataLen = 0, clm = null;
  const chunks = [];
  while (off + 8 <= dv.byteLength) {
    const id = ascii(dv, off, 4);
    let len = dv.getUint32(off + 4, true);
    const body = off + 8;
    chunks.push(id);
    if (id === 'fmt ') {
      const tag = dv.getUint16(body, true);
      fmt = { tag, channels: dv.getUint16(body + 2, true), sampleRate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
      if (tag === 0xfffe && len >= 26) fmt.tag = dv.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE: sub-format GUID
    } else if (id === 'data') {
      dataOff = body;
      if (len === 0xffffffff || body + len > dv.byteLength) len = dv.byteLength - body; // streamed / RF64 / truncated
      dataLen = len;
    } else if (id === 'clm ') {
      const raw = ascii(dv, body, Math.min(len, 256));
      const m = /<!>\s*(\d+)/.exec(raw);
      clm = { frameSize: m ? Number(m[1]) : FRAME_SIZE, raw };
    }
    off = body + len + (len & 1);
  }
  if (!fmt) throw new Error('WAV has no fmt chunk');
  if (dataOff < 0) throw new Error('WAV has no data chunk');
  const { tag, channels, bits } = fmt;
  const isFloat = tag === 3;
  if (!(tag === 1 || tag === 3)) throw new Error(`Unsupported WAV encoding (format ${tag})`);
  if (!channels) throw new Error('WAV has no channels');
  const bps = bits / 8;
  const frames = Math.floor(dataLen / (bps * channels));
  const data = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const p = dataOff + (i * channels + c) * bps;
      let v;
      if (isFloat) v = bits === 64 ? dv.getFloat64(p, true) : dv.getFloat32(p, true);
      else if (bits === 8) v = (dv.getUint8(p) - 128) / 128;
      else if (bits === 16) v = dv.getInt16(p, true) / 32768;
      else if (bits === 24) { let x = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getUint8(p + 2) << 16); if (x & 0x800000) x -= 0x1000000; v = x / 8388608; }
      else if (bits === 32) v = dv.getInt32(p, true) / 2147483648;
      else throw new Error(`Unsupported WAV bit depth ${bits}`);
      data[c][i] = v;
    }
  }
  return { sampleRate: fmt.sampleRate, channels, bits, format: isFloat ? 'float' : 'pcm', data, clm, chunks };
}

/** Mono mix of channel arrays. */
export function toMono(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length, out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] / channels.length;
  return out;
}

/** Split mono samples into frames of frameSize (each resampled to FRAME_SIZE). */
export function splitFrames(mono, frameSize = FRAME_SIZE) {
  const n = Math.max(1, Math.min(MAX_FRAMES, Math.floor(mono.length / frameSize)));
  const out = [];
  for (let f = 0; f < n; f++) {
    const cyc = mono.subarray(f * frameSize, (f + 1) * frameSize);
    out.push(frameSize === FRAME_SIZE ? Float32Array.from(cyc) : resampleCycle(cyc));
  }
  return out;
}

/**
 * How a WAV's audio is read as a wavetable:
 *   'clm'    Serum table (clm chunk: frame size from "<!>2048"),
 *   'multi'  length is a multiple of 2048 (≤ 256 frames),
 *   'single' a short single cycle (≤ 4096 samples, resampled to one frame),
 *   'audio'  anything else: resynthesized (resynthesize()).
 */
export function classifyWav(wav) {
  const len = wav.data[0]?.length || 0;
  if (wav.clm && wav.clm.frameSize > 0 && len >= wav.clm.frameSize) return { kind: 'clm', frameSize: wav.clm.frameSize };
  if (len >= FRAME_SIZE && len % FRAME_SIZE === 0 && len / FRAME_SIZE <= MAX_FRAMES) return { kind: 'multi', frameSize: FRAME_SIZE };
  if (len > 0 && len <= 4096) return { kind: 'single', frameSize: len };
  return { kind: 'audio', frameSize: 0 };
}

/**
 * Wavetable frames from WAV bytes. opts.frames: frame count for resynthesis (default 64).
 * -> { frames: Float32Array[], kind, sampleRate }
 */
export function importWavetable(bytes, opts = {}) {
  const wav = parseWav(bytes);
  const mono = toMono(wav.data);
  const c = classifyWav(wav);
  let frames;
  if (c.kind === 'clm' || c.kind === 'multi') frames = splitFrames(mono, c.frameSize);
  else if (c.kind === 'single') frames = [resampleCycle(mono)];
  else frames = resynthesize(mono, wav.sampleRate, { frames: opts.frames || 64 });
  return { frames, kind: c.kind, sampleRate: wav.sampleRate };
}

// ------------------------------------------------------------------------------------------- resynthesis
/**
 * Fundamental (Hz) of a mono signal by normalized autocorrelation of its loudest 4096-sample region; null when no
 * clear periodicity (noise, drums).
 */
export function detectPitch(mono, sampleRate, { minHz = 30, maxHz = 2000 } = {}) {
  const W = 4096;
  if (mono.length < 256) return null;
  // loudest region
  let best = 0, bestE = -1;
  const hop = 1024;
  for (let s = 0; s + W <= mono.length || s === 0; s += hop) {
    let e = 0;
    for (let i = s; i < Math.min(mono.length, s + W); i++) e += mono[i] * mono[i];
    if (e > bestE) { bestE = e; best = s; }
    if (s + W >= mono.length) break;
  }
  const n = Math.min(W, mono.length - best);
  const x = mono.subarray(best, best + n);
  const lagMin = Math.max(2, Math.floor(sampleRate / maxHz)), lagMax = Math.min(n - 2, Math.ceil(sampleRate / minHz));
  if (lagMax <= lagMin) return null;
  const r = new Float64Array(lagMax + 2);
  let e0 = 0;
  for (let i = 0; i < n; i++) e0 += x[i] * x[i];
  if (!(e0 > 1e-9)) return null;
  for (let lag = lagMin - 1; lag <= lagMax + 1; lag++) {
    let s = 0, ea = 0, eb = 0;
    for (let i = 0; i + lag < n; i++) { s += x[i] * x[i + lag]; ea += x[i] * x[i]; eb += x[i + lag] * x[i + lag]; }
    r[lag] = s / Math.sqrt(ea * eb + 1e-12);
  }
  let max = -1;
  for (let lag = lagMin; lag <= lagMax; lag++) if (r[lag] > max) max = r[lag];
  if (max < 0.5) return null;
  // first local maximum close to the global one (avoids picking a multiple of the period)
  for (let lag = lagMin; lag <= lagMax; lag++) {
    if (r[lag] >= 0.9 * max && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) {
      const a = r[lag - 1], b = r[lag], c = r[lag + 1];
      const d = a - 2 * b + c;
      const shift = d < 0 ? 0.5 * (a - c) / d : 0; // parabolic peak
      return sampleRate / (lag + shift);
    }
  }
  return null;
}

/**
 * Resynthesize audio into `frames` phase-aligned single cycles: the clip is cut into equal slices, each slice is
 * analysed with a Hann-windowed FFT and its harmonics (multiples of the detected fundamental) are read off the
 * spectrum; phases are aligned to the fundamental so neighbouring frames morph smoothly. Unpitched audio uses a
 * 2048-sample "period" (its spectral envelope becomes the frame).
 */
export function resynthesize(mono, sampleRate, { frames = 64, f0 = null } = {}) {
  const F = Math.max(1, Math.min(MAX_FRAMES, Math.round(frames)));
  const pitch = f0 || detectPitch(mono, sampleRate) || sampleRate / FRAME_SIZE;
  let W = 4096;
  while (W < (sampleRate / pitch) * 6 && W < 32768) W <<= 1; // ≥ 6 periods per window: harmonics resolve
  const harmonics = Math.min(FRAME_SIZE / 2 - 1, Math.floor((sampleRate / 2) / pitch) - 1);
  const win = new Float64Array(W);
  for (let i = 0; i < W; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (W - 1));
  const re = new Float64Array(W), im = new Float64Array(W);
  const out = [];
  const span = Math.max(0, mono.length - W);
  for (let f = 0; f < F; f++) {
    const start = F > 1 ? Math.round((span * f) / (F - 1)) : Math.floor(span / 2);
    re.fill(0); im.fill(0);
    for (let i = 0; i < W; i++) re[i] = (mono[start + i] || 0) * win[i];
    fft(re, im, false);
    const amps = new Float32Array(harmonics + 1), phases = new Float32Array(harmonics + 1);
    let ph1 = 0;
    for (let k = 1; k <= Math.max(1, harmonics); k++) {
      const bin = (k * pitch * W) / sampleRate;
      // strongest bin within ±1 of the harmonic's position
      let bi = Math.round(bin), bm = -1;
      for (let j = Math.max(1, Math.floor(bin) - 1); j <= Math.min(W / 2 - 1, Math.ceil(bin) + 1); j++) {
        const m = re[j] * re[j] + im[j] * im[j];
        if (m > bm) { bm = m; bi = j; }
      }
      if (bi >= W / 2) break;
      amps[k] = Math.sqrt(bm) * 4 / W; // Hann coherent gain 0.5, two-sided
      const ph = Math.atan2(im[bi], re[bi]) + Math.PI / 2;
      if (k === 1) ph1 = ph;
      phases[k] = ph - k * ph1; // fundamental at phase 0: frames line up
    }
    out.push(frameFromHarmonics(amps, phases));
  }
  return out;
}
