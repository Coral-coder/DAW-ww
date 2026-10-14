// Main-process side of the native audio engine + plugin hosting: starts the audio server utility
// process on demand, forwards validated control calls from the renderer and hands the renderer a
// MessagePort for the audio stream. The web app sees it as window.daw3Native.audio / .plugins.
'use strict';
const path = require('node:path');
const { nativePaths } = require('./native-server.cjs');
const { startLinkServer, processLink, simulatedLink, LINK_PORT } = require('./link-server.cjs');

function setupNative({ app, ipcMain, utilityProcess, MessageChannelMain, getWindow }) {
  const paths = nativePaths({ resourcesPath: process.resourcesPath, isPackaged: app.isPackaged });
  let child = null;
  let nextId = 1;
  const pending = new Map();
  let protocol = null;
  const loadProtocol = () => (protocol ||= import(require('node:url').pathToFileURL(path.join(__dirname, '..', 'src', 'native', 'protocol.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')).href));

  const send = (ev) => { const w = getWindow(); if (w && !w.isDestroyed()) w.webContents.send('daw3:native-event', ev); };

  function server() {
    if (child) return child;
    child = utilityProcess.fork(path.join(__dirname, 'audio-server.cjs'), [], {
      serviceName: 'daW3 Audio',
      stdio: 'inherit',
      env: { ...process.env, DAW3_ADDON: paths.addon, DAW3_PLUGHOST: paths.binary, DAW3_DATA: app.getPath('userData'), DAW3_TMP: app.getPath('temp') },
    });
    child.on('message', (m) => {
      if (m && m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
      } else if (m && m.event) send(m);
    });
    child.on('exit', (code) => {
      child = null;
      for (const p of pending.values()) p.reject(new Error('The audio server stopped'));
      pending.clear();
      send({ event: 'server-exit', code });
    });
    return child;
  }

  ipcMain.on('daw3:native-caps', (e) => { e.returnValue = { audio: paths.available, plugins: paths.available }; });
  ipcMain.handle('daw3:native', async (_e, method, args) => {
    if (!paths.available) throw new Error('The native audio engine is not part of this build');
    (await loadProtocol()).validateCall(method, args || []);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      server().postMessage({ id, method, args: args || [] });
    });
  });
  ipcMain.on('daw3:native-connect', (e) => {
    if (!paths.available) return;
    const { port1, port2 } = new MessageChannelMain();
    server().postMessage({ type: 'stream-port' }, [port1]);
    e.sender.postMessage('daw3:native-port', null, [port2]);
  });
  // Ableton Link, built in: the daw3-link process (Link SDK) served on the local WebSocket the web app's
  // LinkClient speaks (the tools/link-bridge protocol). Started on the first connect; a busy port 20809 (a
  // separately running bridge) falls back to a free port.
  let linkSrv = null;
  ipcMain.handle('daw3:link-start', async () => {
    if (!linkSrv) {
      linkSrv = (async () => {
        let srv = null;
        let link = null;
        if (paths.link) {
          link = processLink(paths.link, { onState: () => srv?.broadcast(), onExit: () => { linkSrv = null; } });
          try { await link.ready; } catch (e) { console.warn('[link]', e.message); link = null; }
        }
        srv = await startLinkServer({ link: link || simulatedLink(), port: LINK_PORT, fallbackPort: true, origins: ['app://daw3'], log: (m) => console.warn('[link]', m) });
        return { srv, native: !!link };
      })();
      linkSrv.catch(() => { linkSrv = null; });
    }
    const { srv, native } = await linkSrv;
    return { url: srv.url, native };
  });
  app.on('will-quit', () => {
    try { child?.kill(); } catch { /* */ }
    linkSrv?.then(({ srv }) => srv.close(), () => {});
  });
  return { paths };
}

module.exports = { setupNative };
