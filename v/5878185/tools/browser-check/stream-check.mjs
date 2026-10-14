#!/usr/bin/env node
// Long-audio streaming in a real browser: a 10-minute synthetic WAV (click every second, double click every 10 s)
// streams through the 'daw3-stream' worklet, plays, seeks twice and stays sample-locked to the transport; the same
// clip warped (beats, 120 -> 100 BPM) streams through the warp worklet without decoding the whole file.
//   node tools/browser-check/stream-check.mjs
import { launch, serveRepo } from './browser.mjs';

const srv = await serveRepo();
const { browser, page } = await launch();
page.on('console', (m) => { if (/error|stream|warp/i.test(m.text())) console.log('  [page]', m.text().slice(0, 300)); });
let fails = 0;
const report = (ok, msg) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
try {
  await page.goto(srv.url + '/tools/browser-check/blank.html');
  for (const warp of (process.env.ONLY ? [process.env.ONLY === 'plain' ? false : process.env.ONLY] : [false, 'beats', 'tones'])) {
    const r = await page.evaluate(async ({ warp }) => {
      const H = await import('/tools/browser-check/harness.js');
      const SR = 44100, LEN = 600;
      // source: click at every whole second; double click (+80 ms) at every 10 s
      const x = new Float32Array(LEN * SR);
      const click = (i0) => { for (let j = 0; j < 400; j++) x[i0 + j] += 0.8 * Math.exp(-j / 60) * Math.sin(j * 0.7); };
      for (let s = 0; s < LEN; s++) { click(s * SR); if (s % 10 === 0) click(s * SR + Math.round(0.08 * SR)); }
      const bpm = warp ? 100 : 120; // content is 120 BPM (1 beat = 0.5 s)
      const p = H.createProject({ bpm });
      p.mode = 'song'; p.loop.enabled = false; p.master.fx = [];
      const tr = H.createTrack({ type: 'audio', name: 'Long', volume: 1 });
      p.tracks.push(tr);
      p.samples.long = H.wavSample('long', [x], SR);
      const clip = H.createClip(tr.id, { type: 'audio', sampleId: 'long', start: 0, length: LEN * 2 });
      if (warp) clip.warp = { mode: warp, markers: [{ beat: 0, sec: 0 }, { beat: LEN * 2, sec: LEN }], bpm: 120 };
      p.clips.push(clip);
      const t0 = performance.now();
      const { engine } = await H.makeEngine(p);
      const info = await engine.decodeSample('long');
      const prepMs = performance.now() - t0;
      if (warp) { const { loadWarpWorklet } = await import('/src/audio/warp/player.js'); await loadWarpWorklet(engine.ctx); }
      const spb = 60 / bpm;
      const cap = await H.captureOutput(engine.ctx, engine.graph.out);
      const segs = [];
      await engine.play({ from: 0 });
      segs.push({ beat: engine.scheduler.anchors[0].beat, time: engine.scheduler.anchors[0].time });
      await H.sleep(2600);
      for (const beat of [912, 1180]) { // 456 s / 590 s of content
        const cut = engine.ctx.currentTime;
        engine.setPosition(beat);
        segs.push({ beat, time: engine.scheduler.anchors[0].time, cut });
        await H.sleep(5200);
      }
      engine.pause();
      const { data, startTime } = await cap.stop();
      return {
        streamed: !!info?.streamed, decoded: engine.buffers.has('long'), prepMs, spb,
        segs, on: H.onsets(data, engine.ctx.sampleRate, { thresh: 0.2, gap: 0.03 }).map((t) => t + startTime),
        mode: warp, underruns: engine.streamer?.underruns, warpStats: engine.graph._warp?.stats,
      };
    }, { warp });
    // expected heard times: content second s sounds at seg.time + (beatOf(s) - seg.beat) * spb, beatOf(s) = 2 s
    const exp = [];
    r.segs.forEach((sg, i) => {
      const end = r.segs[i + 1]?.time ?? Infinity;
      for (let s = Math.ceil(sg.beat / 2); s < 600; s++) {
        const t = sg.time + (2 * s - sg.beat) * r.spb;
        if (t >= end - 0.01) break;
        // (a click on a voice's first sample sits in the 4 ms de-click fade-in)
        if (t - sg.time > 0.005) exp.push({ t, s });
        // +80 ms: unwarped 0.08 s; beats: inside its 16th slice, which plays at its own speed; tones: stretched
        if (s % 10 === 0) exp.push({ t: t + (r.mode === 'tones' ? 0.16 * r.spb : 0.08), s, dbl: true });
      }
    });
    const last = r.on[r.on.length - 1];
    const used = exp.filter((e) => e.t < last + 0.05);
    const errs = used.map((e) => Math.min(...r.on.map((t) => Math.abs(t - e.t))));
    // (the voice cut by a seek fades out over ~50 ms: ignore onsets there)
    const tol = warp === 'tones' ? 0.015 : 0.003; // WSOLA moves grains by up to ±12 ms (waveform similarity)
    const extra = r.on.filter((t) => Math.min(...exp.map((e) => Math.abs(e.t - t))) > tol + 0.001 && !r.segs.some((sg) => sg.cut != null && t >= sg.cut && t < sg.cut + 0.08)).length;
    const max = Math.max(...errs) * 1000;
    if (process.env.DEBUG) console.log(JSON.stringify({ segs: r.segs, missing: used.filter((e, i) => errs[i] > tol), on: r.on.map((t) => +t.toFixed(4)) }));
    const dbl = used.filter((e) => e.dbl).length;
    report(r.streamed && !r.decoded && used.length >= 12 && max < tol * 1000 && !extra && (!warp || r.warpStats?.worklet > 0),
      `${warp ? `warped (${warp} @100 BPM)` : 'unwarped'}: streamed=${r.streamed} fully-decoded=${r.decoded} prepare ${(r.prepMs / 1000).toFixed(1)} s; ` +
      `${used.length} expected clicks (${dbl} double) after play + 2 seeks, max error ${max.toFixed(2)} ms, unexpected ${extra}, underruns ${r.underruns}` + (warp ? ` warp=${JSON.stringify(r.warpStats)}` : ''));
  }
} finally { await browser.close(); srv.close(); }
process.exit(fails ? 1 : 0);
