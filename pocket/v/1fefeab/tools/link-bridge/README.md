# daW³ Ableton Link bridge

Browsers cannot join an Ableton Link session (Link uses UDP multicast). This folder holds a tiny optional
companion that joins Link and re-publishes it to daW³ over a local WebSocket.

```
cd tools/link-bridge
sh ../../desktop/native/build.sh   # builds daw3-link (real Link); or: npm i abletonlink; without either it simulates Link
node link-bridge.mjs       # ws://127.0.0.1:20809
node link-bridge.mjs --origin https://example.github.io   # allow a hosted daW³ (localhost is always allowed)
node link-bridge.mjs --simulate                            # no Link: a shared clock for several browser tabs
```

In daW³: **Preferences → Sync → Ableton Link → Connect**. When connected, daW³ follows (and sets) the session
tempo, starts on the next bar of the Link timeline (quantum, default 4 beats), stops with it (start/stop sync)
and nudges its playhead when the phase drifts by more than 1/16 note.

## Protocol (JSON text frames)

| direction | message |
|-----------|---------|
| bridge → daW³ | `{type:'state', tempo, beat, phase, quantum, playing, peers, link, time}` — 20×/s and after every change; `beat`/`phase` are valid at `time` (bridge `Date.now()`) |
| daW³ → bridge | `{type:'tempo', bpm}` · `{type:'play'}` · `{type:'stop'}` · `{type:'quantum', value}` |

The client lives in `src/control/link-client.js` (`LinkClient`, pure helper `linkPhaseError`).

## Mac app

The daW³ Mac app has Link built in: `desktop/native/src/link/link_main.cpp` (the `daw3-link` process, Ableton's
Link SDK 3.1.5 — GPL-2.0-or-later, which GPLv3 / AGPLv3 §13 let daW³'s AGPL-3.0-or-later code combine with; it is
kept in its own process anyway) is served on this same WebSocket protocol by `desktop/link-server.cjs`, started
from the main process when you press Connect. This script uses the same server, and the same `daw3-link` binary
when it has been built (`sh desktop/native/build.sh`; `--native <path>` picks another one).
