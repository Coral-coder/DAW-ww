// Touch control popup — pure value logic from the same ParamDefs the desktop knobs use
// ({key, label, type, min, max, step, default, unit, curve}).
import { toNorm, fromNorm } from '../core/automation.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const range = (def) => (def.max ?? 1) - (def.min ?? 0);

/** Snap to the def's step (and its range). */
export function quantize(def, v) {
  const min = def.min ?? 0, max = def.max ?? 1;
  let x = clamp(Number(v), min, max);
  if (def.step) x = Math.round((x - min) / def.step) * def.step + min;
  return clamp(+x.toFixed(6), min, max);
}

/** Integer-stepped params (semitones, counts) move by whole steps. */
const integral = (def) => (def.step ?? 0) >= 1 && (def.curve || 'lin') === 'lin' && range(def) / def.step <= 256;

/**
 * − / + buttons: one press = 1 % of the travel (0.2 % fine) in the control's own curve (log for frequencies),
 * never less than the def's step; integer params move by 1 step.
 */
export function nudge(def, v, dir, { fine = false } = {}) {
  if (integral(def)) return quantize(def, Number(v) + dir * def.step);
  const n0 = toNorm(def, v);
  const dn = fine ? 0.002 : 0.01;
  let nv = fromNorm(def, n0 + dir * dn);
  if (def.step && Math.abs(nv - v) < def.step) nv = Number(v) + dir * def.step;
  return quantize(def, nv);
}

/** Press-and-hold repeat: delay before the n-th repeat (ms) — slow start, then accelerating. */
export const repeatDelay = (n) => (n === 0 ? 380 : Math.max(35, 120 - n * 8));
/** Steps per repeat tick (bigger jumps after a long hold). */
export const repeatSteps = (n) => (n < 12 ? 1 : n < 30 ? 2 : 5);

/**
 * Horizontal scrub on the big slider: fine mode slows the slider down as the finger moves vertically away
 * from it (like iOS media scrubbing): full speed within 30 px, ×½ at ~60 px, ×¼ at ~120 px, min ×1/20.
 */
export function scrubFactor(dyAway) {
  const d = Math.max(0, Math.abs(dyAway) - 30);
  return Math.max(0.05, 1 / (1 + d / 30));
}
/** One scrub move: ddx pixels at slider width -> new normalized position. */
export const scrubNorm = (norm, ddx, width, dyAway) => clamp(norm + (ddx / Math.max(1, width)) * scrubFactor(dyAway), 0, 1);

function kindOf(def) {
  const k = String(def.key || '').toLowerCase(), l = String(def.label || '').toLowerCase();
  if (def.unit === 'Hz' && (def.max ?? 0) > 1000) return 'freq';
  if (/(^|[^a-z])(mix|wet|dry)([^a-z]|$)/.test(l) || k === 'mix' || k === 'wet' || def.unit === '%') return 'mix';
  if (def.unit === 's' || def.unit === 'ms') return 'time';
  if (def.unit === 'st') return 'semis';
  if (def.unit === 'dB') return 'db';
  if (k === 'pan' || (def.min === -1 && def.max === 1)) return 'pan';
  if (k === 'volume' || k === 'gain') return 'gain';
  if (k.startsWith('send') || l.startsWith('send')) return 'mix';
  return 'num';
}

const MUSICAL = {
  freq: [[200, '200'], [800, '800'], [2000, '2k'], [8000, '8k']],
  mix: [[0, '0%'], [0.25, '25%'], [0.5, '50%'], [1, '100%']],
  time: [[0.01, '10 ms'], [0.1, '100 ms'], [0.5, '0.5 s'], [1, '1 s']],
  semis: [[-12, '−12'], [-7, '−7'], [0, '0'], [7, '+7'], [12, '+12']],
  db: [[-12, '−12 dB'], [-6, '−6 dB'], [0, '0 dB'], [6, '+6 dB']],
  pan: [[-1, 'L'], [-0.5, 'L50'], [0, 'C'], [0.5, 'R50'], [1, 'R']],
  gain: [[0, 'Off'], [0.5, '½'], [0.8, 'Unity'], [1, 'Full']],
};

/**
 * Preset chips for a param: Min / Default / Max plus musically useful values for its kind
 * (cutoff 200/800/2k/8k, mix 0/25/50/100 %, times, ±semitones, dB, pan L/C/R…). Sorted, de-duplicated, in range.
 */
export function presetsFor(def) {
  if (def.type === 'enum') return (def.options || []).map((o) => ({ label: o.label, value: o.value }));
  if (def.type === 'bool') return [{ label: 'Off', value: false }, { label: 'On', value: true }];
  const min = def.min ?? 0, max = def.max ?? 1;
  const kind = kindOf(def);
  let list = (MUSICAL[kind] || []).map(([v, label]) => {
    // % values scale to the param's own 0..max range (a 0..100 mix knob)
    if (kind === 'mix' && max > 1.0001) v = min + (v * (max - min));
    return { value: v, label };
  });
  if (kind === 'mix' && max > 1.0001) list = list.map((p) => ({ ...p, value: quantize(def, p.value) }));
  list = list.filter((p) => p.value >= min - 1e-9 && p.value <= max + 1e-9);
  const out = [{ value: min, label: 'Min', tag: 'min' }, ...list];
  if (def.default !== undefined && def.default !== null) out.push({ value: def.default, label: 'Default', tag: 'default' });
  out.push({ value: max, label: 'Max', tag: 'max' });
  out.sort((a, b) => a.value - b.value || (a.tag ? 1 : -1)); // musical names first, tags appended
  const res = [];
  for (const p of out) {
    const qv = quantize(def, p.value);
    const same = res.find((r) => Math.abs(r.value - qv) <= 1e-9);
    if (!same) res.push({ ...p, value: qv });
    else if (p.tag && !same.tag) { same.tag = p.tag; same.label = `${same.label} · ${p.label}`; } // keep the musical name, mark it
    else if (p.tag && same.tag) { same.label = `${same.label} · ${p.label}`; }
  }
  return res;
}

/**
 * Typed entry: "2k", "2.5 kHz", "800hz", "50%", "-6 dB", "120 ms", "1.5 s", "+7" -> value in the def's units
 * (clamped / stepped), or null when unreadable.
 */
export function parseTyped(def, text) {
  const s = String(text ?? '').trim().toLowerCase().replace(/,/g, '.').replace(/−/g, '-');
  if (!s) return null;
  if (def.type === 'bool') return /^(1|on|yes|true)$/.test(s) ? true : /^(0|off|no|false)$/.test(s) ? false : null;
  if (def.type === 'enum') {
    const o = (def.options || []).find((x) => String(x.label).toLowerCase() === s || String(x.value).toLowerCase() === s);
    return o ? o.value : null;
  }
  const m = /^([+-]?\d*\.?\d+(?:e[+-]?\d+)?)\s*(k|khz|hz|%|db|ms|s|st|ct|x|×)?$/.exec(s);
  if (!m) return null;
  let v = parseFloat(m[1]);
  const u = m[2] || '';
  if (u === 'k' || u === 'khz') v *= 1000;
  else if (u === 'ms') v = def.unit === 'ms' ? v : v / 1000;
  else if (u === '%') v = (def.max ?? 1) <= 1 ? v / 100 : v;
  else if (u === 's' && def.unit === 'ms') v *= 1000;
  if (!Number.isFinite(v)) return null;
  return quantize(def, v);
}

/** Reset target. */
export const defaultOf = (def) => def.default ?? (def.type === 'bool' ? false : def.type === 'enum' ? def.options?.[0]?.value : def.min ?? 0);
