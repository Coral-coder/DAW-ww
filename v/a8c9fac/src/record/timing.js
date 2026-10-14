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

/** Unwrapped song beat heard at context time t (anchor: { time, beat, bpm } in heard time). */
export function beatAtTime(anchor, t) {
  return anchor.beat + ((t - anchor.time) * anchor.bpm) / 60;
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
 * With punch: roll from punch.start − pre-roll, record [punch.start, punch.end) (+ post-roll after it, then stop).
 * Without: roll from pos − pre-roll, record from pos.
 */
export function recordPlan({ pos = 0, punch = null, loop = null, preRollBars = 0, postRollBars = 0, bpb = 4 }) {
  const pre = Math.max(0, preRollBars) * bpb;
  const punched = !!(punch?.enabled && punch.end > punch.start);
  const cycle = !!(loop?.enabled && loop.end - loop.start >= 0.25);
  const recIn = punched ? punch.start : pos;
  const playFrom = Math.max(0, recIn - pre);
  // auto-stop after the punch-out (+ post-roll) — not when cycling (the loop keeps going until Stop)
  const stopAt = punched && !cycle ? punch.end + Math.max(0, postRollBars) * bpb : null;
  return { playFrom, recIn, stopAt, punched, cycle };
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
