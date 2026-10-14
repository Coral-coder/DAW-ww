// Native plugin parameter automation for the faster-than-realtime render (Mac app): the automation lanes of a
// native instrument's parameters (`inst:values.<paramId>`) become sample-accurate parameter events
// [[frame, paramId, value]] that the plugin host sends with each block (CLAP param events / VST3 queue points /
// AU parameter buffer offsets at their frame). Ramps are sent as steps every `step` frames. Pure, Node-testable.
import { activeLanes, parseTarget, valueAt } from '../core/automation.js';

const clampTo = (c, v) => (c ? Math.min(c.max, Math.max(c.min, v)) : v);

/** A lane number -> the plugin's plain value (bool controls snap to min / max). */
export function laneToPlain(c, v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (!c) return n;
  if (c.type === 'bool') return n >= 0.5 ? c.max : c.min;
  return clampTo(c, n);
}

/**
 * Parameter events for one track's native instrument.
 *   track      the project track (its `automation` lanes)
 *   controls   the plugin's controls (native/params.js controlsFromParams) — unknown parameters are skipped
 *   startBeat, endBeat   the rendered range;  frameAt(beat) -> render frame (tempo map aware)
 *   step       frames between steps on a ramp (default 64 ≈ 1.3 ms at 48 kHz)
 *   minDelta   smallest change (as a fraction of the parameter range) worth an event on a ramp
 * -> { events: [[frame, paramId, value]] sorted by frame, initial: { paramId: value at startBeat } }
 */
export function nativeAutomationEvents(track, { controls = null, startBeat = 0, endBeat, frameAt, step = 64, minDelta = 1e-4 } = {}) {
  const byAddr = controls ? new Map(controls.map((c) => [c.address, c])) : null;
  const events = [];
  const initial = {};
  if (!track || typeof frameAt !== 'function' || !(endBeat > startBeat)) return { events, initial };
  const f0 = frameAt(startBeat);
  const fr = (b) => Math.max(0, Math.round(frameAt(b) - f0));
  for (const lane of activeLanes(track)) {
    const t = parseTarget(lane.target);
    if (t?.kind !== 'inst' || !t.key.startsWith('values.')) continue;
    const addr = t.key.slice(7);
    const id = Number(addr);
    if (!/^\d+$/.test(addr) || !Number.isSafeInteger(id)) continue;
    const c = byAddr ? byAddr.get(addr) : null;
    if (byAddr && !c) continue;
    const range = c ? Math.max(1e-9, c.max - c.min) : 1;
    const pts = lane.points;
    let last = laneToPlain(c, valueAt(pts, startBeat));
    if (last == null) continue;
    initial[addr] = last;
    const push = (frame, v) => {
      const val = laneToPlain(c, v);
      if (val == null || val === last) return;
      events.push([frame, id, val]);
      last = val;
    };
    // walk the segments inside the range: breakpoints land on their frame, ramps step every `step` frames
    let i = 0;
    while (i < pts.length && pts[i].beat <= startBeat) i++;
    let prevBeat = startBeat;
    const ramp = (b0, b1, fn) => {
      const a = fr(b0), b = fr(b1);
      for (let f = a + step; f < b; f += step) {
        const beat = b0 + ((b1 - b0) * (f - a)) / Math.max(1, b - a);
        const v = laneToPlain(c, fn(beat));
        if (v != null && Math.abs(v - last) >= minDelta * range) push(f, v);
      }
    };
    for (; i < pts.length && pts[i].beat < endBeat; i++) {
      const p = pts[i];
      const prev = i > 0 ? pts[i - 1] : null;
      // a ramp from the previous point (or the range start) to this one
      if (prev && p.beat > prev.beat && p.value !== prev.value) ramp(Math.max(prevBeat, prev.beat), p.beat, (b) => valueAt(pts, b));
      push(fr(p.beat), p.value);
      prevBeat = p.beat;
    }
    // the ramp running past the end of the range
    if (i < pts.length && i > 0 && pts[i].value !== pts[i - 1].value) ramp(Math.max(prevBeat, pts[i - 1].beat), endBeat, (b) => valueAt(pts, b));
  }
  events.sort((a, b) => a[0] - b[0]);
  return { events, initial };
}
