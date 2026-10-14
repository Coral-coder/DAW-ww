// Collaboration session: peers, message routing, presence, chat, activity, soft locks, sample
// transfer and sync-play on top of the store bridge (bridge.js) and WebRTC links (net.js).
//
// Wire messages (JSON over the data channel, see docs/COLLAB.md):
//   { mid, src, to?, ttl, type, ... } — `to` = directed, otherwise broadcast. Messages are flooded
//   to links that may not reach the sender directly (star topology of the manual invite flow:
//   the host forwards), and de-duplicated by `mid`.
//   hello {name,color,docId,links} · sync {docId,state} · ops {ops,label} · presence {...}
//   chat {text} · sreq {hash} · schunk {hash,i,n,d} · snone {hash} · transport {playing,beat,bpm} · bye
import { Emitter, uid } from '../core/util.js';
import { CollabBridge, touchedTracks } from './bridge.js';
import { PeerLink } from './net.js';
import { encodeSignal, decodeSignal, minifySdp } from './invite.js';
import { chunkSample, ChunkAssembler } from './samples.js';

export const PEER_COLORS = ['#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8', '#ff922b', '#20c997', '#f06595'];
export const MAX_PEERS = 6;
const LOCK_MS = 8000; // a track counts as "being edited" this long after someone touched it
const PEER_TIMEOUT = 15000;

export function colorFor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PEER_COLORS[h % PEER_COLORS.length];
}

export class CollabSession extends Emitter {
  constructor(store, { name = 'Guest', color = null, now = () => Date.now() } = {}) {
    super();
    this.store = store;
    this.id = uid('p').replace(/[^a-z0-9_]/gi, '');
    this.name = name;
    this.color = color || colorFor(this.id);
    this.now = now;
    this.bridge = new CollabBridge(store, { replica: this.id });
    this.docId = null;
    this.active = false;
    this.links = new Map(); // peerId -> PeerLink
    this.pendingInvites = new Map(); // slot -> PeerLink (host, manual flow)
    this.peers = new Map(); // peerId -> { id, name, color, presence, lastSeen, editing:{trackId:at}, links:[] }
    this.chat = [];
    this.activity = [];
    this.presence = {};
    this.signaling = null;
    this.seen = new Set();
    this.seenOrder = [];
    this.seq = 0;
    this.assembler = new ChunkAssembler();
    this.sampleReqs = new Map(); // hash -> { tried:Set, at }
    this._presenceTimer = null;
    this._presenceDirty = false;
    this._beat = null;
    this.bridge.on('ops', (ops, label) => {
      this.broadcast({ type: 'ops', ops, label });
      this._noteEditing(this.id, ops);
    });
    this.bridge.on('need-sample', (hash) => this._requestSample(hash));
  }

  // ------------------------------------------------------------------ lifecycle
  /** Start a new shared session from the current project (you are the host). */
  start() {
    if (this.active) return;
    this.docId = uid('ses');
    this.bridge.attach();
    this.bridge.seed();
    this._activate();
    this._log(this.id, 'started the session');
  }

  _activate() {
    this.active = true;
    clearInterval(this._beat);
    this._beat = setInterval(() => this._heartbeat(), 2000);
    this.emit('status');
  }

  leave() {
    this.broadcast({ type: 'bye' });
    for (const l of this.links.values()) l.close();
    for (const l of this.pendingInvites.values()) l.close();
    this.links.clear();
    this.pendingInvites.clear();
    this.peers.clear();
    this.signaling?.close();
    this.signaling = null;
    clearInterval(this._beat);
    this.bridge.detach();
    this.active = false;
    this.docId = null;
    this.emit('status');
    this.emit('peers');
  }

  // ------------------------------------------------------------------ manual invite flow
  /** Host: create an invite code for one more person. Resolves to the code (paste it to them). */
  async createInvite() {
    if (!this.active) this.start();
    if (this.links.size + this.pendingInvites.size >= MAX_PEERS - 1) throw new Error(`Sessions are limited to ${MAX_PEERS} people.`);
    const slot = uid('slot');
    const link = new PeerLink({ initiator: true });
    this.pendingInvites.set(slot, link);
    const sdp = minifySdp(await link.createOffer());
    return encodeSignal({ t: 'offer', from: this.id, name: this.name, session: this.docId, slot, sdp });
  }

  /** Guest: paste the host's invite code; resolves to the answer code to send back. */
  async acceptInvite(code) {
    const sig = await decodeSignal(code);
    if (sig.t !== 'offer') throw new Error('That is an answer code — paste it on the host side.');
    if (this.links.has(sig.from)) throw new Error('Already connected to that person.');
    const link = new PeerLink({ initiator: false });
    const sdp = minifySdp(await link.acceptOffer(sig.sdp));
    this._addLink(sig.from, link, { name: sig.name });
    return encodeSignal({ t: 'answer', from: this.id, name: this.name, slot: sig.slot, sdp });
  }

  /** Host: paste the guest's answer code to finish connecting. */
  async acceptAnswer(code) {
    const sig = await decodeSignal(code);
    if (sig.t !== 'answer') throw new Error('That is an invite code — it goes to the person joining.');
    const link = this.pendingInvites.get(sig.slot);
    if (!link) throw new Error('This answer does not match an open invite (create a new invite).');
    this.pendingInvites.delete(sig.slot);
    await link.acceptAnswer(sig.sdp);
    this._addLink(sig.from, link, { name: sig.name });
  }

  // ------------------------------------------------------------------ signaling adapter flow
  /**
   * Join a room through a signaling adapter (signaling.js). host=true seeds the session from the
   * current project; otherwise the project is replaced by the room's once connected.
   */
  async joinRoom(adapter, room, { host = false } = {}) {
    if (host && !this.active) this.start();
    this.signaling = adapter;
    adapter.on('peers', (ids) => { for (const id of ids) this._callPeer(id); });
    adapter.on('signal', (from, data) => this._onSignal(from, data));
    adapter.on('leave', (id) => this.links.get(id)?.close());
    await adapter.connect(room, this.id);
    if (!this.active) this.emit('status');
  }

  async _callPeer(id) {
    if (this.links.has(id) || id === this.id || this.links.size >= MAX_PEERS - 1) return;
    const link = new PeerLink({ initiator: true, trickle: true });
    link.on('signal', (s) => this.signaling?.send(id, s));
    this._addLink(id, link, {});
    const sdp = await link.createOffer();
    this.signaling?.send(id, { t: 'offer', sdp, name: this.name });
  }

  async _onSignal(from, data) {
    try {
      if (data.t === 'offer') {
        if (this.links.has(from)) this.links.get(from).close();
        const link = new PeerLink({ initiator: false, trickle: true });
        link.on('signal', (s) => this.signaling?.send(from, s));
        this._addLink(from, link, { name: data.name });
        const sdp = await link.acceptOffer(data.sdp);
        this.signaling?.send(from, { t: 'answer', sdp });
      } else if (data.t === 'answer') await this.links.get(from)?.acceptAnswer(data.sdp);
      else if (data.t === 'ice') await this.links.get(from)?.addIce(data.c);
    } catch (e) { console.warn('[collab] signal', e); }
  }

  // ------------------------------------------------------------------ links & routing
  _addLink(peerId, link, info) {
    this.links.set(peerId, link);
    this._peer(peerId, info);
    link.on('open', () => {
      this._send(link, this._wrap({ type: 'hello', ...this._helloBody() }));
      if (this.docId) this._send(link, this._wrap({ type: 'sync', docId: this.docId, state: this.bridge.doc.state() }));
      this._sendPresenceNow();
      this.emit('peers');
      this.emit('link-open', peerId);
    });
    link.on('message', (m) => this._onWire(peerId, m));
    link.on('close', () => {
      if (this.links.get(peerId) === link) this.links.delete(peerId);
      const p = this.peers.get(peerId);
      if (p) { this._log(peerId, 'left'); this.peers.delete(peerId); }
      this.emit('peers');
    });
  }

  _helloBody() { return { name: this.name, color: this.color, docId: this.docId, links: [...this.links.keys()] }; }

  _peer(id, info = {}) {
    let p = this.peers.get(id);
    if (!p) { p = { id, name: info.name || 'Someone', color: info.color || colorFor(id), presence: {}, lastSeen: this.now(), editing: {}, links: [] }; this.peers.set(id, p); }
    for (const k of ['name', 'color']) if (info[k]) p[k] = info[k];
    if (Array.isArray(info.links)) p.links = info.links;
    p.lastSeen = this.now();
    return p;
  }

  _wrap(body, to = null) {
    const m = { mid: `${this.id}:${(++this.seq).toString(36)}`, src: this.id, ttl: 3, ...body };
    if (to) m.to = to;
    this._markSeen(m.mid);
    return m;
  }

  _markSeen(mid) {
    this.seen.add(mid);
    this.seenOrder.push(mid);
    if (this.seenOrder.length > 5000) this.seen.delete(this.seenOrder.shift());
  }

  _send(link, m) { link.send(m); }

  broadcast(body) {
    if (!this.links.size) return;
    const m = this._wrap(body);
    for (const l of this.links.values()) l.send(m);
  }

  sendTo(peerId, body) {
    const m = this._wrap(body, peerId);
    const direct = this.links.get(peerId);
    if (direct) direct.send(m);
    else for (const l of this.links.values()) l.send(m); // someone will forward
  }

  _onWire(viaPeer, m) {
    if (!m || typeof m.mid !== 'string' || this.seen.has(m.mid)) return;
    this._markSeen(m.mid);
    // forward (star topology / partial mesh)
    if (m.ttl > 1 && m.to !== this.id) {
      const fwd = { ...m, ttl: m.ttl - 1 };
      if (m.to && this.links.has(m.to)) this.links.get(m.to).send(fwd);
      else for (const [pid, l] of this.links) {
        if (pid === viaPeer || pid === m.src) continue;
        const knows = this.peers.get(pid)?.links || [];
        if (!knows.includes(m.src)) l.send(fwd);
      }
    }
    if (m.to && m.to !== this.id) return;
    if (m.src === this.id) return;
    try { this._handle(m); } catch (e) { console.error('[collab] message', m.type, e); }
  }

  _handle(m) {
    const p = this._peer(m.src);
    switch (m.type) {
      case 'hello': {
        const isNew = !p.helloed;
        this._peer(m.src, m);
        p.helloed = true;
        if (isNew) this._log(m.src, 'joined');
        this.emit('peers');
        break;
      }
      case 'sync': {
        if (!this.docId) {
          this.docId = m.docId;
          this.bridge.adopt(m.state);
          this.bridge.attach();
          this._activate();
          this.emit('joined');
          // tell everyone else we exist with the session id now
          this.broadcast({ type: 'hello', ...this._helloBody() });
        } else if (m.docId === this.docId) this.bridge.mergeState(m.state);
        else console.warn('[collab] ignoring sync from another session');
        break;
      }
      case 'ops': {
        if (m.docId && m.docId !== this.docId) break;
        if (!this.docId) break;
        this.bridge.applyRemote(m.ops);
        const tracks = this._noteEditing(m.src, m.ops);
        this._log(m.src, m.label || 'edit', tracks);
        break;
      }
      case 'presence': p.presence = m.p || {}; this.emit('presence', m.src); break;
      case 'chat': {
        const entry = { from: m.src, name: p.name, color: p.color, text: String(m.text || '').slice(0, 2000), at: this.now() };
        this.chat.push(entry);
        if (this.chat.length > 500) this.chat.shift();
        this.emit('chat', entry);
        break;
      }
      case 'sreq': {
        const data = this.bridge.getSample(m.hash);
        if (!data) { this.sendTo(m.src, { type: 'snone', hash: m.hash }); break; }
        for (const c of chunkSample(m.hash, data)) this.sendTo(m.src, { type: 'schunk', ...c });
        break;
      }
      case 'schunk': {
        const r = this.assembler.add(m);
        if (r.done) {
          if (r.ok) { this.sampleReqs.delete(m.hash); this.bridge.receiveSample(m.hash, r.data); this.emit('sample', m.hash); }
          else { console.warn('[collab] sample failed verification, retrying'); this._requestSample(m.hash, m.src); }
        } else this.emit('sample-progress', m.hash, r.received, r.total);
        break;
      }
      case 'snone': this._requestSample(m.hash, m.src); break;
      case 'transport': this.emit('transport', { from: m.src, name: p.name, playing: !!m.playing, beat: +m.beat || 0, bpm: m.bpm }); break;
      case 'bye': this.peers.delete(m.src); this._log(m.src, 'left'); this.emit('peers'); break;
      default: break;
    }
  }

  // ------------------------------------------------------------------ samples on demand
  _requestSample(hash, failedPeer = null) {
    if (this.bridge.hasSample(hash)) return;
    let r = this.sampleReqs.get(hash);
    if (!r) this.sampleReqs.set(hash, (r = { tried: new Set() }));
    if (failedPeer) r.tried.add(failedPeer);
    const candidates = [...this.peers.keys()].filter((id) => !r.tried.has(id));
    const direct = candidates.find((id) => this.links.has(id));
    const target = direct || candidates[0];
    if (!target) { r.tried.clear(); r.waiting = true; return; } // retried on the next heartbeat
    r.waiting = false;
    r.tried.add(target);
    r.at = this.now();
    this.assembler.drop(hash);
    this.sendTo(target, { type: 'sreq', hash });
  }

  // ------------------------------------------------------------------ presence / soft locks
  setPresence(partial) {
    Object.assign(this.presence, partial);
    if (!this.active) return;
    this._presenceDirty = true;
    if (this._presenceTimer) return;
    this._presenceTimer = setTimeout(() => { this._presenceTimer = null; if (this._presenceDirty) this._sendPresenceNow(); }, 60);
  }

  _sendPresenceNow() {
    this._presenceDirty = false;
    this.broadcast({ type: 'presence', p: this.presence });
  }

  _heartbeat() {
    this.broadcast({ type: 'hello', ...this._helloBody() });
    const t = this.now();
    for (const [id, p] of this.peers) if (!this.links.has(id) && t - p.lastSeen > PEER_TIMEOUT) { this.peers.delete(id); this.emit('peers'); }
    for (const [hash, r] of this.sampleReqs) if (r.waiting || t - (r.at || 0) > 20000) this._requestSample(hash);
    this.emit('tick');
  }

  _noteEditing(peerId, ops) {
    const tracks = touchedTracks(ops, this.bridge.doc.view());
    const holder = peerId === this.id ? (this.myEditing ||= {}) : this.peers.get(peerId)?.editing;
    if (holder) for (const t of tracks) holder[t] = this.now();
    if (peerId === this.id) {
      const conflicts = this.lockHolders(tracks);
      if (conflicts.length) this.emit('lock-conflict', conflicts);
    }
    return tracks;
  }

  /** Who else is editing these tracks right now: [{ peer, trackId }]. */
  lockHolders(trackIds) {
    const out = [];
    const t = this.now();
    for (const p of this.peers.values()) {
      for (const id of trackIds) {
        const sel = p.presence?.trackId === id && p.presence?.editing;
        if (sel || t - (p.editing[id] || 0) < LOCK_MS) out.push({ peer: p, trackId: id });
      }
    }
    return out;
  }

  /** All soft locks: [{ peer, trackId }] (someone touched / is focused on the track). */
  locks() {
    const out = [];
    const t = this.now();
    for (const p of this.peers.values()) {
      const ids = new Set(Object.entries(p.editing).filter(([, at]) => t - at < LOCK_MS).map(([id]) => id));
      for (const id of ids) out.push({ peer: p, trackId: id });
    }
    return out;
  }

  // ------------------------------------------------------------------ chat / activity / transport
  sendChat(text) {
    const s = String(text || '').trim();
    if (!s) return;
    const entry = { from: this.id, name: this.name, color: this.color, text: s, at: this.now(), mine: true };
    this.chat.push(entry);
    this.broadcast({ type: 'chat', text: s });
    this.emit('chat', entry);
  }

  sendTransport(playing, beat, bpm) { this.broadcast({ type: 'transport', playing, beat, bpm }); }

  _log(peerId, what, tracks = []) {
    const p = peerId === this.id ? { name: this.name, color: this.color } : this.peers.get(peerId) || { name: 'Someone', color: '#888' };
    const last = this.activity[this.activity.length - 1];
    if (last && last.from === peerId && last.what === what && this.now() - last.at < 3000) { last.at = this.now(); last.count = (last.count || 1) + 1; this.emit('activity', last); return; }
    const entry = { from: peerId, name: p.name, color: p.color, what, tracks, at: this.now() };
    this.activity.push(entry);
    if (this.activity.length > 300) this.activity.shift();
    this.emit('activity', entry);
  }

  rename(name) {
    this.name = String(name || '').slice(0, 40) || 'Guest';
    this.broadcast({ type: 'hello', ...this._helloBody() });
    this.emit('peers');
  }

  connectedCount() { return [...this.links.values()].filter((l) => l.open).length; }
}
