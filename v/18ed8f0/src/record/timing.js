// Recording time alignment, latency compensation, punch / pre-roll and input monitoring rules — pure helpers.
//
// Alignment: the capture worklet (capture-processor.js) stamps every block with its AudioContext frame, so the
// recording is on the audio clock. A sample captured at context time C was played by the musician while hearing the
// output that left the graph at C − roundTrip (output latency + converter / driver latency + input latency):
//
//   beat(C) = anchor.beat + (C − roundTrip − anchor.time) · bpm / 60        (anchor = the scheduler's heard time)
//
// roundTrip comes from a loopback "ping" measurement per input device (detectPing) or, when never measured, from the
// browser's own estimate (baseLatency + outputLatency + track latency); a manual offset (ms) is added on top.
//
// Tempo maps: an anchor may carry `map` (src/time/tempo-map.js TempoMap — the ONLY beat<->seconds code) and `loop`
// ({start, end} when cycling). With a non-constant map the "unwrapped" timeline (the song beat as if the loop never
// wrapped: pass k of the loop is [loop.end + (k−1)·len, loop.end + k·len)) is integrated through the map, each pass
// taking span(loop.start, loop.end) seconds. Without a map (or a constant one) the linear formula above is used
// unchanged, so projects without a tempo map compute bit-identical positions.
import { computePasses } from './takes.js';

const varying = (anchor) => !!(anchor?.map && !anchor.map.isConstant);

/** Cycle range of an anchor that the transport wraps at (null when it doesn't). */
function cycleOf(anchor) {
  const lp = anchor.loop;
  if (!lp || !(lp.end - lp.start >= 0.25) || !(anchor.beat < lp.end - 1e-6)) return null;
  return lp;
}

/** Seconds (heard time, relative to anchor.time) at which unwrapped beat u sounds — map anchors only. */
function secOfUnwrapped(anchor, u) {
  const m = anchor.map, s0 = m.secAt(anchor.beat), lp = cycleOf(anchor);
  if (!lp || u <= lp.end) return m.secAt(u) - s0;
  const len = lp.end - lp.start, P = m.span(lp.start, lp.end);
  const x = u - lp.end, k = Math.floor(x / len), r = x - k * len;
  return m.secAt(lp.end) - s0 + k * P + m.span(lp.start, lp.start + r);
}
/** Unwrapped beat heard `dt` seconds after anchor.time — map anchors only. */
function unwrappedOfSec(anchor, dt) {
  const m = anchor.map, s0 = m.secAt(anchor.beat), lp = cycleOf(anchor);
  const d1 = lp ? m.secAt(lp.end) - s0 : Infinity;
  if (dt <= d1) return m.beatAt(s0 + dt);
  const len = lp.end - lp.start, P = m.span(lp.start, lp.end);
  const y = dt - d1, k = Math.floor(y / P), r = y - k * P;
  return lp.end + k * len + (m.beatAt(m.secAt(lp.start) + r) - lp.start);
}

/**
 * Unwrapped song beat heard at context time t.
 *   anchor: { time, beat, bpm, map?, loop? } in heard time (map / loop: see the header).
 */
export function beatAtTime(anchor, t) {
  if (varying(anchor)) return unwrappedOfSec(anchor, t - anchor.time);
  return anchor.beat + ((t - anchor.time) * anchor.bpm) / 60;
}

/** Context time (heard) at which unwrapped beat u sounds (inverse of beatAtTime). */
export function timeAtBeat(anchor, u) {
  if (varying(anchor)) return anchor.time + secOfUnwrapped(anchor, u);
  return anchor.time + ((u - anchor.beat) * 60) / anchor.bpm;
}

/** Song (wrapped) beat of unwrapped beat u. */
export function songBeat(anchor, u) {
  const lp = anchor && cycleOf(anchor);
  if (!lp || u < lp.end) return u;
  const len = lp.end - lp.start;
  return lp.start + ((u - lp.end) % len + len) % len;
}

/** Round-trip compensation (s): calibrated measurement when present, else the estimate; + manual offset (ms). */
export function roundTrip({ estimate = 0, calibratedMs = null, manualMs = 0 } = {}) {
  const base = Number.isFinite(calibratedMs) ? calibratedMs / 1000 : (Number(estimate) || 0);
  return Math.max(-0.5, Math.min(1.5, base + (Number(manualMs) || 0) / 1000));
}

/** Unwrapped beat of captured frame `frame` (context frame index) after latency compensation. */
export function beatOfFrame(frame, sampleRate, anchor, rt) {
  return beatAtTime(anchor, frame / sampleRate - rt);
}

/** Frame (context frame index) whose compensated beat is `beat`. */
export function frameOfBeat(beat, sampleRate, anchor, rt) {
  if (varying(anchor)) return Math.round((timeAtBeat(anchor, beat) + rt) * sampleRate);
  return Math.round(((beat - anchor.beat) * 60 / anchor.bpm + anchor.time + rt) * sampleRate);
}

/**
 * Loopback latency detection: `emits` are the frames (relative to the capture's first frame) at which pings were
 * played; for each, find the onset in the capture within `windowSec`. Returns { frames, ms, hits, spread } with the
 * median latency, or null when fewer than half of the pings were found.
 */
export function detectPing(data, sampleRate, emits, { windowSec = 0.6, minLevel = 0.02 } = {}) {
  const lat = [];
  const win = Math.round(windowSec * sampleRate);
  for (const e of emits) {
    const a = Math.max(0, Math.round(e)), b = Math.min(data.length, a + win);
    if (b - a < 16) continue;
    // noise floor: just before the ping (or the window's start)
    let noise = 0;
    for (let i = Math.max(0, a - 512); i < a; i++) noise = Math.max(noise, Math.abs(data[i]));
    let peak = 0;
    for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(data[i]));
    if (peak < minLevel || peak < noise * 4) continue;
    const thr = Math.max(noise * 2, peak * 0.35);
    for (let i = a; i < b; i++) if (Math.abs(data[i]) >= thr) { lat.push(i - a); break; }
  }
  if (lat.length < Math.max(1, Math.ceil(emits.length / 2))) return null;
  const s = [...lat].sort((x, y) => x - y);
  const med = s[Math.floor(s.length / 2)];
  return { frames: med, ms: (med / sampleRate) * 1000, hits: lat.length, spread: ((s[s.length - 1] - s[0]) / sampleRate) * 1000 };
}

/**
 * Where the transport starts and where the recording (punch-in) begins.
 *   pos: playhead beat, punch: {enabled,start,end}, preRollBars, bpb (beats per bar)
 *   map (optional TempoMap): pre- / post-roll count real bars of the meter map (7/8 bar = 3.5 beats) instead of bpb
 * With punch: roll from punch.start − pre-roll, record [punch.start, punch.end) (+ post-roll after it, then stop).
 * Without: roll from pos − pre-roll, record from pos.
 */
export function recordPlan({ pos = 0, punch = null, loop = null, preRollBars = 0, postRollBars = 0, bpb = 4, map = null }) {
  const punched = !!(punch?.enabled && punch.end > punch.start);
  const cycle = !!(loop?.enabled && loop.end - loop.start >= 0.25);
  const recIn = punched ? punch.start : pos;
  const barsBack = (b, n) => { const x = map.barAt(b); return map.barStart(x.bar) - map.barStart(x.bar - n); };
  const barsFwd = (b, n) => { const x = map.barAt(b); return map.barStart(x.bar + n) - map.barStart(x.bar); };
  const pre = map ? (preRollBars > 0 ? barsBack(recIn, preRollBars) : 0) : Math.max(0, preRollBars) * bpb;
  const playFrom = Math.max(0, recIn - pre);
  // auto-stop after the punch-out (+ post-roll) — not when cycling (the loop keeps going until Stop)
  const post = map ? (postRollBars > 0 ? barsFwd(punch?.end ?? 0, postRollBars) : 0) : Math.max(0, postRollBars) * bpb;
  const stopAt = punched && !cycle ? punch.end + post : null;
  return { playFrom, recIn, stopAt, punched, cycle };
}

/**
 * Count-in through the tempo / meter map: the `bars` bars before `playFrom` (their own meters — a 7/8 bar counts 7
 * eighths, accents per group — and their own tempo; bars before beat 0 use the first meter / tempo).
 * Returns { from (beat the count-in starts), beats, sec, clicks: [{ beat, t (s after the count-in starts), level }] }.
 */
export function countInPlan(map, playFrom, bars) {
  const n = Math.max(0, Math.round(bars || 0));
  const at = map.barAt(Math.max(0, playFrom));
  const off = playFrom - map.barStart(at.bar); // count-in bars keep the playhead's position inside its bar
  const from = map.barStart(at.bar - n) + off;
  const clicks = [];
  for (let k = at.bar - n; k < at.bar; k++) {
    const m = map.meterOfBar(k);
    const levels = [];
    for (const g of m.groups) { levels.push(1); for (let i = 1; i < g; i++) levels.push(0); }
    levels[0] = 2;
    const s = map.barStart(k) + off;
    for (let u = 0; u < m.num; u++) {
      const beat = s + u * m.unit;
      clicks.push({ beat, t: map.span(from, beat), level: levels[u] ?? 0 });
    }
  }
  return { from, beats: playFrom - from, sec: map.span(from, playFrom), clicks };
}

/**
 * What to do for a count-in: where the transport starts, how long after t0 it starts, and which clicks the recorder
 * must schedule itself (t = seconds after t0). With the metronome on the transport rolls through the count-in bars and
 * clicks beats ≥ 0 itself (TempoMap.clicks yields nothing before beat 0), so the recorder clicks only the negative ones;
 * with it off the transport waits and the recorder clicks every count-in unit.
 */
export function countInSchedule(map, playFrom, bars, metronome) {
  const n = Math.max(0, Math.round(bars || 0));
  if (!n) return { from: playFrom, startDelay: 0, clicks: [] };
  const ci = countInPlan(map, playFrom, n);
  if (metronome) return { from: ci.from, startDelay: 0, clicks: ci.clicks.filter((c) => c.beat < -1e-9) };
  return { from: playFrom, startDelay: ci.sec, clicks: ci.clicks };
}

/**
 * Where a recorded audio buffer goes: passes (takes), the frames to keep (+ one bar of handle on each side) and each
 * take's offset into the kept audio.
 *   anchor (see beatAtTime), frame: context frame of the first captured sample, frames: captured length,
 *   sampleRate, rt: round trip (s), recIn, u1: unwrapped beat at stop, loop / punch (computePasses), bpb, bpm.
 * Returns { f0, f1, passes: [{ pass, start, end, offset, srcLength }], srcLength } or null when nothing is left.
 * Offsets / srcLength are content beats like a clip's (sample seconds = offset · spb at the take start — how unwarped
 * clips play under a tempo map, warp/player.js unwarpedInSeconds). Constant tempo: the original arithmetic.
 */
export function planAudioTakes({ anchor, frame, frames, sampleRate: sr, rt, recIn, u1, loop = null, punch = null, bpb = 4, bpm = 120 }) {
  const origin = beatOfFrame(frame, sr, anchor, rt);
  if (!varying(anchor)) {
    const lastBeat = origin + (frames / sr) / (60 / bpm);
    const passes = computePasses({ u0: recIn, u1: Math.min(u1, lastBeat), loop, punch, origin, minLen: 1 });
    if (!passes.length) return null;
    const sp = 60 / bpm;
    const lo = Math.max(0, Math.min(...passes.map((x) => x.offset)) - bpb);
    const hi = Math.max(...passes.map((x) => x.offset + x.end - x.start)) + bpb;
    const f0 = Math.max(0, Math.round(lo * sp * sr)), f1 = Math.min(frames, Math.round(hi * sp * sr));
    const shift = f0 / sr / sp;
    const srcLength = (f1 - f0) / sr / sp;
    return { f0, f1, srcLength, passes: passes.map((x) => ({ ...x, offset: x.offset - shift, srcLength })) };
  }
  const map = anchor.map;
  const lastBeat = beatAtTime(anchor, (frame + frames) / sr - rt);
  const passes = computePasses({ u0: recIn, u1: Math.min(u1, lastBeat), loop, punch, origin, minLen: 1 });
  if (!passes.length) return null;
  const t0 = timeAtBeat(anchor, origin); // = frame / sr − rt
  const srcSec = (u) => timeAtBeat(anchor, u) - t0; // seconds into the captured audio where unwrapped beat u is
  const secs = passes.map((x) => ({ a: srcSec(origin + x.offset), b: srcSec(origin + x.offset + (x.end - x.start)) }));
  const first = passes.reduce((m, x, i) => (secs[i].a < secs[m].a ? i : m), 0);
  const last = passes.reduce((m, x, i) => (secs[i].b > secs[m].b ? i : m), 0);
  // one bar of handle (the meter's bar there, at the tempo there)
  const barBefore = (b) => map.span(b - map.barAt(b - 1e-6).length, b);
  const barAfter = (b) => map.span(b, b + map.barAt(b).length);
  const loSec = Math.max(0, secs[first].a - barBefore(passes[first].start));
  const hiSec = secs[last].b + barAfter(passes[last].end);
  const f0 = Math.max(0, Math.round(loSec * sr)), f1 = Math.min(frames, Math.round(hiSec * sr));
  const shiftSec = f0 / sr, keptSec = (f1 - f0) / sr;
  const out = passes.map((x, i) => {
    const spb = map.spbAt(x.start);
    return { ...x, offset: (secs[i].a - shiftSec) / spb, srcLength: keptSec / spb };
  });
  return { f0, f1, srcLength: out[out.length - 1].srcLength, passes: out };
}

/**
 * Is a track's input monitored right now?
 *   mode 'off' | 'auto' | 'on'. auto (tape style): while armed, monitor when stopped and while recording (inside the
 *   punch range when punching); during plain playback you hear the takes instead.
 */
export function monitorActive(mode, { armed = false, playing = false, recording = false, punched = false, inPunch = true } = {}) {
  if (mode === 'on') return true;
  if (mode !== 'auto' || !armed) return false;
  if (!playing) return true;
  return recording && (!punched || inPunch);
}

export const QUANTIZE_OPTIONS = [
  { value: 0, label: 'Off' }, { value: 1, label: '1/4' }, { value: 0.5, label: '1/8' }, { value: 1 / 3, label: '1/8T' },
  { value: 0.25, label: '1/16' }, { value: 1 / 6, label: '1/16T' }, { value: 0.125, label: '1/32' },
];

/** Default recording preferences (per browser; localStorage 'daw3-rec-prefs'). */
export const DEFAULT_REC_PREFS = {
  countInBars: 0, preRollBars: 0, postRollBars: 0,
  midiMode: 'overdub', // 'overdub' | 'replace' | 'takes' | 'merge' (MIDI recording in song mode)
  inputQuantize: 0.25, // beats (0 = off): note starts snap to this grid while recording
  quantizeLength: false,
  lowLatencyMonitor: false, // monitor straight to the output (skips the track's inserts and their latency)
  stepLength: 0.25,
};
