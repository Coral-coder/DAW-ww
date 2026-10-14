#!/usr/bin/env node
// daW³ Ableton Link bridge — browsers cannot speak Link (UDP multicast), so this tiny companion joins the Link
// session and exposes it to daW³ over a local WebSocket (ws://127.0.0.1:20809). The daW³ Mac app has this built
// in (the daw3-link process + desktop/link-server.cjs, started when you connect); this script is for the browser.
//
//   node tools/link-bridge/link-bridge.mjs [--port 20809] [--origin https://your.daw3.host] [--simulate]
//                                          [--native desktop/native/build/daw3-link]
//
// Link backends, first that works: --native (the daw3-link binary built by `sh desktop/native/build.sh`, Ableton's
// Link SDK), the optional `abletonlink` npm addon, else a simulated session (handy for testing the daW³ side, and
// it still syncs several browser tabs with each other).
// Protocol (JSON text frames) and server: desktop/link-server.cjs; see README.md in this folder.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { startLinkServer, simulatedLink, processLink, LINK_PORT } = require('../../desktop/link-server.cjs');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const PORT = +opt('port', process.env.DAW3_LINK_PORT || LINK_PORT);
const ORIGINS = (opt('origin', process.env.DAW3_LINK_ORIGINS || '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const SIMULATE = args.includes('--simulate');
const here = path.dirname(fileURLToPath(import.meta.url));
const NATIVE = opt('native', path.join(here, '..', '..', 'desktop', 'native', 'build', 'daw3-link'));

function addonLink() {
  let AbletonLink;
  try { AbletonLink = require('abletonlink'); } catch { return null; }
  const link = new AbletonLink(120, 4, true);
  try { link.enablePlayStateSync?.(); link.isStartStopSyncEnabled = true; } catch { /* older addon */ }
  let beat = 0, phase = 0;
  link.startUpdate(16, (b, ph) => { beat = b; phase = ph; });
  return {
    real: true,
    get tempo() { return link.bpm; }, set tempo(v) { link.bpm = v; },
    get quantum() { return link.quantum; }, set quantum(v) { link.quantum = v; },
    get beat() { return beat; }, get phase() { return phase; },
    get playing() { return !!link.isPlaying; },
    play() { link.play?.(); }, stop() { link.stop?.(); },
    get peers() { return link.numPeers ?? 0; },
  };
}

let server = null;
async function nativeLink() {
  if (!NATIVE || !existsSync(NATIVE)) return null;
  const l = processLink(NATIVE, { onState: () => server?.broadcast(), onExit: () => console.warn('[link-bridge] the daw3-link process exited') });
  try { await l.ready; return l; } catch (e) { console.warn('[link-bridge]', e.message); return null; }
}

const link = (!SIMULATE && ((await nativeLink()) || addonLink())) || simulatedLink();
console.log(link.real ? `[link-bridge] Ableton Link enabled (${link.pid ? 'daw3-link process' : 'abletonlink addon'})`
  : `[link-bridge] SIMULATED Link session${SIMULATE ? '' : ' — build desktop/native (daw3-link) or `npm i abletonlink` in this folder for real Link'}`);
server = await startLinkServer({ link, port: PORT, origins: ORIGINS, log: (m) => console.warn('[link-bridge]', m) });
console.log(`[link-bridge] ${server.url}  (daW³: Preferences → Sync → Ableton Link)`);
