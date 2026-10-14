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

/** Least-squares slope of times[i] against i. */
export function slope(times) {
  const n = times.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += times[i]; sxx += i * i; sxy += i * times[i]; }
  return (n * sxy - sx * sy) / (n * sxx - sx * sx);
}

// ------------------------------------------------------------------------------------------- MTC out
export const MTC_RATES = { 24: 0, 25: 1, 30: 3 }; // (29.97 drop-frame not offered)

/** Split seconds into {h, m, s, f} at fps. */
export function toTimecode(seconds, fps) {
  const total = Math.max(0, Math.floor(seconds * fps + 1e-6));
  const f = total % fps, s = Math.floor(total / fps) % 60, m = Math.floor(total / fps / 60) % 60, h = Math.floor(total / fps / 3600) % 24;
  return { h, m, s, f };
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
    this.fps = MTC_RATES[fps] != null ? fps : 25;
    this.lookahead = lookahead;
    this.running = false;
  }
  /** Start at song time `seconds`, audible at t0 (ms). Quarter frames start on a frame boundary. */
  start(seconds, t0) {
    const frame0 = Math.ceil(seconds * this.fps - 1e-6);
    this.frame0 = frame0 % 2 ? frame0 + 1 : frame0; // 8-QF sequences span 2 frames: start on an even frame
    this.t0 = t0 + ((this.frame0 / this.fps) - seconds) * 1000;
    this.qf = 0;
    this.running = true;
    this.send(mtcFullFrame(this.frame0 / this.fps, this.fps), t0);
  }
  qfTime(k) { return this.t0 + (k * 1000) / (this.fps * 4); }
  pump(now) {
    if (!this.running) return 0;
    let n = 0;
    while (this.qfTime(this.qf) < now + this.lookahead) {
      const seq = Math.floor(this.qf / 8), i = this.qf % 8;
      const tc = toTimecode((this.frame0 + seq * 2) / this.fps, this.fps);
      this.send([0xf1, quarterFrames(tc, this.fps)[i]], this.qfTime(this.qf));
      this.qf++;
      if (++n > 500) break;
    }
    return n;
  }
  stop() { this.running = false; }
  locate(seconds, t) { if (!this.running) this.send(mtcFullFrame(seconds, this.fps), t); }
}
