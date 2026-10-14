#!/usr/bin/env node
// "Split into tracks" Strudel import in the real app: paste the house sketch into the Code tab, pick the default
// (split), check the tracks / effects, play it (non-silent), screenshot arrange + mixer, and compare an offline
// render of the split project against the original code track (loudness per section).
//   node tools/browser-check/strudel-split-check.mjs [out-dir] [bars]
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, serveRepo, repoRoot } from './browser.mjs';

const out = process.argv[2] || '/tmp/strudel-split-check';
const BARS = Number(process.argv[3] || 80);
mkdirSync(out, { recursive: true });
const code = readFileSync(join(repoRoot, 'tests/fixtures/strudel-split/house.strudel'), 'utf8');

const srv = await serveRepo();
const { browser, page } = await launch({ args: ['--ignore-certificate-errors'] });
await page.setViewportSize({ width: 1500, height: 900 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.message || e).slice(0, 300)));
let fails = 0;
const report = (ok, msg) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
try {
  await page.goto(srv.url + '/index.html?nowelcome');
  await page.waitForFunction(() => window.daw3?.ui?.get?.().booted, null, { timeout: 30000 });
  // Code tab, paste the sketch (real clipboard-style insert), apply with Ctrl+Enter
  await page.evaluate(() => window.daw3.ui.set({ view: 'code' }));
  await page.waitForSelector('.code-editor, .cm-editor, textarea', { timeout: 10000 });
  const box = await page.$('.code-editor textarea, .code-editor [contenteditable], .cm-content, textarea');
  await box.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(code);
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('.modal', { timeout: 15000 });
  const choices = await page.$$eval('.modal label', (ls) => ls.map((l) => [l.textContent.trim().slice(0, 60), l.querySelector('input')?.checked]));
  report(choices[0]?.[1] === true && /Split into tracks/.test(choices[0][0]), `import dialog default: ${JSON.stringify(choices.map((c) => c[0].slice(0, 40)))}`);
  await page.click('.modal .modal-footer button:has-text("Import")');
  await page.waitForSelector('.modal-header:has-text("split into tracks")', { timeout: 60000 });
  await page.screenshot({ path: join(out, '0-summary.png') });
  await page.click('.modal .modal-footer button:has-text("OK")');
  const st = await page.evaluate(() => {
    const p = window.daw3.store.get();
    return {
      tracks: p.tracks.map((t) => ({ name: t.name, type: t.type, mute: t.mute, fx: (t.fx || []).map((f) => f.type), sends: Object.keys(t.sends || {}).length, lanes: (t.automation || []).length, inst: t.instrument?.type })),
      bpm: p.bpm, clips: p.clips.length, markers: p.markers.length, mode: p.mode, buses: p.buses.map((b) => b.name),
    };
  });
  const inst = st.tracks.filter((t) => t.type === 'instrument');
  report(inst.length >= 10, `${inst.length} instrument tracks: ${inst.map((t) => t.name).join(', ')}`);
  report(inst.reduce((n, t) => n + t.fx.length, 0) >= 6 && inst.reduce((n, t) => n + t.sends, 0) >= 8, `effects ${inst.reduce((n, t) => n + t.fx.length, 0)}, sends ${inst.reduce((n, t) => n + t.sends, 0)}, lanes ${inst.reduce((n, t) => n + t.lanes, 0)}, buses ${st.buses.join('/')}`);
  report(st.bpm === 124 && st.markers === 12 && st.mode === 'song', `bpm ${st.bpm}, ${st.markers} markers, ${st.clips} clips, mode ${st.mode}`);
  report(st.tracks.some((t) => t.type === 'code' && t.mute), 'original code kept as a muted code track');

  // play from the groove (bar 32): non-silent
  await page.evaluate(async () => { const a = window.daw3.actions; a.setPosition?.(32 * 4); await a.play(); });
  let peak = 0;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    const m = await page.evaluate(() => window.daw3.engine.getMeter('master'));
    peak = Math.max(peak, m.l || 0, m.r || 0, m.peakL || 0, m.peakR || 0);
  }
  report(peak > 0.01, `realtime playback level: peak meter ${peak.toFixed(3)}`);
  await page.evaluate(() => window.daw3.ui.set({ view: 'arrange' }));
  await page.waitForTimeout(800);
  await page.click('button:has-text("Fit")').catch(() => {});
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(out, '1-arrange.png') });
  await page.evaluate(() => window.daw3.ui.set({ view: 'mixer' }));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(out, '2-mixer.png') });
  await page.evaluate(() => window.daw3.actions.stop());

  // offline: split project vs the original code track alone, loudness per section
  const cmp = await page.evaluate(async ({ BARS }) => {
    const { renderOffline } = await import('/src/audio/render.js');
    const { measureLoudness } = await import('/src/audio/dsp/loudness.js');
    const p = JSON.parse(JSON.stringify(window.daw3.store.get()));
    const split = { ...p, tracks: p.tracks.map((t) => ({ ...t, mute: t.type === 'code' ? true : t.mute })) };
    // "fair" split: without the parts Strudel itself can't play (daW³ preset names, pads missing from the bank)
    const { splitStrudelToProject } = await import('/src/code/import-split.js');
    const { createProject } = await import('/src/core/model.js');
    const silent = splitStrudelToProject(createProject(), p.importedCode).notInStrudel || [];
    const fair = { ...split, tracks: split.tracks.map((t) => {
      const x = silent.find((q) => q.name === t.name);
      if (!x) return t;
      if (!x.pads) return { ...t, mute: true };
      const pads = { ...(t.instrument.params.pads || {}) };
      for (const k of x.pads) pads[k] = { ...(pads[k] || {}), mute: true };
      return { ...t, instrument: { ...t.instrument, params: { ...t.instrument.params, pads } } };
    }) };
    const orig = { ...p, tracks: p.tracks.filter((t) => t.type === 'code').map((t) => ({ ...t, mute: false })), clips: [], buses: p.buses };
    const sr = 44100;
    const t0 = performance.now();
    const a = await renderOffline(split, { mode: 'song', startBeat: 0, endBeat: BARS * 4, sampleRate: sr, tail: 0 });
    const t1 = performance.now();
    const b = await renderOffline(orig, { mode: 'song', startBeat: 0, endBeat: BARS * 4, sampleRate: sr, tail: 0 });
    const t2 = performance.now();
    const f = await renderOffline(fair, { mode: 'song', startBeat: 0, endBeat: BARS * 4, sampleRate: sr, tail: 0 });
    const spb = 60 / p.bpm;
    const secs = p.markers.filter((m) => m.beat < BARS * 4).map((m, i, arr) => [m.name, m.beat, Math.min(BARS * 4, arr[i + 1]?.beat ?? BARS * 4)]);
    const lufs = (buf, b0, b1) => {
      const i0 = Math.floor(b0 * spb * sr), i1 = Math.min(buf.length, Math.floor(b1 * spb * sr));
      const ch = [buf.getChannelData(0).slice(i0, i1), buf.getChannelData(1).slice(i0, i1)];
      return measureLoudness(ch, sr).integrated;
    };
    return {
      ms: [Math.round(t1 - t0), Math.round(t2 - t1)],
      whole: [lufs(a, 0, BARS * 4), lufs(b, 0, BARS * 4), lufs(f, 0, BARS * 4)],
      sections: secs.map(([n, b0, b1]) => [n, lufs(a, b0, b1), lufs(b, b0, b1), lufs(f, b0, b1)]),
      silent: silent.map((x) => `${x.name}${x.pads ? ` (${x.pads.join('/')})` : ''}`),
    };
  }, { BARS });
  const d = cmp.whole[0] - cmp.whole[1];
  const df = cmp.whole[2] - cmp.whole[1];
  console.log(`      (Strudel can't play: ${cmp.silent.join(', ') || 'nothing'} — "fair" mutes those in the split)`);
  report(Math.abs(df) <= 3, `offline ${BARS} bars: split ${cmp.whole[0].toFixed(1)} LUFS (fair ${cmp.whole[2].toFixed(1)}) vs original code ${cmp.whole[1].toFixed(1)} LUFS (Δ ${d.toFixed(1)} dB, fair Δ ${df.toFixed(1)} dB; render ${cmp.ms.join(' / ')} ms)`);
  for (const [n, x, y, z] of cmp.sections) report(Math.abs(z - y) <= 3 || !(y > -70), `  ${n.padEnd(12)} split ${x.toFixed(1)}  fair ${z.toFixed(1)}  original ${y.toFixed(1)}  fair Δ ${(z - y).toFixed(1)}`);
  const bad = errors.filter((e) => !/favicon|net::ERR|Failed to load resource|404/.test(e));
  report(!bad.length, `console errors: ${bad.length}${bad.length ? '\n    ' + bad.slice(0, 8).join('\n    ') : ''}`);
} finally { await browser.close(); srv.close(); }
console.log(`screenshots in ${out}`);
process.exit(fails ? 1 : 0);
