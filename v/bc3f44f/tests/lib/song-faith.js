// Faithfulness of song code: evaluates the code through the code-engine facade and matches every note the project
// schedules (collectEvents, whole song) with an event of the code — same track, same pitch, onset within the
// humanisation window (the code writes quantized timing: micro-timing / strums are not printed), duration and velocity
// within tolerance.
import { evaluate, queryEvents } from '../../src/code/strudel.js';
import { drumPitch } from '../../src/code/convert.js';
import { beatsPerBar } from '../../src/core/model.js';
import { collectEvents } from '../../src/audio/scheduler.js';

export const ONSET_EARLY = 0.03; // beats the code may be later than the project note (rounding)
export const ONSET_LATE = 0.09; // beats the project note may be behind the code's grid step (late-only humanisation, strums)

/**
 * -> { ok, onsets, total, code events count } for `code` (songToCode / patternsToCode output) against project `p`.
 * labels: { label: trackId } (blocks of songToCode); `end` beats (default: end of the arrangement).
 */
export function songFaith(p, code, labels, { end = null, velTol = 0.1, mode = null } = {}) {
  const bpb = beatsPerBar(p);
  const r = evaluate(code);
  if (r.error) throw new Error(r.error);
  const E = end ?? Math.max(...p.clips.map((c) => c.start + c.length));
  const want = collectEvents({ ...p, swing: 0 }, 0, E, { mode: mode || (p.clips.length ? 'song' : p.mode) }).filter((e) => e.type === 'note');
  const drums = new Set(p.tracks.filter((t) => t.instrument?.type === 'drums').map((t) => t.id));
  const got = new Map(); // track|pitch -> [{beat, dur, vel, used}]
  let count = 0;
  for (const e of queryEvents(r, 0, E / bpb)) {
    const tid = labels[e.name];
    if (!tid) continue;
    const pitch = drums.has(tid) ? (e.value.n >= 24 ? e.value.n : drumPitch(e.value.s)) : e.value.note;
    const k = `${tid}|${pitch}`;
    if (!got.has(k)) got.set(k, []);
    got.get(k).push({ beat: e.begin * bpb, dur: (e.end - e.begin) * bpb, vel: e.value.velocity ?? 0.8, used: false });
    count++;
  }
  for (const list of got.values()) list.sort((a, b) => a.beat - b.beat);
  let ok = 0, onsets = 0;
  const bad = {};
  for (const e of want.sort((a, b) => a.beat - b.beat)) {
    const list = got.get(`${e.trackId}|${e.pitch}`) || [];
    let best = null;
    for (const g of list) {
      if (g.used) continue;
      const d = e.beat - g.beat;
      if (d < -ONSET_EARLY - 1e-9) break;
      if (d > ONSET_LATE + 1e-9) continue;
      if (!best || Math.abs(d) < Math.abs(e.beat - best.beat)) best = g;
    }
    if (!best) { bad[e.trackId] = (bad[e.trackId] || 0) + 1; continue; }
    best.used = true;
    onsets++;
    const durOk = drums.has(e.trackId) || Math.abs(best.dur - e.dur) <= Math.max(0.126, 0.05 * e.dur) + ONSET_LATE;
    if (durOk && Math.abs(best.vel - e.vel) <= velTol + 1e-9) ok++;
  }
  return { ok, onsets, total: want.length, events: count, bad };
}
