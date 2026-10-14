#!/usr/bin/env node
// Strudel repair in the real app: paste the AI-chatbot "Strudel" (breakbeat fixture — TidalCycles syntax real Strudel
// rejects) into the Code tab like a user, take the default choice -> tracks appear, the summary lists the repairs,
// playback is non-silent. Then: a code track whose Apply gets repaired (banner), and an error Strudel can't run is
// shown at its real line / column with the snippet.
//   node tools/browser-check/strudel-repair-check.mjs [out-dir]
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, serveRepo, repoRoot } from './browser.mjs';

const out = process.argv[2] || '/tmp/strudel-repair-check';
mkdirSync(out, { recursive: true });
const code = readFileSync(join(repoRoot, 'tests/fixtures/strudel-split/breakbeat.strudel'), 'utf8');

const srv = await serveRepo();
const { browser, page } = await launch({ args: ['--ignore-certificate-errors'] });
await page.setViewportSize({ width: 1500, height: 900 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.message || e).slice(0, 300)));
let fails = 0;
const report = (ok, msg) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
const paste = async (text) => {
  const box = await page.$('.code-editor textarea');
  await box.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(text);
  await page.keyboard.press('Control+Enter');
};
try {
  await page.goto(srv.url + '/index.html?nowelcome');
  await page.waitForFunction(() => window.daw3?.ui?.get?.().booted, null, { timeout: 30000 });
  await page.evaluate(() => window.daw3.ui.set({ view: 'code' }));
  await page.waitForSelector('.code-editor textarea', { timeout: 10000 });
  await paste(code);
  await page.waitForSelector('.modal', { timeout: 15000 });
  const dlg = await page.evaluate(() => ({
    choices: [...document.querySelectorAll('.modal label')].map((l) => [l.textContent.trim().slice(0, 50), l.querySelector('input')?.checked]),
    repairs: document.querySelectorAll('.modal .strudel-repair').length,
    error: document.querySelector('.modal .strudel-import-error')?.textContent || '',
  }));
  report(dlg.choices[0]?.[1] === true && /Split into tracks/.test(dlg.choices[0][0]) && !dlg.error, `import dialog: default ${JSON.stringify(dlg.choices[0])}, no error, ${dlg.repairs} repairs listed`);
  await page.screenshot({ path: join(out, '0-import-dialog.png') });
  await page.click('.modal .modal-footer button:has-text("Import")');
  await page.waitForSelector('.modal-header:has-text("split into tracks")', { timeout: 60000 });
  const sum = await page.evaluate(() => ({
    head: document.querySelector('.modal .strudel-repairs > div')?.textContent || '',
    rows: [...document.querySelectorAll('.modal .strudel-repair')].map((r) => r.textContent.replace(/\s+/g, ' ').slice(0, 120)),
  }));
  report(/Repaired \d+ things/.test(sum.head) && sum.rows.length >= 8, `summary: ${sum.head}\n    ${sum.rows.join('\n    ')}`);
  await page.screenshot({ path: join(out, '1-summary.png') });
  await page.click('.modal .modal-footer button:has-text("OK")');
  const st = await page.evaluate(() => {
    const p = window.daw3.store.get();
    return {
      tracks: p.tracks.map((t) => ({ name: t.name, type: t.type, mute: t.mute, inst: t.instrument?.type, s: t.instrument?.params?.s, machine: t.instrument?.params?.machine, pan: t.pan, sends: Object.keys(t.sends || {}).length, lanes: (t.automation || []).length, code: t.code })),
      bpm: p.bpm, original: p.importedCode?.original,
    };
  });
  const inst = st.tracks.filter((t) => t.type === 'instrument');
  report(inst.length === 5, `${inst.length} instrument tracks: ${inst.map((t) => `${t.name} [${t.inst} ${t.machine || t.s} pan ${t.pan} sends ${t.sends} lanes ${t.lanes}]`).join(', ')}`);
  report(st.bpm === 156, `bpm ${st.bpm}`);
  const ct = st.tracks.find((t) => t.type === 'code');
  report(!!(ct && ct.mute && /Cm7 Fm7/.test(ct.code) && /C'min7/.test(st.original || '')), 'code track holds the repaired code; the pasted text is kept in project.importedCode.original');

  // the Song view after the import: no error, the repair banner
  await page.evaluate(() => window.daw3.ui.set({ view: 'code' }));
  await page.waitForTimeout(600);
  const songBar = await page.evaluate(() => ({ err: !document.querySelector('.code-errbar').classList.contains('hidden'), note: document.querySelector('.code-notebar:not(.hidden)')?.textContent || '' }));
  report(!songBar.err && /Repaired/.test(songBar.note), `code tab banner: ${songBar.note.slice(0, 100) || '(none)'}${songBar.err ? ' + ERROR bar' : ''}`);
  await page.screenshot({ path: join(out, '2-code-tab.png') });

  // play: non-silent
  await page.evaluate(async () => { const a = window.daw3.actions; a.setPosition?.(0); await a.play(); });
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
  await page.screenshot({ path: join(out, '3-arrange.png') });
  await page.evaluate(() => window.daw3.actions.stop());

  // a code track: Apply repairs Tidal syntax (banner), an error that can't be repaired is shown where it is
  await page.evaluate(() => {
    const { store } = window.daw3;
    const id = 'trk_repair_check';
    store.transact('test', (p) => { p.tracks.push({ ...p.tracks.find((t) => t.type === 'code'), id, name: 'scratch', mute: false, code: '' }); });
    window.daw3.ui.set({ view: 'code', selectedTrackId: id });
  });
  await page.waitForTimeout(400);
  await page.click('.code-item:has-text("scratch")');
  await page.waitForTimeout(300);
  await paste('$: note("<c3\'min7 f3\'maj7>").arp("updown").s("saw")');
  await page.waitForTimeout(800);
  const tr = await page.evaluate(() => ({ code: document.querySelector('.code-editor textarea').value, note: document.querySelector('.code-notebar:not(.hidden)')?.textContent || '', err: document.querySelector('.code-errbar:not(.hidden)')?.textContent || '' }));
  report(/\[c3,eb3,g3,bb3\]/.test(tr.code) && /"sawtooth"/.test(tr.code) && /Repaired 3 things/.test(tr.note) && !tr.err, `code track Apply repaired: ${tr.code} | ${tr.note.slice(0, 80)}`);
  await page.screenshot({ path: join(out, '4-code-track-repaired.png') });
  await paste('// a comment\nsetcps(0.5)\n\n$: s("bd*4")\n$: note("c e [g b").s("sine")');
  await page.waitForTimeout(800);
  const er = await page.evaluate(() => ({ text: document.querySelector('.code-errbar:not(.hidden)')?.textContent || '', snippet: document.querySelector('.code-errbar-snippet')?.textContent || '', line: document.querySelector('.code-editor .code-error-line, .code-editor .err, .code-gutter .err')?.textContent || '' }));
  report(/^.*Line 5:\d+/.test(er.text) && /c e \[g b/.test(er.snippet), `error bar: ${er.text.slice(0, 160)}`);
  await page.screenshot({ path: join(out, '5-error-location.png') });

  const bad = errors.filter((e) => !/favicon|net::ERR|Failed to load resource|404/.test(e));
  report(!bad.length, `console errors: ${bad.length}${bad.length ? '\n    ' + bad.slice(0, 8).join('\n    ') : ''}`);
} finally { await browser.close(); srv.close(); }
console.log(`screenshots in ${out}`);
process.exit(fails ? 1 : 0);
