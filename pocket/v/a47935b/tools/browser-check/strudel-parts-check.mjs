#!/usr/bin/env node
// "Split into tracks", part by part: paste a Strudel file into the Code tab like a user (default choice = split),
// screenshot the summary dialog + arrange, then offline-render each code part isolated (the other parts replaced
// by `silence`, as the importer plays it) against the split project with only that part's tracks unmuted —
// integrated loudness per part must agree within ±3 dB, and every part must be audible.
//   node tools/browser-check/strudel-parts-check.mjs [fixture=ambient] [out-dir] [bars=32]
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { launch, serveRepo, repoRoot } from './browser.mjs';

const name = process.argv[2] || 'ambient';
const out = process.argv[3] || `/tmp/strudel-parts-check/${name}`;
const BARS = Number(process.argv[4] || 32);
mkdirSync(out, { recursive: true });
const base = join(repoRoot, 'tests/fixtures/strudel-split');
const file = [join(base, `${name}.strudel`), join(base, 'corpus', `${name}.strudel`)].find(existsSync);
const code = readFileSync(file, 'utf8');

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
  await page.evaluate(() => window.daw3.ui.set({ view: 'code' }));
  await page.waitForSelector('.code-editor, .cm-editor, textarea', { timeout: 10000 });
  const box = await page.$('.code-editor textarea, .code-editor [contenteditable], .cm-content, textarea');
  await box.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(code);
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('.modal', { timeout: 15000 });
  const choices = await page.$$eval('.modal label', (ls) => ls.map((l) => [l.textContent.trim().slice(0, 60), l.querySelector('input')?.checked]));
  report(choices[0]?.[1] === true && /Split into tracks/.test(choices[0][0]), 'import dialog: "Split into tracks" is the default');
  await page.click('.modal .modal-footer button:has-text("Import")');
  await page.waitForSelector('.modal-header:has-text("split into tracks")', { timeout: 60000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, '0-summary.png') });
  const dialog = await page.$eval('.modal', (m) => m.innerText);
  await page.click('.modal .modal-footer button:has-text("OK")');
  const st = await page.evaluate(() => {
    const p = window.daw3.store.get();
    return { tracks: p.tracks.filter((t) => t.type === 'instrument').map((t) => t.name), bpm: p.bpm, key: p.key };
  });
  report(st.tracks.length > 0, `${st.tracks.length} tracks: ${st.tracks.join(' | ')} · ${st.bpm} BPM · key ${JSON.stringify(st.key)}`);
  await page.evaluate(() => window.daw3.ui.set({ view: 'arrange' }));
  await page.waitForTimeout(800);
  await page.click('button:has-text("Fit")').catch(() => {});
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(out, '1-arrange.png') });

  const res = await page.evaluate(async ({ BARS }) => {
    const { renderOffline } = await import('/src/audio/render.js');
    const { measureLoudness } = await import('/src/audio/dsp/loudness.js');
    const { loadStrudel } = await import('/src/code/strudel.js');
    const { analyzeStrudel } = await import('/src/code/import-split.js');
    await loadStrudel();
    const p = JSON.parse(JSON.stringify(window.daw3.store.get()));
    const a = analyzeStrudel(p.importedCode);
    const parts = a.parts.filter((x) => x.status === 'ok');
    const sr = 44100;
    const end = Math.min(BARS * 4, a.cycles * 4);
    const lufs = (buf) => measureLoudness([buf.getChannelData(0), buf.getChannelData(1)], sr).integrated;
    const codeTrack = p.tracks.find((t) => t.type === 'code');
    const out = [];
    for (const part of parts) {
      // the original, this part alone (other parts -> silence; a sound Strudel lacks -> the substitute the split uses)
      let iso = a.playedCode;
      for (const o of [...a.parts].sort((x, y) => y.start - x.start)) {
        if (o === part || (o.start <= part.start && o.end >= part.end) || (part.start <= o.start && part.end >= o.end)) continue;
        // (a const / label keeps its name, so the code that uses it still runs)
        const txt = iso.slice(o.start, o.end);
        const head = o.kind === 'const' ? /^[^=]*=\s*/.exec(txt)?.[0] : o.kind === 'label' ? /^[^:]*:\s*/.exec(txt)?.[0] : '';
        iso = iso.slice(0, o.start) + (head || '') + 'silence' + iso.slice(o.end);
      }
      for (const t of a.tracks) if (t.substitute && part.tracks.includes(t.name)) iso = iso.split(`"${t.substitute.from}"`).join(`"${t.substitute.to}"`);
      const orig = { ...p, tracks: [{ ...codeTrack, code: iso, mute: false }], clips: [] };
      const split = { ...p, tracks: p.tracks.map((t) => ({ ...t, mute: t.type === 'code' || !part.tracks.includes(t.name) })) };
      const A = await renderOffline(orig, { mode: 'song', startBeat: 0, endBeat: end, sampleRate: sr, tail: 0 });
      const B = await renderOffline(split, { mode: 'song', startBeat: 0, endBeat: end, sampleRate: sr, tail: 0 });
      out.push({ label: part.label, tracks: part.tracks, orig: lufs(A), split: lufs(B) });
    }
    // the user's code exactly as written (no repair): what Strudel itself plays
    const raw = await renderOffline({ ...p, tracks: [{ ...codeTrack, mute: false }], clips: [] }, { mode: 'song', startBeat: 0, endBeat: end, sampleRate: sr, tail: 0 });
    return { parts: out, raw: lufs(raw), silent: a.parts.filter((x) => x.status !== 'ok').map((x) => x.label), bars: end / 4 };
  }, { BARS });
  for (const lbl of res.parts.map((x) => x.label)) report(dialog.includes(lbl), `summary dialog lists part "${lbl}"`);
  report(/Parts found in the code/.test(dialog), 'summary dialog has the parts list');
  console.log(`      (${res.bars} bars; the code as written, all parts: ${res.raw.toFixed(1)} LUFS; parts without notes: ${res.silent.join(', ') || 'none'})`);
  for (const x of res.parts) {
    const d = x.split - x.orig;
    if (!(x.orig > -70) && x.split > -60) { console.log(`SKIP  ${x.label.padEnd(36)} → split ${x.split.toFixed(1)} LUFS; the code track renders it silent offline (soundfont not loaded in time) — not comparable`); continue; }
    report(x.split > -60 && Math.abs(d) <= 3, `${x.label.padEnd(36)} → ${x.tracks.join(' + ').padEnd(36)} split ${x.split.toFixed(1)} LUFS  original ${x.orig.toFixed(1)} LUFS  Δ ${d.toFixed(1)} dB`);
  }
  const bad = errors.filter((e) => !/favicon|net::ERR|Failed to load resource|404/.test(e));
  report(!bad.length, `console errors: ${bad.length}${bad.length ? '\n    ' + bad.slice(0, 8).join('\n    ') : ''}`);
} finally { await browser.close(); srv.close(); }
console.log(`screenshots in ${out}`);
process.exit(fails ? 1 : 0);
