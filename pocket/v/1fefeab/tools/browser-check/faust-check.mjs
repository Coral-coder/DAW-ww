#!/usr/bin/env node
// Faust plugins (AudioWorklet nodes built by @grame/faustwasm): a polyphonic instrument and a stereo effect, realtime
// and offline. faustwasm loads from jsDelivr; where that is blocked, point FAUSTWASM_DIR at an unpacked
// `npm pack @grame/faustwasm@<FAUSTWASM_VERSION>` (its `package/` folder) and the CDN URLs are served from it.
// Without either the check is skipped (exit 0).   node tools/browser-check/faust-check.mjs
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { launch, serveRepo, repoRoot } from './browser.mjs';

const ver = /FAUSTWASM_VERSION = '([^']+)'/.exec(await readFile(join(repoRoot, 'src/plugins/faust.js'), 'utf8'))[1];
const base = `https://cdn.jsdelivr.net/npm/@grame/faustwasm@${ver}`;
const dir = process.env.FAUSTWASM_DIR;
if (!dir) {
  const ok = await fetch(base + '/package.json').then((r) => r.ok, () => false);
  if (!ok) { console.log(`SKIP  Faust: ${base} unreachable and FAUSTWASM_DIR not set`); process.exit(0); }
} else if (!existsSync(join(dir, 'dist/esm/index.js'))) { console.log(`SKIP  Faust: ${dir} is not an unpacked faustwasm package`); process.exit(0); }

const srv = await serveRepo();
const { browser, context, page } = await launch();
if (dir) {
  const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
  await context.route(base + '/**', async (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.slice(new URL(base).pathname.length + 1));
    try {
      const body = await readFile(join(dir, rel));
      await route.fulfill({ status: 200, body, headers: { 'content-type': types[extname(rel)] || 'application/octet-stream', 'access-control-allow-origin': '*' } });
    } catch { await route.fulfill({ status: 404, body: 'not found', headers: { 'access-control-allow-origin': '*' } }); }
  });
}
page.on('console', (m) => { if (/faust|error/i.test(m.text())) console.log('  [page]', m.text().slice(0, 200)); });
let fails = 0;
const report = (ok, msg) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
try {
  await page.goto(srv.url + '/tools/browser-check/blank.html');
  const r = await page.evaluate(async () => {
    const { FaustEngine, FaustEffect } = await import('/src/plugins/faust.js');
    const H = await import('/tools/browser-check/harness.js');
    const inst = 'import("stdfaust.lib"); freq = hslider("freq",440,20,4000,1); gain = hslider("gain",0.5,0,1,0.01); gate = button("gate"); process = os.osc(freq) * gain * en.asr(0.002, 1, 0.01, gate) * 0.5 <: _,_;';
    const fx = 'process = *(0.5), *(-1);';
    const rms = (d, a, b) => { let s = 0; for (let i = a; i < b; i++) s += d[i] * d[i]; return Math.sqrt(s / Math.max(1, b - a)); };
    const out = {};
    // realtime instrument
    const ctx = new AudioContext({ sampleRate: 48000 });
    const g = ctx.createGain();
    const eng = new FaustEngine(ctx, g, { code: inst, voices: 4, gain: 1 });
    const t0 = performance.now();
    out.rtReady = await eng.ready; out.compileMs = Math.round(performance.now() - t0); out.rtError = eng.error;
    const cap = await H.captureOutput(ctx, g);
    const when = ctx.currentTime + 0.1;
    eng.trigger(when, 69, 1, 0.5);
    await H.sleep(800);
    const rec = await cap.stop();
    const i0 = Math.round((when - rec.startTime + 0.1) * 48000);
    out.rtRms = rms(rec.data, i0, i0 + 9600);
    // pitch: zero crossings over 0.2 s
    let zc = 0; for (let i = i0 + 1; i < i0 + 9600; i++) if (rec.data[i - 1] <= 0 && rec.data[i] > 0) zc++;
    out.rtHz = zc / 0.2;
    // offline: instrument + effect in one render
    const oc = new OfflineAudioContext(2, 24000, 48000);
    const fin = oc.createGain(), fout = oc.createGain(); fout.connect(oc.destination);
    const e2 = new FaustEngine(oc, fin, { code: inst, voices: 4, gain: 1 });
    const fxn = new FaustEffect(oc, fin, fout); fxn.setParams({ code: fx });
    out.offReady = await e2.ready; out.fxReady = await fxn.ready; out.offError = e2.error || fxn.error;
    e2.trigger(0.05, 69, 1, 0.3); await e2.flush();
    const buf = await oc.startRendering();
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    out.offL = rms(L, 4800, 14400); out.offR = rms(R, 4800, 14400);
    let corr = 0; for (let i = 4800; i < 14400; i++) corr += L[i] * R[i];
    out.offPolarity = Math.sign(corr);
    return out;
  });
  report(r.rtReady && r.rtRms > 0.05 && Math.abs(r.rtHz - 440) < 10, `realtime Faust instrument: ready=${r.rtReady} (compile+node ${r.compileMs} ms) rms=${r.rtRms?.toFixed(3)} pitch≈${r.rtHz} Hz ${r.rtError || ''}`);
  report(r.offReady && r.fxReady && r.offL > 0.02 && Math.abs(r.offR / r.offL - 2) < 0.05 && r.offPolarity < 0,
    `offline Faust instrument -> effect (×0.5 / ×−1): ready=${r.offReady}/${r.fxReady} L=${r.offL?.toFixed(4)} R=${r.offR?.toFixed(4)} R/L=${(r.offR / r.offL).toFixed(3)} polarity=${r.offPolarity} ${r.offError || ''}`);
} finally { await browser.close(); srv.close(); }
process.exit(fails ? 1 : 0);
