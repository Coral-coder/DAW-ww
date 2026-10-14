// Pluggable signaling adapters. A session only needs someone to carry a few small messages
// (SDP offers/answers, ICE candidates) between peers before the WebRTC data channels open.
//
// Adapter interface (all adapters are Emitters):
//   await adapter.connect(room, selfId)   join a room
//   adapter.send(peerId, data)            deliver a JSON-able signal to one peer in the room
//   adapter.close()
//   events: 'peers' (ids already in the room, on connect) · 'join' (id) · 'leave' (id)
//           'signal' (fromId, data) · 'error' (Error) · 'closed'
//
// Implementations:
//   RelaySignaling      — the tiny optional WebSocket relay in tools/collab-relay (deploy anywhere)
//   BroadcastSignaling  — same-browser tabs via BroadcastChannel (zero infra; demos / testing)
// The manual copy-paste invite flow (invite.js) needs no adapter at all.
import { Emitter } from '../core/util.js';

export class RelaySignaling extends Emitter {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
  }

  connect(room, selfId) {
    return new Promise((resolve, reject) => {
      let u;
      try {
        u = new URL(this.url);
        u.searchParams.set('room', room);
        u.searchParams.set('id', selfId);
      } catch { reject(new Error('Invalid relay URL')); return; }
      const ws = new WebSocket(u.toString());
      this.ws = ws;
      let opened = false;
      const timer = setTimeout(() => { if (!opened) { ws.close(); reject(new Error('Relay did not answer')); } }, 8000);
      ws.onopen = () => { opened = true; clearTimeout(timer); resolve(); };
      ws.onerror = () => { if (!opened) { clearTimeout(timer); reject(new Error('Could not reach the relay')); } else this.emit('error', new Error('Relay connection error')); };
      ws.onclose = () => this.emit('closed');
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'peers') this.emit('peers', m.peers || []);
        else if (m.type === 'join') this.emit('join', m.id);
        else if (m.type === 'leave') this.emit('leave', m.id);
        else if (m.type === 'signal') this.emit('signal', m.from, m.data);
        else if (m.type === 'error') this.emit('error', new Error(m.message || 'relay error'));
      };
    });
  }

  send(to, data) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'signal', to, data }));
  }

  close() { try { this.ws?.close(); } catch { /* ignore */ } this.ws = null; }
}

export class BroadcastSignaling extends Emitter {
  constructor(channelName = 'daw3-collab-signal') { super(); this.channelName = channelName; this.bc = null; }

  async connect(room, selfId) {
    this.room = room;
    this.self = selfId;
    this.bc = new BroadcastChannel(`${this.channelName}:${room}`);
    const known = new Set();
    this.bc.onmessage = (e) => {
      const m = e.data || {};
      if (m.from === selfId) return;
      if (m.type === 'hello') { if (!known.has(m.from)) { known.add(m.from); this.emit('join', m.from); } this.bc.postMessage({ type: 'here', from: selfId, to: m.from }); }
      else if (m.type === 'here' && m.to === selfId) { if (!known.has(m.from)) { known.add(m.from); this.emit('peers', [m.from]); } }
      else if (m.type === 'bye') { known.delete(m.from); this.emit('leave', m.from); }
      else if (m.type === 'signal' && m.to === selfId) this.emit('signal', m.from, m.data);
    };
    this.bc.postMessage({ type: 'hello', from: selfId });
  }

  send(to, data) { this.bc?.postMessage({ type: 'signal', from: this.self, to, data }); }

  close() { try { this.bc?.postMessage({ type: 'bye', from: this.self }); this.bc?.close(); } catch { /* ignore */ } this.bc = null; this.emit('closed'); }
}
