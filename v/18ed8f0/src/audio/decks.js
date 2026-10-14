// Two-deck DJ player on the project's AudioContext: per-deck trim / 3-band EQ / filter-free kills,
// tempo (playbackRate, vinyl-style), beat-synced loops, cue + hot cues, equal-power crossfader.
// Output goes through the daW³ master bus (so master FX, meters and recording hear the decks).
import { Emitter } from '../core/util.js';
import { crossfade, phaseAlign, syncRate } from './analysis/dj.js';

export class DeckPlayer extends Emitter {
  constructor(ctx, dest, name = 'A') {
    super();
    this.ctx = ctx; this.name = name;
    this.trim = ctx.createGain();
    this.low = ctx.createBiquadFilter(); this.low.type = 'lowshelf'; this.low.frequency.value = 220;
    this.mid = ctx.createBiquadFilter(); this.mid.type = 'peaking'; this.mid.frequency.value = 1000; this.mid.Q.value = 0.7;
    this.high = ctx.createBiquadFilter(); this.high.type = 'highshelf'; this.high.frequency.value = 3500;
    this.fader = ctx.createGain();
    this.xf = ctx.createGain();
    this.trim.connect(this.low).connect(this.mid).connect(this.high).connect(this.fader).connect(this.xf).connect(dest);
    this.buffer = null; this.track = null; this.grid = null;
    this.rate = 1; this.playing = false; this.src = null;
    this._pos0 = 0; this._t0 = 0;
    this.loop = null; this.cuePoint = 0; this.hotCues = [null, null, null, null];
  }

  /** Load decoded audio ({channels, sampleRate}) for a library track (with analysis). */
  load(track, audio) {
    this.stop();
    const n = audio.channels[0].length;
    const buf = this.ctx.createBuffer(audio.channels.length, n, audio.sampleRate);
    audio.channels.forEach((c, i) => buf.copyToChannel(c, i));
    this.buffer = buf; this.track = track; this.grid = track.analysis?.grid || null;
    this.loop = null; this.hotCues = [null, null, null, null];
    this.cuePoint = this.grid ? this.grid.anchor : 0;
    this._pos0 = this.cuePoint;
    this.emit('change');
  }

  get duration() { return this.buffer ? this.buffer.duration : 0; }
  get bpm() { return this.grid ? this.grid.bpm * this.rate : 0; }

  position() {
    if (!this.playing) return this._pos0;
    let p = this._pos0 + (this.ctx.currentTime - this._t0) * this.rate;
    const L = this.loop;
    if (L && this._pos0 <= L.end + 1e-3 && p >= L.end) p = L.start + ((p - L.start) % (L.end - L.start));
    return Math.min(p, this.duration);
  }

  _start(at) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.rate;
    if (this.loop) { src.loop = true; src.loopStart = this.loop.start; src.loopEnd = this.loop.end; }
    src.connect(this.trim);
    src.onended = () => { if (this.src === src) { this.playing = false; this._pos0 = this.duration; this.src = null; this.emit('change'); } };
    src.start(0, Math.max(0, Math.min(at, this.duration - 0.001)));
    this.src = src; this._pos0 = at; this._t0 = this.ctx.currentTime; this.playing = true;
  }
  _halt() { const s = this.src; this.src = null; if (s) { try { s.stop(); } catch { /* */ } s.disconnect(); } }

  play() { if (!this.buffer || this.playing) return; if (this._pos0 >= this.duration - 0.01) this._pos0 = this.cuePoint; this._start(this._pos0); this.emit('change'); }
  pause() { if (!this.playing) return; this._pos0 = this.position(); this._halt(); this.playing = false; this.emit('change'); }
  stop() { this._halt(); this.playing = false; this.emit('change'); }
  toggle() { if (this.playing) this.pause(); else this.play(); }
  seek(t) {
    t = Math.max(0, Math.min(t, this.duration));
    if (this.loop && (t < this.loop.start || t >= this.loop.end)) this.setLoop(null);
    if (this.playing) { this._halt(); this._start(t); } else this._pos0 = t;
    this.emit('change');
  }
  /** CDJ-style cue: while playing jump back to the cue and stop; while stopped set the cue here. */
  cue() {
    if (this.playing) { this.pause(); this._pos0 = this.cuePoint; }
    else this.cuePoint = this._pos0;
    this.emit('change');
  }
  setRate(r) {
    r = Math.max(0.5, Math.min(2, r));
    if (this.playing) { this._pos0 = this.position(); this._t0 = this.ctx.currentTime; this.src.playbackRate.setValueAtTime(r, this.ctx.currentTime); }
    this.rate = r;
    this.emit('change');
  }
  setLoop(loop) {
    if (this.playing) { this._pos0 = this.position(); this._t0 = this.ctx.currentTime; }
    this.loop = loop && loop.end > loop.start ? { ...loop } : null;
    if (this.src) {
      if (this.loop) { this.src.loopStart = this.loop.start; this.src.loopEnd = this.loop.end; this.src.loop = true; }
      else this.src.loop = false;
    }
    this.emit('change');
  }
  hotCue(i, { clear = false } = {}) {
    if (clear) this.hotCues[i] = null;
    else if (this.hotCues[i] == null) this.hotCues[i] = this.position();
    else { this.seek(this.hotCues[i]); if (!this.playing) this.play(); }
    this.emit('change');
  }
  /** Match tempo (and beat phase if the leader is playing) to another deck. */
  syncTo(other) {
    if (!this.grid || !other?.grid) return;
    this.setRate(syncRate(this.grid.bpm, other.bpm));
    if (other.playing) this.seek(phaseAlign(other.grid, other.position(), this.grid, this.position()));
  }
  setEq(band, db) { const n = { low: this.low, mid: this.mid, high: this.high }[band]; if (n) n.gain.setTargetAtTime(db, this.ctx.currentTime, 0.02); }
  setTrim(g) { this.trim.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02); }
  setFader(g) { this.fader.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02); }
  dispose() { this.stop(); try { this.xf.disconnect(); } catch { /* */ } }
}

export class DeckMixer {
  constructor(ctx, dest) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.connect(dest);
    this.decks = [new DeckPlayer(ctx, this.out, 'A'), new DeckPlayer(ctx, this.out, 'B')];
    this.xfade = 0;
    this.setCrossfader(0);
  }
  setCrossfader(x) {
    this.xfade = x;
    const g = crossfade(x);
    this.decks[0].xf.gain.setTargetAtTime(g.a, this.ctx.currentTime, 0.01);
    this.decks[1].xf.gain.setTargetAtTime(g.b, this.ctx.currentTime, 0.01);
  }
  /** The deck the audience mostly hears (playing, louder on the crossfader) — reference for harmonic hints. */
  leadDeck() {
    const g = crossfade(this.xfade);
    const [a, b] = this.decks;
    if (a.playing && b.playing) return g.a >= g.b ? a : b;
    return a.playing ? a : b.playing ? b : (a.track ? a : b.track ? b : null);
  }
}
