// Native plugin parameters <-> daW³'s param model. A plugin's parameters become ParamDefs keyed
// `values.<id>` (the same shape Faust controls use), so the device panel knobs, automation lanes,
// the automation recorder and MIDI learn all work on them unchanged. Pure, Node-testable.

export const PARAM_FLAGS = { automatable: 1, stepped: 2, hidden: 4, readOnly: 8, bypass: 16 };

/**
 * Plugin parameter infos (from the host: {id, name, module, unit, min, max, default, steps, flags})
 * -> Faust-style control list [{address, label, type, min, max, init, step, unit, section}].
 * Hidden / read-only parameters are left out; at most `limit` are listed (huge synths expose thousands).
 */
export function controlsFromParams(params = [], { limit = 512 } = {}) {
  const out = [];
  for (const p of params) {
    if (!p || !Number.isInteger(p.id) || p.id < 0) continue;
    const flags = p.flags | 0;
    if (flags & (PARAM_FLAGS.hidden | PARAM_FLAGS.readOnly)) continue;
    const min = Number.isFinite(p.min) ? p.min : 0;
    const max = Number.isFinite(p.max) && p.max > min ? p.max : min + 1;
    const steps = p.steps > 0 ? p.steps | 0 : 0;
    const isBool = (steps === 1 && max - min === 1) || (flags & PARAM_FLAGS.bypass);
    out.push({
      address: String(p.id),
      label: String(p.name || `Param ${p.id}`).slice(0, 64),
      type: isBool ? 'bool' : 'number',
      min,
      max,
      init: Number.isFinite(p.default) ? Math.min(max, Math.max(min, p.default)) : min,
      step: steps > 0 ? (max - min) / steps : (max - min) / 1000,
      unit: p.unit || '',
      section: p.module || 'Plugin',
      automatable: !!(flags & PARAM_FLAGS.automatable),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** ParamDefs for the automation target list (same shape as automation-targets.js faustDefs). */
export function paramDefsFromControls(controls = []) {
  return controls.filter((c) => c.automatable !== false).map((c) => ({
    key: `values.${c.address}`, label: c.label, type: c.type === 'bool' ? 'bool' : 'number',
    min: c.min, max: c.max, step: c.step, default: c.init, curve: 'lin', section: c.section || 'Plugin', unit: c.unit || undefined,
  }));
}

const clampTo = (c, v) => Math.min(c.max, Math.max(c.min, Number(v)));

/** Changes between two `values` maps -> [[id:number, value:number]] (only valid, changed, known ids). */
export function diffValues(prev = {}, next = {}, controls = null) {
  const byAddr = controls ? new Map(controls.map((c) => [c.address, c])) : null;
  const out = [];
  for (const [k, v] of Object.entries(next || {})) {
    const id = Number(k);
    if (!Number.isInteger(id) || id < 0 || !Number.isFinite(Number(v))) continue;
    const c = byAddr?.get(k);
    if (byAddr && !c) continue;
    const val = c ? clampTo(c, v) : Number(v);
    if (prev && Object.prototype.hasOwnProperty.call(prev, k) && Number(prev[k]) === val) continue;
    out.push([id, val]);
  }
  return out;
}

export const normalize = (c, v) => (c.max > c.min ? (clampTo(c, v) - c.min) / (c.max - c.min) : 0);
export const denormalize = (c, n) => {
  const v = c.min + Math.min(1, Math.max(0, n)) * (c.max - c.min);
  if (c.type === 'bool') return v >= (c.min + c.max) / 2 ? c.max : c.min;
  return c.step > 0 && c.max - c.min > 0 && (c.max - c.min) / c.step <= 1024 ? Math.round((v - c.min) / c.step) * c.step + c.min : v;
};

/** MIDI learn: a 7-bit CC value (or 14-bit with hi/lo) -> the control's plain value. */
export function midiToValue(c, cc, lsb = null) {
  const n = lsb == null ? cc / 127 : ((cc << 7) | lsb) / 16383;
  return denormalize(c, n);
}

/** Plugin GUI change -> the `values` patch for the project (null if unchanged / unknown). */
export function valuesPatch(values = {}, controls = [], id, value) {
  const c = controls.find((x) => x.address === String(id));
  if (!c) return null;
  const v = clampTo(c, value);
  if (Number(values?.[c.address]) === v) return null;
  return { ...values, [c.address]: v };
}
