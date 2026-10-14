#!/usr/bin/env node
// Smoke test of a packaged daW³ desktop app (CI runs it on macOS, Windows and Linux after packaging).
// Launches the built app with --remote-debugging-port, connects over CDP (playwright-core) and fails unless the
// page really booted: window.daw3.store exists, the UI rendered (no blank window), no page errors, a generated
// song has more than 5 tracks, and the native audio bridge answered. Saves a screenshot.
//
//   node scripts/smoke-electron.mjs [--app <path to the executable>] [--out <dir>] [--port 9333] [--timeout 120]
//
// Without --app the executable is found in dist/ (mac-arm64 / mac / win-unpacked / win-arm64-unpacked /
// linux-unpacked). Needs playwright-core (npm i --no-save playwright-core). Linux: run under xvfb-run.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : a), []));
const port = Number(args.port || 9333);
const timeoutMs = Number(args.timeout || 120) * 1000;
const outDir = path.resolve(String(args.out || path.join(root, 'dist', 'smoke')));
mkdirSync(outDir, { recursive: true });
const label = String(args.label || `${process.platform}-${os.arch()}`);

function findApp() {
  const dist = path.join(root, 'dist');
  const cands = process.platform === 'darwin'
    ? [`mac-${os.arch()}`, 'mac-arm64', 'mac', 'mac-universal'].map((d) => path.join(dist, d, 'daW3.app', 'Contents', 'MacOS', 'daW3'))
    : process.platform === 'win32'
      ? [os.arch() === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked', 'win-unpacked'].map((d) => path.join(dist, d, 'daW3.exe'))
      : ['linux-unpacked', `linux-${os.arch()}-unpacked`].map((d) => path.join(dist, d, 'daw3'));
  const hit = cands.find((c) => existsSync(c));
  if (!hit) throw new Error(`no packaged app found (looked for ${cands.join(', ')}); dist has: ${existsSync(dist) ? readdirSync(dist).join(', ') : '(none)'}`);
  return hit;
}

function loadPlaywright() {
  const req = createRequire(path.join(root, 'package.json'));
  for (const base of [root, process.env.PLAYWRIGHT_CORE_DIR].filter(Boolean)) {
    try { return createRequire(path.join(base, 'x.js'))('playwright-core'); } catch { /* next */ }
  }
  return req('playwright-core');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[smoke ${label}]`, ...a);

const exe = path.resolve(String(args.app && args.app !== true ? args.app : findApp()));
const userData = path.join(os.tmpdir(), `daw3-smoke-${process.pid}`);
const appArgs = [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`];
if (process.platform === 'linux') appArgs.push('--no-sandbox', '--disable-gpu');
log('launching', exe, appArgs.join(' '));
const child = spawn(exe, appArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } });
let appLog = '';
child.stdout.on('data', (d) => { appLog += d; });
child.stderr.on('data', (d) => { appLog += d; });
let exited = null;
child.on('exit', (code, sig) => { exited = { code, sig }; });

function killApp() {
  if (exited) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  } catch { /* already gone */ }
}

const result = { label, exe, ok: false, checks: {}, errors: [], consoleErrors: [] };
let browser = null;
try {
  const { chromium } = loadPlaywright();
  // wait for the DevTools endpoint
  const t0 = Date.now();
  for (;;) {
    if (exited) throw new Error(`the app exited early (${JSON.stringify(exited)})\n${appLog.slice(-4000)}`);
    try {
      // wait until the window's page exists (connecting while the app is still starting can hang)
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (r.ok && (await r.json()).some((t) => t.type === 'page' && String(t.url).startsWith('app://daw3'))) break;
    } catch { /* not up yet */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('no DevTools endpoint (the app did not start)');
    await sleep(500);
  }
  await sleep(2000);
  for (let attempt = 1; !browser; attempt++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30000 }); } catch (e) {
      if (attempt >= 4 || exited) throw e;
      log(`CDP connect attempt ${attempt} failed (${String(e.message).split('\n')[0]}), retrying`);
      await sleep(2000);
    }
  }
  let page = null;
  while (!page) {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (p.url().startsWith('app://daw3')) page = p;
    if (page) break;
    if (Date.now() - t0 > timeoutMs) throw new Error('no app://daw3 page appeared');
    await sleep(300);
  }
  page.on('pageerror', (e) => result.errors.push(String(e?.stack || e?.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') result.consoleErrors.push(m.text()); });
  // reload so every error from the boot itself is observed (the page may have booted before we attached)
  await page.reload({ waitUntil: 'load', timeout: timeoutMs });
  log('page', page.url());

  // 1. booted: the store exists and the welcome / app UI rendered (the blank-window bug fails here)
  await page.waitForFunction(() => !!window.daw3?.store, null, { timeout: timeoutMs });
  result.checks.store = true;
  const ui = await page.evaluate(() => ({
    app: document.getElementById('app')?.childElementCount || 0,
    text: (document.body?.innerText || '').trim().length,
    title: document.title,
    ua: navigator.userAgent,
    bridge: !!window.daw3Native?.isNative,
    platform: window.daw3Native?.platform || null,
    nativeAudio: !!window.daw3Native?.audio,
    nativePlugins: !!window.daw3Native?.plugins,
  }));
  result.checks.ui = ui;
  if (ui.app < 1 || ui.text < 20) throw new Error(`blank window: #app has ${ui.app} children, ${ui.text} chars of text`);
  if (!ui.bridge) throw new Error('the desktop bridge (preload: window.daw3Native) is missing');
  if (!ui.nativeAudio || !ui.nativePlugins) throw new Error('the native layer (addon + plugin host) is not in the package');

  // 2. the version shown in the app
  result.checks.version = await page.evaluate(async () => { try { return (await import('./src/version.js')).versionLabel(); } catch (e) { return `n/a (${e.message})`; } });
  const pkgVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (!String(result.checks.version).startsWith(`daW³ ${pkgVersion}`)) throw new Error(`version shown: ${result.checks.version}, package.json: ${pkgVersion}`);

  // 3. generate a song -> more than 5 tracks
  await page.keyboard.press('Escape'); // the welcome dialog
  await page.evaluate(() => window.daw3.actions.generateSong({ genre: 'house' }));
  await page.waitForFunction(() => (window.daw3.store.get().tracks || []).length > 5, null, { timeout: 60000 });
  result.checks.tracks = await page.evaluate(() => window.daw3.store.get().tracks.length);
  await sleep(1500); // let the views render the new song

  // 4. the native layer answers through the bridge (audio server utility process + addon): device list + backend
  result.checks.nativeAudio = await page.evaluate(async () => {
    const a = window.daw3Native?.audio;
    if (!a) return 'not shipped';
    try {
      const d = await a.listDevices();
      const st = await a.status();
      return { outputs: (d.outputs || []).length, inputs: (d.inputs || []).length, backend: st?.backend || st?.status?.backend || null };
    } catch (e) { return `error: ${e.message}`; }
  });
  if (typeof result.checks.nativeAudio === 'string' && result.checks.nativeAudio.startsWith('error')) throw new Error(`native audio: ${result.checks.nativeAudio}`);
  await page.keyboard.press('Escape');

  const shot = path.join(outDir, `smoke-${label}.png`);
  await page.screenshot({ path: shot });
  result.checks.screenshot = shot;

  if (result.errors.length) throw new Error(`page errors:\n${result.errors.join('\n')}`);
  result.ok = true;
  log('OK', JSON.stringify(result.checks));
} catch (e) {
  result.failure = String(e?.stack || e);
  console.error(`[smoke ${label}] FAILED:`, result.failure);
  try {
    if (browser) for (const ctx of browser.contexts()) for (const p of ctx.pages()) await p.screenshot({ path: path.join(outDir, `smoke-${label}-failed.png`) });
  } catch { /* */ }
} finally {
  if (result.consoleErrors.length) log('console errors (not fatal):', result.consoleErrors.slice(0, 20).join('\n  '));
  writeFileSync(path.join(outDir, `smoke-${label}.json`), JSON.stringify({ ...result, appLog: appLog.slice(-8000) }, null, 2));
  try { await browser?.close(); } catch { /* */ }
  killApp();
}
process.exit(result.ok ? 0 : 1);
