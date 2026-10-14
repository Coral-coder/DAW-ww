// MIDI sync (Node-safe): MIDI clock out (24 ppqn, start / stop / continue, song position pointer), clock-in
// tempo following with jitter smoothing, and MIDI time code (MTC) quarter-frame output.
// All times are milliseconds in the performance.now() domain (what Web MIDI's send(data, timestamp) takes).
import { Emitter } from '../core/util.js';

export const PPQN = 24;

/** Song position pointer message for a beat position (resolution: 16th notes = 6 clocks). */
export function sppMessage(beat) {
  const six = Math.max(0, Math.min(16383, Math.floor(beat * 4 + 1e-9)));
  return [0xf2, six & 0x7f, (six >> 7) & 0x7f];
}
export const sppToBeat = (value) => value / 4;

// ------------------------------------------------------------------------------------------- clock out
export class MidiClockOut {
  /** send(bytes, timestampMs). lookahead: how far ahead ticks are queued (ms). */
  constructor({ send, lookahead = 120 } = {}) {
    this.send = send || (() => {});
    this.lookahead = lookahead;
    this.running = false;
    this.anchorTime = 0; this.anchorBeat = 0; this.msPerBeat = 500; this.nextTick = 0;
  }
  // With a tempo map (src/time/tempo-map.js, song mode) ticks follow it exactly: tick k sounds at
  // anchorTime + (map.secAt(k/24) − map.secAt(anchorBeat))·1000 — ramps make the tick spacing glide.
  tickTime(k) {
    const m = this.map;
    if (m && !m.isConstant) return this.anchorTime + (m.secAt(k / PPQN) - m.secAt(this.anchorBeat)) * 1000;
    return this.anchorTime + (k / PPQN - this.anchorBeat) * this.msPerBeat;
  }
  beatAt(t) {
    const m = this.map;
    if (m && !m.isConstant) return m.beatAt(m.secAt(this.anchorBeat) + (t - this.anchorTime) / 1000);
    return this.anchorBeat + (t - this.anchorTime) / this.msPerBeat;
  }

  /** Start at `beat`, audible at time t0 (ms). From 0: Start; elsewhere: SPP + Continue (aligned to the 16th). map: optional TempoMap. */
  start(beat, bpm, t0, map = null) {
    this.map = map;
    this.msPerBeat = 60000 / bpm;
    this.anchorBeat = beat;
    this.anchorTime = t0;
    const sppBeat = Math.floor(beat * 4 + 1e-9) / 4;
    if (beat < 1e-6) this.send([0xfa], t0);
    else { this.send(sppMessage(beat), t0); this.send([0xfb], t0); }
    // ticks from the SPP position on; ticks that would be in the past (between the 16th and the start) go out at t0
    this.nextTick = Math.round(sppBeat * PPQN);
    this.running = true;
  }
  /** Tempo change at time t (keeps the phase). map: the new TempoMap (or null for a constant tempo). */
  setTempo(bpm, t, map) {
    if (!this.running) { this.msPerBeat = 60000 / bpm; if (map !== undefined) this.map = map; return; }
    const b = this.beatAt(t);
    this.anchorBeat = b; this.anchorTime = t; this.msPerBeat = 60000 / bpm;
    if (map !== undefined) this.map = map;
    // next tick: the first one not yet sent stays (its time is recomputed from the new anchor)
  }
  /** Queue every tick due before now + lookahead. Returns the number of ticks sent. */
  pump(now) {
    if (!this.running) return 0;
    let n = 0;
    while (this.tickTime(this.nextTick) < now + this.lookahead) {
      this.send([0xf8], Math.max(this.anchorTime, this.tickTime(this.nextTick)));
      this.nextTick++;
      if (++n > 1000) break;
    }
    return n;
  }
  stop(t) { if (this.running) { this.running = false; this.send([0xfc], t); } }
  /** Locate while stopped (sends SPP so slaves follow the playhead). */
  locate(beat, t) { if (!this.running) this.send(sppMessage(beat), t); }
}

// ------------------------------------------------------------------------------------------- clock in
/**
 * Follows an external MIDI clock. Tempo = least-squares slope over the last `window` tick timestamps
 * (robust to per-tick jitter), then smoothed; big jumps (> 4%) snap immediately. Gaps reset the estimate.
 * Events: 'tempo' (bpm), 'start', 'continue', 'stop', 'position' (beat) and 'tick' (beat).
 */
export class MidiClockIn extends Emitter {
  constructor({ window = 72, minTicks = 12 } = {}) {
    super();
    this.window = window;
    this.minTicks = minTicks;
    this.times = [];
    this.bpm = null;
    this.running = false;
    this.position = 0; // beats
    this.base = 0; this.ticks = 0;
    this.reported = null;
  }
  reset() { this.times = []; }
  handle(data, t) {
    switch (data[0]) {
      case 0xf8: return this._tick(t);
      case 0xfa: this.position = this.base = 0; this.ticks = 0; this.running = true; this.reset(); this.emit('start', 0); return;
      case 0xfb: this.base = this.position; this.ticks = 0; this.running = true; this.reset(); this.emit('continue', this.position); return;
      case 0xfc: this.running = false; this.emit('stop', this.position); return;
      case 0xf2: this.ticks = 0; this.position = this.base = sppToBeat((data[1] & 0x7f) | ((data[2] & 0x7f) << 7)); this.emit('position', this.position); return;
      default: return;
    }
  }
  _tick(t) {
    const ts = this.times;
    if (ts.length) {
      const gap = t - ts[ts.length - 1];
      const typical = this.bpm ? 60000 / (this.bpm * PPQN) : null;
      if (gap > 400 || (typical && gap > typical * 4)) this.reset(); // clock paused / restarted
    }
    ts.push(t);
    this.lastTick = t;
    if (ts.length > this.window) ts.shift();
    if (this.running) { this.ticks++; this.position = this.base + this.ticks / PPQN; this.emit('tick', this.position); }
    if (ts.length < this.minTicks) return;
    const est = 60000 / (PPQN * slope(ts));
    if (!Number.isFinite(est) || est < 20 || est > 400) return;
    if (this.bpm == null) this.bpm = est;
    else if (Math.abs(est - this.bpm) / this.bpm > 0.04) {
      // tempo jump: re-estimate from the newest ticks only so the old tempo does not drag the slope
      const recent = ts.slice(-this.minTicks);
      this.times = recent;
      this.bpm = 60000 / (PPQN * slope(recent));
    } else this.bpm += (est - this.bpm) * 0.15;
    const r = Math.round(this.bpm * 10) / 10;
    if (this.reported == null || Math.abs(r - this.reported) >= 0.1) { this.reported = r; this.emit('tempo', r); }
  }
}

/** External clock position (beats) at time t (ms): the last tick's position + the time since, at the clock's tempo. */
MidiClockIn.prototype.beatAt = function beatAt(t) {
  if (this.lastTick == null || !this.bpm) return this.position;
  return this.position + Math.max(0, Math.min(1 / PPQN, ((t - this.lastTick) * this.bpm) / 60000));
};

/**
 * Continuous phase lock to an external clock (not just its tempo). update(extBeat, localBeat, bpm) compares where
 * the external clock is with where daW³ plays at the same instant:
 *   |error| > jump beats  -> { kind: 'jump', beat }   relocate (start / lost sync)
 *   |error| < deadband    -> { kind: 'hold', bpm }    run at the clock's tempo
 *   otherwise             -> { kind: 'trim', bpm }    run slightly faster / slower until the phase meets
 * The error is smoothed (one-pole) so per-tick jitter does not wobble the tempo; the trim is capped (±maxTrim).
 */
export class ClockPhaseLock {
  constructor({ jump = 0.5, deadband = 0.003, gain = 0.25, maxTrim = 0.02, smooth = 0.35 } = {}) {
    Object.assign(this, { jump, deadband, gain, maxTrim, smooth });
    this.err = 0;
  }
  reset() { this.err = 0; }
  update(extBeat, localBeat, bpm) {
    const e = extBeat - localBeat;
    if (Math.abs(e) > this.jump) { this.err = 0; return { kind: 'jump', beat: extBeat, error: e }; }
    this.err += (e - this.err) * this.smooth;
    if (Math.abs(this.err) < this.deadband) return { kind: 'hold', bpm, error: this.err };
    const trim = Math.max(-this.maxTrim, Math.min(this.maxTrim, this.err * this.gain));
    return { kind: 'trim', bpm: bpm * (1 + trim), error: this.err };
  }
}

/** Least-squares slope of times[i] against i. */
export function slope(times) {
  const n = times.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += times[i]; sxx += i * i; sxy += i * times[i]; }
  return (n * sxy - sx * sy) / (n * sxx - sx * sx);
}

// ------------------------------------------------------------------------------------------- MTC out
/** MTC rate codes (bits 5-6 of the hours byte): 24, 25, 29.97 drop-frame ('29.97'), 30 non-drop. */
export const MTC_RATES = { 24: 0, 25: 1, '29.97': 2, 30: 3 };
export const isDropFrame = (fps) => String(fps) === '29.97';
/** Real frames per second (29.97 DF runs at 30000/1001; its frame numbers still count 0-29). */
export const mtcFrameRate = (fps) => (isDropFrame(fps) ? 30000 / 1001 : Number(fps));
/** Nominal (integer) frames per timecode second. */
const nominal = (fps) => (isDropFrame(fps) ? 30 : Number(fps));

/**
 * Frame count (since 00:00:00:00) -> {h, m, s, f}. 29.97 drop-frame skips frame numbers 0 and 1 at the start of
 * every minute except minutes 0, 10, 20, 30, 40, 50 (SMPTE 12M), so the timecode tracks the wall clock.
 */
export function framesToTimecode(frames, fps) {
  let n = Math.max(0, Math.floor(frames));
  const F = nominal(fps);
  if (isDropFrame(fps)) {
    const per10 = 17982; // frames in 10 DF minutes
    const d = Math.floor(n / per10), m = n % per10;
    n += 18 * d + (m < 2 ? 0 : 2 * Math.floor((m - 2) / 1798));
  }
  const f = n % F, s = Math.floor(n / F) % 60, mi = Math.floor(n / F / 60) % 60, h = Math.floor(n / F / 3600) % 24;
  return { h, m: mi, s, f };
}

/** Split seconds into {h, m, s, f} at fps (24 | 25 | 30 | '29.97' drop-frame). */
export function toTimecode(seconds, fps) {
  return framesToTimecode(Math.floor(Math.max(0, seconds) * mtcFrameRate(fps) + 1e-6), fps);
}
/** Full-frame SysEx (locate). */
export function mtcFullFrame(seconds, fps = 25) {
  const { h, m, s, f } = toTimecode(seconds, fps);
  return [0xf0, 0x7f, 0x7f, 0x01, 0x01, (MTC_RATES[fps] << 5) | h, m, s, f, 0xf7];
}
/** The 8 quarter-frame data bytes for a timecode. */
export function quarterFrames(tc, fps) {
  const { h, m, s, f } = tc;
  return [f & 0xf, f >> 4, s & 0xf, s >> 4, m & 0xf, m >> 4, h & 0xf, (h >> 4) | (MTC_RATES[fps] << 1)].map((v, i) => (i << 4) | v);
}

export class MtcOut {
  constructor({ send, fps = 25, lookahead = 120 } = {}) {
    this.send = send || (() => {});
    this.fps = MTC_RATES[fps] != null ? (isDropFrame(fps) ? '29.97' : Number(fps)) : 25;
    this.lookahead = lookahead;
    this.running = false;
  }
  /** Start at song time `seconds`, audible at t0 (ms). Quarter frames start on a frame boundary. */
  start(seconds, t0) {
    const rate = mtcFrameRate(this.fps);
    const frame0 = Math.ceil(seconds * rate - 1e-6);
    this.frame0 = frame0 % 2 ? frame0 + 1 : frame0; // 8-QF sequences span 2 frames: start on an even frame
    this.t0 = t0 + ((this.frame0 / rate) - seconds) * 1000;
    this.qf = 0;
    this.running = true;
    this.send(mtcFullFrame(this.frame0 / rate, this.fps), t0);
  }
  qfTime(k) { return this.t0 + (k * 1000) / (mtcFrameRate(this.fps) * 4); }
  pump(now) {
    if (!this.running) return 0;
    let n = 0;
    while (this.qfTime(this.qf) < now + this.lookahead) {
      const seq = Math.floor(this.qf / 8), i = this.qf % 8;
      const tc = framesToTimecode(this.frame0 + seq * 2, this.fps);
      this.send([0xf1, quarterFrames(tc, this.fps)[i]], this.qfTime(this.qf));
      this.qf++;
      if (++n > 500) break;
    }
    return n;
  }
  stop() { this.running = false; }
  locate(seconds, t) { if (!this.running) this.send(mtcFullFrame(seconds, this.fps), t); }
}
