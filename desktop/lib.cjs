// Pure helpers for the Electron main process (no 'electron' import — unit-tested in Node).
'use strict';
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.wasm': 'application/wasm', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.sf2': 'application/octet-stream',
};
const AUDIO_EXT = ['.mp3', '.wav', '.wave', '.flac', '.m4a', '.aac', '.mp4', '.ogg', '.oga', '.opus', '.aif', '.aiff', '.webm'];
const PROJECT_EXT = ['.daw3', '.json'];
const BLOCKED = ['.git', 'node_modules', 'dist', '.github'];

const mimeFor = (file) => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
const isAudioPath = (p) => AUDIO_EXT.includes(path.extname(String(p)).toLowerCase());
const isProjectPath = (p) => path.extname(String(p)).toLowerCase() === '.daw3';

/**
 * Map an app:// URL pathname to a file under root (null when it escapes root or hits a blocked folder).
 * '/' -> index.html.
 */
function resolveAppPath(root, pathname) {
  let rel;
  try { rel = decodeURIComponent(String(pathname || '/')); } catch { return null; }
  if (rel.includes('\0')) return null;
  rel = rel.replace(/\\/g, '/');
  if (rel === '' || rel === '/') rel = '/index.html';
  const full = path.normalize(path.join(root, rel));
  const rootN = path.normalize(root + path.sep);
  if (!full.startsWith(rootN)) return null;
  const first = full.slice(rootN.length).split(path.sep)[0];
  if (BLOCKED.includes(first)) return null;
  return full;
}

/** Split dropped / opened paths into projects, audio files and (possibly) folders. stat(p) -> {isDirectory()} */
function classifyPaths(paths, stat) {
  const out = { projects: [], audio: [], folders: [], other: [] };
  for (const p of paths || []) {
    let dir = false;
    try { dir = !!stat?.(p)?.isDirectory(); } catch { dir = false; }
    if (dir) out.folders.push(p);
    else if (isProjectPath(p)) out.projects.push(p);
    else if (isAudioPath(p)) out.audio.push(p);
    else out.other.push(p);
  }
  return out;
}

/** Save-dialog filters from a suggested file name. */
function saveFiltersFor(name) {
  const ext = path.extname(String(name || '')).toLowerCase().slice(1);
  const known = {
    daw3: { name: 'daW³ Project', extensions: ['daW3'] }, wav: { name: 'WAV audio', extensions: ['wav'] },
    mid: { name: 'MIDI file', extensions: ['mid'] }, strudel: { name: 'Strudel code', extensions: ['strudel'] },
    json: { name: 'JSON', extensions: ['json'] }, zip: { name: 'Zip archive', extensions: ['zip'] },
  };
  return [...(known[ext] ? [known[ext]] : []), { name: 'All files', extensions: ['*'] }];
}

/** Open-dialog options for a kind of import. */
function openDialogOptions({ kind = 'any', multiple = true, title } = {}, isMac = process.platform === 'darwin') {
  const props = ['openFile'];
  if (multiple) props.push('multiSelections');
  if (kind === 'audio' && isMac) props.push('openDirectory'); // macOS can pick files and folders in one dialog
  const filters = kind === 'audio'
    ? [{ name: 'Audio', extensions: AUDIO_EXT.map((e) => e.slice(1)) }, { name: 'All files', extensions: ['*'] }]
    : kind === 'project' ? [{ name: 'daW³ Project', extensions: ['daW3', 'daw3', 'json'] }, { name: 'All files', extensions: ['*'] }]
      : [{ name: 'All files', extensions: ['*'] }];
  return { title: title || (kind === 'audio' ? 'Import music' : kind === 'project' ? 'Open project' : 'Open'), properties: props, filters };
}

const VIEW_MENU = [
  ['arrange', 'Arrange', '1'], ['session', 'Scenes', '2'], ['rack', 'Step Rack', '3'], ['piano', 'Piano Roll', '4'], ['mixer', 'Mixer', '5'],
  ['code', 'Code', '6'], ['patch', 'Plugboard', '7'], ['setlist', 'Setlist', '8'], ['decks', 'Decks', '9'],
];

/**
 * Native menu template. send(cmd, payload) forwards a command to the renderer; dialogs are main-process
 * callbacks (openProject, importMusic). Single-key view shortcuts stay in the web app (shown as hints).
 */
function buildMenuTemplate({ isMac = process.platform === 'darwin', appName = 'daW³', send, openProject, importMusic, openExternal, isDev = false } = {}) {
  const cmd = (c, payload) => () => send && send(c, payload);
  const template = [];
  if (isMac) {
    template.push({ label: appName, submenu: [
      { role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] });
  }
  template.push({ label: 'File', submenu: [
    { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: cmd('new-project') },
    { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => openProject && openProject() },
    { type: 'separator' },
    { label: 'Import Music…', accelerator: 'CmdOrCtrl+I', click: () => importMusic && importMusic() },
    { label: 'Import Samples…', click: cmd('import-samples') },
    { label: 'Import MIDI…', click: cmd('import-midi') },
    { type: 'separator' },
    { label: 'Save Project…', accelerator: 'CmdOrCtrl+S', click: cmd('save-project') },
    { label: 'Export', submenu: [
      { label: 'Mixdown (WAV)…', accelerator: 'CmdOrCtrl+E', click: cmd('export-wav') },
      { label: 'Stems (WAV)…', click: cmd('export-stems') },
      { label: 'MIDI…', click: cmd('export-midi') },
    ] },
    { type: 'separator' },
    isMac ? { role: 'close' } : { role: 'quit' },
  ] });
  template.push({ label: 'Edit', submenu: [
    { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: cmd('undo') },
    { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: cmd('redo') },
    { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
  ] });
  template.push({ label: 'View', submenu: [
    ...VIEW_MENU.map(([id, label, key]) => ({ label: `${label}    (${key})`, click: cmd('show-view', id) })),
    { type: 'separator' },
    { label: 'Toggle Browser    (B)', click: cmd('toggle-browser') },
    { label: 'Toggle Assistant    (A)', click: cmd('toggle-assistant') },
    { type: 'separator' },
    { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
    ...(isDev ? [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] : [{ type: 'separator' }, { role: 'toggleDevTools' }]),
  ] });
  template.push({ label: 'Transport', submenu: [{ label: 'Play / Pause    (Space)', click: cmd('toggle-play') }] });
  template.push({ role: 'windowMenu' });
  template.push({ role: 'help', submenu: [
    { label: `${appName} Help`, click: cmd('help') },
    { label: 'Source code (AGPL)', click: () => openExternal && openExternal('https://github.com/Coral-coder/daw3') },
  ] });
  return template;
}

module.exports = { mimeFor, isAudioPath, isProjectPath, resolveAppPath, classifyPaths, saveFiltersFor, openDialogOptions, buildMenuTemplate, AUDIO_EXT, PROJECT_EXT, VIEW_MENU };
