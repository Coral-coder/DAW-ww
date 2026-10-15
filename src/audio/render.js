// Offline rendering (export / bounce / stems). Builds the exact same graph as realtime
// playback (MixGraph + collectEvents) inside an OfflineAudioContext.
import * as samplesIO from '../io/samples.js';
import { beatsPerBar } from '../core/model.js';
import { MixGraph, codeSoundOf } from './mixer.js';
import { claimSuperdough } from './strudel-instrument.js';
import { CodeCache, collectEvents, defaultEndBeat, isTrackAudible } from './scheduler.js';
import { hasAutomation, hasControlAutomation } from '../core/automation.js';
import { hasModulation } from '../core/modulation.js';
import { keySourcesFor } from '../core/patch.js';
import { awaitPluginsReady, flushPlugins } from './plugin-instrument.js';
import { prepareCodeSamples } from './code-instrument.js';
import { limitTruePeak } from './dsp/truepeak.js';
import { tempoMapFor } from '../time/tempo-map.js';
import { annotateTimes } from './scheduler.js';

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
 *                                tail=2, sampleCache?: Map, onError?, truePeakCeiling?: dBTP})
 *   truePeakCeiling: run the master through the offline true-peak limiter (dsp/truepeak.js) — e.g. -1 for streaming.
 *   The render itself is float32 end to end (no clipping anywhere); encode with encodeWav (32-bit float keeps overs).
 *   Plugin delay compensation is exact: the render is latency-free and sample-aligned with the timeline.
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
    // code tracks: 'strudel' / 'daw3' forces one sound engine for this render (default: each track's own)
    codeSound: opts.codeSound || null,
    onNotice: opts.onNotice || null,
    metronome: !!opts.metronome, // include the metronome click (checks / click-track export)
  };
  await decodeAllSamples(project, cfg.cache, cfg.sampleRate);

  const finish = (buf) => (opts.truePeakCeiling != null ? applyTruePeakLimit(buf, { ceilingDb: opts.truePeakCeiling }) : buf);
  if (!opts.stems) return finish(await renderOnce(project, cfg));

  const out = { master: finish(await renderOnce(project, cfg)) };
  for (const track of project.tracks) {
    if (!isTrackAudible(project, track)) continue;
    // Tracks that key a ducker heard in this stem keep playing silently (fader at 0, no sends:
    // the key is tapped pre-fader) so the stem keeps its sidechain movement.
    const keyOnly = keySourcesFor(project, track.id);
    const variant = {
      ...project,
      tracks: project.tracks.map((t) => {
        if (t.id === track.id) return { ...t, mute: false, solo: false };
        if (keyOnly.has(t.id) && !t.mute) {
          return { ...t, solo: false, volume: 0, sends: {}, automation: (t.automation || []).filter((l) => !/^(volume|send:)/.test(String(l.target))) };
        }
        return { ...t, mute: true, solo: false, automation: (t.automation || []).filter((l) => l.target !== 'mute') }; // a mute lane must not un-mute it
      }),
    };
    out[track.id] = await renderOnce(variant, cfg);
  }
  return out;
}

async function renderOnce(project, cfg) {
  try {
    return await renderOnceWith(project, cfg);
  } catch (e) {
    // superdough couldn't render offline: render the code tracks with daW³ instruments instead
    if (!e?.strudelOffline || cfg.codeSound === 'daw3') throw e;
    cfg.codeSound = 'daw3';
    const msg = `Strudel sounds could not be rendered offline (${e.cause?.message || e.cause || 'unknown error'}) — code tracks were exported with daW³ instruments.`;
    if (cfg.onNotice) cfg.onNotice(msg); else cfg.onError(new Error(msg));
    return renderOnceWith(project, cfg);
  }
}

/** Waits until every Strudel-engine code instrument of the graph has set up the sounds triggered so far. */
function flushCode(graph) {
  const insts = graph.strudelInstruments?.() || [];
  return insts.length ? Promise.all(insts.map((i) => i.flush())) : Promise.resolve();
}
const flushAll = (graph) => Promise.all([flushPlugins(graph), flushCode(graph)]);

async function renderOnceWith(project, cfg) {
  const { mode, startBeat, endBeat, sampleRate, tail, cache, onError } = cfg;
  // tempo map (time/tempo-map.js): song mode follows tempo / meter changes; a constant map keeps the exact old math
  const map = tempoMapFor(project, mode);
  const constant = map.isConstant;
  const spb = 60 / map.bpm;
  const sec0 = map.secAt(startBeat);
  const timeOf = (b) => (constant ? (b - startBeat) * spb : map.secAt(b) - sec0); // render time of a beat
  const beatOf = (t) => (constant ? startBeat + t / spb : map.beatAt(sec0 + t));
  const dur = timeOf(endBeat);
  const length = Math.max(1, Math.ceil((dur + tail) * sampleRate));
  // PDC: the compensated graph is late by graph.latency; render that much longer and trim it off the head,
  // so the result is identical to a latency-free graph (see latency.js)
  const pad = Math.ceil(PDC_PAD * sampleRate);
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: length + pad, sampleRate });
  const codeCache = new CodeCache((trackId, res) => { if (!res.ok) onError(new Error(`Code track ${trackId}: ${res.error}`)); });
  let graph = null;
  graph = new MixGraph(ctx, {
    destination: ctx.destination,
    getBpm: () => project.bpm,
    // heard beat at ctx time t (the compensated mix is late by graph.latency, trimmed after rendering) — as realtime
    getBeatAt: (t) => beatOf(t - (graph?.latency || 0)),
    getSampleBuffer: (id) => cache.get(id) || null,
    getSampleByName: (name) => {
      const id = findSampleIdByName(project, name);
      return id ? cache.get(id) || null : null;
    },
    onError,
    meters: false,
    codeSound: cfg.codeSound,
    warpWorklet: false, // warped audio clips: precomputed (cached) stretch, deterministic
  });
  graph.sync(project);
  // code tracks with the Strudel sound engine: superdough renders into this context (see strudel-instrument.js)
  const strudelInsts = graph.strudelInstruments();
  let release = () => {};
  if (strudelInsts.length) {
    release = await claimSuperdough(ctx);
    try {
      await Promise.all(strudelInsts.map((i) => i.whenReady()));
    } catch (e) {
      release();
      throw Object.assign(new Error('Strudel offline render failed'), { strudelOffline: true, cause: e });
    }
    const broken = strudelInsts.find((i) => !i.ready && !i.fallback);
    if (broken) { release(); throw Object.assign(new Error('Strudel offline render failed'), { strudelOffline: true, cause: broken.failed }); }
  }
  // plugin instruments / effects (soundfont, faust, wam) load asynchronously: wait before scheduling
  await awaitPluginsReady(graph, project, onError);
  // native (VST3 / AU / CLAP) instruments in the Mac app: rendered faster than realtime by the plugin host
  if ([...(graph.tracks?.values?.() || [])].some((e) => e.instrument?.engine?.plugin?.isNative)) {
    const { prerenderNative } = await import('../native/export.js');
    const all = collectEvents(project, startBeat, endBeat, { mode, jump: true, codeCache, metronome: false, onError });
    // note times through the tempo map (a constant map keeps the exact old math)
    const notesFor = (id) => all.filter((ev) => ev.type === 'note' && ev.trackId === id)
      .map((ev) => ({ time: Math.max(0, timeOf(ev.beat)), pitch: ev.pitch, vel: ev.vel, dur: Math.max(0, timeOf(ev.beat + ev.dur) - timeOf(ev.beat)) }));
    // song-mode automation of the plugins' parameters: sample-accurate parameter events with the render
    const auto = mode === 'song' && hasAutomation(project) ? { project, startBeat, endBeat, frameAt: (b) => timeOf(b) * sampleRate } : null;
    await prerenderNative(graph, notesFor, length, onError, auto);
  }
  // code tracks playing library samples (Strudel drum machines, Dirt-Samples…): fetch + decode first
  // (daW³-instrument code tracks only; superdough loads its own samples while the render waits in flushCode)
  const daw3Code = { ...project, tracks: project.tracks.filter((t) => t.type !== 'code' || codeSoundOf(t, cfg.codeSound) === 'daw3') };
  await prepareCodeSamples(ctx, daw3Code, codeCache, startBeat, endBeat, onError);
  graph.syncLfos(0);

  const schedule = (b0, b1, jump) => {
    if (!(b1 > b0)) return;
    let events = [];
    try {
      events = collectEvents(project, b0, b1, { mode, jump, codeCache, metronome: cfg.metronome, onError, map });
    } catch (e) { onError(e); }
    if (!constant) annotateTimes(events, map);
    for (const ev of events) {
      const time = Math.max(0, constant ? (ev.beat - startBeat) * spb : ev.sec - sec0);
      try { graph.playEvent(ev, time, constant ? spb : map.spbAt(ev.beat), map); } catch (e) { onError(e); }
    }
  };

  // Automation (song mode only, like realtime playback): mixer targets become AudioParam
  // ramps over the whole render; instrument/effect params are applied at control rate
  // (every 1/16 note) while the render is suspended, right before that step's events.
  const automate = mode === 'song' && hasAutomation(project);
  if (automate) graph.automateMixer(project, startBeat, endBeat, 0, constant ? spb : map, 'seek');
  const control = automate && hasControlAutomation(project) && typeof ctx.suspend === 'function';

  const chunkSec = 2;
  // Modulation (macros / modulators, core/modulation.js): control-rate ticks every ~8.7 ms of render time on top of the
  // event steps (the automation step grid when control lanes exist, else 1/4-beat scheduling windows).
  const modulate = hasModulation(project) && typeof ctx.suspend === 'function';
  if (modulate) {
    const q = 128 / sampleRate;
    const modDt = Math.max(1, Math.round(0.0087 / q)) * q;
    const stepBeats = 0.25;
    const steps = Math.ceil((endBeat - startBeat) / stepBeats - 1e-9);
    const total = (length + pad) / sampleRate;
    const songAuto = mode === 'song' && automate;
    const modTick = (t) => {
      try { graph.applyModulation(project, t, { beat: beatOf(t), bpm: constant ? project.bpm : 60 / map.spbAt(beatOf(t)), songAuto, immediate: t === 0 }); } catch (e) { onError(e); }
    };
    const runStep = (k, jump) => {
      const b = startBeat + k * stepBeats;
      if (control) { try { graph.applyControl(project, b, { immediate: k === 0 }); } catch (e) { onError(e); } }
      schedule(b, Math.min(endBeat, b + stepBeats), jump);
    };
    runStep(0, true);
    modTick(0);
    let k = 1, m = 1, lastT = 0;
    const plan = () => {
      for (;;) {
        const te = k < steps ? Math.floor(timeOf(startBeat + k * stepBeats) / q) * q : Infinity;
        const tm = m * modDt < total - q ? m * modDt : Infinity;
        const tn = Math.min(te, tm);
        if (!Number.isFinite(tn)) return;
        if (!(tn > lastT)) { // sub-quantum (extreme tempo): run it now
          if (te <= tn) { runStep(k, false); k++; }
          if (tm <= tn) m++;
          continue;
        }
        lastT = tn;
        ctx.suspend(tn).then(() => {
          if (te <= tn) { runStep(k, false); k++; }
          if (tm <= tn) { modTick(tn); m++; }
          plan();
          flushAll(graph).then(() => ctx.resume()); // worklet plugins / superdough must receive their notes first
        }, (e) => { onError(e); });
        return;
      }
    };
    plan();
  } else if (control) {
    const stepBeats = 0.25;
    const q = 128 / sampleRate; // suspend() works on render-quantum boundaries
    const steps = Math.ceil((endBeat - startBeat) / stepBeats - 1e-9);
    const runStep = (k, jump) => {
      const b = startBeat + k * stepBeats;
      try { graph.applyControl(project, b, { immediate: k === 0 }); } catch (e) { onError(e); }
      schedule(b, Math.min(endBeat, b + stepBeats), jump);
    };
    runStep(0, true);
    let lastT = 0;
    const plan = (k) => {
      if (k >= steps) return;
      const t = Math.floor(timeOf(startBeat + k * stepBeats) / q) * q;
      if (!(t > lastT)) { runStep(k, false); plan(k + 1); return; } // sub-quantum step (extreme tempo)
      lastT = t;
      ctx.suspend(t).then(() => {
        runStep(k, false);
        plan(k + 1);
        flushAll(graph).then(() => ctx.resume()); // worklet plugins / superdough must receive their notes first
      }, (e) => { onError(e); });
    };
    plan(1);
  } else if (typeof ctx.suspend === 'function' && dur > chunkSec * 3) {
    // Schedule incrementally (keeps memory flat on long songs): events for chunk k+1 are
    // scheduled while the renderer is suspended at the start of chunk k.
    schedule(startBeat, Math.min(endBeat, beatOf(2 * chunkSec)), true);
    const plan = (k) => {
      const from = beatOf((k + 1) * chunkSec);
      if (from >= endBeat) return;
      ctx.suspend(k * chunkSec).then(() => {
        schedule(from, Math.min(endBeat, beatOf((k + 2) * chunkSec)), false);
        plan(k + 1);
        flushAll(graph).then(() => ctx.resume()); // worklet plugins / superdough must receive their notes first
      }, (e) => { onError(e); });
    };
    plan(1);
  } else {
    schedule(startBeat, endBeat, true);
  }

  await flushAll(graph);
  graph.updatePdc(project); // plugins may have reported their latency while loading
  const latencyFrames = Math.min(pad, Math.round(graph.latency * sampleRate));
  if (graph.latency * sampleRate > pad + 0.5) onError(new Error(`Plugin latency ${(graph.latency * 1000).toFixed(0)} ms exceeds the render pad — the export is shifted`));
  let buffer;
  try {
    buffer = await ctx.startRendering();
  } finally {
    release();
  }
  try { graph.dispose(); } catch { /* */ }
  return trimHead(ctx, buffer, latencyFrames, length);
}

/** True-peak limit an AudioBuffer in place (offline, look-ahead, no latency). Returns the buffer (+ .truePeak info). */
export function applyTruePeakLimit(buffer, { ceilingDb = -1, lookahead, release } = {}) {
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const res = limitTruePeak(chans, buffer.sampleRate, { ceilingDb, lookahead, release });
  res.channels.forEach((d, c) => buffer.getChannelData(c).set(d));
  try { buffer.truePeak = { gainReductionDb: res.gainReductionDb, truePeakDb: res.truePeakDb }; } catch { /* */ }
  return buffer;
}

/** Max PDC latency (s) an offline render compensates exactly (extra frames rendered then trimmed). */
export const PDC_PAD = 1;

/** The `length` frames of `buffer` starting at frame `from` (a new AudioBuffer). */
export function trimHead(ctx, buffer, from, length) {
  const out = ctx.createBuffer(buffer.numberOfChannels, length, buffer.sampleRate);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    out.getChannelData(c).set(src.subarray(from, Math.min(src.length, from + length)));
  }
  return out;
}
