# daW³ Ableton Link bridge

Browsers cannot join an Ableton Link session (Link uses UDP multicast). This folder holds a tiny optional
companion that joins Link and re-publishes it to daW³ over a local WebSocket.

```
cd tools/link-bridge
npm i abletonlink          # optional native addon (needs a C++ toolchain); without it the bridge simulates Link
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

## Mac app integration point

The macOS app build can host Link natively instead of this script: link the Link SDK (C++), run the same
JSON protocol on a loopback WebSocket (or post the `state` object to the web view with
`window.daw3?.control?.link?.receive(state)` and route `tempo` / `play` / `stop` back through a
`WKScriptMessageHandler`). `LinkClient.receive(state)` is the single entry point the client uses for incoming
state, and `LinkClient.transport` (`send(obj)`) is the only outgoing call, so either transport plugs in without
touching the sync logic.
