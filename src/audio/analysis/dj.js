// Pure DJ-deck math (Node-testable): tempo sync, beat-phase alignment, crossfader curve, pitch %.
import { beatIndexAt, beatTime } from './tempo.js';

/** Playback rate that makes a track at `bpm` play at `targetBpm`. */
export const syncRate = (bpm, targetBpm) => (bpm > 0 && targetBpm > 0 ? targetBpm / bpm : 1);

/** Effective tempo of a deck. */
export const deckBpm = (grid, rate = 1) => (grid ? grid.bpm * rate : 0);

/**
 * Where to seek the follower so its beat phase matches the leader's (both positions in track seconds).
 * Keeps the follower within half a beat of where it is. If barAlign, also matches the beat-in-bar.
 */
export function phaseAlign(leaderGrid, leaderPos, followerGrid, followerPos, { barAlign = false } = {}) {
  const lb = beatIndexAt(leaderGrid, leaderPos);
  const fb = beatIndexAt(followerGrid, followerPos);
  const unit = barAlign ? leaderGrid.beatsPerBar : 1;
  const lFrac = ((lb % unit) + unit) % unit;
  let target = Math.floor(fb / unit) * unit + lFrac;
  if (target - fb > unit / 2) target -= unit;
  if (fb - target > unit / 2) target += unit;
  return beatTime(followerGrid, target);
}

/** Equal-power crossfader. x in [-1 (A), 1 (B)] -> { a, b } gains. */
export function crossfade(x) {
  const t = (Math.max(-1, Math.min(1, x)) + 1) / 2;
  return { a: Math.cos((t * Math.PI) / 2), b: Math.sin((t * Math.PI) / 2) };
}

/** Rate <-> pitch-fader percent. */
export const rateToPercent = (r) => (r - 1) * 100;
export const percentToRate = (p) => 1 + p / 100;
