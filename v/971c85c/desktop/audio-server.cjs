// daW³ audio server — an Electron utility process (its own OS process: a stuck or crashing native
// layer can't freeze the UI). Owns the native audio device (daw3_audio addon) and the plugin host.
//   parentPort  <- { id, method, args }      -> { id, result } | { id, error }   (control, via main)
//               <- { type: 'stream-port' } + MessagePort                          (audio stream, from the renderer's pump worker)
//               -> { event, ... }                                                 (device / plugin events)
'use strict';
const { NativeServer } = require('./native-server.cjs');

const env = process.env;
const post = (m) => { try { process.parentPort.postMessage(m); } catch { /* parent gone */ } };
let server = null;
let ready = null;
const streams = new Set();

function start() {
  if (!ready) {
    ready = (async () => {
      const addon = require(env.DAW3_ADDON);
      server = await NativeServer.create({ addon, binary: env.DAW3_PLUGHOST, dataDir: env.DAW3_DATA, tmpDir: env.DAW3_TMP, post });
      // device input -> every connected renderer stream (2 ms poll; the ring in the addon absorbs jitter)
      setInterval(() => {
        if (!streams.size) return;
        const m = server.pollInput();
        if (m) for (const p of streams) p.postMessage(m);
      }, 2);
      return server;
    })();
  }
  return ready;
}

process.parentPort.on('message', async (e) => {
  const msg = e.data || {};
  if (msg.type === 'stream-port' && e.ports?.[0]) {
    const port = e.ports[0];
    await start();
    streams.add(port);
    port.on('message', (ev) => {
      const reply = server.stream(ev.data);
      if (reply) port.postMessage(reply);
    });
    port.on('close', () => streams.delete(port));
    port.start();
    return;
  }
  if (msg.method) {
    try {
      const s = await start();
      post({ id: msg.id, result: await s.handle(msg.method, msg.args || []) });
    } catch (err) {
      post({ id: msg.id, error: err?.message || String(err) });
    }
  }
});

process.on('exit', () => server?.shutdown());
