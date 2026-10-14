// WebRTC transport: one reliable, ordered data channel per peer. Large messages are fragmented,
// sends respect the channel's buffer (backpressure). Browser-only at use time (RTCPeerConnection),
// but importing this module is Node-safe.
import { Emitter } from '../core/util.js';

/** Public STUN only. For strict / symmetric NATs add a TURN server (see docs/COLLAB.md). */
export const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

export function iceServers() {
  try {
    const extra = JSON.parse(localStorage.getItem('daw3-collab-ice') || 'null');
    if (Array.isArray(extra) && extra.length) return [...DEFAULT_ICE_SERVERS, ...extra];
  } catch { /* no storage */ }
  return DEFAULT_ICE_SERVERS;
}

const FRAG = 60000; // chars per data-channel message
const HIGH_WATER = 1 << 20;
let fragSeq = 0;

export class PeerLink extends Emitter {
  /**
   * opts.initiator: create the data channel (offerer)
   * opts.trickle: emit 'signal' {t:'ice'} candidates; otherwise SDPs are returned after gathering
   */
  constructor({ initiator = false, trickle = false, servers = iceServers() } = {}) {
    super();
    this.trickle = trickle;
    this.pc = new RTCPeerConnection({ iceServers: servers });
    this.dc = null;
    this.open = false;
    this.closed = false;
    this.queue = [];
    this.frags = new Map();
    this.pc.onicecandidate = (e) => { if (this.trickle && e.candidate) this.emit('signal', { t: 'ice', c: e.candidate.toJSON() }); };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      this.emit('state', s);
      if (s === 'failed' || s === 'closed') this.close();
    };
    if (initiator) this._setup(this.pc.createDataChannel('daw3', { ordered: true }));
    else this.pc.ondatachannel = (e) => this._setup(e.channel);
  }

  _setup(dc) {
    this.dc = dc;
    dc.bufferedAmountLowThreshold = HIGH_WATER / 4;
    dc.onopen = () => { this.open = true; this.emit('open'); this._flush(); };
    dc.onclose = () => this.close();
    dc.onbufferedamountlow = () => this._flush();
    dc.onmessage = (e) => this._recv(e.data);
  }

  _gathered() {
    if (this.trickle || this.pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.pc.removeEventListener('icegatheringstatechange', check); resolve(); };
      const check = () => { if (this.pc.iceGatheringState === 'complete') done(); };
      const timer = setTimeout(done, 5000); // use what we have (host + srflx usually arrive fast)
      this.pc.addEventListener('icegatheringstatechange', check);
    });
  }

  async createOffer() {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await this._gathered();
    return this.pc.localDescription.sdp;
  }

  async acceptOffer(sdp) {
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await this._gathered();
    return this.pc.localDescription.sdp;
  }

  async acceptAnswer(sdp) { await this.pc.setRemoteDescription({ type: 'answer', sdp }); }

  async addIce(c) { try { await this.pc.addIceCandidate(c); } catch (e) { console.warn('[collab] ice', e.message); } }

  send(obj) {
    if (this.closed) return;
    const s = JSON.stringify(obj);
    if (s.length <= FRAG) this.queue.push(s);
    else {
      const id = (++fragSeq).toString(36);
      const n = Math.ceil(s.length / FRAG);
      for (let i = 0; i < n; i++) this.queue.push(`F|${id}|${i}|${n}|${s.slice(i * FRAG, (i + 1) * FRAG)}`);
    }
    this._flush();
  }

  _flush() {
    if (!this.open || !this.dc || this.dc.readyState !== 'open') return;
    while (this.queue.length && this.dc.bufferedAmount < HIGH_WATER) {
      try { this.dc.send(this.queue.shift()); } catch (e) { console.warn('[collab] send', e.message); this.close(); return; }
    }
  }

  _recv(data) {
    if (typeof data !== 'string') return;
    let text = data;
    if (data.startsWith('F|')) {
      const [, id, i, n] = data.split('|', 4);
      const head = `F|${id}|${i}|${n}|`.length;
      let f = this.frags.get(id);
      if (!f) this.frags.set(id, (f = { n: +n, parts: [] , got: 0 }));
      if (f.parts[+i] === undefined) { f.parts[+i] = data.slice(head); f.got++; }
      if (f.got < f.n) return;
      this.frags.delete(id);
      text = f.parts.join('');
    }
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    this.emit('message', msg);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    try { this.dc?.close(); } catch { /* ignore */ }
    try { this.pc.close(); } catch { /* ignore */ }
    this.emit('close');
  }
}
