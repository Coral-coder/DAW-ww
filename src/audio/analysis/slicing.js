// Slicing a track for remixing: grid slices (beats / bars / phrases), transient slices, loops,
// and region extraction with click-free fades.
import { beatIndexAt, beatTime, secondsPerBeat } from './tempo.js';

/** Snap a time to the nearest beat (or bar with unitBeats = beatsPerBar). */
export function snapToGrid(grid, t, unitBeats = 1, mode = 'round') {
  const i = beatIndexAt(grid, t) / unitBeats;
  const r = mode === 'floor' ? Math.floor(i + 1e-6) : mode === 'ceil' ? Math.ceil(i - 1e-6) : Math.round(i);
  return beatTime(grid, r * unitBeats);
}

/**
 * Contiguous grid slices between start and end (seconds; start is snapped to the grid).
 * unit: 'beat' | 'bar' | 'phrase'; size = units per slice (e.g. 0.5 beat, 2 bars); phraseBars for 'phrase'.
 * @returns {{index, start, end, beats}[]}  beats = slice length in beats
 */
export function sliceGrid(grid, { start = 0, end, unit = 'beat', size = 1, phraseBars = 8, duration = Infinity, max = 256 } = {}) {
  const unitBeats = unit === 'bar' ? grid.beatsPerBar : unit === 'phrase' ? grid.beatsPerBar * phraseBars : 1;
  const step = unitBeats * size;
  const stop = Math.min(end ?? duration, duration);
  let i0 = Math.round(beatIndexAt(grid, start));
  while (beatTime(grid, i0) < -1e-9) i0 += step;
  const out = [];
  for (let i = i0; out.length < max; i += step) {
    const s = beatTime(grid, i), e = beatTime(grid, i + step);
    if (e > stop + 1e-6) break;
    out.push({ index: out.length, start: s, end: e, beats: step });
  }
  return out;
}

/**
 * Transient slices inside [start, end): each onset starts a slice; optionally quantised to 1/16 notes.
 * @param {number[]} onsets times (s) from detectTransients()
 */
export function sliceTransients(onsets, { start = 0, end, grid = null, quantize = 0.25, max = 64 } = {}) {
  let ts = onsets.filter((t) => t >= start - 1e-6 && t < end - 0.02);
  if (grid && quantize) ts = [...new Set(ts.map((t) => +snapToGrid(grid, t, quantize).toFixed(6)))].filter((t) => t >= start - 1e-6 && t < end);
  if (!ts.length || ts[0] - start > 0.02) ts.unshift(start);
  ts = ts.slice(0, max);
  const spb = grid ? secondsPerBeat(grid) : null;
  return ts.map((s, i) => {
    const e = i + 1 < ts.length ? ts[i + 1] : end;
    return { index: i, start: s, end: e, beats: spb ? (e - s) / spb : null };
  });
}

/** DJ loop: `bars` bars starting at the beat nearest t. */
export function loopAt(grid, t, bars = 4) {
  const start = Math.max(0, snapToGrid(grid, t, 1, 'round'));
  return { start, end: start + bars * grid.beatsPerBar * secondsPerBeat(grid), bars };
}

/** Copy [t0, t1) seconds out of channels with short fades (ms) at both ends. */
export function extractRegion(channels, sr, t0, t1, { fadeMs = 3 } = {}) {
  const chs = Array.isArray(channels) ? channels : [channels];
  const a = Math.max(0, Math.round(t0 * sr));
  const len = Math.max(1, Math.round((t1 - t0) * sr));
  const fade = Math.min(Math.floor(len / 2), Math.round((fadeMs / 1000) * sr));
  return chs.map((x) => {
    const y = new Float32Array(len);
    y.set(x.subarray(a, Math.min(x.length, a + len)));
    for (let i = 0; i < fade; i++) { const g = i / fade; y[i] *= g; y[len - 1 - i] *= g; }
    return y;
  });
}
