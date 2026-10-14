// Plugboard (modular patching) — pure graph helpers. Runs in Node and the browser.
//
// A track may carry an optional `track.patch`:
//   { enabled: boolean,
//     nodes:  [{ id, kind: 'fx', fxId, x, y } | { id, kind: 'split' | 'mix', x, y }],
//     cables: [{ id, from: { node: 'in' | nodeId, port: 0 }, to: { node: 'out' | nodeId, port: 0 | 1 }, gain: 0..2 }] }
//
// 'in'  = the track's own signal (instrument / clips / code), 'out' = the channel strip after the
// patch (pan → volume → mute → master/sends continue as usual). Effect nodes reference entries
// of `track.fx` by id, so the effect params (and automation targets 'fx:<fxId>:<key>') still live
// in track.fx. Several cables into one input sum; one output feeding several cables splits.
// 'split' / 'mix' nodes are plain unity-gain junctions for tidier patches.
// Port 1 on a 'ducker' effect node is its key (sidechain) input.
//
// When `patch.enabled` is false or the patch is absent the serial chain (track.fx order) is used.
import { busesFedBy } from './mixer-model.js';
import { uid } from './util.js';

export const PATCH_IN = 'in';
export const PATCH_OUT = 'out';
export const NODE_W = 172; // layout metrics shared with the UI (canvas units)
export const NODE_H = 118;
export const MAX_CABLE_GAIN = 2;

const isTerminal = (id) => id === PATCH_IN || id === PATCH_OUT;
const clampGain = (g) => { const n = Number(g); return Number.isFinite(n) ? Math.min(MAX_CABLE_GAIN, Math.max(0, n)) : 1; };

/** Is the plugboard driving this track's insert section? */
export function isPatchActive(track) {
  return !!(track && track.patch && track.patch.enabled && Array.isArray(track.patch.nodes));
}

export function createPatchNode(kind, opts = {}) {
  const n = { id: opts.id || uid('pn'), kind, x: Math.round(opts.x ?? 200), y: Math.round(opts.y ?? 120) };
  if (kind === 'fx') n.fxId = opts.fxId;
  return n;
}

export function createCable(fromNode, toNode, opts = {}) {
  return {
    id: opts.id || uid('cb'),
    from: { node: fromNode, port: 0 },
    to: { node: toNode, port: opts.toPort || 0 },
    gain: clampGain(opts.gain ?? 1),
  };
}

/** Fill in missing keys of a (possibly partial / foreign) patch object. Never throws. */
export function normalizePatch(patch) {
  if (!patch || typeof patch !== 'object') return null;
  const nodes = (Array.isArray(patch.nodes) ? patch.nodes : [])
    .filter((n) => n && typeof n.id === 'string' && !isTerminal(n.id) && ['fx', 'split', 'mix'].includes(n.kind))
    .map((n) => ({ ...n, x: Number.isFinite(+n.x) ? +n.x : 200, y: Number.isFinite(+n.y) ? +n.y : 120 }));
  const cables = (Array.isArray(patch.cables) ? patch.cables : [])
    .filter((c) => c && c.from && c.to && c.from.node != null && c.to.node != null)
    .map((c) => ({ id: c.id || uid('cb'), from: { node: c.from.node, port: 0 }, to: { node: c.to.node, port: c.to.port | 0 }, gain: clampGain(c.gain ?? 1) }));
  return { enabled: !!patch.enabled, nodes, cables };
}

// ------------------------------------------------------------------------------- graph queries
function fxTypeMap(track) {
  return new Map((track?.fx || []).map((f) => [f.id, f.type]));
}

/** Number of input ports of a node ('out' = 1, 'in' = 0, ducker fx = 2 (main + key)). */
export function inputCount(track, nodeId) {
  if (nodeId === PATCH_IN) return 0;
  if (nodeId === PATCH_OUT) return 1;
  const n = track?.patch?.nodes?.find((x) => x.id === nodeId);
  if (!n) return 0;
  if (n.kind === 'fx') return fxTypeMap(track).get(n.fxId) === 'ducker' ? 2 : 1;
  return 1;
}

export function outputCount(_track, nodeId) {
  return nodeId === PATCH_OUT ? 0 : 1;
}

/** Adjacency (node -> Set(next nodes)) from a cable list. */
function adjacency(cables) {
  const adj = new Map();
  for (const c of cables) {
    if (!adj.has(c.from.node)) adj.set(c.from.node, new Set());
    adj.get(c.from.node).add(c.to.node);
  }
  return adj;
}

function reaches(adj, start, goal) {
  if (start === goal) return true;
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const n = stack.pop();
    for (const m of adj.get(n) || []) {
      if (m === goal) return true;
      if (!seen.has(m)) { seen.add(m); stack.push(m); }
    }
  }
  return false;
}

/** Would a cable from -> to close a loop (including a self-loop)? */
export function wouldCreateCycle(cables, fromNode, toNode) {
  if (fromNode === toNode) return true;
  return reaches(adjacency(cables || []), toNode, fromNode);
}

/** First cycle found as a list of node ids, or null. */
export function findCycle(cables) {
  const adj = adjacency(cables || []);
  const state = new Map(); // 1 = on stack, 2 = done
  const path = [];
  const visit = (n) => {
    state.set(n, 1);
    path.push(n);
    for (const m of adj.get(n) || []) {
      if (state.get(m) === 1) return path.slice(path.indexOf(m));
      if (!state.has(m)) { const c = visit(m); if (c) return c; }
    }
    path.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of adj.keys()) if (!state.has(n)) { const c = visit(n); if (c) return c; }
  return null;
}

/**
 * Check whether a new cable may be added to track.patch. Returns { ok, reason }.
 * Rules: endpoints exist, signal flows out of an output and into an input, the target port
 * exists, no duplicate cable between the same ports, and no feedback loop.
 */
export function validateCable(track, from, to) {
  const patch = track?.patch;
  if (!patch) return { ok: false, reason: 'No patch' };
  const fromNode = from?.node, toNode = to?.node, toPort = to?.port | 0;
  const has = (id) => isTerminal(id) || patch.nodes.some((n) => n.id === id);
  if (!has(fromNode) || !has(toNode)) return { ok: false, reason: 'Unknown device' };
  if (fromNode === PATCH_OUT) return { ok: false, reason: 'OUT has no output — drag from an output (right side)' };
  if (toNode === PATCH_IN) return { ok: false, reason: 'IN has no input — drop on an input (left side)' };
  if (toPort >= inputCount(track, toNode)) return { ok: false, reason: 'That input does not exist' };
  if (fromNode === toNode) return { ok: false, reason: 'A device cannot feed itself' };
  if (patch.cables.some((c) => c.from.node === fromNode && c.to.node === toNode && (c.to.port | 0) === toPort)) return { ok: false, reason: 'Already connected' };
  if (wouldCreateCycle(patch.cables, fromNode, toNode)) return { ok: false, reason: 'That would create a feedback loop' };
  return { ok: true, reason: '' };
}

/** Add a cable (mutates track.patch). Returns the cable or null when invalid. */
export function connect(track, from, to, gain = 1) {
  const v = validateCable(track, from, to);
  if (!v.ok) return null;
  const c = createCable(from.node, to.node, { toPort: to.port | 0, gain });
  track.patch.cables.push(c);
  return c;
}

/**
 * The patch as the audio engine should build it: nodes whose effect still exists (one node per
 * effect), cables between existing ports, duplicates and loop-closing cables dropped (in order).
 * fxList: track.fx.
 */
export function sanitizePatch(patch, fxList = []) {
  const fxTypes = new Map((fxList || []).map((f) => [f.id, f.type]));
  const usedFx = new Set();
  const nodes = [];
  for (const n of patch?.nodes || []) {
    if (!n || isTerminal(n.id)) continue;
    if (n.kind === 'fx') {
      if (!fxTypes.has(n.fxId) || usedFx.has(n.fxId)) continue;
      usedFx.add(n.fxId);
    } else if (n.kind !== 'split' && n.kind !== 'mix') continue;
    if (nodes.some((m) => m.id === n.id)) continue;
    nodes.push(n);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ports = (id) => (id === PATCH_OUT ? 1 : id === PATCH_IN ? 0 : byId.get(id)?.kind === 'fx' && fxTypes.get(byId.get(id).fxId) === 'ducker' ? 2 : byId.has(id) ? 1 : 0);
  const cables = [];
  const seen = new Set();
  for (const c of patch?.cables || []) {
    const f = c?.from?.node, t = c?.to?.node, tp = c?.to?.port | 0;
    if (f == null || t == null || f === PATCH_OUT || t === PATCH_IN || f === t) continue;
    if (!(f === PATCH_IN || byId.has(f))) continue;
    if (tp >= ports(t)) continue;
    const k = `${f}>${t}:${tp}`;
    if (seen.has(k)) continue;
    if (wouldCreateCycle(cables, f, t)) continue;
    seen.add(k);
    cables.push({ id: c.id, from: { node: f, port: 0 }, to: { node: t, port: tp }, gain: clampGain(c.gain ?? 1) });
  }
  return { nodes, cables };
}

/** Structure signature (routing only — cable gains and positions excluded). */
export function patchStructureKey(sp) {
  return sp.nodes.map((n) => `${n.id}/${n.kind}/${n.fxId || ''}`).join(',') + '|' +
    sp.cables.map((c) => `${c.id}:${c.from.node}>${c.to.node}:${c.to.port}`).join(',');
}

/**
 * Topological order of the patch's nodes (Kahn). Ties are broken by x then y, so the result
 * reads left-to-right like the board. Nodes on a cycle (shouldn't exist) are appended.
 */
export function topoOrder(patch) {
  const nodes = patch?.nodes || [];
  const ids = new Set(nodes.map((n) => n.id));
  const pos = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const adj = new Map();
  for (const c of patch?.cables || []) {
    if (!ids.has(c.from.node) || !ids.has(c.to.node)) continue;
    indeg.set(c.to.node, indeg.get(c.to.node) + 1);
    if (!adj.has(c.from.node)) adj.set(c.from.node, []);
    adj.get(c.from.node).push(c.to.node);
  }
  const cmp = (a, b) => (pos.get(a).x - pos.get(b).x) || (pos.get(a).y - pos.get(b).y);
  const ready = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id).sort(cmp);
  const out = [];
  while (ready.length) {
    const n = ready.shift();
    out.push(n);
    for (const m of adj.get(n) || []) {
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0) { ready.push(m); ready.sort(cmp); }
    }
  }
  for (const n of nodes) if (!out.includes(n.id)) out.push(n.id);
  return out;
}

/** Effect ids in the order they appear in the patch (topological), then unplaced effects. */
export function patchFxOrder(track) {
  const fx = track?.fx || [];
  if (!isPatchActive(track)) return fx.map((f) => f.id);
  const byNode = new Map(track.patch.nodes.filter((n) => n.kind === 'fx').map((n) => [n.id, n.fxId]));
  const out = [];
  for (const id of topoOrder(track.patch)) {
    const fxId = byNode.get(id);
    if (fxId && fx.some((f) => f.id === fxId) && !out.includes(fxId)) out.push(fxId);
  }
  for (const f of fx) if (!out.includes(f.id)) out.push(f.id);
  return out;
}

// ------------------------------------------------------------------------------- conversions
/** Equivalent plugboard of the current serial chain: in → fx1 → fx2 → … → out. */
export function serialToPatch(track) {
  const nodes = [];
  const cables = [];
  let prev = PATCH_IN;
  (track?.fx || []).forEach((f, i) => {
    const n = createPatchNode('fx', { fxId: f.id, x: 150 + i * (NODE_W + 48), y: 90 + (i % 2) * 36 });
    nodes.push(n);
    cables.push(createCable(prev, n.id));
    prev = n.id;
  });
  cables.push(createCable(prev, PATCH_OUT));
  return { enabled: true, nodes, cables };
}

/**
 * Best-effort serial order for when the plugboard is switched off: effects that sit on the
 * patch in topological order first, then the rest. Returns a new fx array (same objects).
 */
export function patchToSerial(track) {
  const fx = track?.fx || [];
  if (!track?.patch?.nodes) return fx.slice();
  const order = patchFxOrder({ ...track, patch: { ...track.patch, enabled: true } });
  const byId = new Map(fx.map((f) => [f.id, f]));
  return order.map((id) => byId.get(id)).filter(Boolean);
}

/** Does the stored patch still describe exactly the current set of effects? */
export function patchMatchesFx(track) {
  const p = track?.patch;
  if (!p?.nodes) return false;
  const ids = new Set((track.fx || []).map((f) => f.id));
  const placed = new Set(p.nodes.filter((n) => n.kind === 'fx').map((n) => n.fxId));
  if (ids.size !== placed.size) return false;
  for (const id of ids) if (!placed.has(id)) return false;
  return true;
}

/**
 * Turn the plugboard on/off for a track (mutates). Enabling re-uses a previous patch when it
 * still matches the effect list, otherwise starts from serialToPatch(). Disabling re-orders
 * track.fx with patchToSerial() and keeps the patch (disabled) for later.
 */
export function setPatchEnabled(track, on) {
  if (on) {
    if (track.patch && patchMatchesFx(track)) track.patch = { ...normalizePatch(track.patch), enabled: true };
    else track.patch = serialToPatch(track);
  } else if (track.patch) {
    track.fx = patchToSerial(track);
    track.patch.enabled = false;
  }
  return track;
}

// ------------------------------------------------------------------------------- editing helpers
/** Remove a node and its cables (mutates). bridge: reconnect its sources to its targets. */
export function removeNode(track, nodeId, { bridge = false } = {}) {
  const p = track.patch;
  if (!p) return;
  const ins = p.cables.filter((c) => c.to.node === nodeId && (c.to.port | 0) === 0);
  const outs = p.cables.filter((c) => c.from.node === nodeId);
  p.cables = p.cables.filter((c) => c.from.node !== nodeId && c.to.node !== nodeId);
  p.nodes = p.nodes.filter((n) => n.id !== nodeId);
  if (bridge) {
    for (const a of ins) for (const b of outs) {
      const from = { node: a.from.node, port: 0 }, to = { node: b.to.node, port: b.to.port | 0 };
      if (validateCable(track, from, to).ok) p.cables.push(createCable(from.node, to.node, { toPort: to.port, gain: clampGain(a.gain * b.gain) }));
    }
  }
}

/** Insert a node "at the end of the chain": everything that fed OUT now feeds the node. */
export function insertBeforeOut(track, nodeId) {
  const p = track.patch;
  const into = p.cables.filter((c) => c.to.node === PATCH_OUT);
  if (!into.length) p.cables.push(createCable(PATCH_IN, nodeId));
  for (const c of into) c.to = { node: nodeId, port: 0 };
  p.cables.push(createCable(nodeId, PATCH_OUT));
}

/** Right-most free spot for a new node. */
export function nextNodePosition(patch) {
  const nodes = patch?.nodes || [];
  if (!nodes.length) return { x: 150, y: 90 };
  const maxX = Math.max(...nodes.map((n) => n.x));
  const col = nodes.filter((n) => Math.abs(n.x - maxX) < NODE_W / 2);
  return { x: maxX + NODE_W + 48, y: Math.min(...col.map((n) => n.y)) };
}

/**
 * Keep an enabled patch consistent with track.fx (mutates; returns true when it changed):
 * effects added elsewhere (device panel, mixer, assistant) are inserted before OUT; nodes whose
 * effect was removed are deleted and their neighbours bridged; dangling cables are dropped.
 */
export function reconcilePatch(track) {
  if (!isPatchActive(track)) return false;
  const p = track.patch;
  if (!Array.isArray(p.cables)) p.cables = [];
  let changed = false;
  const fxIds = new Set((track.fx || []).map((f) => f.id));
  for (const n of [...p.nodes]) {
    if (n.kind === 'fx' && !fxIds.has(n.fxId)) { removeNode(track, n.id, { bridge: true }); changed = true; }
  }
  const nodeIds = new Set(p.nodes.map((n) => n.id));
  const okEnd = (id) => isTerminal(id) || nodeIds.has(id);
  const before = p.cables.length;
  p.cables = p.cables.filter((c) => okEnd(c.from.node) && okEnd(c.to.node));
  if (p.cables.length !== before) changed = true;
  const placed = new Set(p.nodes.filter((n) => n.kind === 'fx').map((n) => n.fxId));
  for (const f of track.fx || []) {
    if (placed.has(f.id)) continue;
    const pos = nextNodePosition(p);
    const n = createPatchNode('fx', { fxId: f.id, ...pos });
    p.nodes.push(n);
    insertBeforeOut(track, n.id);
    placed.add(f.id);
    changed = true;
  }
  return changed;
}

/** Fast check used before reconcilePatch (avoids a transaction when nothing is off). */
export function patchNeedsReconcile(track) {
  if (!isPatchActive(track)) return false;
  const p = track.patch;
  const fxIds = new Set((track.fx || []).map((f) => f.id));
  const placed = new Set();
  for (const n of p.nodes) {
    if (n.kind === 'fx') { if (!fxIds.has(n.fxId)) return true; placed.add(n.fxId); }
  }
  for (const id of fxIds) if (!placed.has(id)) return true;
  const ids = new Set(p.nodes.map((n) => n.id));
  return (p.cables || []).some((c) => !(isTerminal(c.from.node) || ids.has(c.from.node)) || !(isTerminal(c.to.node) || ids.has(c.to.node)));
}

/**
 * Layered left-to-right layout (mutates node x/y): column = longest path from IN.
 * Unconnected nodes go to a row below.
 */
export function autoLayout(patch) {
  const nodes = patch?.nodes || [];
  if (!nodes.length) return patch;
  const ids = new Set(nodes.map((n) => n.id));
  const depth = new Map();
  const order = topoOrder(patch);
  const incoming = new Map();
  for (const c of patch.cables) {
    if (!ids.has(c.to.node)) continue;
    if (!incoming.has(c.to.node)) incoming.set(c.to.node, []);
    incoming.get(c.to.node).push(c.from.node);
  }
  for (const id of order) {
    const preds = incoming.get(id) || [];
    if (!preds.length) { depth.set(id, -1); continue; }
    depth.set(id, 1 + Math.max(...preds.map((s) => (s === PATCH_IN ? 0 : Math.max(0, depth.get(s) ?? 0)))));
  }
  const cols = new Map();
  const loose = [];
  for (const id of order) {
    const d = depth.get(id);
    if (d < 0) { loose.push(id); continue; }
    if (!cols.has(d)) cols.set(d, []);
    cols.get(d).push(id);
  }
  const maxRows = Math.max(1, ...[...cols.values()].map((c) => c.length));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const [d, list] of cols) {
    const off = ((maxRows - list.length) * (NODE_H + 34)) / 2;
    list.forEach((id, i) => { const n = byId.get(id); n.x = 130 + (d - 1) * (NODE_W + 52); n.y = 40 + off + i * (NODE_H + 34); });
  }
  loose.forEach((id, i) => { const n = byId.get(id); n.x = 130 + i * (NODE_W + 30); n.y = 40 + maxRows * (NODE_H + 34) + 20; });
  return patch;
}

// ------------------------------------------------------------------------------- sidechain keys
/** Find the most likely drum track (role, drum instrument, or name), excluding a track id. */
export function findDrumTrack(project, excludeId) {
  const ts = (project?.tracks || []).filter((t) => t.id !== excludeId);
  return ts.find((t) => t.role === 'drums' && t.instrument?.type === 'drums')
    || ts.find((t) => t.instrument?.type === 'drums')
    || ts.find((t) => t.role === 'drums')
    || ts.find((t) => /kick|drum|beat|bd\b/i.test(t.name || ''))
    || null;
}

/** Effect types with a sidechain key input (param `sourceTrackId`: a track or bus id, '' = none / internal). */
export const KEYED_FX = new Set(['ducker', 'compressor', 'gate', 'native']); // native: plugins with a sidechain input bus

/** All sidechain key requests of the project: [{ ownerKind, ownerId, fxId, sourceTrackId }] (source: track or bus id). */
export function keyRequests(project) {
  const out = [];
  const scan = (kind, id, fx) => {
    for (const f of fx || []) {
      const src = KEYED_FX.has(f?.type) ? f.params?.sourceTrackId : null;
      if (src) out.push({ ownerKind: kind, ownerId: id, fxId: f.id, sourceTrackId: src });
    }
  };
  for (const t of project?.tracks || []) scan('track', t.id, t.fx);
  for (const b of project?.buses || []) scan('bus', b.id, b.fx);
  scan('master', 'master', project?.master?.fx);
  return out;
}

/** Audio routing edges (track → bus via sends / output / drum multi-outs) used for key-loop checks. */
function routingEdges(project) {
  const edges = [];
  for (const t of project?.tracks || []) for (const b of busesFedBy(project, t)) edges.push({ from: { node: t.id }, to: { node: b } });
  return edges;
}

/**
 * Key links the engine may build: Map(fxId -> source id). Drops self-keying, missing sources and any link that
 * would close a loop through the audio routing (track → bus) or other keys (A ducks B while B ducks A; a track
 * keyed by a bus it feeds) — in Web Audio that would be a delay-free cycle. Earlier tracks / effects win.
 */
export function resolveKeyLinks(project) {
  const ids = new Set([...(project?.tracks || []).map((t) => t.id), ...(project?.buses || []).map((b) => b.id)]);
  const edges = routingEdges(project);
  const out = new Map();
  for (const r of keyRequests(project)) {
    if (!ids.has(r.sourceTrackId)) continue;
    if (r.ownerId === r.sourceTrackId) continue;
    if (r.ownerKind !== 'master') {
      if (wouldCreateCycle(edges, r.sourceTrackId, r.ownerId)) continue;
      edges.push({ from: { node: r.sourceTrackId }, to: { node: r.ownerId } });
    }
    out.set(r.fxId, r.sourceTrackId);
  }
  return out;
}

/** Could `sourceTrackId` (track or bus) key a sidechain effect on `targetTrackId` (track or bus) without a loop? */
export function canKey(project, targetTrackId, sourceTrackId, ignoreFxId = null) {
  if (!sourceTrackId || targetTrackId === sourceTrackId) return false;
  const edges = routingEdges(project);
  const links = resolveKeyLinks(project);
  for (const r of keyRequests(project)) {
    if (r.ownerKind === 'master' || r.fxId === ignoreFxId || links.get(r.fxId) !== r.sourceTrackId) continue;
    edges.push({ from: { node: r.sourceTrackId }, to: { node: r.ownerId } });
  }
  return !wouldCreateCycle(edges, sourceTrackId, targetTrackId);
}

/** Tracks whose signal (transitively) keys a ducker on track `trackId` or on any bus/master. */
export function keySourcesFor(project, trackId) {
  const links = resolveKeyLinks(project);
  const reqs = keyRequests(project).filter((r) => links.get(r.fxId) === r.sourceTrackId);
  const out = new Set();
  const stack = [trackId];
  for (const r of reqs) if (r.ownerKind !== 'track' && !out.has(r.sourceTrackId)) { out.add(r.sourceTrackId); stack.push(r.sourceTrackId); }
  while (stack.length) {
    const id = stack.pop();
    for (const r of reqs) {
      if (r.ownerKind === 'track' && r.ownerId === id && !out.has(r.sourceTrackId)) { out.add(r.sourceTrackId); stack.push(r.sourceTrackId); }
    }
  }
  out.delete(trackId);
  return out;
}

// ------------------------------------------------------------------------------- templates
export const PATCH_TEMPLATES = [
  { id: 'ny-comp', name: 'Parallel compression (NY)', help: 'Dry signal + a heavily squashed copy blended underneath: punch and density without killing transients.' },
  { id: 'par-dist', name: 'Parallel distortion blend', help: 'Clean signal plus a driven, filtered copy — grit and harmonics while the low end stays clean.' },
  { id: 'multiband', name: 'Multiband-ish split (lowpass + highpass branches)', help: 'Split at ~250 Hz: compress the lows, widen the highs, sum them again.' },
  { id: 'reverb-split', name: 'Dry/wet reverb split', help: 'Keep the dry signal untouched and blend a 100%-wet reverb branch with its own cable level.' },
  { id: 'sidechain', name: 'Sidechain to drums', help: 'Add a Ducker keyed by the drum track: this channel dips on every kick.' },
];

/**
 * Apply a template to track (mutates track.fx + track.patch, which must exist). makeFx(type,
 * params) creates an Effect (model.createEffect). opts.drumTrackId for 'sidechain'.
 * The template is inserted at the end of the current chain (whatever fed OUT now feeds it).
 * Returns the new effects.
 */
export function applyTemplate(track, id, makeFx, opts = {}) {
  if (!track.patch) track.patch = { enabled: true, nodes: [], cables: [] };
  const p = track.patch;
  const added = [];
  const fxNode = (type, params) => {
    const f = makeFx(type, params);
    track.fx.push(f);
    added.push(f);
    const n = createPatchNode('fx', { fxId: f.id });
    p.nodes.push(n);
    return n.id;
  };
  const junction = (kind) => { const n = createPatchNode(kind); p.nodes.push(n); return n.id; };
  const cable = (a, b, gain = 1, toPort = 0) => p.cables.push(createCable(a, b, { gain, toPort }));
  const parallel = (branches) => {
    const s = junction('split');
    const m = junction('mix');
    insertBeforeOut(track, s);
    // insertBeforeOut wired s → out; re-route through the mix junction
    p.cables = p.cables.filter((c) => !(c.from.node === s && c.to.node === PATCH_OUT));
    cable(m, PATCH_OUT);
    for (const br of branches) {
      let prev = s;
      for (const step of br.chain) { const nid = fxNode(step[0], step[1]); cable(prev, nid); prev = nid; }
      cable(prev, m, br.gain ?? 1);
    }
  };
  switch (id) {
    case 'ny-comp':
      parallel([
        { chain: [], gain: 1 },
        { chain: [['compressor', { threshold: -38, ratio: 12, attack: 0.002, release: 0.09, knee: 3, makeup: 14, mix: 1 }]], gain: 0.5 },
      ]);
      break;
    case 'par-dist':
      parallel([
        { chain: [], gain: 1 },
        { chain: [['filter', { type: 'highpass', cutoff: 180, resonance: 0.8, depth: 0, mix: 1 }], ['distortion', { type: 'tube', drive: 26, tone: 4500, output: -6, mix: 1 }]], gain: 0.45 },
      ]);
      break;
    case 'multiband':
      parallel([
        { chain: [['filter', { type: 'lowpass', cutoff: 250, resonance: 0.7, slope: '24', depth: 0, mix: 1 }], ['compressor', { threshold: -24, ratio: 4, attack: 0.02, release: 0.15, makeup: 4, mix: 1 }]], gain: 1 },
        { chain: [['filter', { type: 'highpass', cutoff: 250, resonance: 0.7, slope: '24', depth: 0, mix: 1 }], ['widener', { width: 1.5 }]], gain: 1 },
      ]);
      break;
    case 'reverb-split':
      parallel([
        { chain: [], gain: 1 },
        { chain: [['reverb', { mix: 1, decay: 2.6, size: 0.7, predelay: 0.02 }]], gain: 0.35 },
      ]);
      break;
    case 'sidechain': {
      const nid = fxNode('ducker', { sourceTrackId: opts.drumTrackId || '', amount: 0.75, threshold: -20, attack: 0.004, release: 0.2 });
      insertBeforeOut(track, nid);
      break;
    }
    default:
      throw new Error(`Unknown template "${id}"`);
  }
  autoLayout(p);
  return added;
}
