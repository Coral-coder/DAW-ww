// Pro export runner (browser): offline renders (mixdown + stems) at any sample rate, tail detection, loudness /
// peak normalisation with a true-peak ceiling, WAV 16 / 24 / 32f with dither + noise shaping + INFO / iXML metadata,
// AAC / MP3 through WebCodecs where the browser can encode them, and an export report.
//
//   await runExport({project, render, opts, onProgress}) -> { files: [{name, data: Uint8Array|ArrayBuffer, mime}],
//                                                           report: {mix?: {...}, stems: [...]}, text }
//   render(project, renderOpts) -> AudioBuffer   (src/audio/render.js renderOffline with the engine's sample cache)
//   await lossyFormats() -> ['aac', 'mp3'] subset the browser can encode (feature detection, cached)
import { encodeWav } from '../io/wav.js';
import { addWavMetadata } from '../io/wav-meta.js';
import { measureLoudness, normalizeLoudness } from './dsp/loudness.js';
import { tempoMapFor } from '../time/tempo-map.js';
import {
  EXPORT_FORMATS, DITHER_OPTIONS, resolveRange, detectTail, fadeOutTail, stemTargets, stemProject, formatFileName, uniqueNames, reportRows, reportText,
} from '../io/export-plan.js';

const FMT = Object.fromEntries(EXPORT_FORMATS.map((f) => [f.id, f]));
let lossyCache = null;

/** Lossy formats this browser can encode with WebCodecs (AudioEncoder.isConfigSupported). */
export function lossyFormats() {
  if (lossyCache) return lossyCache;
  lossyCache = (async () => {
    const AE = globalThis.AudioEncoder;
    if (typeof AE?.isConfigSupported !== 'function') return [];
    const out = [];
    for (const f of EXPORT_FORMATS.filter((x) => x.lossy)) {
      try {
        const r = await AE.isConfigSupported({ codec: f.codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 256000 });
        if (r?.supported) out.push(f.id);
      } catch { /* not supported */ }
    }
    return out;
  })();
  return lossyCache;
}

/** Encode planar float channels with WebCodecs. AAC comes out ADTS-framed (.aac), MP3 as a raw frame stream. */
export async function encodeLossy(channels, sampleRate, { codec = 'mp4a.40.2', bitrate = 256000 } = {}) {
  const AE = globalThis.AudioEncoder;
  const AD = globalThis.AudioData;
  if (!AE || !AD) throw new Error('WebCodecs audio encoding is not available in this browser');
  const nch = Math.min(2, channels.length);
  const cfg = { codec, sampleRate, numberOfChannels: nch, bitrate, ...(codec.startsWith('mp4a') ? { aac: { format: 'adts' } } : {}) };
  const sup = await AE.isConfigSupported(cfg);
  if (!sup?.supported) throw new Error(`${codec} encoding at ${sampleRate} Hz is not supported here`);
  const parts = [];
  let failure = null;
  const enc = new AE({
    output: (chunk) => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); parts.push(b); },
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
  }
  await enc.flush();
  enc.close();
  if (failure) throw failure;
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

const chOf = (buf) => Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
const trimTo = (chs, n) => chs.map((c) => (c.length === n ? c : (() => { const o = new Float32Array(n); o.set(c.subarray(0, Math.min(n, c.length))); return o; })()));

async function encodeFile(channels, sampleRate, o, meta) {
  const f = FMT[o.format] || FMT.wav24;
  if (f.lossy) return { data: await encodeLossy(channels, sampleRate, { codec: f.codec, bitrate: o.bitrate || 256000 }), ext: f.ext, mime: f.id === 'mp3' ? 'audio/mpeg' : 'audio/aac' };
  const d = DITHER_OPTIONS.find((x) => x.id === o.dither) || DITHER_OPTIONS[0];
  const wav = encodeWav(channels, { sampleRate, bitDepth: f.bitDepth, dither: f.bitDepth === 32 ? 'none' : d.dither, noiseShaping: f.bitDepth === 32 ? 'none' : d.noiseShaping });
  return { data: addWavMetadata(wav, meta), ext: 'wav', mime: 'audio/wav' };
}

/**
 * opts (see EXPORT_DEFAULTS in io/export-plan.js): format, sampleRate, dither, normalize ('off'|'peak'|'lufs'),
 * target, ceiling, range, selection, custom, tail ('auto'|'none'|seconds), tailMax, mixdown (bool),
 * stems ('none'|'all'|'selected'|'buses'|'groups'), selectedIds, stemTap ('pre'|'post'), stemMaster (bool),
 * limit (true-peak limit at `ceiling` even without normalisation), nameTemplate, stemTemplate, title, artist, isrc, comment.
 */
export async function runExport({ project, render, opts, onProgress = () => {} }) {
  const o = { ...opts };
  const sr = Number(o.sampleRate) || 48000;
  const rng = resolveRange(project, { range: o.range, selection: o.selection, custom: o.custom });
  // musical length through the tempo map (tempo / meter changes), exactly like render.js times the render
  const musicFrames = Math.round(tempoMapFor(project, rng.mode).span(rng.startBeat, rng.endBeat) * sr);
  const tailSec = o.tail === 'none' ? 0 : o.tail === 'auto' ? Number(o.tailMax) || 10 : Math.max(0, Number(o.tail) || 0);
  const rOpts = { startBeat: rng.startBeat, endBeat: rng.endBeat, mode: rng.mode, sampleRate: sr, tail: tailSec };
  const targets = o.stems && o.stems !== 'none' ? stemTargets(project, { which: o.stems, selectedIds: o.selectedIds || [] }) : [];
  const steps = (o.mixdown !== false ? 1 : 0) + targets.length;
  let step = 0;
  const meta = { title: o.title || project.name, artist: o.artist, isrc: o.isrc, comment: o.comment, bpm: project.bpm, date: new Date().toISOString().slice(0, 10) };
  const fmt = FMT[o.format] || FMT.wav24;
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
    const file = await encodeFile(norm.channels, sr, o, meta);
    files.push({ name: `${base}.${file.ext}`, data: file.data, mime: file.mime });
    report.mix = { name: `${base}.${file.ext}`, measure: m, before: norm.before, gainDb: norm.gainDb, limitedDb: norm.limitedDb, rows: reportRows(m, norm) };
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
  report.text = report.mix ? reportText(report.mix.name, report.mix.measure, { gainDb: report.mix.gainDb, limitedDb: report.mix.limitedDb, lines }) : lines.join('\n');
  return { files, report };
}
