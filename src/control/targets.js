// Automation targets as controller destinations (Node-safe): read / write a target's value normalized to
// 0..1 (same curves as the knobs and the automation lanes), resolve template owner aliases.
//   owner aliases (controller templates): '@sel' = selected track, '@t3' = third track, 'master'.
import { parseTarget, automationOwner, toNorm, fromNorm, decodeParam } from '../core/automation.js';
import { createModState } from '../core/modulation.js';
import { targetInfo } from '../ui/automation-targets.js';

export function resolveOwner(project, owner, ctx = {}) {
  if (owner === '@sel') return ctx.selectedTrackId || project.tracks[0]?.id || null;
  const m = /^@t(\d+)$/.exec(owner || '');
  if (m) return project.tracks[+m[1] - 1]?.id || null;
  return owner;
}

/** Owner id -> template alias ('@t2'), master stays 'master', buses keep their id. */
export function templateOwner(project, owner) {
  const i = project.tracks.findIndex((t) => t.id === owner);
  return i >= 0 ? `@t${i + 1}` : owner;
}

export function targetNorm(project, owner, target) {
  const info = targetInfo(project, owner, target);
  if (info.missing) return null;
  return toNorm(info.def, info.staticValue);
}

export function targetSteps(project, owner, target) {
  const info = targetInfo(project, owner, target);
  if (info.missing || !info.def.stepped) return null;
  return Math.max(1, Math.round(((info.def.max ?? 1) - (info.def.min ?? 0)) / (info.def.step || 1)));
}

/** Lane number for a normalized value. */
export function laneValueOf(info, norm) {
  let v = fromNorm(info.def, norm);
  if (info.def.stepped) v = Math.round(v);
  else if (info.def.step) v = +(Math.round(v / info.def.step) * info.def.step).toFixed(6);
  return v;
}

/** Write a lane-number value of a target into a (draft) project. Returns false when the target is missing. */
export function applyLaneValue(p, owner, target, v) {
  const o = automationOwner(p, owner);
  const tg = parseTarget(target);
  if (!o || !tg) return false;
  const info = targetInfo(p, owner, target);
  if (info.missing) return false;
  switch (tg.kind) {
    case 'volume': o.volume = v; return true;
    case 'pan': o.pan = v; return true;
    case 'mute': o.mute = v >= 0.5; return true;
    case 'send': o.sends = { ...(o.sends || {}), [tg.busId]: v }; return true;
    case 'cable': { const c = o.patch?.cables?.find((x) => x.id === tg.cableId); if (c) c.gain = v; return !!c; }
    case 'inst': {
      if (!o.instrument) return false;
      const raw = decodeParam(info.paramDef, v);
      o.instrument.params = { ...(o.instrument.params || {}) };
      writeNested(o.instrument.params, tg.key, raw);
      return true;
    }
    case 'fxen': { const f = o.fx?.find((x) => x.id === tg.fxId); if (f) f.enabled = v >= 0.5; return !!f; }
    case 'macro': {
      o.mod = o.mod ? { ...o.mod, macros: [...(o.mod.macros || createModState().macros)] } : createModState();
      const m = o.mod.macros[tg.index];
      if (!m) return false;
      o.mod.macros[tg.index] = { ...m, value: Math.max(0, Math.min(1, v)) };
      return true;
    }
    case 'fx': {
      const f = o.fx?.find((x) => x.id === tg.fxId);
      if (!f) return false;
      f.params = { ...(f.params || {}) };
      writeNested(f.params, tg.key, decodeParam(info.paramDef, v));
      return true;
    }
    default: return false;
  }
}

/** Write params[key] where key may be 'pads.<pad>.<param>' or 'values.<address>'. */
export function writeNested(params, key, value) {
  if (key.startsWith('pads.')) {
    const rest = key.slice(5);
    const j = rest.indexOf('.');
    if (j <= 0) return;
    const pad = rest.slice(0, j), k = rest.slice(j + 1);
    params.pads = { ...(params.pads || {}) };
    params.pads[pad] = { ...(params.pads[pad] || {}), [k]: value };
  } else if (key.startsWith('values.')) {
    params.values = { ...(params.values || {}), [key.slice(7)]: value };
  } else params[key] = value;
}

/** Write a normalized value. */
export function applyNorm(p, owner, target, norm) {
  const info = targetInfo(p, owner, target);
  if (info.missing) return false;
  return applyLaneValue(p, owner, target, laneValueOf(info, norm));
}
