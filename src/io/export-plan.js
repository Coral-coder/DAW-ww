// Pro export planning (pure, Node-safe): render ranges, stem targets / variants, file naming templates, tail
// detection and the export report. The browser side (offline renders, encoding, download) is src/audio/export.js,
// the dialog src/ui/export-dialog.js.
import { beatsPerBar, songLengthBeats } from '../core/model.js';
import { keySourcesFor } from '../core/patch.js';
import { mixerOf, busesFedBy, outputOf } from '../core/mixer-model.js';
import { defaultEndBeat } from '../audio/scheduler.js';
import { tempoMapFor } from '../time/tempo-map.js';

export const EXPORT_FORMATS = [
  { id: 'wav16', label: 'WAV 16-bit', ext: 'wav', bitDepth: 16 },
  { id: 'wav24', label: 'WAV 24-bit', ext: 'wav', bitDepth: 24 },
  { id: 'wav32f', label: 'WAV 32-bit float', ext: 'wav', bitDepth: 32 },
  { id: 'aac', label: 'AAC (.m4a/ADTS)', ext: 'aac', codec: 'mp4a.40.2', lossy: true },
  { id: 'mp3', label: 'MP3', ext: 'mp3', codec: 'mp3', lossy: true },
];
export const EXPORT_SAMPLE_RATES = [44100, 48000, 88200, 96000];
export const DITHER_OPTIONS = [
  { id: 'none', label: 'Off', dither: 'none', noiseShaping: 'none' },
  { id: 'tpdf', label: 'TPDF', dither: 'tpdf', noiseShaping: 'none' },
  { id: 'tpdf-first', label: 'TPDF + 1st-order shaping', dither: 'tpdf', noiseShaping: 'first' },
  { id: 'tpdf-shaped', label: 'TPDF + F-weighted shaping', dither: 'tpdf', noiseShaping: 'shaped' },
];
export const DEFAULT_NAME_TEMPLATE = '{project}';
export const DEFAULT_STEM_TEMPLATE = '{project} - {n} {stem}';

export const EXPORT_DEFAULTS = Object.freeze({
  format: 'wav24', sampleRate: 48000, dither: 'tpdf', normalize: 'off', target: -14, ceiling: -1, preset: 'spotify',
  range: 'song', tail: 'auto', tailMax: 10, stems: 'none', stemTap: 'post', stemMaster: false, mixdown: true,
  nameTemplate: DEFAULT_NAME_TEMPLATE, stemTemplate: DEFAULT_STEM_TEMPLATE, title: '', artist: '', isrc: '', comment: '',
});

/**
 * Beat range to render. range: 'song' | 'loop' | 'selection' | 'custom'.
 * selection: {start, end} beats (e.g. the span of the selected clips); custom: {start, end} in bars (1-based start).
 * -> { startBeat, endBeat, mode, label }
 */
export function resolveRange(project, { range = 'song', selection = null, custom = null, mode = null } = {}) {
  const m = mode || (project.clips?.length ? 'song' : project.mode || 'pattern');
  const bpb = beatsPerBar(project);
  let start = 0, end = m === 'song' ? songLengthBeats(project) : defaultEndBeat(project, m), label = 'Song';
  if (range === 'loop' && project.loop && project.loop.end > project.loop.start) { start = project.loop.start; end = project.loop.end; label = 'Loop'; }
  else if (range === 'selection' && selection && selection.end > selection.start) { start = selection.start; end = selection.end; label = 'Selection'; }
  else if (range === 'custom' && custom) {
    // bars through the meter map (meter changes move bar lines); constant meter = (bar − 1) × beats per bar
    const map = tempoMapFor(project, m);
    const barBeat = (bar) => (typeof map.barStart === 'function' ? map.barStart(bar) : bar * bpb);
    start = Math.max(0, barBeat((Number(custom.start) || 1) - 1));
    end = Math.max(start + bpb, barBeat((Number(custom.end) || 1) - 1));
    label = `Bars ${custom.start}–${custom.end}`;
  }
  return { startBeat: start, endBeat: end, mode: m, label };
}

/** Seconds of a beat range through the project's tempo map. */
export function rangeSeconds(project, r) { return tempoMapFor(project, r.mode).span(r.startBeat, r.endBeat); }

/** Beat span of the given clips (selection range), or null. */
export function clipSpan(project, clipIds = []) {
  const cs = (project.clips || []).filter((c) => clipIds.includes(c.id));
  if (!cs.length) return null;
  return { start: Math.min(...cs.map((c) => c.start)), end: Math.max(...cs.map((c) => c.start + c.length)) };
}

const pad2 = (n) => String(n).padStart(2, '0');
const PITCH = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/**
 * File name from a template. Tokens: {project} {title} {artist} {stem} {track} {n} (2-digit index) {bpm} {key}
 * {date} (YYYY-MM-DD) {time} (HHMM) {sr} (kHz) {bits} {lufs} {range} {format}. Unknown tokens are kept verbatim.
 * The result is file-system safe (no path separators / reserved characters), without the extension.
 */
export function formatFileName(template, vars = {}, now = new Date()) {
  const p = vars.project || {};
  const map = {
    project: vars.projectName ?? p.name ?? 'Untitled',
    title: vars.title || vars.projectName || p.name || 'Untitled',
    artist: vars.artist || '',
    stem: vars.stem || '',
    track: vars.stem || '',
    n: vars.n != null ? pad2(vars.n) : '',
    bpm: vars.bpm ?? p.bpm ?? '',
    key: vars.key || (p.key ? `${PITCH[p.key.root] || ''}${p.key.scale === 'minor' ? 'm' : ''}` : ''),
    date: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
    time: `${pad2(now.getHours())}${pad2(now.getMinutes())}`,
    sr: vars.sampleRate ? String(+(vars.sampleRate / 1000).toFixed(1)).replace(/\.0$/, '') + 'k' : '',
    bits: vars.bits || '',
    lufs: Number.isFinite(vars.lufs) ? `${Math.round(vars.lufs)}LUFS` : '',
    range: vars.range || '',
    format: vars.format || '',
  };
  let s = String(template || DEFAULT_NAME_TEMPLATE).replace(/\{(\w+)\}/g, (m0, k) => (k in map ? String(map[k]) : m0));
  s = s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').replace(/\s*-\s*-\s*/g, ' - ').replace(/^[\s\-_.]+|[\s\-_.]+$/g, '');
  return s.slice(0, 120) || 'export';
}

/** Names made unique within one export (adds " 2", " 3" …). */
export function uniqueNames() {
  const used = new Set();
  return (base) => {
    let n = base;
    for (let k = 2; used.has(n.toLowerCase()); k++) n = `${base} ${k}`;
    used.add(n.toLowerCase());
    return n;
  };
}

/**
 * Tail detection: frames to keep of a render whose music ends at `musicFrames` — the last frame above
 * `thresholdDb` (after the music end) plus a short fade guard, at most the whole buffer.
 */
export function detectTail(channels, sampleRate, { musicFrames = 0, thresholdDb = -80, guard = 0.05 } = {}) {
  const thr = Math.pow(10, thresholdDb / 20);
  const len = channels[0]?.length || 0;
  let last = Math.min(len, musicFrames);
  for (let i = len - 1; i >= musicFrames; i--) {
    let hit = false;
    for (const c of channels) if (Math.abs(c[i]) > thr) { hit = true; break; }
    if (hit) { last = i + 1; break; }
  }
  return Math.min(len, Math.max(musicFrames, last + Math.round(guard * sampleRate)));
}

/** Short fade-out over the last `sec` of each channel (in place) — after a tail cut. */
export function fadeOutTail(channels, sampleRate, sec = 0.01) {
  const n = Math.min(channels[0]?.length || 0, Math.round(sec * sampleRate));
  for (const c of channels) for (let i = 0; i < n; i++) c[c.length - n + i] *= 1 - (i + 1) / n;
  return channels;
}

// ------------------------------------------------------------------------------------------------ stems
/**
 * Stem targets. which: 'all' (every sounding track) | 'selected' (selectedIds) | 'buses' (every bus that something
 * feeds) | 'groups' (one stem per mixer group, ungrouped tracks get their own).
 * -> [{ kind: 'track' | 'bus' | 'group', id, name, trackIds }]
 */
export function stemTargets(project, { which = 'all', selectedIds = [] } = {}) {
  const sounding = (t) => !t.mute;
  if (which === 'buses') {
    return (project.buses || []).filter((b) => project.tracks.some((t) => sounding(t) && busesFedBy(project, t).includes(b.id)))
      .map((b) => ({ kind: 'bus', id: b.id, name: b.name, trackIds: project.tracks.filter((t) => busesFedBy(project, t).includes(b.id)).map((t) => t.id) }));
  }
  if (which === 'groups') {
    const out = [];
    const grouped = new Set();
    for (const g of mixerOf(project).groups) {
      const ids = g.members.filter((id) => project.tracks.some((t) => t.id === id && sounding(t)));
      if (!ids.length) continue;
      ids.forEach((id) => grouped.add(id));
      out.push({ kind: 'group', id: g.id, name: g.name, trackIds: ids });
    }
    for (const t of project.tracks) if (sounding(t) && !grouped.has(t.id)) out.push({ kind: 'track', id: t.id, name: t.name, trackIds: [t.id] });
    return out;
  }
  const pickIds = which === 'selected' ? new Set(selectedIds) : null;
  return project.tracks.filter((t) => (pickIds ? pickIds.has(t.id) : sounding(t))).map((t) => ({ kind: 'track', id: t.id, name: t.name, trackIds: [t.id] }));
}

const MIXER_LANE = /^(volume|pan|mute|send:)/;
const clone = (x) => JSON.parse(JSON.stringify(x));

/**
 * Project copy in which only `target` sounds (pure).
 *   tap 'post' : the channel's fader, pan, sends (returns' effects included) and automation;
 *   tap 'pre'  : after the inserts — unity fader, centre, no sends, no mixer automation.
 *   master: true keeps the master chain (effects, volume, automation); false bypasses it (volume 1, no fx).
 * Bus targets: the tracks feeding that bus play into it only (main outs off, other buses silent).
 * Sidechain key sources keep playing silently so the stem keeps its ducking. Solo / mute state is reset so every
 * stem renders regardless of what was soloed while mixing.
 */
export function stemProject(project, target, { tap = 'post', master = false } = {}) {
  const p = { ...project, mixer: project.mixer ? { ...project.mixer, soloMode: 'sip' } : project.mixer };
  p.master = master ? project.master : { ...project.master, volume: 1, fx: [], automation: [] };
  const pre = tap === 'pre';
  const live = new Set(target.trackIds);
  const keys = new Set();
  for (const id of live) for (const k of keySourcesFor(project, id)) keys.add(k);
  const strip = (t) => ({ ...t, volume: 1, pan: 0, sends: {}, automation: (t.automation || []).filter((l) => !MIXER_LANE.test(String(l.target))) });
  if (target.kind === 'bus') {
    p.tracks = project.tracks.map((t) => {
      if (!live.has(t.id) || t.mute) return keys.has(t.id) && !t.mute ? { ...strip(t), volume: 0, solo: false } : { ...t, mute: true, solo: false };
      const sends = Object.fromEntries(Object.entries(t.sends || {}).filter(([b]) => b === target.id));
      return { ...t, solo: false, sends, _noDirect: outputOf(project, t) !== target.id };
    });
    p.buses = (project.buses || []).map((b) => (b.id === target.id ? (pre ? { ...b, volume: 1, pan: 0, automation: [] } : b) : { ...b, mute: true, automation: (b.automation || []).filter((l) => l.target !== 'mute') }));
    return prune(p);
  }
  p.tracks = project.tracks.map((t) => {
    if (live.has(t.id)) return pre ? { ...strip(t), mute: false, solo: false } : { ...t, mute: false, solo: false };
    if (keys.has(t.id) && !t.mute) return { ...strip(t), solo: false, volume: 0 };
    return { ...t, mute: true, solo: false, automation: (t.automation || []).filter((l) => l.target !== 'mute') };
  });
  // a pre-fader track routed into a folder bus: bypass the bus too (unity) — the stem is the track itself
  if (pre) p.tracks = p.tracks.map((t) => (live.has(t.id) && t.output ? { ...t, output: undefined } : t));
  return prune(p);
}

/** Drop the silenced tracks (and their clips) so a stem render doesn't build instruments nobody hears. */
function prune(p) {
  const silent = new Set(p.tracks.filter((t) => t.mute && !(t.automation || []).some((l) => l.target === 'mute')).map((t) => t.id));
  if (!silent.size) return p;
  return { ...p, tracks: p.tracks.filter((t) => !silent.has(t.id)), clips: (p.clips || []).filter((c) => !silent.has(c.trackId)) };
}

// ------------------------------------------------------------------------------------------------ report
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '−∞');
const fmtDur = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;

/** Export report rows from a loudness measurement (dsp/loudness.js measureLoudness). */
export function reportRows(m, extra = {}) {
  return [
    ['Integrated', `${f1(m.integrated)} LUFS`],
    ['True peak', `${f1(m.truePeakDb)} dBTP`],
    ['Loudness range', `${f1(m.lra)} LU`],
    ['Max short-term', `${f1(m.shortTermMax)} LUFS`],
    ['Max momentary', `${f1(m.momentaryMax)} LUFS`],
    ['Sample peak', `${f1(m.samplePeakDb)} dBFS`],
    ['Duration', fmtDur(m.duration || 0)],
    ...(Number.isFinite(extra.gainDb) ? [['Normalise gain', `${extra.gainDb >= 0 ? '+' : ''}${extra.gainDb.toFixed(2)} dB`]] : []),
    ...(extra.limitedDb ? [['Limiter (max GR)', `${extra.limitedDb.toFixed(2)} dB`]] : []),
  ];
}

/** Plain-text export report. */
export function reportText(name, m, extra = {}) {
  return [`daW³ export report — ${name}`, ...reportRows(m, extra).map(([k, v]) => `${k.padEnd(18)} ${v}`), ...(extra.lines || [])].join('\n');
}
