// Plugin delay compensation (PDC) — pure helpers (Node-testable, no Web Audio).
//
// Every insert effect / instrument reports a processing latency in seconds (look-ahead of a
// DynamicsCompressor, a DelayNode look-ahead, WaveShaper oversampling filters, a plugin's own
// reported latency, or a manual `latency` override in samples on the effect / instrument def).
// The mixer (MixGraph) sums them per strip and calls computePdc() to find, for every route into the
// master bus, how much extra delay the shorter routes need so that everything arrives together:
//
//   track t ──inserts (Lt)──► fader ──► [delay out_t] ─────────────────────────────► master in
//                                   └─► send gain ──► [delay send_t,b] ──► bus b in ─inserts (Lb)─► fader ──► master in
//   master in ──inserts (Lm)──► fader ──► out
//
//   D (alignment point at the master input) = max over routes of (Lt, Lt + Lb, Lb)
//   out_t = D - Lt      send_t,b = D - Lt - Lb      (every route then arrives at the master input at D)
//   total = D + Lm      (the whole mix is late by `total`; the realtime scheduler pre-rolls every event
//                        by `total` and the offline renderer trims `total` from the head of the render,
//                        so the result is sample-identical to a latency-free graph)
//
// All values are seconds, rounded to whole frames at `sampleRate` so DelayNodes never interpolate.

/**
 * Latencies measured in Chromium 141 (offline render, impulse in -> peak out, 44.1 / 48 / 96 kHz) and derived from
 * the nodes each effect builder uses:
 *   - DynamicsCompressorNode: fixed 6 ms pre-delay (Blink/WebKit/Gecko share the implementation)
 *   - WaveShaperNode oversample '2x' / '4x': linear-phase up/down-sampling kernels (frames at the base rate)
 *   - explicit DelayNode look-ahead (gate 4 ms, tape 12 ms base delay)
 */
export const COMPRESSOR_LOOKAHEAD = 0.006;
export const OVERSAMPLE_FRAMES = { none: 0, '2x': 129, '4x': 193 };

/** Frames of a fixed-seconds look-ahead as the browser truncates it (compressor pre-delay, DelayNode look-aheads
 *  — effects.js sets those to whole frames with lookaheadTime()). */
export const framesOf = (sec, sr) => Math.floor(sec * sr + 1e-6);
/** A look-ahead time rounded down to whole frames (so the DelayNode does not interpolate). */
export const lookaheadTime = (sec, sr) => framesOf(sec, sr) / sr;

/**
 * Latency (frames) of a built-in effect type with resolved params. Unknown / plugin types: 0 (plugins report
 * their own at runtime). A def-level `latency` (samples) overrides everything (manual entry for plugins).
 */
export function effectLatencyFrames(def, sampleRate = 44100) {
  if (!def) return 0;
  if (Number.isFinite(def.latency) && def.latency >= 0) return Math.round(def.latency);
  const comp = framesOf(COMPRESSOR_LOOKAHEAD, sampleRate);
  switch (def.type) {
    case 'compressor': return comp;
    case 'limiter': return comp;
    case 'gate': return framesOf(0.004, sampleRate);
    case 'tape': return framesOf(0.012, sampleRate) + OVERSAMPLE_FRAMES['2x'];
    case 'distortion': return OVERSAMPLE_FRAMES['4x'];
    case 'saturator': return OVERSAMPLE_FRAMES['2x'];
    // glue compressor + limiter (two pre-delays) + 4x-oversampled clipper (measured: one frame less)
    case 'mastering': return 2 * comp + OVERSAMPLE_FRAMES['4x'] - 1;
    default: return 0;
  }
}

export const effectLatency = (def, sampleRate = 44100) => effectLatencyFrames(def, sampleRate) / sampleRate;

/** Round seconds to whole frames (never negative). */
export const quantize = (sec, sampleRate) => Math.max(0, Math.round((Number(sec) || 0) * sampleRate)) / sampleRate;

/**
 * Compensation plan.
 * @param {{ sampleRate?: number, enabled?: boolean,
 *           tracks: {id:string, latency:number, sends?:string[]}[],
 *           buses: {id:string, latency:number}[],
 *           master: number }} g   latencies in seconds; `sends` = bus ids the track feeds
 * @returns {{ enabled:boolean, align:number, total:number,
 *             trackOut: Object<string,number>, trackSend: Object<string,Object<string,number>>,
 *             trackLatency: Object<string,number>, busLatency: Object<string,number>, master:number }}
 *   trackOut[id] / trackSend[id][busId]: compensation delay (s) to insert on that route.
 */
export function computePdc(g) {
  const sr = g.sampleRate || 44100;
  const q = (x) => quantize(x, sr);
  const busLat = {};
  for (const b of g.buses || []) busLat[b.id] = q(b.latency);
  const trackLatency = {};
  for (const t of g.tracks || []) trackLatency[t.id] = q(t.latency);
  const master = q(g.master);
  const out = { enabled: g.enabled !== false, align: 0, total: 0, trackOut: {}, trackSend: {}, trackLatency, busLatency: busLat, master };
  if (!out.enabled) {
    for (const t of g.tracks || []) { out.trackOut[t.id] = 0; out.trackSend[t.id] = {}; }
    return out;
  }
  let D = 0; // (a bus nobody sends to carries no signal: its latency does not count)
  for (const t of g.tracks || []) {
    const lt = trackLatency[t.id];
    D = Math.max(D, lt);
    for (const bid of t.sends || []) if (bid in busLat) D = Math.max(D, lt + busLat[bid]);
  }
  for (const t of g.tracks || []) {
    const lt = trackLatency[t.id];
    out.trackOut[t.id] = q(D - lt);
    const s = {};
    for (const bid of t.sends || []) if (bid in busLat) s[bid] = q(D - lt - busLat[bid]);
    out.trackSend[t.id] = s;
  }
  out.align = q(D);
  out.total = q(D + master);
  return out;
}

/**
 * When the signal of each mixer stage sounds relative to the moment its source events were dispatched
 * (seconds). Used to time fader automation: a track fader sits right after its inserts, a bus fader after
 * the alignment point plus its own inserts, the master fader after everything.
 */
export function faderOffsets(pdc) {
  const tracks = {};
  for (const [id, lt] of Object.entries(pdc.trackLatency || {})) tracks[id] = lt;
  return { tracks, bus: pdc.align, master: pdc.total };
}
