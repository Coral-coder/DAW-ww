#!/usr/bin/env node
// Warp worklet in a real browser: (1) a 120-BPM drum loop warped ('beats') stays on the grid at 90 / 120 / 150 BPM;
// (2) a live tempo edit while a long warped clip plays takes effect at the scheduler's next window (not at the next
// start / seek).   node tools/browser-check/warp-check.mjs
import { launch, serveRepo } from './browser.mjs';

const srv = await serveRepo();
const { browser, page } = await launch();
page.on('console', (m) => { if (/warp|error/i.test(m.text())) console.log('  [page]', m.text()); });
let fails = 0;
const report = (ok, msg) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
try {
  await page.goto(srv.url + '/tools/browser-check/blank.html');
  for (const bpm of [90, 120, 150]) {
    const r = await page.evaluate(async (bpm) => {
      const H = await import('/tools/browser-check/harness.js');
      const SR = 48000;
      const p = H.createProject({ bpm });
      p.mode = 'song'; p.loop.enabled = false;
      p.master.fx = [];
      const tr = H.createTrack({ type: 'audio', name: 'Drums', volume: 1 });
      p.tracks.push(tr);
      p.samples.loop = H.wavSample('loop', [H.drumLoop(120, 8, SR)], SR);
      const clip = H.createClip(tr.id, { type: 'audio', sampleId: 'loop', start: 0, length: 8 });
      clip.warp = { mode: 'beats', markers: [{ beat: 0, sec: 0 }, { beat: 8, sec: 4 }], bpm: 120 };
      p.clips.push(clip);
      const { engine } = await H.makeEngine(p);
      await engine.decodeSample('loop');
      const { loadWarpWorklet } = await import('/src/audio/warp/player.js');
      const wk = await loadWarpWorklet(engine.ctx);
      const cap = await H.captureOutput(engine.ctx, engine.graph.out);
      await engine.play({ from: 0 });
      const t0 = engine.scheduler.anchors[0].time;
      await H.sleep((8 * 60 / bpm) * 1000 + 400);
      engine.stop?.() ?? engine.pause();
      const { data, startTime } = await cap.stop();
      const on = H.onsets(data, engine.ctx.sampleRate).map((t) => t + startTime - t0);
      return { wk, on, stats: engine.graph._warp?.stats };
    }, bpm);
    const spb = 60 / bpm;
    const exp = Array.from({ length: 16 }, (_, k) => (k * spb) / 2);
    const errs = exp.map((e) => Math.min(...r.on.map((t) => Math.abs(t - e))));
    const max = Math.max(...errs) * 1000;
    report(r.wk && r.stats?.worklet > 0 && r.on.length === 16 && max < 3, `grid @${bpm} BPM: worklet=${r.wk} voices=${JSON.stringify(r.stats)} hits=${r.on.length}/16 max error ${max.toFixed(2)} ms`);
  }

  // live tempo edit on a long warped clip
  const r = await page.evaluate(async () => {
    const H = await import('/tools/browser-check/harness.js');
    const SR = 48000;
    const p = H.createProject({ bpm: 120 });
    p.mode = 'song'; p.loop.enabled = false; p.master.fx = [];
    const tr = H.createTrack({ type: 'audio', name: 'Drums', volume: 1 });
    p.tracks.push(tr);
    p.samples.loop = H.wavSample('loop', [H.drumLoop(120, 32, SR)], SR);
    const clip = H.createClip(tr.id, { type: 'audio', sampleId: 'loop', start: 0, length: 32 });
    clip.warp = { mode: 'beats', markers: [{ beat: 0, sec: 0 }, { beat: 32, sec: 16 }], bpm: 120 };
    p.clips.push(clip);
    const { engine, store } = await H.makeEngine(p);
    await engine.decodeSample('loop');
    const { loadWarpWorklet } = await import('/src/audio/warp/player.js');
    await loadWarpWorklet(engine.ctx);
    const cap = await H.captureOutput(engine.ctx, engine.graph.out);
    await engine.play({ from: 0 });
    const t0 = engine.scheduler.anchors[0].time;
    await H.sleep(2100);
    const b = engine.scheduler.boundary();
    store.transact('Tempo', (pr) => { pr.bpm = 80; });
    await H.sleep(3600);
    engine.pause();
    const { data, startTime } = await cap.stop();
    return { on: H.onsets(data, engine.ctx.sampleRate).map((t) => t + startTime), t0, b, stats: engine.graph._warp?.stats };
  });
  // expected heard times of 8th-note hits: 120 BPM up to the boundary beat, 80 BPM after it
  const exp = [];
  for (let k = 0; k < 64; k++) { const beat = k / 2; const t = beat < r.b.beat ? r.t0 + beat * 0.5 : r.b.time + (beat - r.b.beat) * 0.75; exp.push(t); }
  const last = r.on[r.on.length - 1];
  const used = exp.filter((t) => t <= last + 0.01);
  const errs = used.map((e) => Math.min(...r.on.map((t) => Math.abs(t - e))));
  const after = r.on.filter((t) => t > r.b.time + 0.05);
  const gaps = after.slice(1).map((t, i) => t - after[i]);
  const max = Math.max(...errs) * 1000;
  report(r.stats?.retimed > 0 && after.length >= 4 && max < 3 && gaps.every((g) => Math.abs(g - 0.375) < 0.003),
    `live tempo edit 120 -> 80 BPM at beat ${r.b.beat.toFixed(3)} (+${(r.b.time - r.t0).toFixed(3)} s): retimed=${r.stats?.retimed} hits=${r.on.length} max error ${max.toFixed(2)} ms, gaps after the edit ${gaps.map((g) => g.toFixed(3)).join(' ')}`);
} finally { await browser.close(); srv.close(); }
process.exit(fails ? 1 : 0);
