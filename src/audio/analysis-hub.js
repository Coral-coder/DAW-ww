// Metering taps on any mixer channel, created lazily and kept per MixGraph (engine.graph):
//
//   loudnessOf(engine, id, {light})   loudness analysis (meters.js) of 'master' (= the graph's master analysis, with
//                                     scope / spectrum) or a track / bus strip: pre = strip input, post = post-fader
//                                     output. light = true: no true-peak interpolator, no analysers (strip LUFS).
//   releaseLoudness(engine, id, {light})  dispose a strip analysis (the master's stays)
//   utilityOf(engine)                 bit / DC / clip meters of the master output (utility-meter.js)
//   meterBlock(engine, id)            the most recent samples of a strip's (PDC-aligned, post-fader) meter tap:
//                                     {l, r, sampleRate} — fed to dsp/ballistics.js by the mixer's meter modes
//   channelList(project)              [{id, label}] of meterable channels (master, tracks, buses)
//
// A new graph (audio restart, offline render) gets fresh taps; the old graph's taps are disposed on first access.
import { MasterAnalysis } from './meters.js';
import { UtilityMeter } from './utility-meter.js';

const hubs = new WeakMap(); // engine -> {graph, loud: Map, util}

function hubOf(engine) {
  const g = engine?.graph;
  if (!g || !engine.ctx) return null;
  let hub = hubs.get(engine);
  if (hub && hub.graph !== g) { disposeHub(hub); hub = null; }
  if (!hub) { hub = { graph: g, loud: new Map(), util: null, blocks: new WeakMap() }; hubs.set(engine, hub); }
  return hub;
}

function disposeHub(hub) {
  for (const a of hub.loud.values()) { try { a.an.dispose(); } catch { /* */ } }
  hub.loud.clear();
  try { hub.util?.dispose(); } catch { /* */ }
  hub.util = null;
}

/** The ChannelStrip of a channel id in a MixGraph ('master', a track id or a bus id). */
export function stripOf(graph, id) {
  if (!graph) return null;
  if (id === 'master') return graph.master;
  return graph.tracks?.get(id)?.strip || graph.buses?.get(id) || null;
}

export function loudnessOf(engine, id = 'master', { light = false } = {}) {
  const hub = hubOf(engine);
  if (!hub) return null;
  if (id === 'master' && !light) return hub.graph.masterAnalysis();
  const strip = stripOf(hub.graph, id);
  if (!strip) return null;
  const key = `${id}|${light ? 1 : 0}`;
  let e = hub.loud.get(key);
  if (e && e.strip !== strip) { try { e.an.dispose(); } catch { /* */ } e = null; }
  if (!e) {
    const post = id === 'master' ? hub.graph.out : strip.muteGain;
    e = { strip, an: new MasterAnalysis(engine.ctx, strip.input, post, { truePeak: !light, views: !light }) };
    hub.loud.set(key, e);
  }
  return e.an;
}

export function releaseLoudness(engine, id, { light = false } = {}) {
  const hub = hubs.get(engine);
  if (!hub || (id === 'master' && !light)) return;
  const key = `${id}|${light ? 1 : 0}`;
  const e = hub.loud.get(key);
  if (e) { try { e.an.dispose(); } catch { /* */ } hub.loud.delete(key); }
}

/** Dispose every light (strip LUFS) analysis except those in `keep`. */
export function releaseLightExcept(engine, keep = new Set()) {
  const hub = hubs.get(engine);
  if (!hub) return;
  for (const [key, e] of hub.loud) {
    const [id, light] = key.split('|');
    if (light === '1' && !keep.has(id)) { try { e.an.dispose(); } catch { /* */ } hub.loud.delete(key); }
  }
}

export function utilityOf(engine) {
  const hub = hubOf(engine);
  if (!hub) return null;
  if (!hub.util) hub.util = new UtilityMeter(engine.ctx, hub.graph.out);
  return hub.util;
}

export function meterBlock(engine, id) {
  const hub = hubOf(engine);
  const strip = hub && stripOf(hub.graph, id);
  if (!strip?.anL) return null;
  let b = hub.blocks.get(strip);
  const n = strip.anL.fftSize;
  if (!b || b.l.length !== n) { b = { l: new Float32Array(n), r: new Float32Array(n), sampleRate: engine.ctx.sampleRate }; hub.blocks.set(strip, b); }
  strip.anL.getFloatTimeDomainData(b.l);
  strip.anR.getFloatTimeDomainData(b.r);
  return b;
}

export function channelList(project) {
  return [
    { id: 'master', label: 'Master' },
    ...(project?.tracks || []).map((t) => ({ id: t.id, label: t.name || 'Track' })),
    ...(project?.buses || []).map((b) => ({ id: b.id, label: `Bus · ${b.name || 'Bus'}` })),
  ];
}
