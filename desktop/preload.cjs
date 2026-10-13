// Preload (sandboxed, contextIsolation on): the only bridge between daW³'s web code and macOS.
// The web app feature-detects window.daw3Native and works unchanged without it (browser).
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('daw3Native', {
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
