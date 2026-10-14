# Real-time collaboration & versions

daW³ is static files with no backend, so collaboration is peer-to-peer: browsers talk to each
other directly over WebRTC data channels. Code: `src/collab/*`, relay: `tools/collab-relay/`.

## Starting a session

**Copy-paste invite (no server at all)**

1. Host: header button with the people icon (or *Menu → Collaborate*) → **Start & create invite code**.
2. Send the `daw3:…` code (or the link / QR, which opens daW³ with the code filled in) to one person.
3. Guest: paste it under **Join with a code** → **Join**. Their current project is kept in *Recent*;
   the session's project opens. They get an **answer code** and send it back.
4. Host pastes the answer → **Connect**. One invite per extra person (up to 6 people).
   In this mode the host relays between guests (star), so the host must stay online.

**Relay room (optional tiny server)** — *Use a relay server*: enter the relay URL and a room name,
**Host room** on one machine, **Join room** on the others. Everyone connects to everyone (mesh),
no codes to exchange. Enter `local` as the URL to connect tabs of the same browser with no server.

```
PORT=8787 node tools/collab-relay/server.js     # ~100 lines, no dependencies, Node 18+
```

Deploy it anywhere that runs Node and allows WebSockets (Fly.io, Render, Railway, a VPS behind
nginx/Caddy with TLS — pages served over https need `wss://`). It only forwards signaling
(SDP + ICE candidates) inside a room; project data never passes through it. Env: `PORT`,
`MAX_ROOM` (default 8). Rooms are unauthenticated — anyone who knows the room name can join,
so use long random names.

## Network: STUN / TURN

Only public STUN (`stun:stun.l.google.com:19302`) is configured. That covers most home / office
NATs. Behind symmetric NATs or strict firewalls the connection fails; add a TURN server in the
panel (*Network (STUN / TURN)*, stored in `localStorage['daw3-collab-ice']`), e.g.
`[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]`. coturn works well;
hosted TURN (Twilio, Metered, Cloudflare Calls) also does. All participants should use it.

## How edits merge (src/collab/crdt.js)

* The store keeps working exactly as before. On every `change` the bridge (`bridge.js`) diffs
  the project against the CRDT view and produces ops; remote ops are applied to the CRDT and the
  result is reconciled *in place* into `store.project` (object identities of tracks / patterns /
  notes survive, so views keep their references).
* Paths use stable ids: `tracks/<id>/volume`, `patterns/<id>/notes/<noteId>/pitch`,
  `tracks/<id>/automation/<laneId>/points`, …
* Every leaf is a **last-writer-wins register** stamped with a **hybrid logical clock**
  (`hlc.js`, ties broken by replica id ⇒ a total order). Id'd arrays (tracks, clips, scenes,
  buses, markers, fx, automation lanes, plugboard nodes/cables, notes) and the `patterns` map are
  **add-wins sets** (observed-remove tags) with an LWW fractional position per element.
  Containers carry an incarnation id, so replacing an object never resurrects stale keys.
* Atomic values: numbers, strings, `timeSig`, automation `points` (a lane's point list is one
  register), code text (concurrent typing in the same code track: last writer wins).
* Ops are idempotent and commutative (the fuzz test delivers them reordered and duplicated to 3
  replicas and checks convergence); a joining peer gets the full state (state-based merge).
* **Undo is local**: `store.history` points at the bridge, Ctrl+Z reverts only registers whose
  latest write is still yours (someone else's later edit to the same field wins, their other
  edits are never touched). Redo works the same way.
* Kept per user: play/stop/position, `mode` (pattern/song), `metronome`, `loop.enabled`,
  `modifiedAt`, UI state. Optional *sync play* broadcasts play/stop + position.
* Samples: the CRDT carries metadata + SHA-256 of the bytes (`samples.js`, synchronous SHA-256);
  a peer missing the bytes requests them (`sreq`) and receives 16 KB base64 chunks (`schunk`),
  verified against the hash before use, retried from another peer on mismatch.

## Wire protocol (src/collab/session.js)

JSON over one reliable ordered data channel per peer (messages > 60 KB are fragmented, sends
respect `bufferedAmount`). Envelope `{ mid, src, to?, ttl, type, … }`; flooded to links that may
not reach the sender directly (manual star), de-duplicated by `mid`.

| type | body |
| --- | --- |
| `hello` | name, color, docId, links (heartbeat every 2 s) |
| `sync` | docId, full CRDT state (on link open) |
| `ops` | ops, label (activity feed) |
| `presence` | view, cursor (beat + track / pitch), selection (clip / note ids), scroll |
| `chat` | text |
| `sreq` / `schunk` / `snone` | sample transfer by hash |
| `transport` | playing, beat, bpm (sync play) |
| `bye` | — |

## Presence UX

Collaborator list (color, name, current view / track), live cursors and selection outlines in
Arrange and Piano Roll (`overlay.js`, geometry from each view's `collabGeom()`), **Follow** (view,
selection, scroll; any click in the grid stops following), soft locks (“Alex is editing Bass”:
badge on the arrange row, panel list, and a warning toast if you edit the same track — never
blocking), chat, activity feed.

## Versions (src/collab/versions.js, diff.js)

*Menu → Save version…* or the **Versions** tab: named snapshots in IndexedDB (`daw3-versions`),
diff against now or another version (song settings, tracks, clips, patterns / notes, buses,
markers, samples, param-level fields), restore (one undo step; in a session it is shared like
any edit), **Duplicate as alternative** (branch: a new project with a copy of the history), and
**Download with versions** (`versions: [...]` inside the .daW3; imported automatically on open).
Snapshots store sample metadata only; restoring takes the bytes from the current project.

## Limits

* Up to 6 people. Manual invites: one code pair per guest, host relays (stays online).
* No server-side persistence: when everyone leaves, each person keeps their own copy
  (autosaved locally). While a session is running, a dropped peer can be re-invited and both
  sides merge; after *Leave*, joining again starts from the host's copy.
* Concurrent edits to the same atomic value (one automation lane's points, a code track's text,
  a note's pitch) resolve last-writer-wins, not character/point-wise merging.
* Structural conflicts are merged, not validated: e.g. a clip added on a track someone deleted
  concurrently stays orphaned until someone removes it.
* Sample bytes are only available while a peer that has them is connected.
* Relay rooms are unauthenticated; invite codes contain your network candidates (IP addresses).
