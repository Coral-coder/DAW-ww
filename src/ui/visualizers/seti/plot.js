// SETI Scope plot model (Node-safe): world size of the 3D plot, the bands × time-rows history ring, detail levels
// and the adaptive frame budget that drops detail on slow devices.
import { songLengthBeats } from '../../../core/model.js';

/** World units: frequency x ∈ [−width, width], time z ∈ [−depth, 0] (now at the front), power y ∈ [0, height]. */
export const PLOT = { width: 1, depth: 2, height: 0.85 };

/** Detail levels [bands, rows], richest first. */
export const LEVELS = [[96, 64], [72, 52], [56, 44], [44, 34], [32, 26], [24, 20]];

/** Starting level: phones / coarse pointers / small screens start lighter. */
export function initialLevel({ width = 1280, height = 800, coarse = false, dpr = 1 } = {}) {
  const px = width * height * Math.min(dpr, 2) ** 2;
  if (coarse || width < 700) return px > 2.5e6 ? 4 : 3;
  if (px > 6e6) return 2;
  return 1;
}

/** Bars × rows history: row values 0..255 in a ring; `head` = the newest row. */
export class PlotHistory {
  constructor(bands, rows) {
    this.bands = bands;
    this.rows = rows;
    this.data = new Uint8Array(bands * rows);
    this.head = 0;
    this.count = 0;
  }
  /** Push one row of 0..1 values (length = bands); returns its ring index. */
  push(values) {
    this.head = (this.head + 1) % this.rows;
    const o = this.head * this.bands;
    for (let b = 0; b < this.bands; b++) {
      const v = values[b];
      this.data[o + b] = v > 0 ? (v >= 1 ? 255 : Math.round(v * 255)) : 0;
    }
    this.count++;
    return this.head;
  }
  row(i) { return this.data.subarray(i * this.bands, (i + 1) * this.bands); }
  /** Value 0..1 of band b, `age` rows back from the newest. */
  at(b, age) { return this.data[(((this.head - age) % this.rows + this.rows) % this.rows) * this.bands + b] / 255; }
}

/**
 * Frame-time watchdog: average dt over a window; `tick(dt)` returns +1 (time to drop detail) when the average
 * stays above budget for `window` seconds — or at once after 3 frames over 4× the budget (a device that can't
 * cope at all) — else 0. A drop resets the window. Gaps over 2 s (tab switches, breakpoints) are ignored.
 */
export class FrameBudget {
  constructor({ budgetMs = 21, window = 2 } = {}) {
    this.budget = budgetMs / 1000;
    this.window = window;
    this.sum = 0;
    this.n = 0;
    this.elapsed = 0;
  }
  tick(dt) {
    if (!(dt > 0) || dt > 2) return 0;
    this.sum += dt; this.n++; this.elapsed += dt;
    const slow = this.n >= 3 && this.sum / this.n > this.budget * 4;
    if (this.elapsed < this.window && !slow) return 0;
    const avg = this.sum / this.n;
    this.sum = 0; this.n = 0; this.elapsed = 0;
    return avg > this.budget ? 1 : 0;
  }
}

/** "% done": song mode = position / song length; pattern mode = position inside the loop region. 0..1 */
export function songProgress(project, pos) {
  if (!project || !(pos >= 0)) return 0;
  if (project.mode === 'song') {
    const len = songLengthBeats(project);
    return len > 0 ? Math.min(1, pos / len) : 0;
  }
  const s = project.loop?.start ?? 0, e = project.loop?.end ?? 16, len = e - s;
  if (!(len > 0)) return 0;
  return ((((pos - s) % len) + len) % len) / len;
}

/** Tracker of "work units" (bars played) and "CPU time" (seconds of playback) for the User Info panel. */
export class SessionStats {
  constructor() { this.bars = 0; this.cpu = 0; this.lastBar = null; }
  /** dt seconds, playing flag, current 0-based bar (null when unknown). */
  tick(dt, playing, bar) {
    if (!playing) { this.lastBar = null; return; }
    if (dt > 0 && dt < 5) this.cpu += dt;
    if (bar != null && this.lastBar != null && bar !== this.lastBar) this.bars++;
    this.lastBar = bar;
  }
}
