// Headless-Chromium harness for daW³ browser checks, with AudioWorklets that actually run.
//
// Why: Playwright attaches every page with Target.setAutoAttach({waitForDebuggerOnStart: true, filter:
// [iframe, worker, service_worker]}). Chromium still parks new AudioWorklet threads ("worklet" targets) waiting
// for a debugger although the filter excludes them, nobody ever attaches or resumes them, and
// audioWorklet.addModule() never settles (always for a realtime AudioContext, sometimes for an
// OfflineAudioContext). It is not the sandbox, the audio sink or the headless mode: plain `chrome --headless`
// without CDP runs worklets fine. Fix: a second CDP session per page auto-attaches *worklet* targets (also
// waiting) and detaches them at once — detaching releases the wait. Install it before the page creates contexts.
//
//   import { launch, serveRepo } from './browser.mjs';
//   const srv = await serveRepo();                 // node scripts/serve.js on a free port (killed by srv.close())
//   const { browser, page } = await launch();      // page already has the worklet fix
//   await page.goto(srv.url + '/index.html');
//
// playwright-core is resolved from $PLAYWRIGHT_CORE, the repo / cwd node_modules, or /tmp/claude-0/pw.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function loadPlaywright() {
  const bases = [process.env.PLAYWRIGHT_CORE, join(repoRoot, 'package.json'), join(process.cwd(), 'package.json'), '/tmp/claude-0/pw/package.json'].filter(Boolean);
  for (const base of bases) {
    try {
      if (base.endsWith('.json')) return createRequire(base)('playwright-core');
      return createRequire(join(base, 'x.js'))(base);
    } catch { /* next */ }
  }
  throw new Error('playwright-core not found: set PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core');
}

export function findChromium() {
  if (process.env.CHROME) return process.env.CHROME;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (existsSync(root)) {
    for (const d of readdirSync(root).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
      const exe = join(root, d, 'chrome-linux', 'chrome');
      if (existsSync(exe)) return exe;
    }
  }
  return undefined; // let Playwright pick its own
}

/** Release AudioWorklet threads that Chromium parks for a debugger under Playwright (see header). */
export async function enableWorklets(page) {
  const cdp = await page.context().newCDPSession(page);
  cdp.on('Target.attachedToTarget', (e) => {
    cdp.send('Target.detachFromTarget', { sessionId: e.sessionId }).catch(() => {});
  });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'worklet' }] });
  return cdp;
}

export async function launch({ headless = true, args = [], page: wantPage = true } = {}) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    executablePath: findChromium(), headless,
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...args],
  });
  const context = await browser.newContext({ serviceWorkers: 'block', permissions: ['microphone'] });
  context.on('page', (p) => { enableWorklets(p).catch(() => {}); });
  let page = null;
  if (wantPage) { page = await context.newPage(); await enableWorklets(page); }
  return { browser, context, page };
}

function freePort() {
  return new Promise((res, rej) => { const s = createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => res(port)); }); s.on('error', rej); });
}

/** Serve the repo with scripts/serve.js on a free port. Kills only the server it started. */
export async function serveRepo() {
  const port = await freePort();
  const child = spawn(process.execPath, [join(repoRoot, 'scripts/serve.js')], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { child.stdout.on('data', (d) => { if (String(d).includes('running')) res(); }); child.on('exit', (c) => rej(new Error('serve.js exited ' + c))); });
  return { url: `http://localhost:${port}`, port, close: () => child.kill() };
}
