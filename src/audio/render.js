// Offline rendering (export / bounce / stems). Builds the exact same graph as realtime
// playback (MixGraph + collectEvents) inside an OfflineAudioContext.
import * as samplesIO from '../io/samples.js';
import { beatsPerBar } from '../core/model.js';
import { MixGraph } from './mixer.js';
import { CodeCache, collectEvents, defaultEndBeat, isTrackAudible } from './scheduler.js';

function fallbackBase64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Sample JSON -> ArrayBuffer of the original file bytes. */
export function sampleToArrayBuffer(sample) {
  let data = sample?.data || '';
  if (typeof data !== 'string') return data;
  const comma = data.startsWith('data:') ? data.indexOf(',') : -1;
  if (comma >= 0) data = data.slice(comma + 1);
  const conv = samplesIO.base64ToArrayBuffer || fallbackBase64ToArrayBuffer;
  return conv(data);
}

/** Decode a project sample with any (Offline)AudioContext. */
export function decodeSampleData(ctx, sample) {
  const ab = sampleToArrayBuffer(sample);
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(ab, resolve, reject);
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

const stripExt = (n) => String(n || '').replace(/\.[a-z0-9]{1,5}$/i, '').trim().toLowerCase();

/** Find a sample id by name (case-insensitive, extension optional). */
export function findSampleIdByName(project, name) {
  const want = stripExt(name);
  if (!want) return null;
  for (const s of Object.values(project.samples || {})) {
    if (stripExt(s.name) === want || String(s.name || '').toLowerCase() === String(name).toLowerCase()) return s.id;
  }
  return null;
}

/** Decode every project sample missing from `cache` (Map id -> AudioBuffer). */
export async function decodeAllSamples(project, cache, sampleRate = 44100) {
  const missing = Object.values(project.samples || {}).filter((s) => s?.id && s.data && !cache.has(s.id));
  if (!missing.length) return cache;
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  await Promise.all(missing.map(async (s) => {
    try { cache.set(s.id, await decodeSampleData(ctx, s)); } catch (e) { console.warn('[render] could not decode sample', s.name, e); }
  }));
  return cache;
}

/** Snapshot the project so edits during a (suspend-chunked) render can't leak in. */
function snapshot(project) {
  const { samples, ...rest } = project;
  return { ...JSON.parse(JSON.stringify(rest)), samples: samples || {} };
}

/**
 * renderOffline(storeOrProject, {startBeat=0, endBeat?, bars?, mode?, sampleRate=44100, stems=false,
 *                                tail=2, sampleCache?: Map, onError?})
 *   -> AudioBuffer, or with stems: { master: AudioBuffer, [trackId]: AudioBuffer }
 * Song mode renders the arrangement linearly (loop region ignored). Pattern mode loops the
 * active patterns (default length: longest active pattern rounded to bars, min 4 bars).
 */
export async function renderOffline(source, opts = {}) {
  const live = typeof source?.get === 'function' ? source.get() : source;
  if (!live) throw new Error('renderOffline: no project');
  const project = snapshot(live);
  const mode = opts.mode || project.mode || 'song';
  const bpb = beatsPerBar(project);
  const startBeat = Math.max(0, opts.startBeat ?? 0);
  let endBeat = opts.endBeat ?? (opts.bars ? startBeat + opts.bars * bpb : defaultEndBeat(project, mode));
  if (!(endBeat > startBeat)) endBeat = startBeat + bpb;
  const cfg = {
    mode, startBeat, endBeat,
    sampleRate: opts.sampleRate || 44100,
    tail: opts.tail ?? 2,
    cache: opts.sampleCache || new Map(),
    onError: opts.onError || ((e) => console.warn('[render]', e)),
  };
  await decodeAllSamples(project, cfg.cache, cfg.sampleRate);

  if (!opts.stems) return renderOnce(project, cfg);

  const out = { master: await renderOnce(project, cfg) };
  for (const track of project.tracks) {
    if (!isTrackAudible(project, track)) continue;
    const variant = {
      ...project,
      tracks: project.tracks.map((t) => (t.id === track.id ? { ...t, mute: false, solo: false } : { ...t, mute: true, solo: false })),
    };
    out[track.id] = await renderOnce(variant, cfg);
  }
  return out;
}

async function renderOnce(project, cfg) {
  const { mode, startBeat, endBeat, sampleRate, tail, cache, onError } = cfg;
  const spb = 60 / project.bpm;
  const dur = (endBeat - startBeat) * spb;
  const length = Math.max(1, Math.ceil((dur + tail) * sampleRate));
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
  const codeCache = new CodeCache((trackId, res) => { if (!res.ok) onError(new Error(`Code track ${trackId}: ${res.error}`)); });
  const graph = new MixGraph(ctx, {
    destination: ctx.destination,
    getBpm: () => project.bpm,
    getBeatAt: (t) => startBeat + t / spb,
    getSampleBuffer: (id) => cache.get(id) || null,
    getSampleByName: (name) => {
      const id = findSampleIdByName(project, name);
      return id ? cache.get(id) || null : null;
    },
    onError,
    meters: false,
  });
  graph.sync(project);
  graph.syncLfos(0);

  const schedule = (b0, b1, jump) => {
    if (!(b1 > b0)) return;
    let events = [];
    try {
      events = collectEvents(project, b0, b1, { mode, jump, codeCache, metronome: false, onError });
    } catch (e) { onError(e); }
    for (const ev of events) {
      const time = Math.max(0, (ev.beat - startBeat) * spb);
      try { graph.playEvent(ev, time, spb); } catch (e) { onError(e); }
    }
  };

  const chunkSec = 2;
  const chunkBeats = chunkSec / spb;
  if (typeof ctx.suspend === 'function' && dur > chunkSec * 3) {
    // Schedule incrementally (keeps memory flat on long songs): events for chunk k+1 are
    // scheduled while the renderer is suspended at the start of chunk k.
    schedule(startBeat, Math.min(endBeat, startBeat + 2 * chunkBeats), true);
    const plan = (k) => {
      const from = startBeat + (k + 1) * chunkBeats;
      if (from >= endBeat) return;
      ctx.suspend(k * chunkSec).then(() => {
        schedule(from, Math.min(endBeat, from + chunkBeats), false);
        plan(k + 1);
        ctx.resume();
      }, (e) => { onError(e); });
    };
    plan(1);
  } else {
    schedule(startBeat, endBeat, true);
  }

  const buffer = await ctx.startRendering();
  try { graph.dispose(); } catch { /* */ }
  return buffer;
}
