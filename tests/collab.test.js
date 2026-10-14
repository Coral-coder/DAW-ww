import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Doc, LocalHistory, deepEqual } from '../src/collab/crdt.js';
import { HLC } from '../src/collab/hlc.js';
import { CollabBridge, toDocJson } from '../src/collab/bridge.js';
import { sha256, chunkSample, ChunkAssembler, hashSampleData } from '../src/collab/samples.js';
import { encodeSignal, decodeSignal } from '../src/collab/invite.js';
import { diffProjects, summarizeDiff } from '../src/collab/diff.js';
import { reconcileObject } from '../src/collab/reconcile.js';
import { Store } from '../src/core/store.js';
import { createProject, createTrack, createPattern, createNote, createClip, createEffect } from '../src/core/model.js';
import { createRng } from '../src/core/util.js';
import { arrayBufferToBase64 } from '../src/io/samples.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

function baseProject() {
  const p = createProject({ name: 'Fuzz' });
  for (const name of ['Drums', 'Bass', 'Keys']) {
    const t = createTrack({ name, fx: [createEffect('eq3')] });
    const pat = createPattern(t.id, { notes: [createNote(36, 0), createNote(38, 1), createNote(42, 1.5)] });
    p.tracks.push(t);
    p.patterns[pat.id] = pat;
    t.activePatternId = pat.id;
    p.clips.push(createClip(t.id, { patternId: pat.id, start: 0, length: 4 }));
  }
  delete p.samples; // doc JSON (samples handled by the bridge)
  delete p.modifiedAt;
  return p;
}

let nid = 0;
const fresh = (pre) => `${pre}_fz${++nid}`;

/** Random local edit of a project JSON (mutates). */
function mutate(p, rng) {
  const tracks = p.tracks;
  const pats = Object.values(p.patterns);
  const r = rng.int(0, 16);
  const t = tracks.length ? rng.pick(tracks) : null;
  const pat = pats.length ? rng.pick(pats) : null;
  switch (r) {
    case 0: p.bpm = rng.int(60, 180); break;
    case 1: if (t) t.name = `T${rng.int(0, 999)}`; break;
    case 2: if (t) t.volume = Math.round(rng() * 100) / 100; break;
    case 3: { const nt = { ...createTrack({ name: 'New' }), id: fresh('trk') }; tracks.splice(rng.int(0, tracks.length), 0, nt); break; }
    case 4: if (tracks.length > 1) { const i = rng.int(0, tracks.length - 1); const [x] = tracks.splice(i, 1); p.clips = p.clips.filter((c) => c.trackId !== x.id); } break;
    case 5: if (tracks.length > 1) { const i = rng.int(0, tracks.length - 1); const [x] = tracks.splice(i, 1); tracks.splice(rng.int(0, tracks.length), 0, x); } break;
    case 6: if (pat) pat.notes.splice(rng.int(0, pat.notes.length), 0, { ...createNote(rng.int(30, 90), rng.int(0, 15) / 4), id: fresh('n') }); break;
    case 7: if (pat && pat.notes.length) pat.notes.splice(rng.int(0, pat.notes.length - 1), 1); break;
    case 8: if (pat && pat.notes.length) { const n = rng.pick(pat.notes); n.pitch = rng.int(30, 90); n.start = rng.int(0, 15) / 4; } break;
    case 9: if (t) p.clips.push({ ...createClip(t.id, { start: rng.int(0, 32) }), id: fresh('clip') }); break;
    case 10: if (p.clips.length) p.clips.splice(rng.int(0, p.clips.length - 1), 1); break;
    case 11: if (t) t.sends[rng.pick(p.buses).id] = Math.round(rng() * 100) / 100; break;
    case 12: if (t) { const k = Object.keys(t.sends); if (k.length) delete t.sends[rng.pick(k)]; } break;
    case 13: if (t) { if (t.patch) delete t.patch; else t.patch = { enabled: rng.chance(0.5), nodes: [], cables: [] }; } break;
    case 14: if (t) t.automation = [{ id: t.automation[0]?.id || fresh('al'), target: 'volume', enabled: true, points: [{ beat: 0, value: rng() }, { beat: 4, value: rng() }] }]; break;
    case 15: if (t) { const np = { ...createPattern(t.id), id: fresh('pat') }; p.patterns[np.id] = np; } break;
    case 16: if (pats.length > 1 && pat) delete p.patterns[pat.id]; break;
    default: break;
  }
}

test('hlc: monotonic, observes remote clocks, unique per replica', () => {
  let wall = 1000;
  const a = new HLC('A', () => wall), b = new HLC('B', () => wall);
  const t1 = a.tick(), t2 = a.tick();
  assert.ok(t2 > t1);
  wall = 500; // clock went backwards
  const t3 = a.tick();
  assert.ok(t3 > t2);
  b.observe(t3);
  assert.ok(b.tick() > t3);
});

test('crdt: concurrent op streams converge (3 replicas, reorder + duplication fuzz)', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const rng = createRng(seed * 7919);
    const reps = ['A', 'B', 'C'].map((id) => {
      const doc = new Doc(id);
      return { id, doc, hist: new LocalHistory(doc, { now: () => 0 }) };
    });
    const seedOps = reps[0].doc.commit(baseProject()).ops;
    reps[1].doc.applyOps(seedOps);
    reps[2].doc.applyOps(clone(seedOps).reverse());
    assert.deepEqual(reps[1].doc.view(), reps[0].doc.view());
    const queue = [];
    const send = (from, ops) => {
      for (const r of reps) {
        if (r === from) continue;
        queue.push({ to: r, ops: clone(ops) });
        if (rng.chance(0.2)) queue.push({ to: r, ops: clone(ops) }); // duplicate delivery
      }
    };
    for (let step = 0; step < 120; step++) {
      if (queue.length && rng.chance(0.45)) {
        const m = queue.splice(rng.int(0, queue.length - 1), 1)[0]; // random order
        m.to.doc.applyOps(rng.chance(0.3) ? [...m.ops].reverse() : m.ops);
        continue;
      }
      const r = rng.pick(reps);
      if (rng.chance(0.12) && r.hist.canUndo()) { send(r, r.hist.undo().ops); continue; }
      const next = clone(r.doc.view());
      mutate(next, rng);
      const { ops, inverse } = r.doc.commit(next);
      assert.ok(deepEqual(r.doc.view(), JSON.parse(JSON.stringify(next))), `seed ${seed}: local commit reproduces the edit`);
      r.hist.record('edit', inverse);
      send(r, ops);
    }
    while (queue.length) { const m = queue.shift(); m.to.doc.applyOps(m.ops); }
    assert.deepEqual(reps[1].doc.view(), reps[0].doc.view(), `seed ${seed}: B == A`);
    assert.deepEqual(reps[2].doc.view(), reps[0].doc.view(), `seed ${seed}: C == A`);
    // state-based sync reaches the same point too
    const late = new Doc('D');
    late.mergeState(clone(reps[1].doc.state()));
    assert.deepEqual(late.view(), reps[0].doc.view());
  }
});

test('crdt: delete vs concurrent edit, add-wins re-add, concurrent inserts keep both', () => {
  const a = new Doc('A'), b = new Doc('B');
  b.applyOps(a.commit(baseProject()).ops);
  const pa = clone(a.view()), pb = clone(b.view());
  const tid = pa.tracks[0].id;
  pa.tracks.splice(0, 1); // A deletes the track
  pb.tracks[0].name = 'Renamed by B'; // B edits it concurrently
  pb.tracks.push({ ...createTrack({ name: 'B new' }), id: 'trk_b' });
  pa.tracks.push({ ...createTrack({ name: 'A new' }), id: 'trk_a' });
  const oa = a.commit(pa).ops, ob = b.commit(pb).ops;
  a.applyOps(ob); b.applyOps(oa);
  assert.deepEqual(a.view(), b.view());
  assert.ok(!a.view().tracks.some((t) => t.id === tid), 'observed-remove deletes the track');
  assert.ok(a.view().tracks.some((t) => t.id === 'trk_a') && a.view().tracks.some((t) => t.id === 'trk_b'));
});

test('undo reverts only your own ops', () => {
  const a = new Doc('A'), b = new Doc('B');
  const ha = new LocalHistory(a, { now: () => 0 });
  b.applyOps(a.commit(baseProject()).ops);
  // A adds a note and renames the project; B changes tempo and later overrides the name.
  const pa = clone(a.view());
  const pat = Object.values(pa.patterns)[0];
  pat.notes.push({ id: 'n_mine', pitch: 60, start: 2, dur: 0.5, vel: 0.9 });
  pa.name = 'A name';
  const c1 = a.commit(pa); ha.record('Add note', c1.inverse);
  b.applyOps(c1.ops);
  const pb = clone(b.view());
  pb.bpm = 99;
  pb.name = 'B name';
  const c2 = b.commit(pb);
  a.applyOps(c2.ops);
  const u = ha.undo();
  b.applyOps(u.ops);
  const v = a.view();
  assert.deepEqual(v, b.view());
  assert.ok(!v.patterns[pat.id].notes.some((n) => n.id === 'n_mine'), 'own note removed');
  assert.equal(v.bpm, 99, "B's tempo survives A's undo");
  assert.equal(v.name, 'B name', "B's later rename is not clobbered");
  const r = ha.redo();
  b.applyOps(r.ops);
  assert.ok(a.view().patterns[pat.id].notes.some((n) => n.id === 'n_mine'), 'redo restores the note');
  assert.deepEqual(a.view(), b.view());
});

test('bridge: store edits become ops, remote ops reconcile in place, Ctrl+Z is local', () => {
  const p = createProject({ name: 'Bridge' });
  const t = createTrack({ name: 'Lead' });
  p.tracks.push(t);
  const sa = new Store(p), sb = new Store(createProject({ name: 'Other' }));
  const A = new CollabBridge(sa, { replica: 'A' }), B = new CollabBridge(sb, { replica: 'B' });
  A.attach(); B.attach();
  A.seed();
  B.adopt(clone(A.doc.state()));
  assert.equal(sb.get().name, 'Bridge');
  A.on('ops', (ops) => B.applyRemote(clone(ops)));
  B.on('ops', (ops) => A.applyRemote(clone(ops)));
  const trackObj = sb.get().tracks[0];
  sa.transact('Rename', (pp) => { pp.tracks[0].name = 'Lead 2'; });
  assert.equal(sb.get().tracks[0].name, 'Lead 2');
  assert.equal(sb.get().tracks[0], trackObj, 'object identity kept');
  sb.transact('Tempo', (pp) => { pp.bpm = 140; });
  sa.transact('Metronome', (pp) => { pp.metronome = true; }, { undo: false });
  assert.equal(sb.get().metronome, false, 'metronome stays local');
  assert.equal(sa.get().bpm, 140);
  sa.undo(); // undo A's rename only
  assert.equal(sa.get().tracks[0].name, 'Lead');
  assert.equal(sb.get().tracks[0].name, 'Lead');
  assert.equal(sa.get().bpm, 140);
  assert.deepEqual(toDocJson(sa.get()), toDocJson(sb.get()));
});

test('bridge: samples are shared by hash and arrive on demand', () => {
  const bytes = new Uint8Array(70000).map((_, i) => (i * 31) & 255);
  const data = arrayBufferToBase64(bytes);
  const sa = new Store(createProject()), sb = new Store(createProject());
  const A = new CollabBridge(sa, { replica: 'A' }), B = new CollabBridge(sb, { replica: 'B' });
  A.attach(); B.attach(); A.seed(); B.adopt(clone(A.doc.state()));
  const needs = [];
  B.on('need-sample', (hash) => needs.push(hash));
  A.on('ops', (ops) => B.applyRemote(clone(ops)));
  B.on('ops', (ops) => A.applyRemote(clone(ops)));
  sa.transact('Import', (p) => { p.samples.s1 = { id: 's1', name: 'loop.wav', mime: 'audio/wav', data, duration: 1 }; });
  assert.equal(needs.length, 1);
  assert.equal(needs[0], hashSampleData(data));
  assert.ok(!sb.get().samples.s1, 'not materialized before the bytes arrive');
  sb.transact('Unrelated', (p) => { p.bpm = 100; });
  assert.ok(sa.get().samples.s1, 'pending sample is not deleted by peers');
  const asm = new ChunkAssembler();
  const chunks = chunkSample(needs[0], A.getSample(needs[0]), 4096);
  assert.ok(chunks.length > 5);
  let res;
  for (const c of [...chunks].reverse()) res = asm.add(clone(c)); // out of order
  assert.ok(res.done && res.ok);
  B.receiveSample(needs[0], res.data);
  assert.equal(sb.get().samples.s1.data, data);
  assert.equal(sb.get().samples.s1.hash, undefined);
});

test('samples: sha256 known vectors, chunk integrity check', () => {
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256('a'.repeat(1000)), '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
  const data = arrayBufferToBase64(new Uint8Array(5000).map((_, i) => i & 255));
  const hash = hashSampleData(data);
  const asm = new ChunkAssembler();
  const chunks = chunkSample(hash, data, 1000);
  chunks[2] = { ...chunks[2], d: chunks[2].d.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) }; // corrupt
  let r;
  for (const c of chunks) r = asm.add(c);
  assert.equal(r.done, true);
  assert.equal(r.ok, false, 'corrupted transfer is rejected');
});

test('invite codes: encode/decode round trip, compact, rejects junk', async () => {
  const sdp = 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\na=extmap-allow-mixed\r\na=msid-semantic: WMS\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host generation 0 network-id 1\r\na=candidate:2 1 udp 1686052607 203.0.113.7 54321 typ srflx raddr 192.168.1.20 rport 54321 generation 0 network-id 1\r\na=ice-ufrag:abcd\r\na=ice-pwd:0123456789abcdefghijklmn\r\na=ice-options:trickle\r\na=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99\r\na=setup:actpass\r\na=mid:0\r\na=sctp-port:5000\r\na=max-message-size:262144\r\n';
  const sig = { t: 'offer', from: 'peerA', name: 'Alex', session: 'ses_1', slot: 'slot_1', sdp };
  const code = await encodeSignal(sig);
  assert.match(code, /^daw3:[A-Za-z0-9_-]+$/);
  assert.ok(code.length < sdp.length, `compressed (${code.length} < ${sdp.length})`);
  assert.deepEqual(await decodeSignal(code), sig);
  assert.deepEqual(await decodeSignal(`  ${code}\n`), sig, 'whitespace tolerant');
  await assert.rejects(() => decodeSignal('daw3:not-a-code'));
  await assert.rejects(() => decodeSignal('hello'));
});

test('versions: snapshot diff lists track / clip / note / param changes', () => {
  const a = createProject({ name: 'V' });
  const t = createTrack({ name: 'Bass' });
  const pat = createPattern(t.id, { notes: [createNote(40, 0), createNote(43, 1)] });
  a.tracks.push(t); a.patterns[pat.id] = pat; a.clips.push(createClip(t.id, { patternId: pat.id }));
  const b = clone(a);
  b.bpm = 128;
  b.tracks[0].volume = 0.5;
  b.tracks[0].name = 'Sub Bass';
  b.patterns[pat.id].notes[0].pitch = 41;
  b.patterns[pat.id].notes.push({ id: 'n_new', pitch: 50, start: 2, dur: 1, vel: 1 });
  b.patterns[pat.id].notes.splice(1, 1);
  b.clips[0].start = 8;
  const lead = createTrack({ name: 'Lead' });
  b.tracks.push(lead);
  const d = diffProjects(a, b);
  assert.deepEqual(d.project.map((c) => c.key), ['bpm']);
  assert.deepEqual(d.tracks.added.map((x) => x.name), ['Lead']);
  const mod = d.tracks.changed.find((x) => x.id === t.id);
  assert.ok(mod.fields.some((f) => f.key === 'volume') && mod.fields.some((f) => f.key === 'name'));
  assert.equal(d.clips.changed.length, 1);
  const pd = d.patterns.changed.find((x) => x.id === pat.id);
  assert.equal(pd.notes.added, 1);
  assert.equal(pd.notes.removed, 1);
  assert.equal(pd.notes.changed, 1);
  const s = summarizeDiff(d);
  assert.match(s, /1 track added/);
  assert.match(s, /notes/);
  assert.equal(summarizeDiff(diffProjects(a, clone(a))), 'No changes');
});

test('reconcile keeps identities and matches the source', () => {
  const target = { a: 1, list: [{ id: 'x', v: 1 }, { id: 'y', v: 2 }], o: { k: 1 }, gone: true };
  const x = target.list[0];
  reconcileObject(target, { a: 2, list: [{ id: 'y', v: 3 }, { id: 'x', v: 1 }, { id: 'z', v: 0 }], o: { k: 2 } });
  assert.deepEqual(target, { a: 2, list: [{ id: 'y', v: 3 }, { id: 'x', v: 1 }, { id: 'z', v: 0 }], o: { k: 2 } });
  assert.equal(target.list[1], x);
});
