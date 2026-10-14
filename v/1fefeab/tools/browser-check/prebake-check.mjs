#!/usr/bin/env node
// Prebake in the real app: paste a song that calls helper-library functions -> the "needs a prebake" prompt ->
// add the prebake by URL in the manager -> the song is split into tracks with effects, plays non-silent; the
// Prebake ▾ menu and autocomplete list the helper functions. No console errors.
//   PREBAKE_URL=https://…/prebake.strudel node tools/browser-check/prebake-check.mjs [out-dir]
// (needs network access to PREBAKE_URL; pass the proxy with CHROME_ARGS="--proxy-server=… --proxy-bypass-list=…")
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, serveRepo } from './browser.mjs';

const URL = process.env.PREBAKE_URL;
if (!URL) { console.error('set PREBAKE_URL to a prebake .strudel file (raw URL)'); process.exit(2); }
const out = process.argv[2] || '/tmp/prebake-check';
mkdirSync(out, { recursive: true });
// a short song using common helper functions (acidenv, trancegate, dly, rlpf, chrd, trancearp)
const SONG = process.env.PREBAKE_SONG || `setcpm(140/4)
// kick
$: s("bd*4").bank("RolandTR909")
// hats
$: s("~ hh ~ hh ~ hh ~ oh").bank("RolandTR909").gain(.6)
// bass
$: note("<c2 c2 eb2 g1>*8").s("sawtooth").acidenv(.6)
// chords
$: chrd("<0:2 -2:2 3:2 1:2>").scale("c:minor").s("supersaw").trancegate(1.5, 45, 1).rlpf(.55).dly(.4)
// arp
$: n(trancearp("<0:2:4 3:5:7>", 0, 0)).scale("c4:minor").s("sawtooth").acidenv(.4).dly(.3)
`;

const srv = await serveRepo();
const extra = (process.env.CHROME_ARGS || '').split(/\s+/).filter(Boolean);
const { browser, page } = await launch({ args: ['--ignore-certificate-errors', ...extra] });
await page.setViewportSize({ width: 1500, height: 900 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.message || e).slice(0, 300)));
let fails = 0;
const report = (ok, msg) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
const shot = (name) => page.screenshot({ path: join(out, name) });
try {
  await page.goto(srv.url + '/index.html?nowelcome');
  await page.waitForFunction(() => window.daw3?.ui?.get?.().booted, null, { timeout: 30000 });
  await page.evaluate(() => window.daw3.ui.set({ view: 'code' }));
  await page.waitForSelector('.pb-btn', { timeout: 10000 });
  report(true, 'Prebake ▾ button in the Code toolbar');

  // paste the song into the Song code and apply: the helpers are undefined -> "needs a prebake" prompt
  const box = await page.$('.code-editor textarea');
  await box.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(SONG);
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('.modal-header:has-text("may need a prebake")', { timeout: 20000 });
  const nudge = await page.textContent('.pb-nudge');
  report(/aren’t defined: .*acidenv/.test(nudge) && /dly/.test(nudge), `prompt: ${nudge.slice(0, 140)}`);
  await shot('1-needs-prebake.png');
  await page.click('.modal-footer button:has-text("Add a prebake")');
  await page.waitForSelector('.pb-panel .pb-url', { timeout: 5000 });
  await page.fill('.pb-panel .pb-url', URL);
  await page.click('.pb-panel button:has-text("Add URL")');
  await page.waitForSelector('.pb-panel .pb-row', { timeout: 30000 });
  await page.waitForFunction(() => window.daw3.prebake.status().state !== 'loading', null, { timeout: 30000 });
  const st = await page.evaluate(() => { const s = window.daw3.prebake.status(); return { state: s.state, names: s.engine.names, errs: s.evalErrors.flatMap((x) => x.errors), fetch: s.fetchErrors }; });
  report(['acidenv', 'trancegate', 'dly', 'rlpf', 'chrd', 'trancearp'].every((n) => st.names.includes(n)), `prebake loaded: ${st.names.length} names (state ${st.state}; ${st.errs.length} statement errors ${JSON.stringify(st.errs).slice(0, 200)})`);
  await page.click('.pb-panel details.pb-fns summary').catch(() => {});
  await shot('2-manager.png');
  await page.click('.modal-footer button:has-text("Done")');

  // import dialog -> split into tracks (default)
  await page.waitForSelector('.modal .modal-footer button:has-text("Import")', { timeout: 20000 });
  await page.click('.modal .modal-footer button:has-text("Import")');
  await page.waitForSelector('.modal-header:has-text("split into tracks")', { timeout: 60000 });
  await shot('3-summary.png');
  await page.click('.modal .modal-footer button:has-text("OK")');
  const proj = await page.evaluate(() => {
    const p = window.daw3.store.get();
    return {
      tracks: p.tracks.map((t) => ({ name: t.name, type: t.type, inst: t.instrument?.type, params: t.instrument?.params, fx: (t.fx || []).map((f) => `${f.type}:${f.params.type || ''}:${Math.round(f.params.cutoff || 0)}`), sends: t.sends, mute: t.mute, notes: p.clips.filter((c) => c.trackId === t.id).reduce((n, c) => n + (p.patterns[c.patternId]?.notes.length || 0), 0) })),
      buses: p.buses.map((b) => ({ id: b.id, name: b.name, fb: b.fx.find((f) => f.type === 'delay')?.params.feedback })),
      prebake: p.prebake,
    };
  });
  writeFileSync(join(out, 'project.json'), JSON.stringify(proj, null, 2));
  const inst = proj.tracks.filter((t) => t.type === 'instrument');
  report(inst.length >= 5, `${inst.length} instrument tracks: ${inst.map((t) => `${t.name}(${t.notes})`).join(', ')}`);
  const bass = inst.find((t) => /bass/i.test(t.name));
  report(!!bass && bass.params?.lpenv > 0 && bass.params?.resonance === 2, `bass: acidenv -> patch lpenv ${bass?.params?.lpenv}, lpq ${bass?.params?.resonance}, lpdecay ${bass?.params?.lpdecay}`);
  const chords = inst.find((t) => /chord/i.test(t.name));
  const delayBus = proj.buses.find((b) => b.fb !== undefined && chords && chords.sends[b.id]);
  report(!!chords && chords.fx.some((f) => /^filter:lowpass:/.test(f)) && !!delayBus, `chords: ${chords?.fx.join(', ')}; delay send ${chords && delayBus ? chords.sends[delayBus.id] : '-'} (feedback ${delayBus?.fb})`);
  report(Array.isArray(proj.prebake) && proj.prebake.some((r) => r.url), `project.prebake: ${JSON.stringify(proj.prebake)}`);

  // play: non-silent
  await page.evaluate(async () => { await window.daw3.actions.play(); });
  let peak = 0;
  for (let i = 0; i < 32; i++) {
    await page.waitForTimeout(250);
    const m = await page.evaluate(() => window.daw3.engine.getMeter('master'));
    peak = Math.max(peak, m.l || 0, m.r || 0, m.peakL || 0, m.peakR || 0);
  }
  report(peak > 0.01, `plays: master peak ${peak.toFixed(3)}`);
  await page.evaluate(() => window.daw3.ui.set({ view: 'arrange' }));
  await page.waitForTimeout(500);
  await shot('4-arrange.png');
  await page.evaluate(() => window.daw3.actions.stop());

  // the original code track (muted) evaluates with the prebake: no undefined functions
  const codeOk = await page.evaluate(async () => {
    const t = window.daw3.store.get().tracks.find((x) => x.type === 'code');
    const s = await import('./src/code/strudel.js');
    const r = s.evaluate(t.code);
    return { error: r.error, warnings: r.warnings, entries: r.entries.length };
  });
  report(!codeOk.error && !codeOk.warnings.length, `code track evaluates: ${JSON.stringify(codeOk)}`);

  // Prebake ▾ menu lists the functions; autocomplete offers them
  await page.evaluate(() => window.daw3.ui.set({ view: 'code' }));
  await page.waitForTimeout(300);
  await page.click('.pb-btn');
  await page.waitForSelector('.ctx-menu', { timeout: 5000 });
  const menu = await page.textContent('.ctx-menu');
  report(/functions defined/.test(menu) && /acidenv/.test(menu), `menu: ${menu.slice(0, 160)}`);
  await shot('5-menu.png');
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 880);
  await page.evaluate(() => { const a = window.daw3.actions; const t = a.addTrack('code', { name: 'ac test' }); window.daw3.ui.set({ view: 'code', selectedTrackId: t.id }); });
  await page.waitForTimeout(400);
  const ta = await page.$('.code-editor textarea');
  await ta.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText('note("c2").s("sawtooth").');
  await page.keyboard.type('acide', { delay: 40 });
  await page.waitForSelector('.cac-pop:not(.hidden) .cac-item', { timeout: 5000 });
  const items = await page.$$eval('.cac-pop .cac-item .cac-label', (els) => els.map((e) => e.textContent).slice(0, 5));
  const doc = await page.textContent('.cac-pop .cac-doc').catch(() => '');
  report(items[0] === 'acidenv' && /prebake/.test(doc), `autocomplete: ${items.join(', ')} — ${doc.slice(0, 100)}`);
  await shot('6-autocomplete.png');
  await page.keyboard.press('Enter');
  const after = await page.$eval('.code-editor textarea', (e) => e.value);
  report(/\.acidenv\([^)]*\)/.test(after), `accepted: ${after}`);
} catch (e) {
  fails++;
  console.log('FAIL  exception:', e.message);
  await shot('error.png').catch(() => {});
} finally {
  const errs = errors.filter((e) => !/favicon|net::ERR|Failed to load resource/.test(e));
  report(!errs.length, `console errors: ${errs.length ? errs.join(' | ') : 'none'}`);
  await browser.close();
  srv.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
}
