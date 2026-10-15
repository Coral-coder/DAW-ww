#!/usr/bin/env node
// Smoke test of a packaged daW³ desktop app (CI runs it on macOS, Windows and Linux after packaging).
// Launches the built app with --remote-debugging-port, connects over CDP (playwright-core) and fails unless the
// page really booted: window.daw3.store exists, the UI rendered (no blank window), no page errors, a generated
// song has more than 5 tracks, the native audio bridge answered, and a catalog Faust effect loads from the compiler
// bundled in the package (live and offline, no network needed). Saves a screenshot.
//
//   node scripts/smoke-electron.mjs [--app <path to the executable>] [--out <dir>] [--port 9333] [--timeout 120] [--test-plugins <dir>]
//
// --test-plugins: a folder with the built daW3TestGain.vst3 / .clap (desktop/native/build). They are installed in the
// user plug-in folders (removed again afterwards) and must be found, load and process audio; macOS adds a quarantined
// copy (the quarantine fix must be shown, also in Plugins › Native) and an Intel-only copy (Rosetta plugin host).
//
// Without --app the executable is found in dist/ (mac-arm64 / mac / win-unpacked / win-arm64-unpacked /
// linux-unpacked). Needs playwright-core (npm i --no-save playwright-core). Linux: run under xvfb-run.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, cpSync, renameSync } from 'node:fs';
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

// --test-plugins <dir with daW3TestGain.vst3 / .clap>: install the built test plugins in the user plug-in folders
// before launch (the first-launch scan must find them), then scan, load and process audio through each one. macOS
// also gets a quarantined copy (the quarantine fix must be reported) and an Intel-only (x86_64) copy (Rosetta host).
const testPluginsDir = args['test-plugins'] && args['test-plugins'] !== true ? path.resolve(String(args['test-plugins'])) : null;
const installed = [];
function userPluginDirs() {
  const home = os.homedir();
  if (process.platform === 'darwin') return { vst3: path.join(home, 'Library/Audio/Plug-Ins/VST3'), clap: path.join(home, 'Library/Audio/Plug-Ins/CLAP') };
  if (process.platform === 'win32') {
    const base = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'Common');
    return { vst3: path.join(base, 'VST3'), clap: path.join(base, 'CLAP') };
  }
  return { vst3: path.join(home, '.vst3'), clap: path.join(home, '.clap') };
}
function installTestPlugins() {
  const dirs = userPluginDirs();
  const put = (src, dir, name) => {
    mkdirSync(dir, { recursive: true });
    const dst = path.join(dir, name);
    rmSync(dst, { recursive: true, force: true });
    cpSync(src, dst, { recursive: true });
    installed.push(dst);
    return dst;
  };
  const out = { vst3: put(path.join(testPluginsDir, 'daW3TestGain.vst3'), dirs.vst3, 'daW3TestGain.vst3'), clap: put(path.join(testPluginsDir, 'daW3TestGain.clap'), dirs.clap, 'daW3TestGain.clap') };
  if (process.platform === 'darwin') {
    // a downloaded, non-notarized copy: Gatekeeper's quarantine flag on the bundle and its binary
    out.quarantined = put(path.join(testPluginsDir, 'daW3TestGain.clap'), dirs.clap, 'daW3TestGainQuarantined.clap');
    const flag = `0081;${Math.floor(Date.now() / 1000).toString(16)};Safari;`;
    execFileSync('/usr/bin/find', [out.quarantined, '-exec', '/usr/bin/xattr', '-w', 'com.apple.quarantine', flag, '{}', ';']);
    // an Intel-only copy (x86_64 slice only), as many older plugins ship: scanned + served by the Rosetta host
    const intel = path.join(os.tmpdir(), `daw3-smoke-intel-${process.pid}`, 'daW3TestGainIntel.vst3');
    rmSync(path.dirname(intel), { recursive: true, force: true });
    mkdirSync(path.dirname(intel), { recursive: true });
    cpSync(path.join(testPluginsDir, 'daW3TestGain.vst3'), intel, { recursive: true });
    const bin = path.join(intel, 'Contents', 'MacOS', 'daW3TestGain');
    try {
      execFileSync('/usr/bin/lipo', [bin, '-thin', 'x86_64', '-output', `${bin}.x64`]);
      renameSync(`${bin}.x64`, bin);
      try { execFileSync('/usr/bin/codesign', ['-f', '-s', '-', intel], { stdio: 'ignore' }); } catch { /* unsigned is fine under Rosetta */ }
      out.intelSrc = intel;
    } catch (e) { log(`no Intel-only copy (${String(e.message).split('\n')[0]})`); }
  }
  log('installed test plugins', JSON.stringify(out));
  return out;
}
const testPlugins = testPluginsDir ? installTestPlugins() : null;

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
  // Playwright parks new AudioWorklet threads waiting for a debugger and never resumes them (see
  // tools/browser-check/browser.mjs enableWorklets): auto-attach worklet targets and detach at once to release them
  const cdp = await page.context().newCDPSession(page);
  cdp.on('Target.attachedToTarget', (e) => { cdp.send('Target.detachFromTarget', { sessionId: e.sessionId }).catch(() => {}); });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'worklet' }] });
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

  // 5. a catalog Faust effect compiles with the bundled compiler and runs live and in an offline render
  result.checks.faust = await page.evaluate(async () => {
    const f = await import('./src/plugins/faust.js');
    const { getCatalogEntry, pluginParams } = await import('./src/plugins/catalog.js');
    const params = pluginParams(getCatalogEntry('faust-zita-reverb'));
    const out = {};
    try { out.source = (await f.loadFaustCompiler()).source; } catch (e) { return { error: String(e?.message || e) }; }
    const engine = window.daw3.engine;
    await engine.init();
    const live = new f.FaustEffect(engine.ctx, engine.ctx.createGain(), engine.ctx.createGain());
    live.setParams(params);
    out.live = await live.ready;
    out.liveError = live.error;
    live.dispose();
    const oc = new OfflineAudioContext(2, 24000, 48000);
    const src = oc.createOscillator(); const fin = oc.createGain(); src.connect(fin); src.start();
    const off = new f.FaustEffect(oc, fin, oc.destination);
    off.setParams(params);
    out.offline = await off.ready;
    out.offlineError = off.error;
    if (out.offline) {
      const d = (await oc.startRendering()).getChannelData(0);
      let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i];
      out.rms = Math.round(Math.sqrt(s / d.length) * 1e4) / 1e4;
    }
    return out;
  });
  const fz = result.checks.faust;
  if (fz.error || fz.source !== 'bundled' || !fz.live || !fz.offline || !(fz.rms > 0.001)) throw new Error(`Faust effect: ${JSON.stringify(fz)}`);
  // 6. native plugin hosting: the test plugins are found, load, and process audio (offline render of a constant)
  if (testPlugins) {
    const run = (intel) => page.evaluate(async ({ installed, intel }) => {
      const api = window.daw3Native.plugins;
      const out = { loaded: [], failed: [], warnings: [] };
      const r = await api.scan({ force: false });
      const list = await api.list();
      out.count = r.count;
      out.hostArch = list.hostArch;
      out.failed = list.failed.map((f) => ({ path: f.path, error: f.error, quarantined: f.quarantined, arch: f.arch }));
      out.warnings = list.warnings || [];
      const want = intel ? [['vst3', intel]] : [['vst3', installed.vst3], ['clap', installed.clap]];
      for (const [format, p] of want) {
        const d = list.plugins.find((x) => x.format === format && x.path === p && /Gain/.test(x.name));
        if (!d) { out.loaded.push({ format, path: p, error: 'not found by the scan' }); continue; }
        try {
          const info = await api.load({ key: d.key, sampleRate: 48000 });
          const frames = 4800;
          const res = await api.render({ inst: info.inst, frames, input: new Float32Array(frames * 2).fill(0.5) });
          const v = res.output[frames - 100];
          await api.unload(info.inst);
          out.loaded.push({ format, name: d.name, arch: d.arch, value: v, ok: Math.abs(v - 0.5) < 1e-4 });
        } catch (e) { out.loaded.push({ format, name: d.name, arch: d.arch, error: String(e.message || e) }); }
      }
      return out;
    }, { installed: testPlugins, intel });
    const res = await run(null);
    result.checks.plugins = res;
    const bad = res.loaded.filter((x) => !x.ok);
    if (bad.length) throw new Error(`native plugins did not load / process: ${JSON.stringify(bad)}`);
    const unexpected = res.failed.filter((f) => [testPlugins.vst3, testPlugins.clap].includes(f.path));
    if (unexpected.length) throw new Error(`test plugins reported as failed: ${JSON.stringify(unexpected)}`);
    if (testPlugins.quarantined) {
      // the quarantined copy is reported with the fix, whether macOS refused to load it or not
      const q = res.failed.find((f) => f.path === testPlugins.quarantined) || res.warnings.find((w) => w.path === testPlugins.quarantined);
      if (!q?.quarantined && !/xattr -dr com\.apple\.quarantine/.test(q?.message || q?.error || '')) throw new Error(`the quarantined plugin copy was not reported as quarantined: ${JSON.stringify(q || null)}`);
      // and the Plugins dialog's Native tab shows it
      const shown = await page.evaluate(async () => {
        const m = await import('./src/ui/plugins-dialog.js');
        m.openPluginsDialog(window.daw3, { tab: 'native' });
        const sel = document.querySelector('.nplg-tab select:nth-of-type(2)');
        if (sel) { sel.value = 'problems'; sel.dispatchEvent(new Event('change')); }
        for (let i = 0; i < 100; i++) {
          const t = document.querySelector('.nplg-tab')?.innerText || '';
          if (/com\.apple\.quarantine/.test(t)) return true;
          await new Promise((r) => setTimeout(r, 100));
        }
        return document.querySelector('.nplg-tab')?.innerText?.slice(0, 2000) || 'no Native tab';
      });
      await page.screenshot({ path: path.join(outDir, `smoke-${label}-plugins.png`) });
      await page.keyboard.press('Escape');
      if (shown !== true) throw new Error(`the Native tab does not show the quarantine fix: ${shown}`);
    }
    if (testPlugins.intelSrc) {
      const rosetta = (() => { try { execFileSync('/usr/bin/arch', ['-x86_64', '/usr/bin/true'], { stdio: 'ignore' }); return true; } catch { return false; } })();
      const dst = path.join(userPluginDirs().vst3, 'daW3TestGainIntel.vst3');
      rmSync(testPlugins.vst3, { recursive: true, force: true }); // the universal copy would win the duplicate-key tie
      cpSync(testPlugins.intelSrc, dst, { recursive: true });
      installed.push(dst);
      const ri = await run(dst);
      result.checks.intelPlugin = { rosetta, ...ri };
      const one = ri.loaded[0] || {};
      const f = ri.failed.find((x) => x.path === dst);
      if (ri.hostArch === 'arm64') {
        if (rosetta && !(one.ok && one.arch === 'x86_64')) throw new Error(`Intel-only plugin did not run in the Rosetta host: ${JSON.stringify(ri)}`);
        if (!rosetta && !(f && /Rosetta/.test(f.error))) throw new Error(`Intel-only plugin without Rosetta was not explained: ${JSON.stringify(ri)}`);
      } else if (!one.ok) throw new Error(`x86_64 plugin failed in an x86_64 host: ${JSON.stringify(ri)}`);
    }
    log('plugins OK', JSON.stringify(result.checks.plugins.loaded), testPlugins.intelSrc ? JSON.stringify(result.checks.intelPlugin?.loaded) : '');
  }

  // what the screenshot shows, in words (for the CI log)
  result.checks.visible = await page.evaluate(() => ({
    song: window.daw3.store.get().name,
    bpm: window.daw3.store.get().bpm,
    trackNames: window.daw3.store.get().tracks.slice(0, 8).map((t) => t.name),
    activeView: document.querySelector('[aria-selected="true"], .tab.active, .view-tab.active')?.textContent?.trim()?.slice(0, 40) || null,
    modalsOpen: document.querySelectorAll('.modal').length,
    window: `${innerWidth}x${innerHeight}`,
  }));
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
  // leave the user plug-in folders as they were (the plugin host may still hold a file open for a moment on Windows)
  if (installed.length) { await sleep(1500); for (const p of installed) { try { rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { log(`could not remove ${p}: ${e.message}`); } } }
}
process.exit(result.ok ? 0 : 1);
