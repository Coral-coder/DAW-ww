// How a native plugin lives in a .daW3 project: instrument.params / effect.params of type 'native'
//   { key, format, uid, path, name, vendor, instrument, state: base64 chunk, values: { [paramId]: plain value },
//     gain?, mix? }
// `state` is the plugin's own opaque chunk (restored first); `values` mirror automatable parameters so
// automation / MIDI learn / undo work through daW³'s param model. Pure, Node-testable.
import { isBase64, MAX_STATE_BYTES } from './protocol.js';

export const NATIVE_TYPE = 'native';

/** Project params for a freshly picked plugin (DB entry or catalog source). */
export function nativeParamsFor(desc) {
  const d = desc?.source || desc || {};
  const key = d.key || (d.format && d.uid ? `${d.format}:${d.uid}` : '');
  const [format] = key.split(':');
  return {
    key,
    format: d.format || format || '',
    uid: d.uid || key.slice(format.length + 1),
    path: d.path || '',
    name: desc?.name || d.name || key,
    vendor: desc?.author || desc?.vendor || d.vendor || '',
    instrument: !!(desc?.type === 'instrument' || desc?.instrument || d.instrument),
    state: '',
    values: {},
  };
}

/** Validate / clean native params read from a project file (unknown keys are kept). */
export function sanitizeNativeParams(p = {}) {
  const out = { ...p };
  out.key = typeof p.key === 'string' && /^(clap|vst3|au):./.test(p.key) ? p.key : '';
  out.state = typeof p.state === 'string' && isBase64(p.state) && p.state.length <= (MAX_STATE_BYTES * 4) / 3 + 4 ? p.state : '';
  const values = {};
  for (const [k, v] of Object.entries(p.values && typeof p.values === 'object' ? p.values : {})) {
    if (/^\d+$/.test(k) && Number.isFinite(Number(v))) values[k] = Number(v);
  }
  out.values = values;
  out.name = typeof p.name === 'string' ? p.name.slice(0, 256) : out.key;
  return out;
}

/** What identifies the loaded plugin (changing it reloads; changing values / state does not). */
export const nativeSourceKey = (p = {}) => `native:${p.key || ''}`;

/** Bytes of a base64 state chunk. */
export function stateBytes(b64) {
  if (!b64) return 0;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

/** Native plugins used by a project: [{ owner, where: 'instrument'|'fx', def }]. */
export function nativePluginsIn(project) {
  const out = [];
  const fxOf = (owner, list) => (list || []).forEach((f) => { if (f?.type === NATIVE_TYPE) out.push({ owner, where: 'fx', def: f }); });
  for (const t of project?.tracks || []) {
    if (t.instrument?.type === NATIVE_TYPE) out.push({ owner: t.id, where: 'instrument', def: t.instrument });
    fxOf(t.id, t.fx);
  }
  for (const b of project?.buses || []) fxOf(b.id, b.fx);
  fxOf('master', project?.master?.fx);
  return out;
}
