// Hardware check (Node-safe logic): MIDI message decoding for the monitor, an MPE note tracker, control-surface
// handshake detection, test-pattern generators (fader sweep, LED test, scribble text) and the text report users
// paste back to us. The browser UI lives in src/ui/hardware-check.js (Preferences → Hardware check, Cmd+K).
import { parseMessage, bendNorm } from './midi.js';
import { MCU_STRIP_BUTTONS, MCU_BUTTONS } from './surface-protocol.js';

const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteLabel = (n) => `${NOTE[n % 12]}${Math.floor(n / 12) - 1}`;
const CC_NAMES = { 0: 'Bank MSB', 1: 'Mod wheel', 2: 'Breath', 4: 'Foot', 5: 'Portamento time', 6: 'Data entry', 7: 'Volume', 10: 'Pan', 11: 'Expression', 32: 'Bank LSB', 64: 'Sustain', 65: 'Portamento', 66: 'Sostenuto', 67: 'Soft pedal', 71: 'Resonance', 74: 'Brightness / MPE timbre', 96: 'Data +', 97: 'Data −', 98: 'NRPN LSB', 99: 'NRPN MSB', 100: 'RPN LSB', 101: 'RPN MSB', 120: 'All sound off', 121: 'Reset controllers', 123: 'All notes off' };
export const hex = (data) => Array.from(data || [], (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

/** One MIDI message -> { type (short tag), text (human), ch (1-16 | null), quiet (clock / sensing) }. */
export function decodeMidi(data) {
  const m = parseMessage(data);
  const ch = m.ch != null ? m.ch + 1 : null;
  const c = ch ? `ch ${ch} · ` : '';
  switch (m.type) {
    case 'noteon': return { type: 'Note on', ch, text: `${c}${noteLabel(m.note)} (${m.note}) vel ${m.vel}` };
    case 'noteoff': return { type: 'Note off', ch, text: `${c}${noteLabel(m.note)} (${m.note})${m.vel ? ` vel ${m.vel}` : ''}` };
    case 'polyat': return { type: 'Poly pressure', ch, text: `${c}${noteLabel(m.note)} = ${m.value}` };
    case 'cc': return { type: 'CC', ch, text: `${c}CC ${m.cc}${CC_NAMES[m.cc] ? ` ${CC_NAMES[m.cc]}` : ''} = ${m.value}` };
    case 'pc': return { type: 'Program', ch, text: `${c}program ${m.value + 1}` };
    case 'chanat': return { type: 'Channel pressure', ch, text: `${c}${m.value}` };
    case 'pb': { const v = bendNorm(m.value); return { type: 'Pitch bend', ch, text: `${c}${m.value} (${v >= 0 ? '+' : ''}${v.toFixed(3)})` }; }
    case 'clock': return { type: 'Clock', ch: null, text: 'timing clock (24 ppqn)', quiet: true };
    case 'start': return { type: 'Start', ch: null, text: 'transport start' };
    case 'continue': return { type: 'Continue', ch: null, text: 'transport continue' };
    case 'stop': return { type: 'Stop', ch: null, text: 'transport stop' };
    case 'spp': return { type: 'Song position', ch: null, text: `${m.value} sixteenths (beat ${m.value / 4})` };
    case 'mtc': return { type: 'MTC', ch: null, text: `quarter frame ${m.value >> 4}: ${m.value & 15}`, quiet: true };
    case 'sense': return { type: 'Active sensing', ch: null, text: 'keep-alive', quiet: true };
    case 'sysex': {
      const s = surfaceReply([...data]);
      return { type: 'SysEx', ch: null, text: `${data.length} bytes${s ? ` — ${s.label}` : ''}` };
    }
    default: return { type: 'Other', ch: null, text: hex(data) };
  }
}

/**
 * MPE view: tracks per-note expression from member-channel messages. feed(data) -> true when the view changed.
 * notes(): [{ ch (1-16), note, vel, bend (semitones), pressure 0..1, timbre 0..1 }]; zone: lower (master ch 1).
 */
export class MpeTracker {
  constructor({ bendRange = 48 } = {}) { this.bendRange = bendRange; this.byCh = new Map(); this.seenMember = false; }
  feed(data) {
    const m = parseMessage(data);
    if (m.ch == null) return false;
    const ch = m.ch + 1;
    if (ch >= 2) this.seenMember = this.seenMember || m.type === 'noteon';
    const cur = this.byCh.get(ch);
    switch (m.type) {
      case 'noteon': this.byCh.set(ch, { ch, note: m.note, vel: m.vel, bend: 0, pressure: 0, timbre: 0.5 }); return true;
      case 'noteoff': if (cur && cur.note === m.note) { this.byCh.delete(ch); return true; } return false;
      case 'pb': if (cur) { cur.bend = +(bendNorm(m.value) * this.bendRange).toFixed(2); return true; } return false;
      case 'chanat': if (cur) { cur.pressure = +(m.value / 127).toFixed(3); return true; } return false;
      case 'polyat': if (cur && cur.note === m.note) { cur.pressure = +(m.value / 127).toFixed(3); return true; } return false;
      case 'cc': if (cur && m.cc === 74) { cur.timbre = +(m.value / 127).toFixed(3); return true; } return false;
      default: return false;
    }
  }
  notes() { return [...this.byCh.values()].sort((a, b) => a.ch - b.ch); }
  get isMpe() { return this.seenMember; }
}

// ------------------------------------------------------------------------------------------- control surfaces
export const MCU_QUERY = [0xf0, 0x00, 0x00, 0x66, 0x14, 0x00, 0xf7]; // device query (MCU); XT: 0x15
export const MCU_XT_QUERY = [0xf0, 0x00, 0x00, 0x66, 0x15, 0x00, 0xf7];
export const HUI_PING = [0x90, 0x00, 0x00];

/** A surface's reply to the handshake: MCU host-connection query (… 66 14|15 01 <serial> …) / version reply, HUI ping reply. */
export function surfaceReply(data) {
  if (!data?.length) return null;
  if (data[0] === 0x90 && data[1] === 0x00 && data[2] === 0x7f) return { kind: 'hui', label: 'HUI ping reply' };
  if (data[0] === 0xf0 && data[1] === 0x00 && data[2] === 0x00 && data[3] === 0x66) {
    const id = data[4], cmd = data[5];
    const kind = id === 0x15 ? 'mcu-xt' : id === 0x14 || id === 0x10 || id === 0x11 ? 'mcu' : null;
    if (!kind) return null;
    if (cmd === 0x01) return { kind, label: `${kind === 'mcu-xt' ? 'Mackie XT' : 'Mackie Control'} host-connection query (serial ${hex(data.slice(6, 13))})`, serial: data.slice(6, 13) };
    if (cmd === 0x14 || cmd === 0x13) return { kind, label: `${kind === 'mcu-xt' ? 'Mackie XT' : 'Mackie Control'} version reply` };
    if (cmd === 0x03 || cmd === 0x04) return { kind, label: `${kind === 'mcu-xt' ? 'Mackie XT' : 'Mackie Control'} connection ${cmd === 0x03 ? 'confirmed' : 'error'}` };
    return { kind, label: 'Mackie SysEx' };
  }
  return null;
}

/**
 * The MCU host-connection reply: when the device sends its query (01 + serial + challenge), the host answers
 * 02 + serial + response (the challenge response from the Logic Control docs, as Ardour implements it). Many
 * surfaces also work without it; we send it anyway.
 */
export function mcuConnectionReply(query) {
  const id = query[4], serial = query.slice(6, 13), l = query.slice(13, 17);
  if (serial.length < 7 || l.length < 4) return null;
  const r = [
    0x7f & (l[0] + (l[1] ^ 0x0a) - l[3]),
    0x7f & ((l[2] >> l[3]) ^ (l[0] + l[3])),
    0x7f & (l[3] - (l[2] << 2) ^ (l[0] | l[1])),
    0x7f & (l[1] - l[2] + (0xf0 ^ (l[3] << 4))),
  ];
  return [0xf0, 0x00, 0x00, 0x66, id, 0x02, ...serial, ...r, 0xf7];
}

/** Fader sweep frames for a protocol: `steps` positions up and back down on strips 0..7 (+ master on MCU). */
export function faderSweepFrames(proto, { steps = 16, strips = 8 } = {}) {
  const frames = [];
  const curve = [...Array(steps + 1).keys()].map((i) => i / steps);
  for (const v of [...curve, ...curve.slice(0, -1).reverse()]) {
    const msgs = [];
    for (let s = 0; s < strips; s++) msgs.push(...proto.fader(s, s % 2 ? 1 - v : v));
    if (proto.name !== 'HUI') msgs.push(...proto.fader(8, v));
    frames.push(msgs);
  }
  return frames;
}

/** LED test: every strip LED (and the transport / mode LEDs) on, then off. -> [onFrame, offFrame] */
export function ledTestFrames(proto, { strips = 8 } = {}) {
  const names = Object.keys(MCU_STRIP_BUTTONS).filter((n) => n !== 'vpotPush');
  const global = ['play', 'stop', 'record', 'cycle', 'click', 'rewind', 'forward', 'flip', 'readOff', 'write', 'touch', 'latch', 'marker', 'assignPan', 'assignSend', 'assignPlugin'].filter((n) => n in MCU_BUTTONS);
  const frame = (state) => {
    const out = [];
    for (let s = 0; s < strips; s++) for (const n of names) out.push(...proto.led(n, s, state));
    for (const n of global) out.push(...proto.led(n, null, state));
    for (let s = 0; s < strips; s++) out.push(...proto.ring(s, state ? 1 : 0, 2));
    return out;
  };
  return [frame(1), frame(0)];
}

/** Scribble-strip test text: strip numbers on the top row, a message across the bottom. */
export function scribbleTestFrames(proto, text = 'daW3 hardware check') {
  const out = [];
  for (let s = 0; s < 8; s++) out.push(...proto.scribble(s, 0, `Strip ${s + 1}`));
  const msg = String(text).padEnd(56, ' ');
  for (let s = 0; s < 8; s++) out.push(...proto.scribble(s, 1, msg.slice(s * 7, s * 7 + 7)));
  out.push(...proto.timecode('  1. 1. 1.000'), ...proto.assignment('HW'));
  return out;
}

// ------------------------------------------------------------------------------------------- audio helpers
/** Peak (linear) -> dBFS, floored at -120. */
export const toDb = (x) => (x > 1e-6 ? 20 * Math.log10(x) : -120);

/** Round-trip latency verdict for the report: measured ms vs. the browser's estimate. */
export function latencyVerdict(measuredMs, estimateMs) {
  if (!Number.isFinite(measuredMs)) return { status: 'skip', text: 'not measured (needs a loopback cable: output → input)' };
  const diff = Number.isFinite(estimateMs) ? measuredMs - estimateMs : null;
  const ok = measuredMs > 0 && measuredMs < 250;
  return { status: ok ? 'pass' : 'fail', text: `${measuredMs.toFixed(1)} ms round trip${diff != null ? ` (browser estimate ${estimateMs.toFixed(1)} ms, ${diff >= 0 ? '+' : ''}${diff.toFixed(1)} ms)` : ''}` };
}

// ------------------------------------------------------------------------------------------- report
/** Overall status of a section from its checks: any fail -> fail, all pass/skip with ≥1 pass -> pass. */
export function sectionStatus(checks) {
  const st = (checks || []).map((c) => c.status);
  if (st.includes('fail')) return 'fail';
  if (st.includes('pass')) return st.includes('pending') ? 'pending' : 'pass';
  if (st.length && st.every((s) => s === 'skip')) return 'skip';
  return 'pending';
}

const MARK = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP', pending: '----' };
/**
 * Text report: sections [{ title, checks: [{ name, status, text }], details?: [lines] }] + env { ua, app, date }.
 * Plain text so it can be pasted into an issue / chat.
 */
export function buildReport(sections, env = {}) {
  const lines = [`daW³ hardware check — ${env.date || new Date().toISOString()}`];
  if (env.app) lines.push(`App: ${env.app}`);
  if (env.ua) lines.push(`Browser: ${env.ua}`);
  if (env.extra) for (const l of env.extra) lines.push(l);
  for (const s of sections) {
    const status = s.status || sectionStatus(s.checks);
    lines.push('', `[${MARK[status] || status}] ${s.title}`);
    for (const c of s.checks || []) lines.push(`  ${MARK[c.status] || c.status}  ${c.name}${c.text ? ` — ${c.text}` : ''}`);
    for (const d of s.details || []) lines.push(`    ${d}`);
  }
  return lines.join('\n');
}
