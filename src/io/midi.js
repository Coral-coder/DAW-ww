// Standard MIDI File import/export (zero dependencies).
//
//   exportMidi(project, {mode:'song'|'pattern', ppq=480}) -> Uint8Array   (SMF format 1)
//   importMidi(arrayBuffer) -> { format, ppq, bpm, timeSig, tracks:[{name, channel, isDrums, program, notes}] }
//   addMidiToProject(project, parsed) -> { trackIds } (mutates project; call inside store.transact)
import {
  beatsPerBar, songLengthBeats, patternsForTrack, createTrack, createPattern, createNote, createClip, TRACK_COLORS,
} from '../core/model.js';
import { codeToPatterns } from '../code/convert.js';

const DRUM_CHANNEL = 9;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ----------------------------------------------------------------------------------- writing

function vlq(n) {
  n = Math.max(0, Math.round(n));
  const out = [n & 0x7f];
  n = Math.floor(n / 128);
  while (n > 0) {
    out.unshift((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  return out;
}
const u16 = (n) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const ascii = (s) => Array.from(new TextEncoder().encode(String(s)));

function chunk(type, bytes) {
  return [...ascii(type), ...u32(bytes.length), ...bytes];
}

function metaText(type, text) {
  const b = ascii(text).slice(0, 255);
  return [0xff, type, ...vlq(b.length), ...b];
}

/** events: [{tick, order, bytes}] -> MTrk chunk bytes (adds End Of Track). */
function trackChunk(events) {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const bytes = [];
  let last = 0;
  for (const e of events) {
    const t = Math.max(last, Math.round(e.tick));
    bytes.push(...vlq(t - last), ...e.bytes);
    last = t;
  }
  bytes.push(0x00, 0xff, 0x2f, 0x00);
  return chunk('MTrk', bytes);
}

/** Notes (beats) of one track for the given mode. Pattern clips loop their pattern across the clip. */
export function collectTrackNotes(project, track, mode = 'pattern') {
  if (mode === 'song') {
    const out = [];
    for (const clip of project.clips || []) {
      if (clip.trackId !== track.id || clip.type === 'audio') continue;
      const pat = project.patterns?.[clip.patternId];
      if (!pat || !pat.notes?.length) continue;
      const len = pat.length > 0 ? pat.length : beatsPerBar(project);
      const offset = clip.offset || 0;
      const firstLoop = Math.floor(offset / len);
      const lastLoop = Math.ceil((offset + clip.length) / len);
      for (let k = firstLoop; k <= lastLoop; k++) {
        for (const n of pat.notes) {
          if (n.start >= len || n.start < 0) continue;
          const rel = k * len + n.start - offset;
          if (rel < -1e-9 || rel >= clip.length - 1e-9) continue;
          out.push({ pitch: n.pitch, start: clip.start + rel, dur: Math.min(n.dur, clip.length - rel), vel: n.vel * (clip.gain ?? 1) });
        }
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }
  const pat = project.patterns?.[track.activePatternId] || patternsForTrack(project, track.id)[0];
  if (!pat) return [];
  return pat.notes.filter((n) => n.start >= 0 && n.start < (pat.length || Infinity)).map((n) => ({ ...n }));
}

/**
 * Exports the project as a Standard MIDI File (format 1, one tempo track + one track per instrument).
 * mode 'song' expands arrangement clips; 'pattern' writes each track's active pattern once.
 * Code tracks are rendered (4 bars in pattern mode, the song length in song mode).
 */
export function exportMidi(project, { mode = project.mode === 'song' ? 'song' : 'pattern', ppq = 480 } = {}) {
  const tracks = [];
  const [num, den] = project.timeSig || [4, 4];
  const bpb = beatsPerBar(project);
  const tempo = Math.round(60000000 / (project.bpm || 120));
  const conductor = [];
  conductor.push({ tick: 0, order: 0, bytes: metaText(0x03, project.name || 'daW³') });
  conductor.push({ tick: 0, order: 1, bytes: [0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff] });
  conductor.push({ tick: 0, order: 2, bytes: [0xff, 0x58, 0x04, num & 0xff, Math.round(Math.log2(den)) & 0xff, 24, 8] });
  if (mode === 'song') {
    for (const m of project.markers || []) conductor.push({ tick: m.beat * ppq, order: 3, bytes: metaText(0x06, m.name || 'Marker') });
  }
  tracks.push(trackChunk(conductor));

  let nextChannel = 0;
  const allocChannel = () => {
    const ch = nextChannel % 15;
    nextChannel++;
    return ch >= DRUM_CHANNEL ? ch + 1 : ch; // skip channel 10 (index 9)
  };
  const songBeats = mode === 'song' ? songLengthBeats(project) : 4 * bpb;

  const parts = [];
  for (const track of project.tracks || []) {
    if (track.type === 'instrument') {
      const notes = collectTrackNotes(project, track, mode);
      if (!notes.length) continue;
      const isDrums = track.instrument?.type === 'drums';
      parts.push({ name: track.name, isDrums, notes });
    } else if (track.type === 'code' && track.code) {
      let groups = [];
      try {
        groups = codeToPatterns(track.code, { cycles: Math.max(1, Math.ceil(songBeats / bpb)), beatsPerCycle: bpb, trim: false });
      } catch { groups = []; }
      for (const g of groups) {
        if (!g.notes.length) continue;
        parts.push({ name: groups.length > 1 ? `${track.name} ${g.sound}` : track.name, isDrums: g.kind === 'drums', notes: g.notes });
      }
    }
  }
  for (const part of parts) {
    const ch = part.isDrums ? DRUM_CHANNEL : allocChannel();
    const evs = [{ tick: 0, order: 0, bytes: metaText(0x03, part.name || 'Track') }];
    for (const n of part.notes) {
      const pitch = clamp(Math.round(n.pitch), 0, 127);
      const on = Math.round(n.start * ppq);
      const off = Math.max(on + 1, Math.round((n.start + Math.max(0.001, n.dur)) * ppq));
      const vel = clamp(Math.round((n.vel ?? 0.8) * 127), 1, 127);
      evs.push({ tick: on, order: 2, bytes: [0x90 | ch, pitch, vel] });
      evs.push({ tick: off, order: 1, bytes: [0x80 | ch, pitch, 0x40] });
    }
    tracks.push(trackChunk(evs));
  }
  const header = chunk('MThd', [...u16(1), ...u16(tracks.length), ...u16(ppq)]);
  return new Uint8Array([...header, ...tracks.flat()]);
}

// ----------------------------------------------------------------------------------- reading

function toBytes(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  throw new Error('importMidi expects an ArrayBuffer or Uint8Array');
}

/** Parses a Standard MIDI File (format 0 or 1; format 2 is read as independent tracks). */
export function importMidi(arrayBuffer) {
  const data = toBytes(arrayBuffer);
  let pos = 0;
  const str = (p, n) => String.fromCharCode(...data.subarray(p, p + n));
  const rd32 = (p) => ((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) >>> 0;
  const rd16 = (p) => (data[p] << 8) | data[p + 1];
  if (data.length < 14 || str(0, 4) !== 'MThd') throw new Error('Not a MIDI file (missing MThd header).');
  const hlen = rd32(4);
  const format = rd16(8);
  const ntrks = rd16(10);
  const division = rd16(12);
  let ppq;
  if (division & 0x8000) {
    const fps = 256 - (division >> 8);
    const tpf = division & 0xff;
    ppq = (fps * tpf) / 2; // assume 120 bpm for SMPTE timing
  } else ppq = division || 480;
  pos = 8 + hlen;

  let bpm = null;
  let timeSig = null;
  const out = [];
  let trackIndex = 0;
  while (pos + 8 <= data.length && trackIndex < Math.max(ntrks, 1) + 64) {
    const type = str(pos, 4);
    const len = rd32(pos + 4);
    const start = pos + 8;
    const end = Math.min(data.length, start + len);
    pos = start + len;
    if (type !== 'MTrk') continue;
    trackIndex++;
    let p = start;
    let tick = 0;
    let running = null;
    let name = null;
    let instName = null;
    const open = new Map(); // (ch<<7|pitch) -> [{tick, vel}]
    const byChannel = new Map(); // ch -> notes
    const programs = new Map();
    const readVlq = () => {
      let v = 0;
      for (let k = 0; k < 4 && p < end; k++) {
        const b = data[p++];
        v = v * 128 + (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      return v;
    };
    const noteOff = (ch, pitch, t) => {
      const key = (ch << 7) | pitch;
      const q = open.get(key);
      if (!q || !q.length) return;
      const on = q.shift();
      if (!byChannel.has(ch)) byChannel.set(ch, []);
      byChannel.get(ch).push({ pitch, start: on.tick / ppq, dur: Math.max(1, t - on.tick) / ppq, vel: on.vel / 127 });
    };
    while (p < end) {
      tick += readVlq();
      if (p >= end) break;
      let status = data[p];
      if (status < 0x80) {
        if (running === null) throw new Error(`Corrupt MIDI data in track ${trackIndex} (running status without status byte).`);
        status = running;
      } else p++;
      if (status === 0xff) {
        const mtype = data[p++];
        const mlen = readVlq();
        const m = data.subarray(p, p + mlen);
        if (mtype === 0x03 && name === null) name = new TextDecoder().decode(m).trim();
        else if (mtype === 0x04 && instName === null) instName = new TextDecoder().decode(m).trim();
        else if (mtype === 0x51 && mlen >= 3 && bpm === null) bpm = 60000000 / ((m[0] << 16) | (m[1] << 8) | m[2]);
        else if (mtype === 0x58 && mlen >= 2 && timeSig === null) timeSig = [m[0], 2 ** m[1]];
        else if (mtype === 0x2f) { p += mlen; break; }
        p += mlen;
        running = null;
      } else if (status === 0xf0 || status === 0xf7) {
        p += readVlq();
        running = null;
      } else if (status >= 0xf0) {
        // system common/realtime (should not appear in files) — skip known lengths
        p += status === 0xf2 ? 2 : status === 0xf1 || status === 0xf3 ? 1 : 0;
      } else {
        running = status;
        const hi = status & 0xf0;
        const ch = status & 0x0f;
        const d1 = data[p];
        const d2 = data[p + 1];
        p += hi === 0xc0 || hi === 0xd0 ? 1 : 2;
        if (hi === 0x90 && d2 > 0) {
          const key = (ch << 7) | d1;
          if (!open.has(key)) open.set(key, []);
          open.get(key).push({ tick, vel: d2 });
        } else if (hi === 0x80 || (hi === 0x90 && d2 === 0)) {
          noteOff(ch, d1, tick);
        } else if (hi === 0xc0 && !programs.has(ch)) programs.set(ch, d1);
      }
    }
    for (const [key, q] of open) for (let k = q.length; k > 0; k--) noteOff(key >> 7, key & 0x7f, tick);
    const chans = [...byChannel.keys()].sort((a, b) => a - b);
    for (const ch of chans) {
      const notes = byChannel.get(ch).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
      const isDrums = ch === DRUM_CHANNEL;
      let tname = name || instName || (isDrums ? 'Drums' : `Track ${out.length + 1}`);
      if (chans.length > 1) tname += ` (ch ${ch + 1})`;
      out.push({ name: tname, channel: ch, isDrums, program: programs.get(ch) ?? null, notes });
    }
  }
  return { format, ppq, bpm: bpm ? Math.round(bpm * 1000) / 1000 : 120, timeSig: timeSig || [4, 4], tracks: out };
}

/**
 * Adds imported MIDI tracks to a project as instrument tracks with one pattern each
 * (pattern length rounded up to whole bars) plus a clip at bar 1. Mutates `project`.
 */
export function addMidiToProject(project, parsed, { setTempo = false } = {}) {
  const bpb = beatsPerBar(project);
  if (setTempo && parsed.bpm) project.bpm = Math.round(parsed.bpm * 100) / 100;
  const trackIds = [];
  parsed.tracks.forEach((t, i) => {
    const track = createTrack({
      name: t.name,
      color: TRACK_COLORS[(project.tracks.length + i) % TRACK_COLORS.length],
      instrument: t.isDrums ? { type: 'drums', preset: null, params: {} } : { type: 'synth', preset: null, params: {} },
      role: t.isDrums ? 'drums' : null,
    });
    const end = t.notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0);
    const length = Math.max(bpb, Math.ceil(end / bpb - 1e-6) * bpb);
    const pat = createPattern(track.id, {
      name: t.name,
      length,
      notes: t.notes.map((n) => createNote(n.pitch, Math.round(n.start * 1e4) / 1e4, Math.round(n.dur * 1e4) / 1e4, Math.round(n.vel * 1000) / 1000)),
    });
    track.activePatternId = pat.id;
    project.tracks.push(track);
    project.patterns[pat.id] = pat;
    project.clips.push(createClip(track.id, { patternId: pat.id, start: 0, length }));
    trackIds.push(track.id);
  });
  return { trackIds };
}
