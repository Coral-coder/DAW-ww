// daW³ for macOS — Electron main process. Serves the unchanged web app from app://daw3/ (a privileged
// standard scheme so ES modules, fetch() and workers work from local files), adds native menus,
// Finder file associations (.daW3), drag & drop / open-file of audio and folders, native open / save
// dialogs and microphone permission. Run: npm run mac:dev · build: npm run mac:build (README appendix).
'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, shell, session, systemPreferences } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const lib = require('./lib.cjs');

const ROOT = path.resolve(__dirname, '..');
const APP_ORIGIN = 'app://daw3';
const isMac = process.platform === 'darwin';
const isDev = !app.isPackaged;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

let win = null;
let rendererReady = false;
const pending = []; // commands queued until the page says it's ready
const queuedPaths = []; // open-file events before the window exists
const approved = new Set(); // paths the user opened / picked / saved — readFile is limited to these
let lastDir = null;

function send(cmd, payload) {
  if (win && !win.isDestroyed() && rendererReady) win.webContents.send('daw3:command', cmd, payload);
  else pending.push([cmd, payload]);
}

async function listAudio(dir, depth = 0, out = []) {
  if (depth > 6 || out.length > 500) return out;
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await listAudio(p, depth + 1, out);
    else if (lib.isAudioPath(p)) out.push(p);
  }
  return out;
}

async function readPayload(p) {
  const data = await fsp.readFile(p);
  approved.add(path.resolve(p));
  return { name: path.basename(p), path: p, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

/** Files from Finder (open-file, dock / window drops via argv, dialogs): projects open, audio goes to Decks. */
async function openPaths(paths) {
  const c = lib.classifyPaths(paths, (p) => fs.statSync(p));
  for (const dir of c.folders) c.audio.push(...(await listAudio(dir)));
  if (c.projects[0]) send('open-project', [await readPayload(c.projects[0])]);
  if (c.audio.length) {
    const files = [];
    for (const p of c.audio) { try { files.push(await readPayload(p)); } catch (e) { console.warn('[open]', p, e.message); } }
    if (files.length) send('import-music', files);
  }
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
}

async function openProjectDialog() {
  const r = await dialog.showOpenDialog(win, { ...lib.openDialogOptions({ kind: 'project', multiple: false }, isMac), defaultPath: lastDir || undefined });
  if (!r.canceled && r.filePaths[0]) { lastDir = path.dirname(r.filePaths[0]); await openPaths([r.filePaths[0]]); }
}

async function pickFiles(opts = {}) {
  const r = await dialog.showOpenDialog(win, { ...lib.openDialogOptions(opts, isMac), defaultPath: lastDir || app.getPath('music') });
  if (r.canceled || !r.filePaths.length) return [];
  lastDir = path.dirname(r.filePaths[0]);
  const c = lib.classifyPaths(r.filePaths, (p) => fs.statSync(p));
  const paths = [...c.projects, ...c.audio, ...c.other];
  for (const dir of c.folders) paths.push(...(await listAudio(dir)));
  const out = [];
  for (const p of paths) { try { out.push(await readPayload(p)); } catch (e) { console.warn('[pick]', p, e.message); } }
  return out;
}

async function importMusicDialog() {
  const files = await pickFiles({ kind: 'audio', multiple: true });
  if (files.length) send('import-music', files);
}

function registerIpc() {
  ipcMain.handle('daw3:open-files', (_e, opts) => pickFiles(opts || {}));
  ipcMain.handle('daw3:save-file', async (_e, { name = 'untitled', data } = {}) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(lastDir || app.getPath('documents'), path.basename(String(name))), filters: lib.saveFiltersFor(name) });
    if (r.canceled || !r.filePath) return null;
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data || []);
    await fsp.writeFile(r.filePath, buf);
    lastDir = path.dirname(r.filePath);
    approved.add(path.resolve(r.filePath));
    if (isMac) app.addRecentDocument(r.filePath);
    return r.filePath;
  });
  ipcMain.handle('daw3:read-file', async (_e, p) => {
    const full = path.resolve(String(p));
    if (!approved.has(full)) throw new Error('daW³ can only read files you opened, picked or dropped.');
    return readPayload(full);
  });
  ipcMain.handle('daw3:reveal', (_e, p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(path.resolve(p)); return true; });
  ipcMain.on('daw3:ready', (e) => {
    if (!win || e.sender !== win.webContents) return;
    rendererReady = true;
    for (const [c, p] of pending.splice(0)) win.webContents.send('daw3:command', c, p);
  });
}

function registerProtocol() {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    const file = lib.resolveAppPath(ROOT, url.pathname);
    if (!file) return new Response('Forbidden', { status: 403 });
    try {
      const body = await fsp.readFile(file);
      return new Response(body, { headers: { 'content-type': lib.mimeFor(file), 'cache-control': 'no-cache' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function setupPermissions() {
  const allowed = new Set(['media', 'midi', 'midiSysex', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'notifications']);
  session.defaultSession.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    const fromApp = String(details?.requestingUrl || wc.getURL()).startsWith(APP_ORIGIN);
    if (!fromApp || !allowed.has(permission)) return callback(false);
    if (permission === 'media' && isMac && (details?.mediaTypes || []).includes('audio')) {
      try { return callback(await systemPreferences.askForMediaAccess('microphone')); } catch { return callback(false); }
    }
    callback(true);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => String(origin || '').startsWith(APP_ORIGIN) && allowed.has(permission));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 920, minWidth: 960, minHeight: 600,
    title: 'daW³',
    backgroundColor: '#14151b',
    show: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 12, y: 14 } : undefined,
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false, // keep the audio scheduler + Setlist running when the window is in the background
    },
  });
  rendererReady = false;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; rendererReady = false; });
  // External links open in the default browser; a file dropped outside a drop zone must not navigate away.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(APP_ORIGIN)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
    else if (url.startsWith('file://')) { try { openPaths([decodeURIComponent(new URL(url).pathname)]); } catch { /* */ } }
  });
  win.loadURL(`${APP_ORIGIN}/index.html`);
}

// ---- lifecycle ----
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    const files = argv.slice(1).filter((a) => !a.startsWith('-') && fs.existsSync(a) && a !== process.execPath);
    if (files.length) openPaths(files);
    else if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  // Finder: double-clicked .daW3 files, files dropped on the Dock icon (may fire before 'ready').
  app.on('open-file', (e, p) => {
    e.preventDefault();
    if (app.isReady() && win) openPaths([p]); else queuedPaths.push(p);
  });
  app.setName('daW³');
  app.whenReady().then(() => {
    registerProtocol();
    registerIpc();
    setupPermissions();
    Menu.setApplicationMenu(Menu.buildFromTemplate(lib.buildMenuTemplate({
      isMac, appName: 'daW³', send, openProject: openProjectDialog, importMusic: importMusicDialog, openExternal: (u) => shell.openExternal(u), isDev,
    })));
    if (isMac) app.setAboutPanelOptions({ applicationName: 'daW³', copyright: 'AGPL-3.0-or-later', website: 'https://github.com/Coral-coder/daw3' });
    createWindow();
    const argvFiles = process.argv.slice(isDev ? 2 : 1).filter((a) => !a.startsWith('-') && fs.existsSync(a) && path.resolve(a) !== ROOT);
    const initial = [...queuedPaths.splice(0), ...argvFiles];
    if (initial.length) openPaths(initial);
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => { if (!isMac) app.quit(); });
}
