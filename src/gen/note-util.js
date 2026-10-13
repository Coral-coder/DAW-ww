// Internal helper: create a model Note with tidy rounding that never spills past `length`.
import { createNote } from '../core/model.js';

const r4 = (x) => Math.round(x * 10000) / 10000;

/** -> Note | null (null when the start lies outside [0, length)). */
export function makeNote(pitch, start, dur, vel, length = Infinity) {
  const s = r4(Math.max(0, start));
  if (!(s < length - 1e-6)) return null;
  const maxDur = length - s;
  const d = Math.max(0.01, Math.floor(Math.min(dur, maxDur) * 10000) / 10000);
  const v = Math.round(Math.min(1, Math.max(0.05, vel)) * 100) / 100;
  return createNote(Math.max(0, Math.min(127, Math.round(pitch))), s, Math.min(d, maxDur), v);
}
