#!/usr/bin/env node
// superdough (Strudel) AudioWorklet sounds: realtime supersaw plays through its worklet; an offline render (WAV
// export path: OfflineAudioContext) uses the real worklet once it loaded in this browser, and its level matches the
// worklet-free stand-in the patch level tables were measured with.   node tools/browser-check/superdough-check.mjs
import { launch, serveRepo } from './browser.mjs';

const srv = await serveRepo();
const { browser, page } = await launch();
page.on('console', (m) => { if (/strudel|worklet/i.test(m.text())) console.log('  [page]', m.text().slice(0, 200)); });
let fails = 0;
const report = (ok, msg) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
try {
  await page.goto(srv.url + '/tools/browser-check/blank.html');
  const r = await page.evaluate(async () => {
    const { StrudelInstrument, workletsLoaded } = await import('/src/audio/strudel-instrument.js');
    const H = await import('/tools/browser-check/harness.js');
    const rms = (d, a = 0, b = d.length) => { let s = 0; for (let i = a; i < b; i++) s += d[i] * d[i]; return Math.sqrt(s / Math.max(1, b - a)); };
    const note = { s: 'supersaw', note: 45, unison: 5, detune: 0.3, spread: 0.6, gain: 0.8, attack: 0.005, release: 0.05, lpf: 4000 };
    const stand = [-0.15, 0, 0.15].map((d) => ({ ...note, s: 'sawtooth', note: 45 + d, pan: 0.5 + d * 2, gain: note.gain / Math.sqrt(3) }));
    const out = {};
    // realtime
    const ctx = new AudioContext({ sampleRate: 48000 });
    const g = ctx.createGain();
    const inst = new StrudelInstrument(ctx, g);
    const t0 = performance.now();
    await inst.whenReady({ sounds: false });
    out.rtReady = inst.ready; out.rtWorklets = workletsLoaded(ctx); out.loadMs = Math.round(performance.now() - t0);
    const cap = await H.captureOutput(ctx, g);
    const when = ctx.currentTime + 0.1;
    inst.trigger(when, note, 0.6, { cps: 0.5, hapDur: 0.3, cycle: 0 });
    await H.sleep(900);
    const rec = await cap.stop();
    const i0 = Math.round((when - rec.startTime + 0.1) * ctx.sampleRate);
    out.rtRms = rms(rec.data, i0, i0 + 0.4 * ctx.sampleRate);
    // offline: real worklet vs stand-in (3 detuned saws)
    for (const [name, vals] of [['worklet', [note]], ['stand-in', stand]]) {
      const oc = new OfflineAudioContext(2, 48000, 48000);
      const og = oc.createGain(); og.connect(oc.destination);
      const oi = new StrudelInstrument(oc, og);
      await oi.whenReady({ sounds: false });
      out[name + 'Worklets'] = workletsLoaded(oc);
      for (const v of vals) oi.trigger(0.05, v, 0.6, { cps: 0.5, hapDur: 0.3, cycle: 0 });
      await oi.flush();
      const buf = await oc.startRendering();
      out[name + 'Rms'] = Math.hypot(rms(buf.getChannelData(0), 4800, 24000), rms(buf.getChannelData(1), 4800, 24000)) / Math.SQRT2;
      oi.dispose?.();
    }
    return out;
  });
  report(r.rtReady && r.rtWorklets && r.rtRms > 0.01, `realtime supersaw: superdough ready=${r.rtReady} worklets=${r.rtWorklets} (loaded in ${r.loadMs} ms) rms=${r.rtRms?.toFixed(4)}`);
  report(r.workletWorklets && r.workletRms > 0.01, `offline render uses the real supersaw worklet: worklets=${r.workletWorklets} rms=${r.workletRms?.toFixed(4)}`);
  const dB = 20 * Math.log10(r.workletRms / r['stand-inRms']);
  report(Math.abs(dB) < 3, `worklet supersaw vs worklet-free stand-in level: ${dB.toFixed(2)} dB (patch level tables were measured with the stand-in)`);
} finally { await browser.close(); srv.close(); }
process.exit(fails ? 1 : 0);
