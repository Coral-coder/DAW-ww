// Ableton Link client — talks to the optional companion bridge (tools/link-bridge) over a local WebSocket.
// Follows / sets the session tempo, starts on the next quantum boundary, start/stop sync, phase nudging.
//
// host: { bpm(), setBpm(bpm), playing(), beat() (playhead, beats), play(), stop(), setBeat(beat), now() ms }
// receive(state) is the single entry point for bridge state (the Mac app can call it directly, see README).
// opts.start: async () => url | null — the Mac app starts its built-in Link (daw3-link) and says where it listens.
import { Emitter } from '../core/util.js';

export const LINK_DEFAULT_URL = 'ws://127.0.0.1:20809';
const PHASE_TOLERANCE = 0.25; // beats (a 16th) before the playhead is nudged

/** Signed phase error (beats) of a local beat against the Link phase, wrapped to (-quantum/2, quantum/2]. */
export function linkPhaseError(localBeat, linkPhase, quantum = 4) {
  const local = ((localBeat % quantum) + quantum) % quantum;
  let d = linkPhase - local;
  if (d > quantum / 2) d -= quantum;
  if (d <= -quantum / 2) d += quantum;
  return d;
}

export class LinkClient extends Emitter {
  constructor(host, { url = LINK_DEFAULT_URL, WebSocketImpl = typeof WebSocket !== 'undefined' ? WebSocket : null, start = null } = {}) {
    super();
    this.host = host;
    this.url = url;
    this.WS = WebSocketImpl;
    this.start = start;
    this.ws = null;
    this.state = null;
    this.status = 'off'; // 'off' | 'connecting' | 'connected' | 'error'
    this.wanted = false;
    this.retry = 0;
    this.pendingStart = 0;
    this.lastTempoSent = null;
    this.transport = { send: (obj) => { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj)); } };
  }

  connect(url = this.url) {
    this.url = url;
    this.wanted = true;
    if (!this.WS) { this._status('error', 'WebSocket unavailable'); return; }
    if (this.start && url === LINK_DEFAULT_URL) {
      // built-in Link (Mac app): start it, then connect wherever it listens
      this._status('connecting');
      Promise.resolve().then(() => this.start()).then((u) => { if (this.wanted && !this.ws) this._open(u || url); },
        (e) => { this._status('error', `Link could not start: ${e?.message || e}`); });
      return;
    }
    this._open(url);
  }

  _open(url) {
    try { this.ws?.close(); } catch { /* */ }
    this._status('connecting');
    const ws = new this.WS(url);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this._status('connected'); this.transport.send({ type: 'hello', client: 'daw3' }); };
    ws.onmessage = (e) => { try { this.receive(JSON.parse(e.data)); } catch { /* ignore junk */ } };
    ws.onerror = () => this._status('error', `No Link bridge at ${url} — run node tools/link-bridge/link-bridge.mjs`);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.wanted) {
        this._status('connecting');
        const ms = Math.min(10000, 500 * 2 ** this.retry++);
        setTimeout(() => { if (this.wanted && !this.ws) this.connect(this.url); }, ms);
      } else this._status('off');
    };
  }
  disconnect() { this.wanted = false; clearTimeout(this.pendingStart); try { this.ws?.close(); } catch { /* */ } this.ws = null; this.state = null; this._status('off'); }
  _status(s, msg) { this.status = s; this.emit('status', { status: s, message: msg || null }); }

  /** Bridge state in. */
  receive(st) {
    if (st?.type !== 'state') return;
    const prev = this.state;
    this.state = { ...st, recv: this.host.now() };
    const h = this.host;
    // tempo: Link is the master while connected
    if (Number.isFinite(st.tempo) && Math.abs(st.tempo - h.bpm()) > 0.005 && Math.abs(st.tempo - (this.lastTempoSent ?? -1)) > 0.005) h.setBpm(+st.tempo.toFixed(2));
    // start / stop sync
    if (st.playing && !h.playing() && !this.pendingStart) this._scheduleStart(st);
    if (!st.playing && prev?.playing && h.playing()) h.stop();
    // phase: nudge when the playhead drifts
    if (st.playing && h.playing() && Number.isFinite(st.phase)) {
      const age = (h.now() - this.state.recv) / 60000 * st.tempo; // ~0: state is fresh
      const err = linkPhaseError(h.beat(), (st.phase + age) % st.quantum, st.quantum);
      if (Math.abs(err) > PHASE_TOLERANCE) h.setBeat(Math.max(0, h.beat() + err));
    }
    this.emit('state', this.state);
  }

  _scheduleStart(st) {
    const q = st.quantum || 4;
    const toNext = (q - (((st.phase % q) + q) % q)) % q || q;
    const ms = (toNext * 60000) / st.tempo;
    this.pendingStart = setTimeout(() => {
      this.pendingStart = 0;
      if (!this.state?.playing || this.host.playing()) return;
      const b = this.host.beat();
      this.host.setBeat(Math.ceil(b / q - 1e-6) * q); // start on a bar of our own timeline too
      this.host.play();
    }, Math.max(0, ms - 5));
  }

  /** Local changes out (call when the user changes tempo / transport in daW³). */
  sendTempo(bpm) { if (this.status === 'connected') { this.lastTempoSent = bpm; this.transport.send({ type: 'tempo', bpm }); setTimeout(() => { this.lastTempoSent = null; }, 300); } }
  sendPlay(on) { if (this.status === 'connected' && !!this.state?.playing !== !!on) this.transport.send({ type: on ? 'play' : 'stop' }); }
}
