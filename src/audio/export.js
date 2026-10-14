// Pro export runner (browser): offline renders (mixdown + stems) at any sample rate, tail detection, loudness /
// peak normalisation with a true-peak ceiling, WAV 16 / 24 / 32f with dither + noise shaping + INFO / iXML metadata,
// MP3 (vendored LAME port in a Worker — every browser), AAC (.m4a) and Opus (.ogg) through WebCodecs where the browser
// can encode them, and an export report (lossy files are decoded back and measured).
//
//   await runExport({project, render, opts, onProgress, decode}) -> { files: [{name, data: Uint8Array|ArrayBuffer, mime}],
//                                                                   report: {mix?: {...}, stems: [...]}, text }
//   render(project, renderOpts) -> AudioBuffer   (src/audio/render.js renderOffline with the engine's sample cache)
//   decode(bytes, mime) -> {channels, sampleRate} | AudioBuffer   (optional: measures the encoded file)
//   await formatSupport() -> {wav16: {ok: true}, mp3: {ok}, aac: {ok, reason?}, opus: {ok, reason?}}  (cached)
//   await lossyFormats() -> ids of the lossy formats this browser can write
import { encodeWav } from '../io/wav.js';
import { addWavMetadata, cleanIsrc } from '../io/wav-meta.js';
import { muxM4a } from '../io/mp4.js';
import { muxOggOpus } from '../io/ogg.js';
import { measureLoudness, normalizeLoudness } from './dsp/loudness.js';
import { tempoMapFor } from '../time/tempo-map.js';
import {
  EXPORT_FORMATS, DITHER_OPTIONS, resolveRange, detectTail, fadeOutTail, stemTargets, stemProject, formatFileName, uniqueNames, reportRows, reportText, encodeRate,
} from '../io/export-plan.js';

const FMT = Object.fromEntries(EXPORT_FORMATS.map((f) => [f.id, f]));
let supportCache = null;

/** Which formats this browser can write, with a reason for the ones it can't (shown as the option's tooltip). */
export function formatSupport() {
  if (supportCache) return supportCache;
  supportCache = (async () => {
    const out = {};
    for (const f of EXPORT_FORMATS) out[f.id] = { ok: true };
    // MP3: pure-JS LAME, needs nothing but JavaScript (a module Worker when available, else the main thread)
    const AE = globalThis.AudioEncoder;
    for (const f of EXPORT_FORMATS.filter((x) => x.webcodecs)) {
      if (typeof AE?.isConfigSupported !== 'function' || typeof globalThis.AudioData !== 'function') {
        out[f.id] = { ok: false, reason: `${f.label} needs WebCodecs audio encoding (AudioEncoder), which this browser does not offer — use MP3 or WAV` };
        continue;
      }
      let ok = false;
      try {
        const rate = f.id === 'opus' ? 48000 : 44100;
        const r = await AE.isConfigSupported({ codec: f.codec, sampleRate: rate, numberOfChannels: 2, bitrate: 192000 });
        ok = !!r?.supported;
      } catch { ok = false; }
      out[f.id] = ok ? { ok: true } : { ok: false, reason: `This browser has no ${f.id === 'aac' ? 'AAC' : 'Opus'} encoder (WebCodecs reports ${f.codec} unsupported${f.id === 'aac' ? ' — Chromium on Linux ships without one' : ''}) — use MP3 or WAV` };
    }
    return out;
  })();
  return supportCache;
}

/** Lossy formats this browser can write (MP3 always; AAC / Opus when WebCodecs can encode them). */
export async function lossyFormats() {
  const s = await formatSupport();
  return EXPORT_FORMATS.filter((f) => f.lossy && s[f.id]?.ok).map((f) => f.id);
}

/**
 * Encode planar float channels with WebCodecs AudioEncoder -> {chunks: [{data, timestamp, duration}], description}.
 * AAC is requested raw (format 'aac', AudioSpecificConfig in the decoder description) for the .m4a muxer.
 */
export async function encodeWebCodecs(channels, sampleRate, { codec = 'mp4a.40.2', bitrate = 256000, bitrateMode = 'constant' } = {}) {
  const AE = globalThis.AudioEncoder;
  const AD = globalThis.AudioData;
  if (!AE || !AD) throw new Error('WebCodecs audio encoding is not available in this browser');
  const nch = Math.min(2, channels.length);
  const cfg = { codec, sampleRate, numberOfChannels: nch, bitrate, bitrateMode, ...(codec.startsWith('mp4a') ? { aac: { format: 'aac' } } : {}), ...(codec === 'opus' ? { opus: { format: 'opus', frameDuration: 20000 } } : {}) };
  let sup = await AE.isConfigSupported(cfg).catch(() => null);
  if (!sup?.supported) { delete cfg.bitrateMode; sup = await AE.isConfigSupported(cfg).catch(() => null); }
  if (!sup?.supported) throw new Error(`${codec} encoding at ${sampleRate} Hz is not supported here`);
  const chunks = [];
  let description = null;
  let failure = null;
  const enc = new AE({
    output: (chunk, meta) => {
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      chunks.push({ data: b, timestamp: chunk.timestamp, duration: chunk.duration });
      const d = meta?.decoderConfig?.description;
      if (d && !description) description = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
    },
    error: (e) => { failure = e; },
  });
  enc.configure(cfg);
  const block = 4096;
  const len = channels[0].length;
  for (let o = 0; o < len; o += block) {
    const n = Math.min(block, len - o);
    const data = new Float32Array(n * nch);
    for (let c = 0; c < nch; c++) data.set(channels[c].subarray(o, o + n), c * n);
    const ad = new AD({ format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels: nch, timestamp: Math.round((o / sampleRate) * 1e6), data });
    enc.encode(ad);
    ad.close();
    if (failure) break;
    if (enc.encodeQueueSize > 64) await new Promise((r) => setTimeout(r, 0));
  }
  await enc.flush();
  enc.close();
  if (failure) throw failure;
  return { chunks, description };
}

// AudioSpecificConfig for AAC-LC when an encoder gives no description
function aacAsc(sampleRate, channels) {
  const idx = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000].indexOf(sampleRate);
  return Uint8Array.from([(2 << 3) | (idx >> 1), ((idx & 1) << 7) | (channels << 3)]);
}

let worker = null, workerSeq = 0;
/** MP3 through LAME in a module Worker (main-thread fallback). */
export async function encodeMp3Async(channels, sampleRate, opts, onProgress = () => {}) {
  if (typeof Worker === 'function') {
    try {
      worker ||= new Worker(new URL('./encode-worker.js', import.meta.url), { type: 'module' });
      const id = ++workerSeq;
      const copy = channels.map((c) => c.slice());
      return await new Promise((resolve, reject) => {
        const onMsg = (e) => {
          if (e.data?.id !== id) return;
          if (e.data.progress != null) { onProgress(e.data.progress); return; }
          worker.removeEventListener('message', onMsg);
          worker.removeEventListener('error', onErr);
          if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.data);
        };
        const onErr = (e) => { worker.removeEventListener('message', onMsg); worker.removeEventListener('error', onErr); worker = null; reject(Object.assign(new Error(e.message || 'MP3 worker failed'), { workerFailed: true })); };
        worker.addEventListener('message', onMsg);
        worker.addEventListener('error', onErr);
        worker.postMessage({ id, channels: copy, sampleRate, opts }, copy.map((c) => c.buffer));
      });
    } catch (e) {
      if (!e.workerFailed) throw e;
    }
  }
  const { encodeMp3 } = await import('../io/mp3.js');
  return encodeMp3(channels, sampleRate, { ...opts, onProgress });
}

/** Encode one file in the chosen lossy format -> Uint8Array. */
export async function encodeLossy(channels, sampleRate, format, { bitrate, bitrateMode = 'cbr', tags = {}, onProgress } = {}) {
  const f = FMT[format];
  const kbps = Number(bitrate) || 320;
  if (format === 'mp3') return encodeMp3Async(channels, sampleRate, { bitrate: kbps, mode: bitrateMode === 'vbr' ? 'abr' : 'cbr', tags }, onProgress);
  const nch = Math.min(2, channels.length);
  const { chunks, description } = await encodeWebCodecs(channels, sampleRate, { codec: f.codec, bitrate: kbps * 1000, bitrateMode: bitrateMode === 'vbr' ? 'variable' : 'constant' });
  if (format === 'aac') {
    // encoder priming: chunks timestamped before 0 when the encoder reports it, else the AAC-LC convention (2112)
    const t0 = chunks[0]?.timestamp || 0;
    const priming = t0 < 0 ? Math.round((-t0 / 1e6) * sampleRate) : 2112;
    return muxM4a({ frames: chunks.map((c) => c.data), asc: description?.length ? description : aacAsc(sampleRate, nch), sampleRate, channels: nch, samples: channels[0].length, priming, bitrate: kbps * 1000, tags });
  }
  // Opus: 48 kHz granules; pre-skip from the encoder's OpusHead when it gives one (libopus look-ahead = 312)
  let preSkip = 312;
  if (description?.length >= 19 && String.fromCharCode(...description.subarray(0, 8)) === 'OpusHead') preSkip = description[10] | (description[11] << 8);
  const packets = chunks.map((c) => ({ data: c.data, samples: Math.round(((c.duration || 20000) / 1e6) * 48000) }));
  return muxOggOpus({ packets, channels: nch, inputRate: sampleRate, preSkip, samples48: Math.round((channels[0].length * 48000) / sampleRate), tags });
}

const chOf = (buf) => Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
const trimTo = (chs, n) => chs.map((c) => (c.length === n ? c : (() => { const o = new Float32Array(n); o.set(c.subarray(0, Math.min(n, c.length))); return o; })()));

async function encodeFile(channels, sampleRate, o, meta, onProgress) {
  const f = FMT[o.format] || FMT.wav24;
  if (f.lossy) {
    const kbps = f.bitrates.includes(Number(o.bitrate)) ? Number(o.bitrate) : f.bitrates[f.bitrates.length - 1];
    const tags = { ...meta, isrc: cleanIsrc(meta.isrc) || undefined, software: 'daW³', cover: o.cover || null };
    return { data: await encodeLossy(channels, sampleRate, f.id, { bitrate: kbps, bitrateMode: o.bitrateMode, tags, onProgress }), ext: f.ext, mime: f.mime, kbps };
  }
  const d = DITHER_OPTIONS.find((x) => x.id === o.dither) || DITHER_OPTIONS[0];
  const wav = encodeWav(channels, { sampleRate, bitDepth: f.bitDepth, dither: f.bitDepth === 32 ? 'none' : d.dither, noiseShaping: f.bitDepth === 32 ? 'none' : d.noiseShaping });
  return { data: addWavMetadata(wav, meta), ext: 'wav', mime: 'audio/wav' };
}

/**
 * opts (see EXPORT_DEFAULTS in io/export-plan.js): format, sampleRate, dither, normalize ('off'|'peak'|'lufs'),
 * target, ceiling, range, selection, custom, tail ('auto'|'none'|seconds), tailMax, mixdown (bool),
 * stems ('none'|'all'|'selected'|'buses'|'groups'), selectedIds, stemTap ('pre'|'post'), stemMaster (bool),
 * limit (true-peak limit at `ceiling` even without normalisation), nameTemplate, stemTemplate, title, artist, album, isrc, comment,
 * bitrate (kbps) + bitrateMode ('cbr'|'vbr') for lossy formats, cover ({mime, data}: MP3 APIC / m4a covr / Opus picture).
 */
export async function runExport({ project, render, opts, onProgress = () => {}, decode = null }) {
  const o = { ...opts };
  const fmt = FMT[o.format] || FMT.wav24;
  // lossy formats render straight at a rate their codec takes (MP3 / AAC 32–48 kHz, Opus 48 kHz)
  const sr = encodeRate(fmt.id, Number(o.sampleRate) || 48000);
  const rng = resolveRange(project, { range: o.range, selection: o.selection, custom: o.custom });
  // musical length through the tempo map (tempo / meter changes), exactly like render.js times the render
  const musicFrames = Math.round(tempoMapFor(project, rng.mode).span(rng.startBeat, rng.endBeat) * sr);
  const tailSec = o.tail === 'none' ? 0 : o.tail === 'auto' ? Number(o.tailMax) || 10 : Math.max(0, Number(o.tail) || 0);
  const rOpts = { startBeat: rng.startBeat, endBeat: rng.endBeat, mode: rng.mode, sampleRate: sr, tail: tailSec };
  const targets = o.stems && o.stems !== 'none' ? stemTargets(project, { which: o.stems, selectedIds: o.selectedIds || [] }) : [];
  const steps = (o.mixdown !== false ? 1 : 0) + targets.length;
  let step = 0;
  const meta = { title: o.title || project.name, artist: o.artist, album: o.album, isrc: o.isrc, comment: o.comment, bpm: project.bpm, date: new Date().toISOString().slice(0, 10) };
  const nameVars = { project, title: o.title, artist: o.artist, sampleRate: sr, bits: fmt.bitDepth ? (fmt.bitDepth === 32 ? '32f' : `${fmt.bitDepth}bit`) : fmt.id, range: rng.label, format: fmt.id };
  const unique = uniqueNames();
  const files = [];
  const report = { range: rng, sampleRate: sr, format: fmt.label, stems: [] };

  // 1) mixdown (also decides the common length: every file of one export starts and ends together)
  let keep = musicFrames + Math.round(tailSec * sr);
  let gain = 1;
  if (o.mixdown !== false) {
    onProgress(step++ / steps, 'Rendering mixdown…');
    const buf = await render(project, rOpts);
    let chs = chOf(buf);
    if (o.tail === 'auto') keep = detectTail(chs, sr, { musicFrames, thresholdDb: -80 });
    chs = trimTo(chs, Math.min(keep, chs[0].length));
    if (o.tail === 'auto' && keep < musicFrames + tailSec * sr) fadeOutTail(chs, sr, 0.01);
    onProgress((step - 0.5) / steps, 'Measuring loudness…');
    const norm = normalizeLoudness(chs, sr, { mode: o.normalize || 'off', target: Number(o.target), ceiling: (o.normalize && o.normalize !== 'off') || o.limit ? Number(o.ceiling) : null });
    gain = Math.pow(10, (norm.gainDb || 0) / 20);
    const m = norm.after;
    const base = unique(formatFileName(o.nameTemplate, { ...nameVars, lufs: m.integrated }));
    if (fmt.lossy) onProgress((step - 0.4) / steps, `Encoding ${fmt.label}…`);
    const file = await encodeFile(norm.channels, sr, o, meta, (f) => onProgress((step - 0.4 + 0.3 * f) / steps, `Encoding ${fmt.label}… ${Math.round(f * 100)}%`));
    files.push({ name: `${base}.${file.ext}`, data: file.data, mime: file.mime });
    // lossy: decode the encoded file back and measure what listeners will get
    let encoded = null, encodedError = null;
    if (fmt.lossy && decode) {
      onProgress((step - 0.1) / steps, 'Measuring the encoded file…');
      try {
        const d = await decode(file.data, file.mime);
        const dch = d.channels || chOf(d);
        encoded = { ...measureLoudness(dch, d.sampleRate), codec: `${fmt.label} ${file.kbps} kbps ${o.bitrateMode === 'vbr' ? 'VBR' : 'CBR'} @ ${sr} Hz`, frames: dch[0].length, sampleRate: d.sampleRate };
      } catch (e) { encodedError = e.message || String(e); }
    }
    report.mix = { name: `${base}.${file.ext}`, measure: m, before: norm.before, gainDb: norm.gainDb, limitedDb: norm.limitedDb, encoded, rows: reportRows(m, { ...norm, encoded, encodedError }) };
  }

  // 2) stems (same start, same length as the mixdown; normalisation gain carried over so stems sum to the mix)
  let n = 0;
  for (const t of targets) {
    onProgress(step++ / steps, `Rendering stem ${++n}/${targets.length}: ${t.name}…`);
    const variant = stemProject(project, t, { tap: o.stemTap === 'pre' ? 'pre' : 'post', master: !!o.stemMaster });
    const buf = await render(variant, rOpts);
    let chs = trimTo(chOf(buf), o.mixdown !== false ? keep : chOf(buf)[0].length);
    if (gain !== 1) chs = chs.map((c) => c.map((x) => x * gain));
    const m = measureLoudness(chs, sr);
    const base = unique(formatFileName(o.stemTemplate, { ...nameVars, n, stem: t.name, lufs: m.integrated }));
    const file = await encodeFile(chs, sr, o, { ...meta, title: `${meta.title || ''} — ${t.name}`.trim() });
    files.push({ name: `${base}.${file.ext}`, data: file.data, mime: file.mime });
    report.stems.push({ name: `${base}.${file.ext}`, target: t, measure: m });
  }
  onProgress(1, 'Done');
  const lines = [`Range: ${rng.label} (beats ${rng.startBeat}–${rng.endBeat}, ${rng.mode} mode)`, `Format: ${fmt.label} @ ${sr} Hz`,
    ...report.stems.map((s) => `Stem ${s.name}: ${Number.isFinite(s.measure.integrated) ? s.measure.integrated.toFixed(1) : '−∞'} LUFS, TP ${Number.isFinite(s.measure.truePeakDb) ? s.measure.truePeakDb.toFixed(1) : '−∞'} dBTP`)];
  report.text = report.mix ? reportText(report.mix.name, report.mix.measure, { gainDb: report.mix.gainDb, limitedDb: report.mix.limitedDb, encoded: report.mix.encoded, lines }) : lines.join('\n');
  return { files, report };
}
