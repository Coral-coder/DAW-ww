// Audio-clip playback through the warp engine (browser side). Used by MixGraph.playEvent for clips that are
// warped (clip.warp.mode != 'off') or when the transport follows a non-constant tempo map.
//
//   off      — AudioBufferSourceNode at rate 1 (offset / duration from the tempo map)
//   repitch  — AudioBufferSourceNode whose playbackRate steps through curveRates() (exact at every breakpoint)
//   beats / tones / complex (pitch-preserving):
//              realtime: an AudioWorkletNode ('daw3-warp', worklet.js) streams WarpRenderer (core.js) — the sample
//              PCM is posted once per context into the worklet scope;
//              fallback (no AudioWorklet, worklet still loading, offline renders / export): the same WarpRenderer
//              runs once on the main thread and the result is cached (LRU) and played as a plain buffer.
// Live tempo edits: retime(map, time, beat) re-curves every voice that spans `beat` from ctx `time` on (worklet
// voices get the spliced curve and carry on seamlessly; repitch re-schedules playbackRate; cached voices restart).
import { clipCurve, curveRates, curveTimeAt, isWarped, secAtBeat, spliceCurve } from './markers.js';
import { envelopePoints } from '../../record/clips.js';
import { renderWarp } from './core.js';
import { TempoMap } from '../../time/tempo-map.js';

export const needsWarpPlayer = (clip) => isWarped(clip);

/**
 * Unwarped clip under a non-constant tempo map, re-expressed in seconds (spb = 1) so the regular buffer / streaming
 * clip player plays it: the audio runs at its own speed from clip.offset·60/bpm(clip.start).
 */
export function unwarpedInSeconds(ev, map) {
  const c = ev.clip, cs = c.start, ce = c.start + c.length;
  const clip = { ...c, offset: (c.offset || 0) * map.spbAt(cs), length: map.span(cs, ce) };
  if (c.fadeIn > 0) clip.fadeIn = map.span(cs, cs + c.fadeIn);
  if (c.fadeOut > 0) clip.fadeOut = map.span(ce - c.fadeOut, ce);
  // clip gain envelope points are beats from the clip start -> seconds, like the fades
  if (c.gainEnv?.length) clip.gainEnv = c.gainEnv.map((p) => ({ ...p, beat: map.span(cs, cs + p.beat) }));
  return { ...ev, clip, offset: map.span(cs, ev.beat), dur: map.span(ev.beat, ev.beat + ev.dur) };
}

const workletState = new WeakMap(); // ctx -> { status: 'loading'|'ready'|'failed', promise, samples: Set }

/** Load the warp worklet into ctx (idempotent). Resolves true when available. */
export function loadWarpWorklet(ctx) {
  let st = workletState.get(ctx);
  if (st) return st.promise;
  st = { status: 'loading', samples: new Set(), promise: null };
  workletState.set(ctx, st);
  if (!ctx?.audioWorklet || typeof AudioWorkletNode !== 'function' || globalThis.DAW3_NO_WARP_WORKLET) {
    st.status = 'failed';
    st.promise = Promise.resolve(false);
    return st.promise;
  }
  // some (sandboxed / headless) browsers never settle addModule: give up after 8 s and keep the offline cache path
  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 8000));
  st.promise = Promise.race([ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url).href), timeout])
    .then((r) => {
      if (r === 'timeout') { st.status = 'failed'; console.warn('[warp] AudioWorklet did not load — using the offline warp cache'); return false; }
      st.status = 'ready'; return true;
    }, (e) => { st.status = 'failed'; st.error = e; console.warn('[warp] AudioWorklet unavailable — using the offline warp cache', e?.message || e); return false; });
  return st.promise;
}
export const warpWorkletStatus = (ctx) => workletState.get(ctx)?.status || 'none';

/** Slice points (sample seconds) for 'beats' mode: detected transients, else every 16th of the warp grid. */
export function beatSlices(clip, analysis, duration) {
  if (analysis?.transients?.length) return analysis.transients;
  const out = [];
  const w = clip.warp;
  for (let k = 0; k < 4096; k++) {
    const s = secAtBeat(w, (w.markers?.[0]?.beat || 0) + k / 4);
    if (s > duration) break;
    if (s >= 0) out.push(s);
  }
  return out;
}

export class WarpPlayer {
  constructor(graph, o = {}) {
    this.g = graph;
    this.ctx = graph.ctx;
    this.o = o;
    this.cache = new Map(); // key -> AudioBuffer (LRU)
    this.cacheFrames = 0;
    this.useWorklet = o.worklet !== false && typeof OfflineAudioContext !== 'undefined' && !(this.ctx instanceof OfflineAudioContext);
    if (this.useWorklet) loadWarpWorklet(this.ctx);
    this.stats = { worklet: 0, cached: 0, rendered: 0, native: 0, retimed: 0 };
    this.voices = new Set(); // { e, ev, clip, time, points, mode, kind: 'worklet'|'native'|'cached', src, g, dest }
  }

  play(e, ev, time, spb, map) {
    const clip = ev.clip;
    const buffer = this.o.getSampleBuffer(clip.sampleId);
    if (!buffer) return;
    if (!map) map = new TempoMap({ bpm: 60 / (spb || 0.5) });
    const b0 = ev.beat, b1 = ev.beat + ev.dur;
    const { points, duration } = clipCurve(clip, map, b0, b1);
    if (!(duration > 0.002)) return;
    const mode = isWarped(clip) ? clip.warp.mode : 'off';
    const ctx = this.ctx;
    const g = ctx.createGain();
    this.g._clipEnvelope(g, clip, ev, time, duration, map.spbAt(b0));
    g.connect(e.strip.input);
    let src = null;
    if (mode === 'off' || mode === 'repitch') src = this._native(buffer, points, duration, time, g, mode);
    else src = this._stretched(clip, buffer, points, duration, time, g, mode);
    if (!src) { try { g.disconnect(); } catch { /* */ } return; }
    const rec = { src, g };
    this.g.sources.add(rec);
    const voice = { e, ev, clip, time, points, mode, kind: src.node ? 'worklet' : (mode === 'off' || mode === 'repitch') ? 'native' : 'cached', src, g, rec };
    this.voices.add(voice);
    this._onEnded(voice, src);
  }

  _onEnded(voice, src) {
    src.onended = () => {
      if (voice.src !== src) return; // replaced by a retimed source
      this.voices.delete(voice);
      this.g.sources.delete(voice.rec);
      try { voice.g.disconnect(); } catch { /* */ }
    };
  }

  /**
   * Live tempo edit: from ctx `time` (dispatch time of transport `beat` — the scheduler's next window boundary,
   * where the new map takes over) every voice that spans `beat` follows `map`. Returns the number of voices retimed.
   */
  retime(map, time, beat) {
    let n = 0;
    for (const v of [...this.voices]) {
      const { ev, clip } = v;
      const end = ev.beat + ev.dur;
      if (!(beat > ev.beat + 1e-9 && beat < end - 1e-9)) continue;
      const tc = time - v.time;
      if (!(tc > 0) || tc >= v.points[v.points.length - 1].t) continue;
      const tail = clipCurve(clip, map, beat, end).points;
      const points = spliceCurve(v.points, tc, tail);
      const duration = points[points.length - 1].t;
      try {
        if (v.kind === 'worklet') v.src.node.port.postMessage({ type: 'curve', curve: points });
        else if (v.kind === 'native') this._retimeNative(v, points, tc, duration);
        else this._retimeCached(v, tail, time);
      } catch (err) { console.warn('[warp] retime failed', err); continue; }
      v.points = points;
      this._retimeEnvelope(v, map, beat, end, time, duration - tc);
      n++;
    }
    this.stats.retimed += n;
    return n;
  }

  _retimeNative(v, points, tc, duration) {
    const src = v.src, t = v.time + tc;
    if (v.mode === 'repitch') {
      src.playbackRate.cancelScheduledValues(t);
      for (const r of curveRates(points)) if (r.t >= tc - 1e-9) src.playbackRate.setValueAtTime(Math.max(0.01, r.rate), v.time + r.t);
    }
    src.stop(v.time + duration + 0.001); // a later stop() replaces the earlier stop time
  }

  _retimeCached(v, tail, time) {
    const buffer = this.o.getSampleBuffer(v.clip.sampleId);
    if (!buffer) return;
    const out = this._cached(v.clip.sampleId, buffer, this._opts(v.clip, buffer, tail, v.mode));
    if (!out) return;
    const src = this.ctx.createBufferSource();
    src.buffer = out;
    src.connect(v.g);
    src.start(time, 0, tail[tail.length - 1].t + 0.001);
    try { v.src.stop(time); } catch { /* */ }
    v.src = src; v.rec.src = src;
    this._onEnded(v, src);
  }

  /** Clip gain envelope from `time` on, under the new map (no de-click dip at the splice). */
  _retimeEnvelope(v, map, beat, end, time, dur) {
    const p = v.g.gain;
    const pts = envelopePoints(v.clip, beat - v.clip.start, dur, map);
    if (pts.length > 1) pts[0] = { t: 0, v: pts[1].v };
    if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(time); else p.cancelScheduledValues(time);
    p.setValueAtTime(pts[0].v, time);
    for (let i = 1; i < pts.length; i++) p.linearRampToValueAtTime(pts[i].v, time + pts[i].t);
  }

  /** Forget every voice (transport stop / seek: the mixer stops the sources). */
  clear() { this.voices.clear(); }

  _native(buffer, points, duration, time, dest, mode) {
    const ctx = this.ctx;
    const s0 = points[0].s;
    // portion before the sample start (negative source time) is silent: start later
    let t0 = 0;
    if (s0 < 0) { t0 = curveTimeAt(points, 0); if (t0 >= duration) return null; }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (mode === 'repitch') {
      // piecewise-constant rates: exact source position at every curve breakpoint
      for (const r of curveRates(points)) src.playbackRate.setValueAtTime(Math.max(0.01, r.rate), time + r.t);
    }
    src.connect(dest);
    const off = Math.max(0, s0 < 0 ? 0 : s0);
    if (off >= buffer.duration) return null;
    this.stats.native++;
    if (mode === 'off') src.start(time + t0, off, Math.min(duration - t0, buffer.duration - off) + 0.001);
    else { src.start(time + t0, off); src.stop(time + duration + 0.001); }
    return src;
  }

  _opts(clip, buffer, points, mode) {
    const w = clip.warp || {};
    const analysis = this.o.getSampleAnalysis?.(clip.sampleId) || null;
    return {
      mode, curve: points, transpose: Number(w.transpose) || 0, formants: !!w.formants, quality: w.quality || 'normal',
      slices: mode === 'beats' ? beatSlices(clip, analysis, buffer.duration) : [],
      srcRate: buffer.sampleRate, outRate: this.ctx.sampleRate,
    };
  }

  _stretched(clip, buffer, points, duration, time, dest, mode) {
    const opts = this._opts(clip, buffer, points, mode);
    const st = workletState.get(this.ctx);
    if (this.useWorklet && st?.status === 'ready') {
      try { return this._worklet(clip.sampleId, buffer, opts, time, dest); } catch (err) { console.warn('[warp] worklet voice failed', err); }
    }
    const out = this._cached(clip.sampleId, buffer, opts);
    if (!out) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = out;
    src.connect(dest);
    src.start(time, 0, duration + 0.001);
    return src;
  }

  _key(sampleId, o) {
    const c = o.curve.map((p) => `${p.t.toFixed(6)},${p.s.toFixed(6)}`).join(';');
    return `${sampleId}|${o.mode}|${o.transpose}|${o.formants}|${o.quality}|${o.outRate}|${o.slices.length}|${c}`;
  }

  /** Offline-rendered (cached) warp of this play. */
  _cached(sampleId, buffer, o) {
    const key = this._key(sampleId, o);
    let out = this.cache.get(key);
    if (out) { this.cache.delete(key); this.cache.set(key, out); this.stats.cached++; return out; }
    const chs = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) chs.push(buffer.getChannelData(c));
    const data = renderWarp({ ...o, channels: chs });
    const len = data[0].length;
    if (!len) return null;
    out = this.ctx.createBuffer(Math.min(2, Math.max(1, data.length)), len, o.outRate);
    for (let c = 0; c < out.numberOfChannels; c++) out.getChannelData(c).set(data[c]);
    this.stats.rendered++;
    this.cache.set(key, out);
    this.cacheFrames += len;
    while (this.cacheFrames > 40 * 60 * 48000 && this.cache.size > 1) { // ~40 min of audio
      const [k, b] = this.cache.entries().next().value;
      this.cache.delete(k); this.cacheFrames -= b.length;
    }
    return out;
  }

  _worklet(sampleId, buffer, o, time, dest) {
    const st = workletState.get(this.ctx);
    const node = new AudioWorkletNode(this.ctx, 'daw3-warp', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { sampleId, when: time, mode: o.mode, curve: o.curve, transpose: o.transpose, formants: o.formants, quality: o.quality, slices: o.slices, srcRate: o.srcRate },
    });
    if (!st.samples.has(sampleId)) {
      const chs = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) chs.push(buffer.getChannelData(c).slice());
      node.port.postMessage({ type: 'sample', id: sampleId, sr: buffer.sampleRate, channels: chs }, chs.map((c) => c.buffer));
      st.samples.add(sampleId);
    }
    node.connect(dest);
    const voice = {
      node,
      onended: null,
      stop: (t) => { try { node.port.postMessage({ type: 'stop', at: t ?? 0 }); } catch { /* */ } },
    };
    node.port.onmessage = (m) => {
      if (m.data?.type === 'ended') { try { node.disconnect(); } catch { /* */ } voice.onended?.(); }
    };
    this.stats.worklet++;
    return voice;
  }
}
