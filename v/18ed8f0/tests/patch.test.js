import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  serialToPatch, patchToSerial, validateCable, connect, wouldCreateCycle, findCycle, sanitizePatch, topoOrder,
  patchFxOrder, setPatchEnabled, reconcilePatch, patchNeedsReconcile, removeNode, resolveKeyLinks, canKey, keySourcesFor,
  applyTemplate, PATCH_TEMPLATES, autoLayout, findDrumTrack, isPatchActive, inputCount, normalizePatch, patchStructureKey,
  createPatchNode, createCable,
} from '../src/core/patch.js';
import { createTrack, createEffect, createProject, normalizeProject } from '../src/core/model.js';
import { EFFECT_DEFS, resolveEffectParams } from '../src/audio/effect-defs.js';

const mkTrack = (types = ['eq3', 'compressor', 'reverb']) => createTrack({ name: 'T', fx: types.map((t) => createEffect(t)) });

/** Nodes reachable from IN and able to reach OUT (signal-carrying). */
function liveNodes(patch) {
  const fwd = new Map(), back = new Map();
  for (const c of patch.cables) {
    (fwd.get(c.from.node) || fwd.set(c.from.node, []).get(c.from.node)).push(c.to.node);
    (back.get(c.to.node) || back.set(c.to.node, []).get(c.to.node)).push(c.from.node);
  }
  const walk = (start, adj) => { const s = new Set([start]); const st = [start]; while (st.length) for (const m of adj.get(st.pop()) || []) if (!s.has(m)) { s.add(m); st.push(m); } return s; };
  const a = walk('in', fwd), b = walk('out', back);
  return new Set([...a].filter((x) => b.has(x)));
}

test('serialToPatch builds in → fx1 → fx2 → fx3 → out', () => {
  const t = mkTrack();
  const p = serialToPatch(t);
  assert.equal(p.enabled, true);
  assert.equal(p.nodes.length, 3);
  assert.deepEqual(p.nodes.map((n) => n.fxId), t.fx.map((f) => f.id));
  assert.equal(p.cables.length, 4);
  assert.equal(p.cables[0].from.node, 'in');
  assert.equal(p.cables[3].to.node, 'out');
  for (let i = 0; i < 3; i++) assert.equal(p.cables[i].to.node, p.nodes[i].id);
  assert.ok(p.cables.every((c) => c.gain === 1));
  t.patch = p;
  assert.deepEqual(patchFxOrder(t), t.fx.map((f) => f.id));
  // empty chain → in → out
  const e = serialToPatch(createTrack());
  assert.equal(e.nodes.length, 0);
  assert.deepEqual(e.cables.map((c) => [c.from.node, c.to.node]), [['in', 'out']]);
});

test('validateCable rejects cycles, self loops, bad ports and duplicates', () => {
  const t = mkTrack();
  t.patch = serialToPatch(t);
  const [a, b, c] = t.patch.nodes.map((n) => n.id);
  assert.equal(validateCable(t, { node: c }, { node: a }).ok, false); // c → a closes a loop
  assert.match(validateCable(t, { node: c }, { node: a }).reason, /loop/);
  assert.equal(validateCable(t, { node: b }, { node: b }).ok, false);
  assert.equal(validateCable(t, { node: 'out' }, { node: a }).ok, false);
  assert.equal(validateCable(t, { node: a }, { node: 'in' }).ok, false);
  assert.equal(validateCable(t, { node: 'in' }, { node: a }).ok, false); // duplicate
  assert.equal(validateCable(t, { node: 'in' }, { node: c }).ok, true); // parallel feed is fine
  assert.equal(validateCable(t, { node: a }, { node: 'out' }).ok, true); // fan-out is fine
  assert.equal(validateCable(t, { node: 'in' }, { node: b, port: 1 }).ok, false); // compressor has no key
  assert.equal(validateCable(t, { node: 'nope' }, { node: b }).ok, false);
  assert.ok(connect(t, { node: 'in' }, { node: c }, 0.5));
  assert.equal(connect(t, { node: c }, { node: b }), null);
  assert.equal(findCycle(t.patch.cables), null);
});

test('cycle helpers', () => {
  const cab = (f, to) => ({ from: { node: f }, to: { node: to } });
  const cables = [cab('in', 'a'), cab('a', 'b'), cab('b', 'c'), cab('c', 'out')];
  assert.equal(wouldCreateCycle(cables, 'c', 'a'), true);
  assert.equal(wouldCreateCycle(cables, 'a', 'c'), false);
  assert.equal(wouldCreateCycle(cables, 'x', 'x'), true);
  assert.equal(findCycle(cables), null);
  const cyc = findCycle([...cables, cab('c', 'a')]);
  assert.ok(cyc && cyc.includes('a') && cyc.includes('c'));
});

test('ducker nodes have a key input (port 1)', () => {
  const t = mkTrack(['ducker', 'eq3']);
  t.patch = serialToPatch(t);
  const [d, eq] = t.patch.nodes;
  assert.equal(inputCount(t, d.id), 2);
  assert.equal(inputCount(t, eq.id), 1);
  assert.equal(inputCount(t, 'out'), 1);
  assert.equal(inputCount(t, 'in'), 0);
  // internal key: in → eq is a new branch? (eq is after the ducker: eq → ducker.key would loop)
  assert.equal(validateCable(t, { node: eq.id }, { node: d.id, port: 1 }).ok, false);
  assert.equal(validateCable(t, { node: 'in' }, { node: d.id, port: 1 }).ok, true);
});

test('sanitizePatch drops dangling, duplicate and loop-closing cables (in order)', () => {
  const t = mkTrack(['eq3', 'compressor']);
  const p = serialToPatch(t);
  const [a, b] = p.nodes.map((n) => n.id);
  p.cables.push({ id: 'loop', from: { node: b }, to: { node: a }, gain: 1 });
  p.cables.push({ id: 'dang', from: { node: 'ghost' }, to: { node: 'out' }, gain: 1 });
  p.cables.push({ id: 'dup', from: { node: 'in' }, to: { node: a }, gain: 1 });
  p.cables.push({ id: 'badport', from: { node: 'in' }, to: { node: b, port: 1 }, gain: 1 });
  p.cables.push({ id: 'loud', from: { node: 'in' }, to: { node: 'out' }, gain: 9 });
  p.nodes.push(createPatchNode('fx', { fxId: 'missing' }));
  p.nodes.push(createPatchNode('fx', { fxId: t.fx[0].id })); // same effect twice
  const sp = sanitizePatch(p, t.fx);
  assert.equal(sp.nodes.length, 2);
  const ids = sp.cables.map((c) => c.id);
  for (const bad of ['loop', 'dang', 'dup', 'badport']) assert.ok(!ids.includes(bad), bad);
  assert.equal(sp.cables.find((c) => c.id === 'loud').gain, 2);
  assert.equal(findCycle(sp.cables), null);
  // structure key ignores gains
  const k1 = patchStructureKey(sp);
  p.cables[0].gain = 0.3;
  assert.equal(patchStructureKey(sanitizePatch(p, t.fx)), k1);
});

test('topoOrder / patchToSerial follow the signal flow', () => {
  const t = mkTrack(['eq3', 'compressor', 'reverb']);
  const [e, c, r] = t.fx;
  const n = (f, x) => createPatchNode('fx', { fxId: f.id, x, y: 0 });
  const ne = n(e, 500), nc = n(c, 100), nr = n(r, 300);
  // in → reverb → comp → eq → out, drawn in a scrambled layout
  t.patch = { enabled: true, nodes: [ne, nc, nr], cables: [createCable('in', nr.id), createCable(nr.id, nc.id), createCable(nc.id, ne.id), createCable(ne.id, 'out')] };
  assert.deepEqual(topoOrder(t.patch), [nr.id, nc.id, ne.id]);
  assert.deepEqual(patchToSerial(t).map((f) => f.type), ['reverb', 'compressor', 'eq3']);
  setPatchEnabled(t, false);
  assert.equal(t.patch.enabled, false);
  assert.equal(isPatchActive(t), false);
  assert.deepEqual(t.fx.map((f) => f.type), ['reverb', 'compressor', 'eq3']);
  // re-enabling re-uses the stored patch (same effects)
  setPatchEnabled(t, true);
  assert.equal(t.patch.nodes.length, 3);
  assert.equal(t.patch.cables.length, 4);
  // after the chain changed elsewhere it starts fresh from the serial chain
  setPatchEnabled(t, false);
  t.fx.push(createEffect('delay'));
  setPatchEnabled(t, true);
  assert.equal(t.patch.nodes.length, 4);
  assert.deepEqual(patchFxOrder(t), t.fx.map((f) => f.id));
});

test('reconcilePatch: new effects go before OUT, removed effects are bridged', () => {
  const t = mkTrack(['eq3', 'compressor', 'reverb']);
  t.patch = serialToPatch(t);
  assert.equal(patchNeedsReconcile(t), false);
  const d = createEffect('delay');
  t.fx.push(d);
  assert.equal(patchNeedsReconcile(t), true);
  assert.equal(reconcilePatch(t), true);
  assert.equal(patchNeedsReconcile(t), false);
  assert.deepEqual(patchFxOrder(t).at(-1), d.id);
  // remove the compressor: eq → reverb gets bridged
  const comp = t.fx[1].id;
  t.fx = t.fx.filter((f) => f.id !== comp);
  reconcilePatch(t);
  assert.ok(!t.patch.nodes.some((n) => n.fxId === comp));
  assert.deepEqual(patchFxOrder(t), [t.fx[0].id, t.fx[1].id, d.id]);
  const live = liveNodes(t.patch);
  assert.equal(t.patch.nodes.filter((n) => live.has(n.id)).length, 3);
  // removeNode without bridge leaves the chain open
  removeNode(t, t.patch.nodes[0].id);
  assert.ok(!liveNodes(t.patch).has('out'));
});

test('templates build valid, loop-free patches where every device carries signal', () => {
  for (const tpl of PATCH_TEMPLATES) {
    const t = mkTrack(['eq3']);
    t.patch = serialToPatch(t);
    const added = applyTemplate(t, tpl.id, (type, params) => createEffect(type, params), { drumTrackId: 'trk_drums' });
    assert.ok(added.length >= 1, tpl.id);
    for (const f of added) assert.ok(EFFECT_DEFS[f.type], `${tpl.id}: ${f.type}`);
    assert.equal(findCycle(t.patch.cables), null, tpl.id);
    const sp = sanitizePatch(t.patch, t.fx);
    assert.equal(sp.cables.length, t.patch.cables.length, `${tpl.id} all cables valid`);
    const live = liveNodes(t.patch);
    for (const n of t.patch.nodes) assert.ok(live.has(n.id), `${tpl.id}: ${n.kind} ${n.fxId || ''} is connected`);
    assert.ok(live.has('out'));
    assert.equal(patchNeedsReconcile(t), false, tpl.id);
    // the existing eq still comes first
    assert.equal(patchFxOrder(t)[0], t.fx[0].id, tpl.id);
    // layout puts nodes at distinct positions
    const pos = new Set(t.patch.nodes.map((n) => `${n.x},${n.y}`));
    assert.equal(pos.size, t.patch.nodes.length, `${tpl.id} layout`);
  }
  const t = mkTrack([]);
  t.patch = serialToPatch(t);
  applyTemplate(t, 'sidechain', (type, params) => createEffect(type, params), { drumTrackId: 'trk_x' });
  assert.equal(t.fx[0].type, 'ducker');
  assert.equal(t.fx[0].params.sourceTrackId, 'trk_x');
  assert.throws(() => applyTemplate(t, 'nope', createEffect));
});

test('autoLayout puts parallel branches in the same column', () => {
  const t = mkTrack([]);
  t.patch = serialToPatch(t);
  applyTemplate(t, 'reverb-split', (type, params) => createEffect(type, params));
  autoLayout(t.patch);
  const split = t.patch.nodes.find((n) => n.kind === 'split');
  const mix = t.patch.nodes.find((n) => n.kind === 'mix');
  const rev = t.patch.nodes.find((n) => n.kind === 'fx');
  assert.ok(split.x < rev.x && rev.x < mix.x);
});

test('sidechain key links skip self-keying, missing tracks and loops', () => {
  const p = createProject();
  const kick = createTrack({ name: 'Kick', role: 'drums', instrument: { type: 'drums', preset: '808', params: {} } });
  const bass = createTrack({ name: 'Bass' });
  const pad = createTrack({ name: 'Pad' });
  p.tracks = [bass, pad, kick]; // earlier tracks win: the kick's loop-closing ducker is dropped
  const dk = (src) => createEffect('ducker', { sourceTrackId: src });
  bass.fx = [dk(kick.id)];
  pad.fx = [dk(bass.id), dk(pad.id), dk('ghost')];
  kick.fx = [dk(pad.id)]; // pad → kick → bass → pad would loop
  const links = resolveKeyLinks(p);
  assert.equal(links.get(bass.fx[0].id), kick.id);
  assert.equal(links.get(pad.fx[0].id), bass.id);
  assert.equal(links.has(pad.fx[1].id), false);
  assert.equal(links.has(pad.fx[2].id), false);
  assert.equal(links.has(kick.fx[0].id), false);
  assert.equal(canKey(p, kick.id, pad.id), false);
  assert.equal(canKey(p, pad.id, kick.id), true);
  assert.equal(canKey(p, bass.id, bass.id), false);
  // stems: pad's stem needs bass and (transitively) kick as silent keys
  assert.deepEqual([...keySourcesFor(p, pad.id)].sort(), [bass.id, kick.id].sort());
  assert.deepEqual([...keySourcesFor(p, kick.id)], []);
  // bus duckers make their key a source for every stem
  p.buses[0].fx.push(dk(kick.id));
  assert.ok(keySourcesFor(p, pad.id).has(kick.id));
  assert.equal(findDrumTrack(p, bass.id).id, kick.id);
  assert.equal(findDrumTrack({ tracks: [bass] }, null), null);
});

test('model + effect defs integration', () => {
  const t = mkTrack(['eq3']);
  t.patch = serialToPatch(t);
  const p = normalizeProject({ tracks: [t, createTrack()] });
  assert.ok(p.tracks[0].patch.enabled);
  assert.equal(p.tracks[0].patch.nodes.length, 1);
  assert.equal('patch' in p.tracks[1], false);
  assert.equal(normalizePatch(null), null);
  const r = resolveEffectParams({ type: 'ducker', params: { sourceTrackId: 'trk_1', amount: 5 } });
  assert.equal(r.sourceTrackId, 'trk_1');
  assert.equal(r.amount, 1);
  assert.equal(resolveEffectParams({ type: 'ducker', params: {} }).sourceTrackId, '');
  assert.equal(EFFECT_DEFS.ducker.category, 'Dynamics');
});
