// Automation target metadata shared by the arrange lanes, the automation recorder, the mixer and
// the device panel: which targets an owner (track / bus / master) has, their labels, lane ranges
// (enum / bool params become stepped number lanes) and current static values.
// Owner ids: a track id, a bus id or 'master' (see core/automation.js automationOwner).
import {
  MIXER_TARGETS, parseTarget, laneDef, encodeParam, readParam, automationOwner,
} from '../core/automation.js';
import { DRUM_PADS } from '../core/model.js';
import { INSTRUMENT_DEFS } from '../audio/defs.js';
import { EFFECT_DEFS, resolveEffectParams } from '../audio/effect-defs.js';
import { resolveInstrumentDef } from '../audio/presets.js';
import { getStatus, pluginKey } from '../plugins/status.js';

export const BUS_COLOR = '#3bc9db';
export const MASTER_COLOR = '#ffa94d';

const MUTE_DEF = { ...MIXER_TARGETS.mute, boolParam: true, onLabel: 'Muted', offLabel: 'Playing' };
const FXEN_DEF = { ...MIXER_TARGETS.fxen, boolParam: true, onLabel: 'On', offLabel: 'Bypassed' };
const automatable = (d) => d && !d.hidden && (d.type === 'number' || d.type === 'enum' || d.type === 'bool' || d.type == null);

/** {kind, id, name, color, owner} for an owner id (null when it does not exist). */
export function ownerInfo(project, id) {
  const o = automationOwner(project, id);
  if (!o) return null;
  if (id === 'master') return { kind: 'master', id, name: 'Master', color: MASTER_COLOR, owner: o };
  if (project.tracks.includes(o)) return { kind: 'track', id, name: o.name, color: o.color, owner: o };
  return { kind: 'bus', id, name: o.name || 'Bus', color: BUS_COLOR, owner: o };
}

/** Read-only view of an owner shaped like a track for the lane UI: {...owner, id, name, color, kind}. */
export function ownerView(project, id) {
  const oi = ownerInfo(project, id);
  if (!oi) return null;
  return oi.kind === 'track' ? oi.owner : { ...oi.owner, id, name: oi.name, color: oi.color, kind: oi.kind, automation: oi.owner.automation || [] };
}

/** Faust plugin controls of a plugin def ({type, params}) as ParamDefs keyed 'values.<address>'. */
function faustDefs(def) {
  if (def?.type !== 'faust' && def?.type !== 'native') return [];
  const list = getStatus(pluginKey(def))?.info?.params || [];
  return list.map((p) => ({
    key: `values.${p.address}`, label: p.label || p.address, type: p.type === 'bool' ? 'bool' : 'number',
    min: p.min ?? 0, max: p.max ?? 1, step: p.step, default: p.init ?? p.min ?? 0,
    curve: p.scale === 'log' && p.min > 0 ? 'log' : p.scale === 'exp' ? 'exp' : 'lin', section: p.section || (def.type === 'native' ? 'Plugin' : 'Faust'),
  }));
}

function instrumentInfo(track) {
  if (track?.type !== 'instrument' || !track.instrument) return null;
  const res = resolveInstrumentDef(track.instrument);
  const idef = INSTRUMENT_DEFS[res.type];
  return idef ? { res, idef } : null;
}

const fxName = (owner, f) => {
  const ed = EFFECT_DEFS[f.type];
  return (ed?.plugin && f.params?.name) || ed?.name || f.type;
};

/**
 * Grouped automation targets of an owner: [{ name, kind:'mixer'|'inst'|'pads'|'fx', fxId?,
 *   items:[{target, label, def (lane def), paramDef, section}] }].
 */
export function targetGroups(project, ownerId) {
  const oi = ownerInfo(project, ownerId);
  if (!oi) return [];
  const o = oi.owner;
  const groups = [];
  const mixer = [{ target: 'volume', label: 'Volume', def: MIXER_TARGETS.volume }];
  if (oi.kind !== 'master') mixer.push({ target: 'pan', label: 'Pan', def: MIXER_TARGETS.pan }, { target: 'mute', label: 'Mute', def: MUTE_DEF });
  if (oi.kind === 'track') for (const b of project.buses || []) mixer.push({ target: `send:${b.id}`, label: `Send → ${b.name}`, def: MIXER_TARGETS.send });
  if (oi.kind === 'track' && o.patch?.enabled) {
    (o.patch.cables || []).forEach((c, k) => mixer.push({ target: `cable:${c.id}`, label: `Cable ${k + 1} gain`, def: MIXER_TARGETS.cable }));
  }
  groups.push({ name: 'Mixer', kind: 'mixer', items: mixer });
  if (oi.kind === 'track') {
    const ii = instrumentInfo(o);
    if (ii) {
      const items = [...ii.idef.params, ...faustDefs(ii.res)].filter(automatable)
        .map((d) => ({ target: `inst:${d.key}`, label: d.label, def: laneDef(d), paramDef: d, section: d.section || 'Main' }));
      groups.push({ name: `Instrument · ${ii.idef.name}`, kind: 'inst', items });
      if (ii.idef.padParams) {
        const pdefs = ii.idef.padParams.filter(automatable);
        const items2 = [];
        for (const pad of DRUM_PADS) for (const d of pdefs) items2.push({ target: `inst:pads.${pad.key}.${d.key}`, label: `${pad.name} ${d.label}`, def: laneDef(d), paramDef: d, section: pad.name });
        groups.push({ name: 'Drum pads', kind: 'pads', items: items2 });
      }
    }
  }
  (o.fx || []).forEach((f, k) => {
    const ed = EFFECT_DEFS[f.type];
    if (!ed) return;
    const items = [{ target: `fxen:${f.id}`, label: 'On / bypass', def: FXEN_DEF, section: 'Device' },
      ...[...ed.params, ...faustDefs(f)].filter(automatable).map((d) => ({ target: `fx:${f.id}:${d.key}`, label: d.label, def: laneDef(d), paramDef: d, section: d.section }))];
    groups.push({ name: `FX ${k + 1} · ${fxName(o, f)}`, kind: 'fx', fxId: f.id, items });
  });
  return groups;
}

/** ParamDef of an 'inst:'/'fx:' key (handles pads.<pad>.<key> and Faust values.<address>). */
function findParamDef(defs, padDefs, key, pluginDef) {
  if (key.startsWith('pads.')) { const k = key.slice(key.indexOf('.', 5) + 1); return padDefs?.find((d) => d.key === k) || null; }
  if (key.startsWith('values.')) {
    return faustDefs(pluginDef).find((d) => d.key === key)
      || { key, label: key.slice(7).split('/').filter(Boolean).pop() || key, type: 'number', min: 0, max: 1, default: 0, curve: 'lin' };
  }
  return defs?.find((d) => d.key === key) || null;
}

const miss = (label) => ({ label, short: label, def: { min: 0, max: 1, curve: 'lin', step: 0.01 }, paramDef: null, staticValue: 0, missing: true });

/**
 * { label, short, def (lane def, numeric), paramDef (raw ParamDef for encode/decode, null for mixer
 *   targets), staticValue (lane number), missing, stepped } for a lane target on an owner.
 */
export function targetInfo(project, ownerId, target) {
  const oi = ownerInfo(project, ownerId);
  if (!oi) return miss(`Unknown owner (${ownerId})`);
  const o = oi.owner;
  const tg = parseTarget(target);
  if (!tg) return miss(`Unknown target (${target})`);
  const ok = (label, def, staticValue, paramDef = null, short = label) => ({ label, short, def, paramDef, staticValue, missing: false, stepped: !!def.stepped });
  if (tg.kind === 'volume') return ok('Volume', MIXER_TARGETS.volume, o.volume ?? (oi.kind === 'master' ? 0.9 : 0.8));
  if (tg.kind === 'pan') return oi.kind === 'master' ? miss('Pan (master has no pan)') : ok('Pan', MIXER_TARGETS.pan, o.pan || 0);
  if (tg.kind === 'mute') return oi.kind === 'master' ? miss('Mute (master)') : ok('Mute', MUTE_DEF, o.mute ? 1 : 0);
  if (tg.kind === 'send') {
    if (oi.kind !== 'track') return miss('Send (tracks only)');
    const bus = (project.buses || []).find((b) => b.id === tg.busId);
    if (!bus) return miss('Send → (deleted bus)');
    return ok(`Send → ${bus.name}`, MIXER_TARGETS.send, o.sends?.[tg.busId] || 0);
  }
  if (tg.kind === 'cable') {
    const cables = o.patch?.enabled ? o.patch.cables || [] : [];
    const k = cables.findIndex((c) => c.id === tg.cableId);
    if (k < 0) return miss('Cable gain (cable removed)');
    return ok(`Cable ${k + 1} gain`, MIXER_TARGETS.cable, cables[k].gain ?? 1);
  }
  if (tg.kind === 'inst') {
    const ii = oi.kind === 'track' ? instrumentInfo(o) : null;
    if (!ii) return miss(`${tg.key} (no instrument)`);
    const d = findParamDef(ii.idef.params, ii.idef.padParams, tg.key, ii.res);
    if (!d || !automatable(d)) return miss(`${tg.key} (not in ${ii.res.type})`);
    let label = d.label;
    if (tg.key.startsWith('pads.')) {
      const pad = DRUM_PADS.find((x) => x.key === tg.key.split('.')[1]);
      label = `${pad?.name || tg.key.split('.')[1]} ${d.label}`;
    }
    const raw = readParam(ii.res.params, tg.key) ?? d.default;
    return ok(`${ii.idef.name}: ${label}`, laneDef(d), encodeParam(d, raw) ?? 0, d, label);
  }
  const f = (o.fx || []).find((x) => x.id === tg.fxId);
  const ed = f && EFFECT_DEFS[f.type];
  if (!ed) return miss(`${tg.key} (effect removed)`);
  const k = o.fx.indexOf(f) + 1;
  const name = fxName(o, f);
  if (tg.kind === 'fxen') return ok(`FX ${k} ${name}: On`, FXEN_DEF, f.enabled === false ? 0 : 1, null, `${name} › On`);
  const d = findParamDef(ed.params, null, tg.key, f);
  if (!d || !automatable(d)) return miss(`${tg.key} (effect removed)`);
  const raw = tg.key.startsWith('values.') ? readParam(f.params, tg.key) ?? d.default : resolveEffectParams(f)[tg.key] ?? d.default;
  return ok(`FX ${k} ${name}: ${d.label}`, laneDef(d), encodeParam(d, raw) ?? 0, d, `${name} › ${d.label}`);
}

/** "Bass · Reverb › Decay", "Lead › Volume", "Master › Volume" — for toasts and recorded-lane labels. */
export function laneLabel(project, ownerId, target) {
  const oi = ownerInfo(project, ownerId);
  const info = targetInfo(project, ownerId, target);
  const own = oi ? oi.name : ownerId;
  const tg = parseTarget(target);
  if (tg && (tg.kind === 'fx' || tg.kind === 'fxen')) return `${own} · ${info.short}`;
  return `${own} › ${info.short}`;
}

/** Format a lane number for display (enum option label, On/Off, units). */
export function formatLaneValue(def, v, formatValue) {
  if (v == null || !Number.isFinite(+v)) return '–';
  if (def?.enumOptions) return def.enumOptions[Math.max(0, Math.min(def.enumOptions.length - 1, Math.round(v)))]?.label ?? '–';
  if (def?.boolParam) return v >= 0.5 ? (def.onLabel || 'On') : (def.offLabel || 'Off');
  return formatValue ? formatValue({ ...def, type: 'number' }, v) : String(+(+v).toFixed(3));
}
