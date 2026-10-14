// Crash-safe autosave / recovery / version history (memory backend, fake clock).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecovery, memoryBackend } from '../src/io/recovery.js';
import { Store } from '../src/core/store.js';
import { createProject, createTrack } from '../src/core/model.js';

function setup() {
  let t = Date.parse('2026-10-14T12:00:00Z');
  const clock = { now: () => t, tick: (ms) => { t += ms; } };
  const backend = memoryBackend();
  return { clock, backend };
}

test('snapshots are incremental: unchanged projects are skipped, samples are stored once', async () => {
  const { clock, backend } = setup();
  const rec = createRecovery({ backend, now: clock.now });
  const p = createProject({ name: 'Song' });
  p.id = 'prj_1';
  p.samples.s1 = { id: 's1', name: 'kick', mime: 'audio/wav', data: 'A'.repeat(1000) };
  const a = await rec.snapshot(p);
  assert.ok(a && a.id);
  clock.tick(1000);
  assert.equal(await rec.snapshot(p), null, 'unchanged -> no snapshot');
  p.bpm = 128;
  clock.tick(1000);
  const b = await rec.snapshot(p);
  assert.ok(b);
  assert.equal(backend._stores.samples.size, 1, 'the sample was written once');
  for (const s of backend._stores.snapshots.values()) assert.ok(!s.json.includes('AAAA'), 'snapshots carry no sample data');
  const back = await rec.loadSnapshot(b.id);
  assert.equal(back.bpm, 128);
  assert.equal(back.samples.s1.data.length, 1000);
  const old = await rec.loadSnapshot(a.id);
  assert.equal(old.bpm, 120);
});

test('version history keeps the last 20 per project and garbage-collects unreferenced samples', async () => {
  const { clock, backend } = setup();
  const rec = createRecovery({ backend, now: clock.now, maxSnapshots: 20 });
  const p = createProject({ name: 'Long session' });
  p.id = 'prj_2';
  for (let i = 0; i < 25; i++) {
    p.samples = { [`s${i}`]: { id: `s${i}`, name: `take ${i}`, data: 'x'.repeat(10 + i) } }; // a new sample each version
    p.bpm = 100 + i;
    clock.tick(10000);
    await rec.snapshot(p);
  }
  const list = await rec.listSnapshots('prj_2');
  assert.equal(list.length, 20);
  assert.equal(list[0].name, 'Long session');
  assert.ok(list[0].at > list[19].at, 'newest first');
  const newest = await rec.loadSnapshot(list[0].id);
  assert.equal(newest.bpm, 124);
  assert.equal(backend._stores.samples.size, 20, 'samples of pruned snapshots are gone');
  // other projects are untouched by pruning
  const q = createProject({ name: 'Other' });
  q.id = 'prj_3';
  await rec.snapshot(q);
  assert.equal((await rec.listSnapshots('prj_3')).length, 1);
  assert.equal((await rec.listSnapshots('prj_2')).length, 20);
});

test('crash detection: an unclean session with a stale heartbeat is offered for recovery; clean ones are not', async () => {
  const { clock, backend } = setup();
  // session 1 works on a project and "crashes" (never marks itself clean)
  const s1 = createRecovery({ backend, now: clock.now });
  const store = new Store(createProject({ name: 'Crashy' }));
  store.get().id = 'prj_c';
  s1.start(store, { intervalMs: 1e9, heartbeatMs: 1e9 });
  store.transact('Add', (p) => { p.tracks.push(createTrack({ name: 'Bass' })); });
  await s1.snapshot(store.get());
  s1.stop(false); // timers off, NOT clean (simulated crash)

  // session 2 boots right away: s1's heartbeat is still fresh -> could be another live tab, not offered
  const s2 = createRecovery({ backend, now: clock.now });
  assert.equal(await s2.findUnclean(), null);
  clock.tick(60000);
  const found = await s2.findUnclean();
  assert.ok(found);
  assert.equal(found.snapshot.name, 'Crashy');
  assert.equal(found.session.id, s1.sessionId);
  const proj = await s2.loadSnapshot(found.snapshot.id);
  assert.equal(proj.tracks[0].name, 'Bass');
  // dismissing it (or recovering) clears the offer
  await s2.dismiss(found.session.id);
  assert.equal(await s2.findUnclean(), null);

  // a session that closes normally is never offered
  const s3 = createRecovery({ backend, now: clock.now });
  await s3.snapshot(store.get(), { force: true });
  await s3.markClean();
  clock.tick(60000);
  const s4 = createRecovery({ backend, now: clock.now });
  assert.equal(await s4.findUnclean(), null);
});

test('serial writes: concurrent snapshot calls never interleave or duplicate', async () => {
  const { clock, backend } = setup();
  const rec = createRecovery({ backend, now: clock.now });
  const p = createProject();
  p.id = 'prj_s';
  const res = await Promise.all([rec.snapshot(p), rec.snapshot(p), rec.snapshot(p)]);
  assert.equal(res.filter(Boolean).length, 1);
  assert.equal(backend._stores.snapshots.size, 1);
});
