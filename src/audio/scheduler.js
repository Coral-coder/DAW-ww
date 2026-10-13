// Event collection (shared by realtime playback and offline rendering) + the realtime
// lookahead scheduler.
//
// collectEvents(project, b0, b1, opts) returns every event whose (unswung) onset lies in the
// half-open beat window [b0, b1). Windows are contiguous so nothing is doubled or dropped.
// Event shapes (beat = absolute song/transport beat, swing already applied):
//   { type:'note',  trackId, beat, pitch, vel, dur }            dur in beats
//   { type:'audio', trackId, beat, clip, offset, dur }          offset: beats into the clip (added to clip.offset)
//   { type:'code',  trackId, beat, dur, value }                 dur in beats (legato applied)
//   { type:'click', beat, accent }
import * as strudel from '../code/strudel.js';
import { beatsPerBar } from '../core/model.js';
import { hasMuteLane } from '../core/automation.js';

export const EPS = 1e-7;
const inWin = (x, b0, b1) => x >= b0 - EPS && x < b1 - EPS;

export function isTrackAudible(project, track) {
  if (!track || track.mute) return false;
  const anySolo = project.tracks.some((t) => t.solo);
  return !anySolo || !!track.solo;
}

/**
 * Should the scheduler collect this track's events? Like isTrackAudible, except that in song mode a
 * muted track with an active 'mute' automation lane keeps playing (its mute gain follows the lane).
 */
export function isTrackPlayable(project, track, mode) {
  if (isTrackAudible(project, track)) return true;
  if (!track || mode !== 'song' || !track.mute || !hasMuteLane(track)) return false;
  const anySolo = project.tracks.some((t) => t.solo);
  return !anySolo || !!track.solo;
}

/** Delay odd 16ths by swing * 1/8 beat. */
export function applySwing(beat, swing) {
  if (!swing) return beat;
  const s16 = beat * 4;
  const r = Math.round(s16);
  if (Math.abs(s16 - r) < 1e-4 && (((r % 2) + 2) % 2) === 1) return beat + swing * 0.125;
  return beat;
}

/**
 * Caches `evaluate(code)` per track; keeps the last good result when new code fails.
 * onResult(trackId, {ok, error, cps}) is called whenever a track's code changes.
 */
export class CodeCache {
  constructor(onResult = () => {}) {
    this.entries = new Map(); // trackId -> { code, evaluated, error }
    this.onResult = onResult;
  }
  get(track) {
    const code = track.code || '';
    let e = this.entries.get(track.id);
    if (e && e.code === code) return e;
    const prev = e;
    e = { code, evaluated: prev?.evaluated || null, error: null };
    let res;
    try {
      res = strudel.evaluate(code);
    } catch (err) {
      res = { patterns: [], cps: null, error: String(err?.message || err) };
    }
    if (res && !res.error) {
      e.evaluated = res;
      this.entries.set(track.id, e);
      this.onResult(track.id, { ok: true, error: null, cps: res.cps ?? null });
    } else {
      e.error = res?.error || 'Evaluation failed';
      this.entries.set(track.id, e);
      this.onResult(track.id, { ok: false, error: e.error, cps: null });
    }
    return e;
  }
  /** Evaluate changed code for all code tracks now; drop entries for removed tracks. */
  refresh(project) {
    const ids = new Set();
    for (const t of project.tracks) {
      if (t.type !== 'code') continue;
      ids.add(t.id);
      this.get(t);
    }
    for (const id of [...this.entries.keys()]) if (!ids.has(id)) this.entries.delete(id);
  }
  clear() { this.entries.clear(); }
}

/** Instrument-pattern note onsets of a pattern looping from `anchor` with period L, clipped to [lo, hi). */
function pushPatternNotes(out, track, pat, anchor, offset, lo, hi, b0, b1, swing) {
  const L = pat.length;
  if (!(L > 0)) return;
  const from = Math.max(b0, lo);
  const to = Math.min(b1, hi);
  if (to <= from) return;
  for (const n of pat.notes || []) {
    if (!(n.start >= 0 && n.start < L - EPS)) continue;
    // onset beats: anchor - offset + n.start + k*L
    const base = anchor - offset + n.start;
    let k = Math.ceil((from - EPS - base) / L) - 1; // start one early; inWin() filters exactly
    for (let s = base + k * L; s < to - EPS; k++, s = base + k * L) {
      if (!inWin(s, from, to) || s < lo - EPS) continue;
      let dur = n.dur > 0 ? n.dur : 0.25;
      if (s + dur > hi) dur = Math.max(0.01, hi - s); // cut at clip end
      out.push({ type: 'note', trackId: track.id, beat: applySwing(s, swing), pitch: n.pitch, vel: n.vel ?? 0.8, dur });
    }
  }
}

/**
 * @param {object} project
 * @param {number} b0 window start (beats)
 * @param {number} b1 window end (beats, exclusive)
 * @param {{mode?:'pattern'|'song', jump?:boolean, codeCache?:CodeCache, metronome?:boolean, onError?:Function}} opts
 *   jump: window starts at a discontinuity (play/seek/loop wrap) -> audio clips already in
 *         progress at b0 are started mid-way.
 */
export function collectEvents(project, b0, b1, opts = {}) {
  const out = [];
  if (!(b1 > b0)) return out;
  const mode = opts.mode || project.mode;
  const swing = project.swing || 0;
  const bpb = beatsPerBar(project);
  for (const track of project.tracks) {
    if (!isTrackPlayable(project, track, mode)) continue;
    try {
      if (track.type === 'code') {
        collectCode(out, project, track, b0, b1, bpb, opts);
      } else if (mode === 'pattern') {
        if (track.type !== 'instrument') continue;
        const pat = track.activePatternId && project.patterns[track.activePatternId];
        if (pat) pushPatternNotes(out, track, pat, 0, 0, -Infinity, Infinity, b0, b1, swing);
      } else {
        for (const clip of project.clips) {
          if (clip.trackId !== track.id) continue;
          const cs = clip.start;
          const ce = clip.start + clip.length;
          if (ce <= b0 + EPS || cs >= b1 - EPS) continue; // no overlap with the window
          if (clip.type === 'audio') {
            if (!clip.sampleId) continue;
            if (inWin(cs, b0, b1)) {
              out.push({ type: 'audio', trackId: track.id, beat: cs, clip, offset: 0, dur: clip.length });
            } else if (opts.jump && cs < b0 - EPS && ce > b0 + EPS) {
              out.push({ type: 'audio', trackId: track.id, beat: b0, clip, offset: b0 - cs, dur: ce - b0 });
            }
          } else if (track.type === 'instrument') {
            const pat = project.patterns[clip.patternId];
            if (pat) pushPatternNotes(out, track, pat, cs, clip.offset || 0, cs, ce, b0, b1, swing);
          }
        }
      }
    } catch (e) {
      opts.onError?.(e, track);
    }
  }
  if (opts.metronome ?? project.metronome) {
    for (let b = Math.ceil(b0 - EPS); b < b1 - EPS; b++) {
      if (!inWin(b, b0, b1)) continue;
      out.push({ type: 'click', beat: b, accent: Math.abs(b / bpb - Math.round(b / bpb)) < 1e-6 });
    }
  }
  return out;
}

function collectCode(out, project, track, b0, b1, bpb, opts) {
  const cache = opts.codeCache;
  if (!cache) return;
  const entry = cache.get(track);
  if (!entry?.evaluated) return;
  const c0 = b0 / bpb;
  const c1 = b1 / bpb;
  const evs = strudel.queryEvents(entry.evaluated, c0, c1) || [];
  for (const ev of evs) {
    const begin = Number(ev.begin);
    if (!isFinite(begin) || !inWin(begin, c0, c1)) continue;
    const end = Number(ev.end);
    const value = ev.value ?? {};
    const legato = Number(value.legato) > 0 ? Number(value.legato) : 1;
    const durCycles = isFinite(end) && end > begin ? end - begin : 0.25;
    out.push({ type: 'code', trackId: track.id, beat: begin * bpb, dur: durCycles * bpb * legato, value });
  }
}

/** Sensible default end (beats) for a render/export. */
export function defaultEndBeat(project, mode = project.mode) {
  const bpb = beatsPerBar(project);
  if (mode === 'song') {
    const end = project.clips.reduce((m, c) => Math.max(m, c.start + c.length), 0);
    return Math.max(bpb, Math.ceil(end / bpb - 1e-9) * bpb);
  }
  let longest = 0;
  for (const t of project.tracks) {
    const p = t.activePatternId && project.patterns[t.activePatternId];
    if (p && isTrackAudible(project, t)) longest = Math.max(longest, p.length);
  }
  return Math.max(bpb * 4, Math.ceil(longest / bpb - 1e-9) * bpb);
}

// ------------------------------------------------------------------------------ realtime
/**
 * Classic lookahead scheduler. Keeps (time, beat, bpm) anchors per scheduled window so the
 * playhead is exact across tempo changes and loop wraps.
 *
 * opts: { ctx, getProject, dispatch(event, time, spb), onWrap?(time), onError?, interval=25, lookahead=0.12,
 *         onWindow?(project, b0, b1, t0, spb, jump), onTick?(project, now) }
 *   onWindow is called for every scheduled window before its events are dispatched
 *   (jump: 'seek' after play/seek/drop-out, 'wrap' after a loop wrap, else null) — automation hook.
 */
export class Scheduler {
  constructor(opts) {
    this.o = { interval: 25, lookahead: 0.12, ...opts };
    this.ctx = opts.ctx;
    this.playing = false;
    this.timer = null;
    this.anchors = [];
    this.nextTime = 0;
    this.nextBeat = 0;
    this.jump = false;
    this._tick = () => this.tick();
  }

  start(beat, startDelay = 0.06) {
    this.stopTimer();
    this.playing = true;
    this._resetAt(beat, this.ctx.currentTime + startDelay);
    this.timer = setInterval(this._tick, this.o.interval);
    this.tick();
    return this.nextTimeStart;
  }

  /** Re-anchor while playing (seek). Returns the ctx time at which `beat` will sound. */
  seek(beat, delay = 0.03) {
    if (!this.playing) return null;
    this._resetAt(beat, this.ctx.currentTime + delay);
    this.tick();
    return this.nextTimeStart;
  }

  _resetAt(beat, time) {
    const bpm = this.o.getProject().bpm;
    this.nextBeat = beat;
    this.nextTime = time;
    this.nextTimeStart = time;
    this.jump = true;
    this.jumpKind = 'seek';
    this.anchors = [{ time, beat, bpm }];
  }

  stop() {
    this.stopTimer();
    const pos = this.getPosition();
    this.playing = false;
    this.anchors = [];
    return pos;
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Transport beat at ctx time t (null when stopped). */
  beatAt(t) {
    if (!this.playing || !this.anchors.length) return null;
    let a = this.anchors[0];
    for (const x of this.anchors) if (x.time <= t + 1e-9) a = x; else break;
    return a.beat + ((t - a.time) * a.bpm) / 60;
  }

  getPosition() {
    if (!this.playing || !this.anchors.length) return null;
    const now = this.ctx.currentTime;
    if (now < this.anchors[0].time) return this.anchors[0].beat;
    return this.beatAt(now);
  }

  tick() {
    if (!this.playing) return;
    const project = this.o.getProject();
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const hidden = typeof document !== 'undefined' && document.hidden;
    const horizon = now + (hidden ? 1.5 : this.o.lookahead);

    // Fell behind (e.g. main thread blocked): skip ahead instead of bursting late notes.
    if (this.nextTime < now - 0.05) {
      const skip = now + 0.02 - this.nextTime;
      let b = this.nextBeat + (skip * project.bpm) / 60;
      const lp = project.loop;
      if (project.mode === 'song' && lp?.enabled && lp.end - lp.start >= 0.25 && this.nextBeat < lp.end && b >= lp.end) {
        b = lp.start + ((b - lp.start) % (lp.end - lp.start));
      }
      this.nextBeat = b;
      this.nextTime = now + 0.02;
      this.jump = true;
      this.jumpKind = 'seek';
      this.anchors.push({ time: this.nextTime, beat: b, bpm: project.bpm });
    }

    let guard = 0;
    while (this.nextTime < horizon && guard++ < 64) {
      const bpm = project.bpm;
      const spb = 60 / bpm;
      const b0 = this.nextBeat;
      let b1 = b0 + (horizon - this.nextTime) / spb;
      let wrap = false;
      const lp = project.loop;
      if (project.mode === 'song' && lp?.enabled && lp.end - lp.start >= 0.25 && b0 < lp.end - EPS && b1 >= lp.end - EPS) {
        b1 = lp.end;
        wrap = true;
      }
      const t0 = this.nextTime;
      const last = this.anchors[this.anchors.length - 1];
      if (!last || Math.abs(last.time - t0) > 1e-9 || last.bpm !== bpm || Math.abs(last.beat - b0) > 1e-9) {
        this.anchors.push({ time: t0, beat: b0, bpm });
      }
      if (this.o.onWindow) {
        try { this.o.onWindow(project, b0, b1, t0, spb, this.jump ? (this.jumpKind || 'seek') : null); } catch (e) { this.o.onError?.(e); }
      }
      let events = [];
      try {
        events = collectEvents(project, b0, b1, {
          jump: this.jump, codeCache: this.o.codeCache, onError: this.o.onError,
        });
      } catch (e) {
        this.o.onError?.(e);
      }
      for (const ev of events) {
        const time = t0 + (ev.beat - b0) * spb;
        try {
          this.o.dispatch(ev, Math.max(time, now), spb);
        } catch (e) {
          this.o.onError?.(e, ev);
        }
      }
      this.jump = false;
      this.nextTime = t0 + (b1 - b0) * spb;
      if (wrap) {
        this.nextBeat = lp.start;
        this.jump = true;
        this.jumpKind = 'wrap';
        this.o.onWrap?.(this.nextTime);
      } else {
        this.nextBeat = b1;
        break;
      }
    }
    if (this.o.onTick) { try { this.o.onTick(project, now); } catch (e) { this.o.onError?.(e); } }
    // prune anchors that are fully in the past (keep the latest one <= now - 0.5 s, so latency-compensated
    // lookups like beatAt(now - outputLatency) — used by the code view's live highlighting — stay exact)
    while (this.anchors.length > 2 && this.anchors[1].time <= now - 0.5) this.anchors.shift();
  }
}
