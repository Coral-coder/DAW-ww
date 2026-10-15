#!/usr/bin/env node
// Wavetable synth + modulation in headless Chromium:
//   1. the 'daw3-wavetable' worklet plays in an OfflineAudioContext (no fallback), notes land on time;
//   2. renderOffline of a project with a wavetable track, an LFO -> cutoff route and a macro -> volume route;
//   3. the app UI: wavetable editor + Modulation card in the device panel, drag-to-modulate onto a knob, rings.
//   node tools/browser-check/wavetable-check.mjs [--shots dir]      (exit 1 on failure)
import { launch, serveRepo } from './browser.mjs';

const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const srv = await serveRepo();
const { browser, page } = await launch();
let failed = 0;
const report = (ok, what, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  (' + extra + ')' : ''}`); if (!ok) failed++; };
page.on('pageerror', (e) => report(false, 'page error', e.message));
try {
  await page.goto(srv.url + '/tools/browser-check/blank.html');
  const r1 = await page.evaluate(async () => {
    const { WavetableInstrument } = await import('/src/audio/wavetable/engine.js');
    const { resolveInstrumentDef } = await import('/src/audio/presets.js');
    const ctx = new OfflineAudioContext(2, 48000 * 2, 48000);
    const inst = new WavetableInstrument(ctx, ctx.destination, resolveInstrumentDef({ preset: 'wt-reese' }).params, { getBpm: () => 120 });
    const ready = await inst.ready;
    inst.trigger(0.25, 45, 0.9, 0.5);
    inst.trigger(1.0, 52, 0.9, 0.5);
    await inst.flush();
    const buf = await ctx.startRendering();
    const d = buf.getChannelData(0);
    const first = d.findIndex((x) => x !== 0);
    let pk = 0; for (const x of d) pk = Math.max(pk, Math.abs(x));
    return { ready, fallback: !!inst.fallback, first, pk };
  });
  report(r1.ready && !r1.fallback, 'worklet engine starts offline (no fallback)');
  report(Math.abs(r1.first - 12000) <= 1, 'note starts on its frame', `first sample ${r1.first}`);
  report(r1.pk > 0.05 && r1.pk < 1.5, 'audible, not clipping', `peak ${r1.pk.toFixed(3)}`);

  const r2 = await page.evaluate(async () => {
    const { createProject, createTrack, createPattern, createNote, createClip } = await import('/src/core/model.js');
    const { renderOffline } = await import('/src/audio/render.js');
    const { createModState, createModulator, createRoute } = await import('/src/core/modulation.js');
    const make = (mod) => {
      const p = createProject();
      p.bpm = 120; p.mode = 'song'; p.master.fx = [];
      const t = createTrack({ type: 'instrument', name: 'WT' });
      t.instrument = { type: 'wavetable', preset: 'wt-supersaw-lead', params: { cutoff: 600, filterType: 'lp' } };
      const pat = createPattern(t.id, { length: 8 });
      pat.notes = [createNote(57, 0, 7.5, 0.9)];
      p.patterns[pat.id] = pat;
      p.tracks.push(t);
      p.clips.push(createClip(t.id, { type: 'pattern', patternId: pat.id, start: 0, length: 8 }));
      if (mod) {
        t.mod = createModState();
        t.mod.mods.push(createModulator('lfo', { id: 'l1', shape: 'square', sync: true, div: '1/2' }));
        t.mod.routes.push(createRoute('l1', 'inst:cutoff', { amount: 0.4 }));
        t.mod.macros[0].value = 0;
        t.mod.routes.push(createRoute('macro:0', 'volume', { amount: -0.5 }));
      }
      return p;
    };
    const t0 = performance.now();
    const plain = await renderOffline(make(false), { sampleRate: 48000, tail: 0.5 });
    const t1 = performance.now();
    const modded = await renderOffline(make(true), { sampleRate: 48000, tail: 0.5 });
    const t2 = performance.now();
    // brightness per half cycle: the square LFO (1/2 note = 1 s at 120 bpm) is high for 0.5 s, then low for 0.5 s
    const bright = (buf, s0, s1) => { const d = buf.getChannelData(0); let e = 0; for (let i = Math.floor(s0 * 48000) + 1; i < s1 * 48000; i++) e += (d[i] - d[i - 1]) ** 2; return Math.sqrt(e / ((s1 - s0) * 48000)); };
    return {
      plainOn: bright(plain, 1.05, 1.45), plainOff: bright(plain, 1.55, 1.95), modOn: bright(modded, 1.05, 1.45), modOff: bright(modded, 1.55, 1.95),
      msPlain: Math.round(t1 - t0), msMod: Math.round(t2 - t1),
    };
  });
  report(Math.abs(r2.plainOn / r2.plainOff - 1) < 0.35, 'unmodulated render is steady', `${r2.plainOn.toFixed(4)} / ${r2.plainOff.toFixed(4)}`);
  report(r2.modOn > r2.modOff * 1.4, 'LFO -> cutoff modulates the offline render', `${r2.modOn.toFixed(4)} / ${r2.modOff.toFixed(4)}, ${r2.msPlain} ms vs ${r2.msMod} ms`);

  // ---- UI
  await page.setViewportSize({ width: 2600, height: 950 });
  await page.goto(srv.url + '/index.html?nowelcome');
  await page.waitForFunction(() => window.daw3?.store, null, { timeout: 15000 });
  await page.evaluate(async () => {
    const app = window.daw3;
    const { createTrack } = await import('/src/core/model.js');
    const t = createTrack({ type: 'instrument', name: 'Wavetable' });
    t.instrument = { type: 'wavetable', preset: 'wt-growl-bass', params: {} };
    app.store.transact('add', (p) => { p.tracks.push(t); });
    app.ui.set({ selectedTrackId: t.id, deviceOpen: true, deviceHeight: 520 });
    window.__wt = t.id;
  });
  await page.waitForSelector('.wt-editor canvas', { timeout: 8000 });
  report(true, 'wavetable editor in the device panel');
  // open the Modulation card, add an LFO
  const folded = await page.$('.dv-mod-card .dv-folded');
  if (folded) await folded.click();
  await page.waitForSelector('.dv-mod-card .mod-empty-btns button', { timeout: 5000 });
  await page.click('.dv-mod-card .mod-empty-btns button');
  await page.waitForSelector('.dv-mod-card .mod-tab .mod-handle');
  report(true, 'Modulation card adds an LFO');
  // drag its plug onto the instrument's first position knob
  const knobSel = '.dv-instrument .knob[data-auto-target="inst:osc1Pos"]';
  await page.waitForSelector(knobSel);
  await page.$eval('.device-chain', (el) => { el.scrollLeft = 0; });
  const hb = await (await page.$('.dv-mod-card .mod-tab .mod-handle')).boundingBox();
  const kb = await (await page.$(knobSel)).boundingBox();
  if (process.env.WT_DEBUG) { console.log('handle', hb, 'knob', kb); if (shots) await page.screenshot({ path: `${shots}/wavetable-predrag.png` }); }
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(kb.x + kb.width / 2, kb.y + 12, { steps: 12 });
  await page.mouse.up();
  const routes = await page.evaluate(() => window.daw3.store.get().tracks.find((t) => t.id === window.__wt).mod?.routes || []);
  report(routes.some((r) => r.target === 'inst:osc1Pos'), 'drag-to-modulate creates a route', JSON.stringify(routes.map((r) => r.target)));
  await page.waitForTimeout(600);
  report(await page.$eval(knobSel, (el) => el.classList.contains('mod-on') && !!el.querySelector('.knob-mod')), 'modulated knob shows a ring');
  // macro row + matrix
  await page.evaluate(() => {
    const app = window.daw3;
    app.store.transact('route', (p) => { const t = p.tracks.find((x) => x.id === window.__wt); t.mod.routes.push({ id: 'mr_x', src: 'macro:0', target: 'inst:cutoff', amount: 0.5, min: 0, bipolar: false, curve: 0 }); });
  });
  await page.waitForSelector('.dv-macro-row .knob[data-auto-target="macro:0"]', { timeout: 5000 });
  report(true, 'macro row appears once a macro is mapped');
  await page.click('.dv-mod-card .mod-tab-matrix');
  await page.waitForSelector('.dv-mod-card .mod-matrix .mod-route.full select');
  report((await page.$$('.dv-mod-card .mod-matrix .mod-route.full:not(.mod-matrix-head)')).length === 2, 'matrix lists both routes');
  // play a note live: the engine starts, the processor runs, the modulation view is live
  await page.evaluate(async () => { const app = window.daw3; await app.engine.init(); app.engine.noteOn(window.__wt, 45, 0.9); });
  await page.waitForTimeout(800);
  const live = await page.evaluate(() => {
    const app = window.daw3;
    const v = app.engine.getModView(window.__wt);
    const eng = app.engine.graph.getInstrument(window.__wt)?.engine;
    app.engine.noteOff(window.__wt, 45);
    return { view: !!v && Object.keys(v.targets).length, voices: eng?.liveVoices, fallback: !!eng?.fallback, state: app.engine.ctx.state, t: app.engine.ctx.currentTime, node: !!eng?.node };
  });
  report(live.view >= 2 && !live.fallback, 'realtime: modulation view live, worklet engine running', JSON.stringify(live));
  if (shots) await page.screenshot({ path: `${shots}/wavetable-device.png` });
  // undo removes the route again
  await page.evaluate(() => window.daw3.store.undo());
  const n = await page.evaluate(() => window.daw3.store.get().tracks.find((t) => t.id === window.__wt).mod.routes.length);
  report(n === 1, 'undo', `${n} route(s) left`);
} catch (e) {
  report(false, 'check crashed', e.stack || e.message);
  if (shots) await page.screenshot({ path: `${shots}/wavetable-crash.png` }).catch(() => {});
} finally {
  await browser.close(); srv.close();
}
console.log(failed ? `${failed} check(s) failed` : 'all wavetable / modulation checks passed');
process.exit(failed ? 1 : 0);
