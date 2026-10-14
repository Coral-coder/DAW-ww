# daW³ collab relay

Optional signaling relay for daW³ live sessions — one dependency-free file (`server.js`, Node 18+).
Peers in the same room exchange WebRTC offers / answers / ICE candidates through it; the music
and project data then flow peer-to-peer. Without a relay, daW³ still works with copy-paste invite
codes.

```sh
PORT=8787 node tools/collab-relay/server.js
# in daW³: Collaborate → Use a relay server → ws://localhost:8787 (or wss://your-host) + room name
```

Deploy behind TLS for pages served over https (the browser requires `wss://`), e.g. Caddy:
`relay.example.com { reverse_proxy localhost:8787 }`. Any Node host with WebSocket support works
(Fly.io, Render, Railway, a VPS). Env: `PORT` (default 8787), `MAX_ROOM` (default 8).

Protocol: `ws://host/?room=<room>&id=<peerId>`; the server sends `{type:'peers',peers}`, `{type:'join',id}`,
`{type:'leave',id}`, `{type:'signal',from,data}`; clients send `{type:'signal',to,data}`. Messages over
256 KB are dropped. No auth: choose long random room names. See docs/COLLAB.md.
