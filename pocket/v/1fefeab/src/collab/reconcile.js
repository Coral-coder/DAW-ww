// In-place deep reconcile: mutate `target` until it deep-equals `src`, keeping the identity of
// objects / arrays that survive (matched by key, or by `id` inside arrays of objects) so UI code
// holding references to a track / pattern keeps working after a remote edit. Pure / Node-safe.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const idArray = (a) => a.length > 0 && a.every((e) => isObj(e) && typeof e.id === 'string');

/** Returns the reconciled value (target itself when it could be updated in place). */
export function reconcileValue(target, src) {
  if (isObj(target) && isObj(src)) { reconcileObject(target, src); return target; }
  if (Array.isArray(target) && Array.isArray(src)) { reconcileArray(target, src); return target; }
  return clone(src);
}

export function reconcileObject(target, src, skip = null) {
  for (const k of Object.keys(target)) if (!(k in src) && !(skip && skip.has(k))) delete target[k];
  for (const k of Object.keys(src)) {
    if (skip && skip.has(k)) continue;
    const t = target[k], s = src[k];
    if (t === s && (s === null || typeof s !== 'object')) continue;
    target[k] = reconcileValue(t, s);
  }
}

function reconcileArray(target, src) {
  if (idArray(src) && target.every((e) => isObj(e))) {
    const byId = new Map(target.filter((e) => typeof e.id === 'string').map((e) => [e.id, e]));
    const out = src.map((s) => { const t = byId.get(s.id); return t ? reconcileValue(t, s) : clone(s); });
    target.length = 0;
    target.push(...out);
    return;
  }
  const out = src.map((s, i) => reconcileValue(target[i], s));
  target.length = 0;
  target.push(...out);
}
