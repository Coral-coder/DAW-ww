// Modulation targets (Node-safe): which params of a track can be modulated, their ParamDefs and static values.
// Targets are automation target strings (core/automation.js parseTarget): 'inst:<key>', 'fx:<fxId>:<key>',
// 'volume', 'pan', 'send:<busId>'. Only numeric params can be modulated.
import { MIXER_TARGETS, parseTarget } from '../../core/automation.js';
import { INSTRUMENT_DEFS } from '../defs.js';
import { EFFECT_DEFS, resolveEffectParams } from '../effect-defs.js';
import { resolveInstrumentDef } from '../presets.js';

// The store edits the project in place, so resolutions are cached per call site (`cache`, e.g. one runner tick),
// never across edits.
/** Resolved instrument ({type, params}) of a track. cache: optional {} reused within one evaluation. */
export function trackInstrument(track, cache = null) {
  const ins = track?.instrument;
  if (!ins || track.type !== 'instrument') return null;
  if (cache && cache.inst !== undefined) return cache.inst;
  let r = null;
  try { r = resolveInstrumentDef(ins); } catch { r = null; }
  if (cache) cache.inst = r;
  return r;
}
function fxParams(f, cache) {
  const m = cache ? (cache.fx ||= new Map()) : null;
  if (m?.has(f.id)) return m.get(f.id);
  let r;
  try { r = resolveEffectParams(f); } catch { r = f.params || {}; }
  m?.set(f.id, r);
  return r;
}

const numeric = (d) => d && (d.type === 'number' || d.type == null) && Number.isFinite(d.min) && Number.isFinite(d.max) && d.max > d.min;

/**
 * { def, value (static raw), label, kind } of a modulation target on a track, or null when it cannot be modulated
 * (missing / non-numeric / nested pad or plugin keys).
 */
export function modTargetInfo(project, track, target, cache = null) {
  const tg = parseTarget(target);
  if (!tg || !track) return null;
  if (tg.kind === 'volume') return { def: MIXER_TARGETS.volume, value: track.volume ?? 0.8, label: 'Volume', kind: 'mixer' };
  if (tg.kind === 'pan') return { def: MIXER_TARGETS.pan, value: track.pan || 0, label: 'Pan', kind: 'mixer' };
  if (tg.kind === 'send') {
    const bus = (project?.buses || []).find((b) => b.id === tg.busId);
    return bus ? { def: MIXER_TARGETS.send, value: track.sends?.[tg.busId] || 0, label: `Send → ${bus.name}`, kind: 'mixer' } : null;
  }
  if (tg.kind === 'inst') {
    if (tg.key.includes('.')) return null;
    const r = trackInstrument(track, cache);
    const d = r && INSTRUMENT_DEFS[r.type]?.params.find((p) => p.key === tg.key);
    return numeric(d) ? { def: d, value: Number(r.params[tg.key] ?? d.default), label: d.label, kind: 'inst' } : null;
  }
  if (tg.kind === 'fx') {
    if (tg.key.includes('.')) return null;
    const f = (track.fx || []).find((x) => x.id === tg.fxId);
    const d = f && EFFECT_DEFS[f.type]?.params.find((p) => p.key === tg.key);
    if (!numeric(d)) return null;
    return { def: d, value: Number(fxParams(f, cache)[tg.key] ?? d.default), label: `${EFFECT_DEFS[f.type].name} › ${d.label}`, kind: 'fx', fxId: f.id };
  }
  return null;
}

/** Every modulatable target of a track: [{target, label, group}]. */
export function modTargets(project, track) {
  const out = [];
  if (!track) return out;
  out.push({ target: 'volume', label: 'Volume', group: 'Mixer' }, { target: 'pan', label: 'Pan', group: 'Mixer' });
  for (const b of project?.buses || []) out.push({ target: `send:${b.id}`, label: `Send → ${b.name}`, group: 'Mixer' });
  const r = trackInstrument(track);
  if (r) for (const d of INSTRUMENT_DEFS[r.type]?.params || []) if (numeric(d)) out.push({ target: `inst:${d.key}`, label: d.label, group: `Instrument · ${d.section || 'Main'}` });
  (track.fx || []).forEach((f, i) => {
    const ed = EFFECT_DEFS[f.type];
    for (const d of ed?.params || []) if (numeric(d)) out.push({ target: `fx:${f.id}:${d.key}`, label: d.label, group: `FX ${i + 1} · ${ed.name}` });
  });
  return out;
}
