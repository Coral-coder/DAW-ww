// Audio quantize + groove templates (pure, Node-safe).
//
// GrooveTemplate { id, name, grid (beats per slot, e.g. 0.25 = 16ths), length (beats, the cycle), offsets: [beats]
//                  (timing deviation of each slot from the straight grid), velocities: [0..1 | null] (relative
//                  accent per slot, null = no data) }  — kept in project.grooves (optional).
//
// quantizeWarp(clip, transients, opts)   audio: warp markers on the clip's transients pulled toward the grid
//                                        (or a groove) by `strength`, with `swing` — the audio is re-warped
// extractGroove(beats[], opts)           groove from onsets (MIDI note starts or audio transients in beats)
// grooveFromNotes / grooveFromAudio      convenience wrappers
// applyGrooveToNotes(notes, groove, opts) MIDI: move note starts (and velocities) toward the groove
import { beatAtSec, normalizeMarkers, isWarped } from '../audio/warp/markers.js';

const r6 = (x) => Math.round(x * 1e6) / 1e6;

/** Straight-grid target of a beat with swing: odd slots of `grid` are delayed by swing·grid/2. */
export function gridTarget(beat, grid = 0.25, swing = 0) {
  const k = Math.round(beat / grid);
  let t = k * grid;
  if (swing && ((k % 2) + 2) % 2 === 1) t += swing * grid * 0.5;
  return { slot: k, target: t };
}

/** Groove target of a beat: the nearest grid slot moved by the template's offset for that slot. */
export function grooveTarget(beat, groove) {
  const k = Math.round(beat / groove.grid);
  const n = Math.max(1, Math.round(groove.length / groove.grid));
  const idx = ((k % n) + n) % n;
  return { slot: k, idx, target: k * groove.grid + (groove.offsets[idx] || 0), velocity: groove.velocities?.[idx] ?? null };
}

/**
 * Audio quantize: put a warp marker on each transient (sample seconds) of the clip, moved toward its grid / groove
 * position by `strength` (0..1). Grid positions are TIMELINE beats (the clip's start counts), so a clip placed off
 * the bar line still quantizes to the song grid. `range` (beats) ignores transients farther than that from the grid.
 * Returns the new warp (the clip's warp is replaced; mode 'beats' when the clip was unwarped).
 */
export function quantizeWarp(clip, transients, { grid = 0.25, strength = 1, swing = 0, groove = null, range = Infinity, duration } = {}) {
  const w = clip.warp ? { ...clip.warp, markers: [...(clip.warp.markers || [])] } : null;
  if (!w || !w.markers.length) throw new Error('quantizeWarp: the clip has no warp markers (analyse / warp it first)');
  const toTimeline = (c) => c - (clip.offset || 0) + clip.start;
  const cand = [];
  const best = new Map(); // grid slot -> closest transient (two hits in one slot: only the closer one moves)
  for (const s of transients || []) {
    if (duration != null && (s < 0 || s > duration)) continue;
    const c = beatAtSec(w, s);
    const b = toTimeline(c);
    if (b < clip.start - 1e-6 || b > clip.start + clip.length + 1e-6) continue;
    const g = groove ? grooveTarget(b, groove) : gridTarget(b, grid, swing);
    const x = { s, c, b, slot: g.slot, t: g.target, d: Math.abs(g.target - b) };
    cand.push(x);
    if (x.d <= range && (!best.has(x.slot) || best.get(x.slot).d > x.d)) best.set(x.slot, x);
  }
  const pts = cand.map((x) => (best.get(x.slot) === x ? { beat: x.c + strength * (x.t - x.b), sec: x.s } : { beat: x.c, sec: x.s }));
  // keep the outer markers so the clip edges don't move; drop moved points that would cross a neighbour
  const ends = [w.markers[0], w.markers[w.markers.length - 1]];
  const outer = ends.filter((m) => !pts.some((p) => Math.abs(p.sec - m.sec) < 0.03 || Math.abs(p.beat - m.beat) < grid / 2)); // transients win
  const all = [...outer, ...pts].sort((a, b) => a.sec - b.sec);
  const mono = [];
  for (const m of all) if (!mono.length || (m.beat > mono[mono.length - 1].beat + 1e-4 && m.sec > mono[mono.length - 1].sec + 1e-4)) mono.push({ beat: r6(m.beat), sec: r6(m.sec) });
  w.markers = normalizeMarkers(mono);
  if (!isWarped({ warp: w })) w.mode = 'beats';
  return w;
}

/**
 * Groove from onsets (beats). Each onset within `tolerance`·grid of a slot contributes its deviation; slots without
 * onsets get offset 0 / velocity null. velocities: optional parallel array (0..1) -> normalised to the max slot.
 */
export function extractGroove(beats, { grid = 0.25, length = 4, velocities = null, tolerance = 0.45, name = 'Groove' } = {}) {
  const n = Math.max(1, Math.round(length / grid));
  const sum = new Float64Array(n), cnt = new Float64Array(n), vs = new Float64Array(n), vc = new Float64Array(n);
  beats.forEach((b, i) => {
    const k = Math.round(b / grid);
    const d = b - k * grid;
    if (Math.abs(d) > tolerance * grid) return;
    const idx = ((k % n) + n) % n;
    sum[idx] += d; cnt[idx]++;
    if (velocities?.[i] != null) { vs[idx] += velocities[i]; vc[idx]++; }
  });
  const offsets = Array.from(sum, (s, i) => (cnt[i] ? r6(s / cnt[i]) : 0));
  const vm = Math.max(1e-9, ...Array.from(vs, (v, i) => (vc[i] ? v / vc[i] : 0)));
  const vel = Array.from(vs, (v, i) => (vc[i] ? r6(v / vc[i] / vm) : null));
  return { id: `groove_${Math.random().toString(36).slice(2, 9)}`, name, grid, length: n * grid, offsets, velocities: velocities ? vel : null, hits: Array.from(cnt) };
}

/** Groove of MIDI notes (pattern-relative starts, velocities). */
export const grooveFromNotes = (notes, opts = {}) => extractGroove(notes.map((n) => n.start), { ...opts, velocities: notes.map((n) => n.vel ?? 0.8) });

/** Groove of an audio clip: transients (sample s) -> timeline beats through its warp. levels: optional peak per transient. */
export function grooveFromAudio(clip, transients, opts = {}) {
  const w = clip.warp?.markers?.length ? clip.warp : { markers: [{ beat: 0, sec: 0 }], bpm: opts.bpm || 120 };
  const beats = transients.map((s) => beatAtSec(w, s) - (clip.offset || 0));
  return extractGroove(beats, { ...opts, velocities: opts.levels || null });
}

/**
 * Apply a groove to notes (positions relative to the pattern; the groove cycle is aligned to beat 0):
 * start -> start + strength·(grooveTarget − start); velocity blended toward the slot accent by velStrength.
 * Returns new note objects (ids kept).
 */
export function applyGrooveToNotes(notes, groove, { strength = 1, velStrength = 0, range = Infinity } = {}) {
  return notes.map((n) => {
    const g = grooveTarget(n.start, groove);
    if (Math.abs(g.target - n.start) > range) return { ...n };
    const out = { ...n, start: r6(Math.max(0, n.start + strength * (g.target - n.start))) };
    if (velStrength > 0 && g.velocity != null) out.vel = r6(Math.max(0.05, Math.min(1, (n.vel ?? 0.8) * (1 - velStrength) + g.velocity * velStrength)));
    return out;
  });
}

/** Plain MIDI quantize with strength / swing. */
export function quantizeNotes(notes, { grid = 0.25, strength = 1, swing = 0 } = {}) {
  return notes.map((n) => ({ ...n, start: r6(Math.max(0, n.start + strength * (gridTarget(n.start, grid, swing).target - n.start))) }));
}

// ------------------------------------------------------------------ groove library
/** MPC-style swing amounts (% of the pair: 50 = straight, 66 ≈ triplet). */
export const MPC_SWING = [50, 54, 56, 58, 60, 62, 64, 66, 71];

/**
 * An MPC swing template: the off-beat of every pair of `grid` slots is placed at `pct`% of the pair
 * (offset = (pct/100 − 0.5)·2·grid). grid 0.25 = 16th swing, 0.5 = 8th swing. Off-beats are slightly softer.
 */
export function mpcSwingGroove(pct, grid = 0.25) {
  const off = r6((pct / 100 - 0.5) * 2 * grid);
  const n = Math.max(2, Math.round(1 / grid)); // one beat per cycle... aligned to beats
  const offsets = Array.from({ length: n }, (_, i) => (i % 2 ? off : 0));
  const velocities = Array.from({ length: n }, (_, i) => (i % 2 ? 0.85 : 1));
  const tag = grid === 0.25 ? '16' : grid === 0.5 ? '8' : String(grid);
  return { id: `mpc${tag}-${pct}`, name: `MPC ${tag}th swing ${pct}%`, grid, length: n * grid, offsets, velocities, builtin: true };
}

/** Built-in grooves: MPC 16th-swing presets (54–71%) + 8th-swing 58 / 66%. */
export const BUILTIN_GROOVES = Object.freeze([
  ...MPC_SWING.filter((p) => p > 50).map((p) => mpcSwingGroove(p, 0.25)),
  mpcSwingGroove(58, 0.5), mpcSwingGroove(66, 0.5),
]);

/** All grooves usable in a project: built-ins first, then the ones extracted / saved in project.grooves. */
export function grooveLibrary(project) {
  return [...BUILTIN_GROOVES, ...((project && project.grooves) || [])];
}
export const findGroove = (project, id) => grooveLibrary(project).find((g) => g.id === id) || null;

/**
 * Apply a library groove to a pattern's notes (only `noteIds` when given), strength 0..1 (timing), velStrength 0..1
 * (accents). Returns the new notes array (the input is not modified).
 */
export function grooveNotes(notes, groove, { strength = 1, velStrength = 0, noteIds = null } = {}) {
  if (!groove) return notes.map((n) => ({ ...n }));
  const ids = noteIds && noteIds.size !== undefined ? noteIds : noteIds ? new Set(noteIds) : null;
  const pick = ids && ids.size ? notes.filter((n) => ids.has(n.id)) : notes;
  const moved = new Map(applyGrooveToNotes(pick, groove, { strength, velStrength }).map((n) => [n.id, n]));
  return notes.map((n) => moved.get(n.id) || { ...n });
}
