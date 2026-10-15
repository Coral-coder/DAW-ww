// Preload (sandboxed, contextIsolation on): the only bridge between daW³'s web code and the desktop OS.
// The web app feature-detects window.daw3Native and works unchanged without it (browser).
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Native audio engine + plugin hosting (present when the app ships the native layer).
let caps = {};
try { caps = ipcRenderer.sendSync('daw3:native-caps') || {}; } catch { caps = {}; }
// Electron prefixes errors thrown in the main process ("Error invoking remote method 'daw3:native': Error: …"): the
// page gets the plain message
const cleanError = (e) => new Error(String(e?.message || e).replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:[A-Z][A-Za-z]*)?Error:\s*/, ''));
const call = (method, ...args) => ipcRenderer.invoke('daw3:native', method, args).catch((e) => { throw cleanError(e); });
const onNativeEvent = (cb) => {
  const listener = (_e, ev) => cb(ev);
  ipcRenderer.on('daw3:native-event', listener);
  return () => ipcRenderer.removeListener('daw3:native-event', listener);
};
// The audio-stream MessagePort can't cross the context bridge: hand it to the page with postMessage.
ipcRenderer.on('daw3:native-port', (e) => { window.postMessage({ daw3: 'native-port' }, '*', e.ports); });

const audio = caps.audio ? {
  listDevices: () => call('audio.listDevices'),
  getConfig: () => call('audio.getConfig'),
  /** Partial config -> { config, status, error }. { enabled: true } routes daW³'s output to the device. */
  setConfig: (cfg) => call('audio.setConfig', cfg || {}),
  status: () => call('audio.status'),
  /** Loopback ping -> { ok, latencyMs, latencySamples, message } */
  calibrate: (opts) => call('audio.calibrate', opts || {}),
  /** Ask for the audio-stream port; it arrives as window 'message' { daw3: 'native-port' } with ports[0]. */
  connectStream: () => ipcRenderer.send('daw3:native-connect'),
  onEvent: onNativeEvent,
} : undefined;

const plugins = caps.plugins ? {
  scan: (opts) => call('plugins.scan', opts || {}),
  list: () => call('plugins.list'),
  /** Rescan one bundle -> { ok, error, count, failed, warnings } */
  retry: (format, path) => call('plugins.retry', { format: String(format || ''), path: String(path || '') }),
  /** -> { log, at, ok, arch, quarantined } */
  scanLog: (format, path) => call('plugins.scanLog', { format: String(format || ''), path: String(path || '') }),
  /** Plugin manager preferences: { favorites: [key], hidden: [key], blocked: [{ format, path, key, name }] } */
  getPrefs: () => call('plugins.getPrefs'),
  setPrefs: (prefs) => call('plugins.setPrefs', prefs || {}),
  load: (opts) => call('plugins.load', opts || {}),
  unload: (inst) => call('plugins.unload', inst),
  info: (inst) => call('plugins.info', inst),
  setParam: (inst, id, value) => call('plugins.setParam', inst, id, value),
  getState: (inst) => call('plugins.getState', inst),
  setState: (inst, state) => call('plugins.setState', inst, state),
  openEditor: (inst) => call('plugins.openEditor', inst),
  closeEditor: (inst) => call('plugins.closeEditor', inst),
  setOffline: (inst, off) => call('plugins.setOffline', inst, !!off),
  render: (opts) => call('plugins.render', opts || {}),
  /** -> [{ id, name, category, kind: 'factory'|'file', path? }] */
  presets: (inst) => call('plugins.presets', inst),
  /** -> instance info with the new parameter values */
  loadPreset: (inst, id) => call('plugins.loadPreset', inst, String(id || '')),
  /** Save a .vstpreset / .aupreset in the plugin's user preset folder -> its path */
  savePreset: (inst, name) => call('plugins.savePreset', inst, String(name || '')),
  onEvent: onNativeEvent,
} : undefined;

// Ableton Link, built in (the daw3-link process behind a local WebSocket): start() -> { url, native }
const link = { start: () => ipcRenderer.invoke('daw3:link-start') };

contextBridge.exposeInMainWorld('daw3Native', {
  ...(audio ? { audio } : {}),
  ...(plugins ? { plugins } : {}),
  link,
  isNative: true,
  platform: process.platform,
  /** Native open dialog -> [{ name, path, data: Uint8Array }]. opts: { kind: 'audio'|'project'|'any', multiple, title } */
  openFiles: (opts) => ipcRenderer.invoke('daw3:open-files', opts || {}),
  /** Native save dialog + write -> saved path | null. opts: { name, data: Uint8Array|ArrayBuffer|string } */
  saveFile: (opts) => ipcRenderer.invoke('daw3:save-file', opts || {}),
  /** Read a file the user opened / picked / dropped this session -> { name, path, data } */
  readFile: (p) => ipcRenderer.invoke('daw3:read-file', String(p || '')),
  revealInFinder: (p) => ipcRenderer.invoke('daw3:reveal', String(p || '')),
  /** Absolute path of a dropped File ('' when unknown). */
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  /** Menu / Finder commands: cb(cmd, payload). Returns an unsubscribe function. */
  onCommand: (cb) => {
    const listener = (_e, cmd, payload) => cb(cmd, payload);
    ipcRenderer.on('daw3:command', listener);
    return () => ipcRenderer.removeListener('daw3:command', listener);
  },
  /** The page is ready for commands (flushes files opened from Finder during startup). */
  ready: () => ipcRenderer.send('daw3:ready'),
});
