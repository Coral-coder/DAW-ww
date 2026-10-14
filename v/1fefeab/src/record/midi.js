// MIDI recording helpers — pure (Node-testable).
//   quantizeNote             input quantize
//   MidiPassRecorder         notes of a song-mode recording, tagged with the loop pass they started in
//   buildMidiTakes           passes -> takes (cycle: one take per pass, or merged) with notes relative to each take
//   CaptureBuffer            retrospective record: always-on buffer of the last 2 minutes of played notes
//   StepInput                step entry: each chord / note goes in at the cursor, the cursor advances
const EPS = 1e-6;
const r5 = (x) => +(+x).toFixed(5);

/** Snap a note start to `grid` beats (0 = off); optionally its length too (min one grid step). */
export function quantizeNote(start, dur, grid, { length = false } = {}) {
  if (!(grid > 0)) return { start, dur };
  const s = Math.round(start / grid) * grid;
  const d = length ? Math.max(grid, Math.round(dur / grid) * grid) : dur;
  return { start: r5(s), dur: r5(Math.max(0.01, d)) };
}

/**
 * Collects notes during a song-mode recording. Positions are song beats; call wrap() (or let position() detect it)
 * when the transport jumps back to the loop start, so each note knows its pass.
 */
export class MidiPassRecorder {
  constructor({ recIn = 0, loop = null } = {}) {
    this.recIn = recIn;
    this.loop = loop?.enabled ? { ...loop } : null;
    this.pass = 0;
    this.last = null;
    this.held = new Map(); // key -> {pitch, vel, start, pass, trackId}
    this.notes = []; // {trackId, pitch, vel, start, end, pass, x?}
    this.end = recIn; // last position seen (song beat)
  }
  /** Feed the transport position; a jump backwards of more than a beat is a loop wrap. */
  position(beat) {
    if (this.last != null && beat < this.last - 1) this.wrap();
    this.last = beat;
    this.end = beat;
  }
  wrap() {
    // notes still held at the wrap end at the loop end and carry on in the next pass
    if (this.loop) {
      for (const [k, h] of this.held) {
        this.notes.push({ trackId: h.trackId, pitch: h.pitch, vel: h.vel, start: h.start, end: this.loop.end, pass: h.pass });
        this.held.set(k, { ...h, start: this.loop.start, pass: this.pass + 1 });
      }
    }
    this.pass++;
  }
  noteOn(trackId, pitch, vel, beat) {
    this.position(beat);
    this.held.set(`${trackId}|${pitch}`, { trackId, pitch, vel, start: beat, pass: this.pass });
  }
  noteOff(trackId, pitch, beat, x = null) {
    this.position(beat);
    const k = `${trackId}|${pitch}`;
    const h = this.held.get(k);
    if (!h) return null;
    this.held.delete(k);
    const n = { trackId, pitch, vel: h.vel, start: h.start, end: Math.max(beat, h.start + 0.01), pass: h.pass, ...(x ? { x } : {}) };
    this.notes.push(n);
    return n;
  }
  /** Close held notes at the stop position. */
  finish(beat = this.end) {
    for (const h of this.held.values()) this.notes.push({ trackId: h.trackId, pitch: h.pitch, vel: h.vel, start: h.start, end: Math.max(beat, h.start + 0.05), pass: h.pass });
    this.held.clear();
    this.end = beat;
    return this.notes;
  }
}

/**
 * Turn recorded notes of ONE track into takes.
 *   notes: [{pitch, vel, start, end, pass, x?}] (song beats), recIn: where recording began, stop: last position
 *   loop: cycle range or null; mode: 'takes' (one take per pass) | 'merge' (one take with everything)
 *   grid / quantizeLength: input quantize
 * Returns [{ pass, start, length, notes: [{pitch, vel, start (relative to the take), dur}] }].
 */
export function buildMidiTakes(notes, { recIn = 0, stop = null, loop = null, mode = 'takes', grid = 0, quantizeLength = false, passes = null } = {}) {
  const cyc = !!(loop && loop.end - loop.start >= 0.25);
  const lastPass = passes ?? Math.max(0, ...notes.map((n) => n.pass));
  const rangeOf = (k) => {
    if (!cyc) {
      const end = stop ?? Math.max(recIn, ...notes.map((n) => n.end));
      return [recIn, Math.max(end, recIn + 0.25)];
    }
    const a = k === 0 ? Math.min(recIn, loop.end) : loop.start;
    const b = k === lastPass && stop != null && stop > a ? Math.min(stop, loop.end) : loop.end;
    return [a, Math.max(b, a + 0.25)];
  };
  const mk = (list, [a, b], pass) => ({
    pass, start: r5(a), length: r5(b - a),
    notes: list.map((n) => {
      const q = quantizeNote(n.start, n.end - n.start, grid, { length: quantizeLength });
      let s = q.start - a;
      if (s < 0 && s > -grid / 2 - EPS) s = 0;
      const d = Math.min(q.dur, b - a - s);
      return { pitch: n.pitch, vel: n.vel, start: r5(s), dur: r5(Math.max(0.01, d)), ...(n.x || {}) };
    }).filter((n) => n.start >= 0 && n.start < b - a - EPS),
  });
  if (!cyc || mode === 'merge') {
    if (!cyc) return notes.length ? [mk(notes, rangeOf(0), 0)] : [];
    const a = Math.min(recIn, loop.start), b = loop.end;
    return notes.length ? [mk(notes, [Math.max(0, Math.min(a, loop.start)), b], 0)] : [];
  }
  const out = [];
  for (let k = 0; k <= lastPass; k++) {
    const list = notes.filter((n) => n.pass === k);
    if (!list.length) continue; // passes where nothing was played make no take
    out.push(mk(list, rangeOf(k), k));
  }
  return out;
}

/** Note ranges a 'replace' recording clears: [{start, end}] of the recorded span (song beats). */
export function replaceRange(notes, { recIn, stop, loop }) {
  if (loop?.enabled && loop.end > loop.start) return { start: Math.min(recIn, loop.start), end: loop.end };
  return { start: recIn, end: Math.max(stop ?? recIn, ...notes.map((n) => n.end)) };
}

/**
 * Retrospective record ("Capture MIDI"): every note played is kept for `seconds` (2 min) whether or not anything is
 * recording. capture() turns what was played into a clip: at the song positions where it was played when the
 * transport was running, else relative to the first note at the current tempo.
 */
export class CaptureBuffer {
  constructor({ seconds = 120 } = {}) {
    this.seconds = seconds;
    this.events = []; // completed notes {trackId, pitch, vel, t0, t1, b0, b1}
    this.held = new Map();
  }
  noteOn(trackId, pitch, vel, t, beat = null) {
    this.held.set(`${trackId}|${pitch}`, { trackId, pitch, vel, t0: t, b0: beat });
    this.prune(t);
  }
  noteOff(trackId, pitch, t, beat = null) {
    const k = `${trackId}|${pitch}`;
    const h = this.held.get(k);
    if (!h) return;
    this.held.delete(k);
    this.events.push({ ...h, t1: Math.max(t, h.t0 + 0.01), b1: beat });
  }
  prune(now) {
    const lim = now - this.seconds;
    while (this.events.length && this.events[0].t1 < lim) this.events.shift();
  }
  clear() { this.events = []; this.held.clear(); }
  /** Notes of one track (or all), oldest first. Held notes count as released at `now`. */
  notes(trackId = null, now = null) {
    const out = this.events.filter((e) => !trackId || e.trackId === trackId);
    if (now != null) for (const h of this.held.values()) if (!trackId || h.trackId === trackId) out.push({ ...h, t1: now, b1: null });
    return out.sort((a, b) => a.t0 - b.t0);
  }
  /**
   * The last phrase as a clip: { start, length, notes } or null. A gap of more than `gapSec` of silence starts a new
   * phrase (only the latest phrase is captured). Positions: song beats when every note of the phrase carries one
   * (played over a running transport), else from `atBeat` at `bpm`. start / length snap to bars (bpb).
   * map (optional TempoMap, src/time/tempo-map.js): free timing goes through the tempo map from `atBeat` and start /
   * length snap to the meter map's bars (used when the project has tempo or meter changes).
   */
  capture({ trackId = null, bpm = 120, bpb = 4, atBeat = 0, gapSec = 6, grid = 0, now = null, map = null } = {}) {
    const all = this.notes(trackId, now);
    if (!all.length) return null;
    let i = all.length - 1;
    let end = all[i].t1;
    while (i > 0 && all[i].t0 - Math.max(...all.slice(0, i).map((e) => e.t1)) < gapSec) i--;
    void end;
    const phrase = all.slice(i);
    const spb = 60 / bpm;
    const onBeats = phrase.every((e) => e.b0 != null && e.b1 != null && e.b1 >= e.b0);
    const tm = map && (!map.isConstant || map.meters.length > 1) ? map : null;
    const sA = tm ? tm.secAt(atBeat) : 0;
    const at = tm ? (t) => tm.beatAt(sA + (t - phrase[0].t0)) : (t) => atBeat + (t - phrase[0].t0) / spb;
    const pos = onBeats ? phrase.map((e) => ({ s: e.b0, e: e.b1 })) : phrase.map((e) => ({ s: at(e.t0), e: at(e.t1) }));
    const s0 = Math.min(...pos.map((p) => p.s)), s1 = Math.max(...pos.map((p) => p.e));
    let start, length;
    if (tm) {
      // whole bars of the meter map around the phrase
      start = Math.max(0, tm.barAt(Math.max(0, s0) + EPS).start);
      const endBar = tm.barAt(Math.max(start, s1) - EPS).bar;
      length = Math.max(tm.barAt(start).length, tm.barStart(endBar + 1) - start);
    } else {
      start = Math.max(0, Math.floor(s0 / bpb + EPS) * bpb);
      length = Math.max(bpb, Math.ceil((s1 - start) / bpb - EPS) * bpb);
    }
    const notes = phrase.map((e, k) => {
      const q = quantizeNote(pos[k].s - start, pos[k].e - pos[k].s, grid);
      return { trackId: e.trackId, pitch: e.pitch, vel: e.vel, start: Math.max(0, q.start), dur: Math.max(0.01, q.dur) };
    });
    return { start, length, notes, onBeats };
  }
}

/**
 * Step input: notes pressed together (a chord) go in at the cursor when the last key is released; the cursor then
 * advances one step. rest() advances without a note, back() removes the last step.
 */
export class StepInput {
  constructor({ cursor = 0, step = 0.25, legato = 0.9 } = {}) {
    this.cursor = cursor;
    this.step = step;
    this.legato = legato;
    this.down = new Map(); // pitch -> vel
    this.chord = new Map();
    this.history = []; // [{at, notes}]
  }
  noteOn(pitch, vel = 0.8) { this.down.set(pitch, vel); this.chord.set(pitch, vel); }
  /** Returns the notes to insert ({pitch, vel, start, dur}) when the chord is complete, else null. */
  noteOff(pitch) {
    this.down.delete(pitch);
    if (this.down.size || !this.chord.size) return null;
    const at = this.cursor;
    const notes = [...this.chord].map(([p, v]) => ({ pitch: p, vel: v, start: r5(at), dur: r5(this.step * this.legato) }));
    this.chord.clear();
    this.history.push({ at, notes });
    this.cursor = r5(this.cursor + this.step);
    return notes;
  }
  rest() { this.history.push({ at: this.cursor, notes: [] }); this.cursor = r5(this.cursor + this.step); }
  /** Undo the last step: returns the notes it inserted (to remove) and moves the cursor back. */
  back() {
    const h = this.history.pop();
    if (!h) return [];
    this.cursor = h.at;
    return h.notes;
  }
}
