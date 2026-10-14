// Audio-clip warping — the pure math (Node-safe): warp markers, the clip "source curve" through the tempo map,
// auto-warp from analysis, audio quantize.
//
// clip.warp = {
//   mode: 'off' | 'repitch' | 'beats' | 'tones' | 'complex',
//   markers: [{ beat, sec }],   // content beat (beats from the sample start, the unit of clip.offset) <-> sample
//                               // seconds; sorted, strictly increasing in both. Between markers the mapping is
//                               // linear; outside it extrapolates the nearest segment (or `bpm` with one marker).
//   bpm,                        // source tempo (detected / set); used with < 2 markers
//   transpose,                  // semitones (beats / tones / complex: pitch only; repitch: rate × 2^(st/12) on top of the tempo ratio — tape)
//   formants,                   // tones / complex: keep formants while transposing (LPC envelope)
//   quality,                    // 'draft' | 'normal' | 'high' (grain size / search effort)
// }
// sample.analysis = { bpm, confidence, downbeat, transients: [sec], v } (from analyze.js)
//
// A clip on the timeline: content beat c at timeline beat b is c = b − clip.start + clip.offset. Warped clips
// follow the tempo map: sample time s(c) is fixed by the markers, so the audio stretches with tempo changes.
// mode 'off' keeps the old behaviour (sample plays at its own speed from clip.offset·60/bpm(clip.start) seconds).

export const WARP_MODES = ['off', 'repitch', 'beats', 'tones', 'complex'];
export const WARP_MODE_LABELS = { off: 'Off', repitch: 'Re-Pitch', beats: 'Beats', tones: 'Tones', complex: 'Complex' };
export const isWarped = (clip) => !!(clip?.warp && clip.warp.mode && clip.warp.mode !== 'off' && WARP_MODES.includes(clip.warp.mode));

/** Clean marker list: finite, sorted by beat, strictly increasing in sec too. */
export function normalizeMarkers(markers) {
  const ms = (markers || []).filter((m) => m && Number.isFinite(+m.beat) && Number.isFinite(+m.sec))
    .map((m) => ({ beat: +m.beat, sec: +m.sec })).sort((a, b) => a.beat - b.beat);
  const out = [];
  for (const m of ms) {
    const p = out[out.length - 1];
    if (p && (m.beat - p.beat < 1e-6 || m.sec - p.sec < 1e-6)) continue;
    out.push(m);
  }
  return out;
}

/** Seconds per content beat outside / with too few markers. */
const fallbackSpb = (warp) => 60 / (warp?.bpm > 0 ? warp.bpm : 120);

/** Sample seconds at content beat c. */
export function secAtBeat(warp, c) {
  const m = warp?.markers || [];
  if (!m.length) return c * fallbackSpb(warp);
  if (m.length === 1) return m[0].sec + (c - m[0].beat) * fallbackSpb(warp);
  let i = 0;
  if (c >= m[m.length - 1].beat) i = m.length - 2;
  else if (c > m[0].beat) { let lo = 0, hi = m.length - 2; while (lo < hi) { const x = (lo + hi + 1) >> 1; if (m[x].beat <= c) lo = x; else hi = x - 1; } i = lo; }
  const a = m[i], b = m[i + 1];
  return a.sec + ((c - a.beat) * (b.sec - a.sec)) / (b.beat - a.beat);
}

/** Content beat at sample seconds s (inverse of secAtBeat). */
export function beatAtSec(warp, s) {
  const m = warp?.markers || [];
  if (!m.length) return s / fallbackSpb(warp);
  if (m.length === 1) return m[0].beat + (s - m[0].sec) / fallbackSpb(warp);
  let i = 0;
  if (s >= m[m.length - 1].sec) i = m.length - 2;
  else if (s > m[0].sec) { let lo = 0, hi = m.length - 2; while (lo < hi) { const x = (lo + hi + 1) >> 1; if (m[x].sec <= s) lo = x; else hi = x - 1; } i = lo; }
  const a = m[i], b = m[i + 1];
  return a.beat + ((s - a.sec) * (b.beat - a.beat)) / (b.sec - a.sec);
}

/** Local source tempo (bpm) of the segment containing content beat c. */
export function sourceBpmAt(warp, c) {
  const d = 1e-3;
  return (60 * 2 * d) / (secAtBeat(warp, c + d) - secAtBeat(warp, c - d));
}

/**
 * Source curve for playing `clip` from timeline beat b0 to b1 under tempo map `map`:
 * -> { points: [{t, s}] (t = seconds from the play start, s = sample seconds; piecewise linear, t increasing),
 *      duration (s) }
 * Breakpoints: play ends, warp markers, tempo-map breaks and — inside tempo ramps — every 1/16 beat (the true
 * curve is smooth there; 1/16-beat chords keep the error far below a sample at musical tempi).
 */
export function clipCurve(clip, map, b0, b1, { step = 0.0625 } = {}) {
  const cs = clip.start, off = clip.offset || 0;
  const t0 = map.secAt(b0);
  if (!isWarped(clip)) {
    const s0 = off * map.spbAt(cs) + (t0 - map.secAt(cs));
    const T = map.secAt(b1) - t0;
    return { points: [{ t: 0, s: s0 }, { t: T, s: s0 + T }], duration: T };
  }
  const w = clip.warp;
  const beats = new Set([b0, b1]);
  for (const mk of w.markers || []) { const b = mk.beat - off + cs; if (b > b0 && b < b1) beats.add(b); }
  for (const b of map.breaks(b0, b1)) beats.add(b);
  let list = [...beats].sort((a, b) => a - b);
  if (!map.isConstant) {
    const fine = [];
    for (let i = 0; i < list.length; i++) {
      fine.push(list[i]);
      const nx = list[i + 1];
      if (nx == null || map.isConstantIn(list[i], nx)) continue;
      for (let b = list[i] + step; b < nx - 1e-9; b += step) fine.push(b);
    }
    list = fine;
  }
  const points = list.map((b) => ({ t: map.secAt(b) - t0, s: secAtBeat(w, b - cs + off) }));
  return { points, duration: points[points.length - 1].t };
}

/** s(t) on a curve (linear extrapolation outside). `hint` = {i} speeds up monotone lookups. */
export function curveAt(points, t, hint) {
  const n = points.length;
  if (n === 1) return points[0].s + t;
  let i = hint?.i ?? 0;
  if (i > n - 2) i = n - 2;
  while (i > 0 && t < points[i].t) i--;
  while (i < n - 2 && t >= points[i + 1].t) i++;
  if (hint) hint.i = i;
  const a = points[i], b = points[i + 1];
  const dt = b.t - a.t;
  return dt > 0 ? a.s + ((t - a.t) * (b.s - a.s)) / dt : a.s;
}

/** t(s) on a curve (inverse; the curve is increasing in s). */
export function curveTimeAt(points, s) {
  const n = points.length;
  if (n === 1) return s - points[0].s;
  let i = 0;
  if (s >= points[n - 1].s) i = n - 2;
  else { while (i < n - 2 && s >= points[i + 1].s) i++; }
  const a = points[i], b = points[i + 1];
  const ds = b.s - a.s;
  return ds > 0 ? a.t + ((s - a.s) * (b.t - a.t)) / ds : a.t;
}

/** Piecewise-constant playback rates reproducing the curve exactly at every breakpoint: [{t, rate}]. */
/** Re-Pitch transpose factor: 2^(st/12) (1 for 0 / invalid). */
export const repitchFactor = (st) => Math.pow(2, (Number(st) || 0) / 12);

/**
 * Re-Pitch playback rates with transpose: the tempo ratio (curveRates) × 2^(st/12) — like speeding up tape, the
 * source advances P× faster from the clip's first source point (s0 + P·(s(t) − s0)), so pitch AND speed rise.
 */
export function repitchRates(points, transpose = 0) {
  const P = repitchFactor(transpose);
  return curveRates(points).map((r) => ({ t: r.t, rate: r.rate * P }));
}

export function curveRates(points) {
  const out = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    if (b.t - a.t <= 1e-9) continue;
    out.push({ t: a.t, rate: (b.s - a.s) / (b.t - a.t) });
  }
  return out;
}

// ------------------------------------------------------------------ auto warp / editing
/**
 * Warp settings for a freshly imported sample from its analysis: one marker per bar of the detected grid
 * (snapped to a transient within 25 ms), content beat 0 = the first downbeat. Percussive material -> 'beats',
 * else 'tones'; long files (> maxLoopSec) are analysed but left unwarped.
 */
export function autoWarp(analysis, duration, { beatsPerBar = 4, maxLoopSec = 60 } = {}) {
  const bpm = analysis?.bpm > 0 ? analysis.bpm : 120;
  const spb = 60 / bpm;
  const trans = analysis?.transients || [];
  let down = analysis?.downbeat ?? 0;
  // loops (short files starting with a hit) start on their downbeat: bar-phase detection is ambiguous on
  // loops with a kick every 2 beats, the cut point is not
  if (duration < 32 && trans.length && trans[0] < 0.03) down = trans[0];
  const bar = spb * beatsPerBar;
  while (down - bar > -0.03) down -= bar; // earliest bar start (30 ms slack: detection jitter)
  if (down < 0.03) down = Math.max(0, down < 0 && down > -0.03 ? 0 : down);
  const markers = [];
  const snap = (t) => { let best = t, bd = 0.025; for (const x of trans) { const d = Math.abs(x - t); if (d < bd) { bd = d; best = x; } } return best; };
  // beat 0 = the downbeat; material before it (pickup) sits at negative content beats
  for (let k = 0; ; k++) {
    const t = down + k * bar;
    if (t > duration + 1e-6) break;
    markers.push({ beat: k * beatsPerBar, sec: k === 0 ? down : snap(t) });
  }
  if (markers.length < 2) markers.push({ beat: (duration - down) / spb, sec: duration });
  const density = trans.length / Math.max(0.5, duration);
  const percussive = density > bpm / 60 * 0.9;
  const mode = duration > maxLoopSec || !(analysis?.confidence > 0.05) ? 'off' : (percussive ? 'beats' : 'tones');
  return { mode, markers: normalizeMarkers(markers), bpm: Math.round(bpm * 100) / 100, transpose: 0, formants: false, quality: 'normal' };
}

/** Clip length (beats) covering the whole sample under its warp. */
export function warpedLength(warp, duration, offset = 0) { return Math.max(0.25, beatAtSec(warp, duration) - offset); }

/** Insert a marker at content beat c (sec from the current mapping). Returns its index. */
export function addMarker(warp, c) {
  const sec = secAtBeat(warp, c);
  warp.markers = normalizeMarkers([...(warp.markers || []), { beat: c, sec }]);
  return warp.markers.findIndex((m) => Math.abs(m.beat - c) < 1e-6);
}
/** Drag marker i to content beat c (keeps its sample time — the audio stretches around it). */
export function moveMarker(warp, i, c) {
  const m = warp.markers;
  if (!m?.[i]) return;
  const lo = i > 0 ? m[i - 1].beat + 1e-3 : -Infinity, hi = i < m.length - 1 ? m[i + 1].beat - 1e-3 : Infinity;
  m[i].beat = Math.max(lo, Math.min(hi, c));
}
export function removeMarker(warp, i) { if (warp.markers?.[i] && warp.markers.length > 1) warp.markers.splice(i, 1); }

/** Re-tempo a whole clip's warp: source plays as if recorded at `bpm` (keeps marker 0). */
export function setWarpBpm(warp, bpm) {
  const m = warp.markers?.[0] || { beat: 0, sec: 0 };
  const ratio = bpm / (warp.bpm > 0 ? warp.bpm : bpm);
  warp.markers = normalizeMarkers((warp.markers?.length ? warp.markers : [m]).map((x) => ({ beat: m.beat + (x.beat - m.beat) * ratio, sec: x.sec })));
  warp.bpm = bpm;
}

/** Transient positions as content beats. */
export const transientBeats = (warp, transients) => (transients || []).map((s) => beatAtSec(warp, s));

/** Sample seconds at content beat c of `clip` placed on the timeline of tempo map `map` (drawing / editing). */
export function sourceTimeFn(clip, map) {
  if (isWarped(clip)) return (c) => secAtBeat(clip.warp, c);
  const cs = clip.start, off = clip.offset || 0;
  if (map.isConstant) { const spb = 60 / map.bpm; return (c) => c * spb; }
  const base = off * map.spbAt(cs), s0 = map.secAt(cs);
  return (c) => base + map.secAt(cs + c - off) - s0;
}
