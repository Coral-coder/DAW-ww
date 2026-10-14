// Audio-clip editing — pure helpers shared by playback (scheduler / mixer / offline render), the arrange view and
// flatten / consolidate (Node-testable, no Web Audio).
//
// Clip fields used here (all optional; absent = old behaviour, bit-identical renders):
//   fadeIn / fadeOut           beats
//   fadeInShape / fadeOutShape 'lin' (default) | 'exp' | 'log' | 's' | 'eqp' (equal power, used for crossfades)
//   gainEnv                    [{ beat (relative to the clip start), gain (linear multiplier, 0..4) }] sorted
//   xfade === false            opt this clip out of automatic crossfades with overlapping clips
// Overlapping audio clips on a track crossfade automatically over the overlap (equal power), see autoCrossfade().
import { compClips, srcSecAt } from './takes.js';

const EPS = 1e-6;
export const FADE_SHAPES = ['lin', 'exp', 'log', 's', 'eqp'];
export const DECLICK = 0.004; // s — the mixer's de-click ramp at the start / end of every clip play

/** Rising fade curve 0..1 -> 0..1. Fade-outs evaluate it at the remaining fraction. */
export function fadeCurve(shape, x) {
  x = x <= 0 ? 0 : x >= 1 ? 1 : x;
  switch (shape) {
    case 'exp': return x * x * x;
    case 'log': return 1 - (1 - x) * (1 - x) * (1 - x);
    case 's': return 0.5 - 0.5 * Math.cos(Math.PI * x);
    case 'eqp': return Math.sin((Math.PI / 2) * x);
    default: return x;
  }
}

/** Gain-envelope value at `beat` (relative to the clip start): linear between points, held outside. */
export function envAt(points, beat) {
  if (!points?.length) return 1;
  if (beat <= points[0].beat) return points[0].gain;
  const last = points[points.length - 1];
  if (beat >= last.beat) return last.gain;
  for (let i = 1; i < points.length; i++) {
    const b = points[i];
    if (beat <= b.beat) {
      const a = points[i - 1];
      const span = b.beat - a.beat;
      return span > EPS ? a.gain + (b.gain - a.gain) * ((beat - a.beat) / span) : b.gain;
    }
  }
  return last.gain;
}

/** Linear gain of a clip at `tb` beats after its start: clip gain × gain envelope × fades. */
export function clipGainAt(clip, tb) {
  let g = (clip.gain ?? 1) * envAt(clip.gainEnv, tb);
  const fi = clip.fadeIn || 0, fo = clip.fadeOut || 0;
  if (fi > 0 && tb < fi) g *= fadeCurve(clip.fadeInShape, tb / fi);
  if (fo > 0 && tb > clip.length - fo) g *= fadeCurve(clip.fadeOutShape, (clip.length - tb) / fo);
  return g;
}

/** Does this clip need the shaped envelope (curved fades / gain envelope) rather than the mixer's simple one? */
export const needsShapedEnvelope = (clip) => !!(clip && ((clip.fadeInShape && clip.fadeInShape !== 'lin')
  || (clip.fadeOutShape && clip.fadeOutShape !== 'lin') || clip.gainEnv?.length));

/**
 * Breakpoints of one clip play's gain: [{ t (s after the play starts), v }], to be scheduled as linear ramps.
 *   offBeats: where the play starts inside the clip (beats from the clip start), durSec: how long it plays.
 * Includes the 4 ms de-click ramps at both ends (like every clip play) and samples curved fades in 24 steps.
 *   spb: seconds per beat, or a TempoMap (src/time/tempo-map.js) — beats are then song beats from clip.start, timed
 *   through the map (fades / envelope points stay on their beats across tempo ramps).
 */
export function envelopePoints(clip, offBeats, durSec, spb, { steps = 24 } = {}) {
  const dur = Math.max(0, durSec);
  const dc = Math.min(DECLICK, dur / 4);
  const map = spb && typeof spb === 'object' ? spb : null;
  const s0 = map ? map.secAt(clip.start + offBeats) : 0;
  const tbAt = map ? (t) => map.beatAt(s0 + t) - clip.start : (t) => offBeats + t / spb;
  const tOf = map ? (b) => map.secAt(clip.start + b) - s0 : (b) => (b - offBeats) * spb;
  const ts = new Set([dc, dur - dc]);
  const addRange = (b0, b1, curved) => {
    const n = curved ? steps : 1;
    for (let k = 0; k <= n; k++) ts.add(tOf(b0 + ((b1 - b0) * k) / n));
  };
  const fi = clip.fadeIn || 0, fo = clip.fadeOut || 0;
  if (fi > 0) addRange(0, fi, (clip.fadeInShape || 'lin') !== 'lin');
  if (fo > 0) addRange(clip.length - fo, clip.length, (clip.fadeOutShape || 'lin') !== 'lin');
  for (const p of clip.gainEnv || []) ts.add(tOf(p.beat));
  const inner = [...ts].filter((t) => t >= dc - 1e-9 && t <= dur - dc + 1e-9).sort((a, b) => a - b);
  const pts = [{ t: 0, v: 0 }];
  let prev = -1;
  for (const t of inner) {
    if (t - prev < 1e-6) continue;
    pts.push({ t, v: clipGainAt(clip, tbAt(t)) });
    prev = t;
  }
  pts.push({ t: dur, v: 0 });
  return pts;
}

/** Value of a breakpoint list (linear ramps) at time t. */
export function pointsValueAt(pts, t) {
  if (t <= pts[0].t) return pts[0].v;
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].t) {
      const a = pts[i - 1], b = pts[i];
      return b.t - a.t > 1e-12 ? a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t)) : b.v;
    }
  }
  return pts[pts.length - 1].v;
}

/**
 * Automatic crossfades: where an audio clip starts inside another one (and runs past its end), the earlier clip
 * fades out and the later one fades in over the overlap (equal power). Returns new objects only for clips that
 * change; the others are returned as they are.
 */
export function autoCrossfade(clips) {
  const audio = clips.filter((c) => c.type === 'audio' && c.xfade !== false);
  if (audio.length < 2) return clips;
  const sorted = [...audio].sort((a, b) => a.start - b.start || a.length - b.length);
  const patch = new Map();
  const get = (c) => patch.get(c) || c;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const A = sorted[i];
    const aEnd = A.start + A.length;
    // the next clip starting inside A and ending after it
    for (let j = i + 1; j < sorted.length; j++) {
      const B = sorted[j];
      if (B.start >= aEnd - EPS) break;
      const bEnd = B.start + B.length;
      if (bEnd <= aEnd + EPS || B.start <= A.start + EPS) continue;
      const ov = aEnd - B.start;
      const a = { ...get(A) }, b = { ...get(B) };
      if (!(a.fadeOut > ov)) { a.fadeOut = ov; a.fadeOutShape = 'eqp'; }
      if (!(b.fadeIn > ov)) { b.fadeIn = ov; b.fadeInShape = 'eqp'; }
      patch.set(A, a);
      patch.set(B, b);
      break;
    }
  }
  if (!patch.size) return clips;
  return clips.map((c) => patch.get(c) || c);
}

/**
 * The clips a track plays in song mode: its own clips (with automatic crossfades) + the comp of its take lanes.
 * Used by scheduler.collectEvents (realtime + offline render).
 */
export function trackClips(project, track) {
  let own = null;
  for (const c of project.clips) {
    if (c.trackId !== track.id) continue;
    (own || (own = [])).push(c);
  }
  own = own ? autoCrossfade(own) : [];
  if (track.comp?.length && track.takeLanes?.length) return own.concat(compClips(project, track));
  return own;
}

// ------------------------------------------------------------------------------------------- editing math
/** Split a clip at song beat `beat` -> [left, right] (copies; right gets `newId`). Pattern offsets wrap. */
export function splitClipAt(clip, beat, { patternLength = 0, newId } = {}) {
  if (!(beat > clip.start + EPS && beat < clip.start + clip.length - EPS)) return null;
  const cut = beat - clip.start;
  const left = { ...clip, length: +cut.toFixed(6) };
  const right = { ...clip, id: newId || `${clip.id}b`, start: +beat.toFixed(6), length: +(clip.length - cut).toFixed(6) };
  right.offset = clip.type === 'pattern' && patternLength > 0 ? +(((clip.offset || 0) + cut) % patternLength).toFixed(6) : +((clip.offset || 0) + cut).toFixed(6);
  // fades stay at the outer edges, the gain envelope is split in two
  delete left.fadeOut; delete left.fadeOutShape;
  delete right.fadeIn; delete right.fadeInShape;
  if (clip.gainEnv?.length) {
    const g = envAt(clip.gainEnv, cut);
    left.gainEnv = [...clip.gainEnv.filter((p) => p.beat < cut - EPS), { beat: +cut.toFixed(6), gain: g }];
    right.gainEnv = [{ beat: 0, gain: g }, ...clip.gainEnv.filter((p) => p.beat > cut + EPS).map((p) => ({ ...p, beat: +(p.beat - cut).toFixed(6) }))];
  }
  if (left.fadeIn > left.length) left.fadeIn = left.length;
  if (right.fadeOut > right.length) right.fadeOut = right.length;
  return [left, right];
}

/**
 * Slip edit: move the audio inside the clip by `delta` beats (positive = later), the clip stays put.
 * srcLength (beats of audio in the sample) bounds it so the clip never runs past the recording.
 */
export function slipOffset(clip, delta, srcLength = Infinity) {
  const maxOff = Math.max(0, srcLength - clip.length);
  const off = (clip.offset || 0) - delta;
  return +Math.min(maxOff, Math.max(0, off)).toFixed(6);
}

/**
 * Ripple delete: remove clips and pull every later clip on the same track left by the removed time.
 * Returns the new clip list (does not mutate).
 */
export function rippleDelete(clips, ids) {
  const del = new Set(ids);
  const gaps = new Map(); // trackId -> [{start, end}] merged
  for (const c of clips) {
    if (!del.has(c.id)) continue;
    const g = gaps.get(c.trackId) || [];
    g.push({ start: c.start, end: c.start + c.length });
    gaps.set(c.trackId, g);
  }
  for (const [tid, g] of gaps) {
    g.sort((a, b) => a.start - b.start);
    const m = [];
    for (const x of g) { const l = m[m.length - 1]; if (l && x.start <= l.end + EPS) l.end = Math.max(l.end, x.end); else m.push({ ...x }); }
    gaps.set(tid, m);
  }
  return clips.filter((c) => !del.has(c.id)).map((c) => {
    const g = gaps.get(c.trackId);
    if (!g) return c;
    let shift = 0;
    for (const x of g) if (x.end <= c.start + EPS) shift += x.end - x.start;
    return shift ? { ...c, start: +(c.start - shift).toFixed(6) } : c;
  });
}

/** Ripple edit: shift every clip of `trackId` starting at / after `from` by `delta` beats (except `exceptIds`). */
export function rippleShift(clips, trackId, from, delta, exceptIds = []) {
  const ex = new Set(exceptIds);
  return clips.map((c) => (c.trackId === trackId && !ex.has(c.id) && c.start >= from - EPS
    ? { ...c, start: +Math.max(0, c.start + delta).toFixed(6) } : c));
}

/** Nearest zero crossing (sign change) to `frame` within ±maxDist frames (frame itself when none). */
export function nearestZeroCrossing(data, frame, maxDist = 2048) {
  const n = data.length;
  const f = Math.max(1, Math.min(n - 1, Math.round(frame)));
  const zc = (i) => i > 0 && i < n && ((data[i - 1] <= 0 && data[i] > 0) || (data[i - 1] >= 0 && data[i] < 0) || data[i] === 0);
  for (let d = 0; d <= maxDist; d++) {
    if (zc(f - d)) return f - d;
    if (zc(f + d)) return f + d;
  }
  return f;
}

/** Peak (absolute) of channels over [a, b) frames. */
export function peakOf(channels, a = 0, b = Infinity) {
  let m = 0;
  for (const d of channels) {
    const e = Math.min(d.length, b);
    for (let i = Math.max(0, a); i < e; i++) { const v = Math.abs(d[i]); if (v > m) m = v; }
  }
  return m;
}

/** Clip gain that brings the peak of what the clip plays to `targetDb` dBFS (null when silent). */
export function normalizeGain(peak, targetDb = -0.3) {
  if (!(peak > 1e-6)) return null;
  return +(Math.pow(10, targetDb / 20) / peak).toFixed(5);
}

/** Reversed copy of frames [a, b) of each channel. */
export function reverseFrames(channels, a, b) {
  return channels.map((d) => {
    const e = Math.min(d.length, b), s = Math.max(0, a);
    const o = new Float32Array(Math.max(0, e - s));
    for (let i = 0; i < o.length; i++) o[i] = d[e - 1 - i];
    return o;
  });
}

/**
 * Mix audio clips into PCM exactly like playback does (offset, gain, fades, gain envelope, de-click ramps).
 *   clips: audio clips (e.g. trackClips() output), getPcm(sampleId) -> { channels: Float32Array[], sampleRate } | null
 *   startBeat / endBeat: range to render; bpm; sampleRate of the result; channels (1 | 2)
 *   map (optional TempoMap): song beats -> seconds through the tempo map (unwarped clips play their audio at its own
 *   speed, offsets count at the tempo of the clip start — see takes.js srcSecAt); a constant map = `bpm`.
 * Returns Float32Array[] (one per output channel). Used by flatten comp / consolidate and the tests.
 */
export function mixClipsToPcm({ clips, getPcm, bpm, map = null, sampleRate = 44100, startBeat, endBeat, channels = 2 }) {
  const tm = map && !map.isConstant ? map : null;
  if (map && !tm) bpm = map.bpm;
  const spb = 60 / bpm;
  const frames = Math.max(0, Math.round((tm ? tm.span(startBeat, endBeat) : (endBeat - startBeat) * spb) * sampleRate));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (const clip of clips) {
    if (clip.type !== 'audio' || !clip.sampleId) continue;
    const pcm = getPcm(clip.sampleId);
    if (!pcm?.channels?.length) continue;
    const srcSr = pcm.sampleRate || sampleRate;
    const srcLen = pcm.channels[0].length;
    // the play: from max(clip.start, startBeat) for as long as the clip and the source last
    const playStart = Math.max(clip.start, startBeat);
    const offBeats = playStart - clip.start;
    const offSec = tm ? srcSecAt(tm, clip, playStart) : ((clip.offset || 0) + offBeats) * spb;
    const srcDur = srcLen / srcSr;
    if (offSec >= srcDur) continue;
    const durSec = Math.min(tm ? tm.span(playStart, clip.start + clip.length) : (clip.start + clip.length - playStart) * spb, srcDur - offSec);
    if (durSec <= 0.002) continue;
    const pts = needsShapedEnvelope(clip) || clip.fadeIn > 0 || clip.fadeOut > 0
      ? envelopePoints(clip, offBeats, durSec, tm || spb)
      : (() => { const dc = Math.min(DECLICK, durSec / 4); const g = clip.gain ?? 1; return [{ t: 0, v: 0 }, { t: dc, v: g }, { t: durSec - dc, v: g }, { t: durSec, v: 0 }]; })();
    const f0 = Math.round((tm ? tm.span(startBeat, playStart) : (playStart - startBeat) * spb) * sampleRate);
    const n = Math.min(frames - f0, Math.round(durSec * sampleRate));
    let k = 0; // breakpoint cursor
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      while (k + 1 < pts.length - 1 && pts[k + 1].t < t) k++;
      const a = pts[k], b = pts[k + 1] || a;
      const g = b.t - a.t > 1e-12 ? a.v + (b.v - a.v) * Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : b.v;
      if (g === 0) continue;
      const sp = (offSec + t) * srcSr;
      const j = Math.floor(sp), fr = sp - j;
      if (j >= srcLen) break;
      for (let c = 0; c < channels; c++) {
        const d = pcm.channels[Math.min(c, pcm.channels.length - 1)];
        const v = j + 1 < srcLen ? d[j] + (d[j + 1] - d[j]) * fr : d[j];
        out[c][f0 + i] += v * g;
      }
    }
  }
  return out;
}
