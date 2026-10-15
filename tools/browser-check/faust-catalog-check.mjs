#!/usr/bin/env node
// Every Faust plugin in the catalog (src/plugins/catalog.js): compile it, start its AudioWorklet node in an
// OfflineAudioContext, play a note (instruments) or feed noise (effects) and assert the render is finite and
// audible, then start it once more in a realtime AudioContext. Every entry is tried as an instrument when it
// follows the freq/gain/gate convention and as an effect when it has audio inputs. Finally the Pocket layout
// (?mobile=1) generates a song that uses Faust effects and exports it offline: no plugin may fall back or fail.
//
//   node tools/browser-check/faust-catalog-check.mjs            # uses the faustwasm copy the app resolves
//   FAUST_ONLY=zita node tools/browser-check/faust-catalog-check.mjs   # entries whose id contains "zita"
//
// The Faust compiler is loaded the way the app loads it: the bundled vendor/faustwasm (scripts/vendor-faustwasm.sh),
// jsDelivr only when that is missing. Exit code 1 when any entry fails. Needs playwright-core + Chromium (browser.mjs).
import { launch, serveRepo } from './browser.mjs';

const only = process.env.FAUST_ONLY || '';
const srv = await serveRepo();
const { browser, page } = await launch();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || /faust/i.test(m.text())) logs.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => logs.push('pageerror: ' + String(e.message).slice(0, 300)));
let fails = 0;
const report = (ok, msg) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
try {
  await page.goto(srv.url + '/tools/browser-check/blank.html');
  const avail = await page.evaluate(async () => {
    const f = await import('/src/plugins/faust.js');
    try { const c = await f.loadFaustCompiler(); return { ok: true, version: c.version, source: c.source }; } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });
  report(avail.ok && avail.source === 'bundled', `Faust compiler: ${avail.ok ? `libfaust ${avail.version} from the ${avail.source} copy` : avail.error}`);
  if (!avail.ok) throw new Error('no compiler');
  const results = await page.evaluate(async (onlyId) => {
    const { CATALOG } = await import('/src/plugins/catalog.js');
    const { pluginParams } = await import('/src/plugins/catalog.js');
    const { FaustEngine, FaustEffect, getFaustFactory, looksPolyphonic } = await import('/src/plugins/faust.js');
    const rms = (d) => { let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i]; return Math.sqrt(s / d.length); };
    const finite = (d) => d.every(Number.isFinite);
    const out = [];
    const SR = 48000, LEN = SR * 1.5;
    for (const e of CATALOG.filter((x) => x.kind === 'faust' && x.id.includes(onlyId))) {
      const params = pluginParams(e);
      const legs = [];
      const poly = looksPolyphonic(params.code);
      if (poly) legs.push('instrument');
      const mono = await getFaustFactory(params.code, 'mono').catch((err) => ({ err }));
      if (mono.err) { out.push({ id: e.id, as: 'compile', ok: false, error: String(mono.err.message || mono.err) }); continue; }
      if (mono.inputs > 0) legs.push('effect');
      if (!legs.length) out.push({ id: e.id, as: '-', ok: false, error: 'neither an instrument (freq/gain/gate) nor an effect (no audio inputs)' });
      for (const as of legs) {
        const t0 = performance.now();
        const oc = new OfflineAudioContext(2, LEN, SR);
        const bus = oc.createGain(); bus.connect(oc.destination);
        let host;
        if (as === 'instrument') {
          host = new FaustEngine(oc, bus, { ...params, voices: 4, gain: 1 });
        } else {
          const fin = oc.createGain();
          const n = oc.createBufferSource();
          const b = oc.createBuffer(2, SR, SR);
          for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.3; }
          n.buffer = b; n.connect(fin); n.start(0.05);
          host = new FaustEffect(oc, fin, bus); host.setParams(params);
        }
        const ready = await host.ready;
        if (ready && as === 'instrument') { host.trigger(0.05, 60, 0.9, 0.6); host.trigger(0.05, 64, 0.9, 0.6); await host.flush(); }
        let L = new Float32Array(0), R = L;
        if (ready) { const buf = await oc.startRendering(); L = buf.getChannelData(0); R = buf.getChannelData(1); }
        const level = Math.max(rms(L), rms(R));
        host.dispose?.();
        // realtime: the node must start in a live AudioContext too
        const ac = new AudioContext({ sampleRate: SR });
        const g = ac.createGain(); g.gain.value = 0; g.connect(ac.destination);
        let live;
        if (as === 'instrument') live = new FaustEngine(ac, g, { ...params, voices: 4 });
        else { live = new FaustEffect(ac, ac.createGain(), g); live.setParams(params); }
        const liveReady = await live.ready;
        const liveError = live.error;
        live.dispose(); await ac.close();
        out.push({ id: e.id, name: e.name, as, ok: ready && liveReady && finite(L) && finite(R) && level > 1e-4 && level < 4, ready, liveReady, level, finite: finite(L) && finite(R), ms: Math.round(performance.now() - t0), error: host.error || liveError });
      }
    }
    return out;
  }, only);
  for (const r of results) report(r.ok, `${r.id} as ${r.as}: offline=${r.ready} realtime=${r.liveReady} level=${r.level?.toFixed?.(4)} finite=${r.finite} ${r.ms ?? ''}ms ${r.error || ''}`);
  if (!only) {
    // Pocket: a generated song with Faust effects exports (OfflineAudioContext) without plugin errors
    const pk = await browser.contexts()[0].newPage();
    await pk.setViewportSize({ width: 390, height: 844 });
    await pk.goto(srv.url + '/index.html?mobile=1');
    await pk.waitForFunction(() => !!window.daw3?.store, null, { timeout: 60000 });
    const r = await pk.evaluate(async () => {
      const app = window.daw3;
      await app.actions.generateSong({ genre: 'synthwave' });
      const p = app.store.get();
      const strips = [...p.tracks, ...(p.buses || []), p.master].filter(Boolean);
      const faust = strips.flatMap((s) => [s.instrument, ...(s.fx || [])]).filter((x) => x?.type === 'faust').map((x) => x.params.name);
      const { renderOffline } = await import('/src/audio/render.js');
      const errors = [];
      const buf = await renderOffline(app.store, { bars: 2, onError: (e) => errors.push(String(e?.message || e)) });
      const d = buf.getChannelData(0); let sum = 0; for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      return { pocket: !!app.pocket, faust, errors, rms: Math.sqrt(sum / d.length) };
    });
    report(r.pocket && r.faust.length > 0 && !r.errors.length && r.rms > 1e-3,
      `Pocket: generated song with Faust (${r.faust.join(', ')}) exports — rms=${r.rms.toFixed(4)} ${r.errors.join(' | ')}`);
  }
  if (fails && logs.length) console.log(logs.map((l) => '  [page] ' + l).join('\n'));
} finally { await browser.close(); srv.close(); }
process.exit(fails ? 1 : 0);
