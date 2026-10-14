// AudioEngine: owns the AudioContext, follows the store, runs the transport.
// See docs/ARCHITECTURE.md "Audio" for the public contract.
//
// Transport position semantics:
//   - play() starts from the current position (song mode: if it is at/after loop.end with the
//     loop enabled, playback starts at loop.start).
//   - pause() keeps the position.
//   - stop() while playing returns to the "return point": the last position set via
//     setPosition() (0 if never set). stop() while already stopped rewinds to 0.
//   - setPosition(beat) works while playing (re-anchors, cuts sounding notes) and also sets
//     the return point.
import { Emitter } from '../core/util.js';
import { MixGraph, codeSoundOf } from './mixer.js';
import { Scheduler, CodeCache } from './scheduler.js';
import { renderOffline as renderOfflineImpl, decodeSampleData, findSampleIdByName } from './render.js';
import { prefetchCodeSamples } from './code-instrument.js';
import { activeLanes, automationOwner, valueAt } from '../core/automation.js';
import { createFreezeGuard } from '../core/freeze.js';
import * as freeze from './freeze.js';
import { EngineMonitor } from './monitor.js';
import { SampleStreamer } from './stream/streamer.js';

/** Sample rates offered in the UI (the device / browser decides what actually works). */
export const SAMPLE_RATES = [44100, 48000, 88200, 96000];

export class AudioEngine extends Emitter {
  constructor(store) {
    super();
    this.store = store;
    this.ctx = null;
    this.graph = null;
    this.scheduler = null;
    this.buffers = new Map(); // sampleId -> AudioBuffer
    this._decoding = new Map(); // sampleId -> Promise
    this._failedSamples = new Set();
    this._pos = 0;
    this._returnBeat = 0;
    this._playing = false;
    this._posTimer = null;
    this._held = new Set();
    this._audition = null;
    this._errTimes = new Map();
    this._codeStatus = new Map();
    this._sampleKeys = '';
    this._overrides = new Set(); // `${ownerId}|${target}` lanes the user is currently writing (automation recording)
    this.codeCache = new CodeCache((trackId, res) => {
      this._codeStatus.set(trackId, res);
      if (res.ok) this.emit('code-ok', { trackId, cps: res.cps });
      // start loading the library samples this code plays (Strudel drum machines, Dirt-Samples…)
      // (daW³-instrument code tracks; the Strudel sound engine loads its own samples)
      if (res.ok && this._daw3Code(trackId)) prefetchCodeSamples(this.ctx, this.codeCache.entries.get(trackId)?.evaluated).catch(() => {});
      else this.emit('code-error', { trackId, error: res.error });
    });
    this.sampleRate = null; // preferred AudioContext sample rate (null = device default), see setSampleRate()
    this.monitor = new EngineMonitor(this);
    this.streamer = null; // long-audio streaming (stream/streamer.js), created with the context when supported
    this._unguard = store.addGuard ? store.addGuard(createFreezeGuard()) : null; // frozen tracks: edits blocked
    this._unsubs = [
      store.on('change', (p) => this._onChange(p)),
      store.on('load', (p) => this._onLoad(p)),
    ];
    try { this.codeCache.refresh(store.get()); } catch (e) { this._error(e); }
  }

  get project() { return this.store.get(); }
  /** Does this code track play through daW³ instruments (not the Strudel sound engine)? */
  _daw3Code(trackId) { return codeSoundOf(this.project.tracks.find((t) => t.id === trackId)) === 'daw3'; }
  get isPlaying() { return this._playing; }
  get currentTime() { return this.ctx ? this.ctx.currentTime : 0; }

  /** Create/resume the AudioContext (call from a user gesture). Idempotent. */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return this._initPromise || Promise.resolve(this);
    }
    this._initPromise = (async () => {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) throw new Error('Web Audio API is not supported in this browser');
      let ctx;
      try {
        ctx = new AC(this.sampleRate ? { latencyHint: 'interactive', sampleRate: this.sampleRate } : { latencyHint: 'interactive' });
      } catch (e) {
        // the device / browser refused the rate: fall back to its default
        this._error(new Error(`Sample rate ${this.sampleRate} Hz is not available (${e?.message || e}) — using the device default.`));
        this.sampleRate = null;
        ctx = new AC({ latencyHint: 'interactive' });
      }
      this.ctx = ctx;
      this.graph = new MixGraph(ctx, {
        destination: ctx.destination,
        getBpm: () => this.project.bpm,
        getBeatAt: (t) => this.scheduler?.beatAt(t) ?? null,
        getSampleBuffer: (id) => this.getSampleBuffer(id),
        getSampleByName: (name) => this.getSampleByName(name),
        getSampleStream: (id) => this.streamer?.handle(id) || null,
        isStreamed: (id) => this._streams(id),
        playStream: (meta, dest, when, off, dur) => this.streamer.play(meta, dest, when, off, dur),
        onError: (e) => this._error(e),
        onLatency: (pdc) => this.emit('latency', this.getLatency()),
      });
      this.scheduler = new Scheduler({
        ctx,
        getProject: () => this.project,
        codeCache: this.codeCache,
        dispatch: (ev, time, spb) => this.graph.playEvent(ev, time, spb),
        onError: (e) => this._error(e),
        onWrap: (time) => this.graph.syncLfos(time),
        onWindow: (project, b0, b1, t0, spb, jump, pre) => this._automateWindow(project, b0, b1, t0 - (pre || 0), spb, jump),
        onTick: (project) => this._automateTick(project),
        getPreroll: () => this.graph?.latency || 0, // plugin delay compensation (see latency.js)
      });
      try { this.graph.sync(this.project); } catch (e) { this._error(e); }
      for (const [id, e] of this.codeCache.entries) if (this._daw3Code(id)) prefetchCodeSamples(ctx, e.evaluated).catch(() => {});
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      this.streamer = SampleStreamer.supported(ctx) ? new SampleStreamer(ctx, { onError: (e) => this._error(e) }) : null;
      this._sampleKeys = '';
      this._syncSamples(this.project);
      this.monitor.start();
      this.emit('ready');
      this.emit('context', ctx);
      return this;
    })();
    return this._initPromise;
  }

  // ------------------------------------------------------------------ store following
  _onChange(project) {
    try { this.codeCache.refresh(project); } catch (e) { this._error(e); }
    if (this.graph) {
      const bpmChanged = this.graph.bpm !== project.bpm;
      try { this.graph.sync(project); } catch (e) { this._error(e); }
      if (bpmChanged && this._playing) {
        // re-align tempo-synced LFOs once the scheduler has anchored the new tempo
        clearTimeout(this._resyncTimer);
        this._resyncTimer = setTimeout(() => { if (this._playing) this.graph.syncLfos(); }, 250);
      }
    }
    this._syncSamples(project);
  }

  _onLoad() {
    if (this._playing) this.stop();
    this._pos = 0;
    this._returnBeat = 0;
    this.codeCache.clear();
    this._codeStatus.clear();
    this.emit('position', 0);
  }

  _syncSamples(project) {
    const keys = Object.keys(project.samples || {});
    const k = keys.join('|');
    if (k === this._sampleKeys) return;
    this._sampleKeys = k;
    const live = new Set(keys);
    for (const id of [...this.buffers.keys()]) if (!live.has(id)) this.buffers.delete(id);
    if (!this.ctx) return;
    for (const id of keys) {
      // long samples stream from the PCM cache (no AudioBuffer); everything else is decoded up front
      if (this._streams(id)) this.streamer.prepare(id, project.samples[id]).then(() => this.emit('samples', { id, streamed: true }), () => {});
      else if (!this.buffers.has(id)) this.decodeSample(id).catch(() => {});
    }
  }

  /** Does this sample stream (long + streaming supported here)? Audio clips then play it via the streamer. */
  _streams(id) {
    const s = this.project.samples?.[id];
    return !!(this.streamer && s && !this.buffers.has(id) && this.streamer.streams(id, s));
  }

  // ------------------------------------------------------------------ samples
  /** Fully decoded AudioBuffer of a sample (instruments, previews). Starts decoding and returns null when missing. */
  getSampleBuffer(id) {
    if (!id) return null;
    const b = this.buffers.get(id);
    if (b) return b;
    if (this.project.samples?.[id] && !this._failedSamples.has(id)) this.decodeSample(id, { full: true }).catch(() => {});
    return null;
  }

  /**
   * Waveform overview of a sample without holding its PCM: { bucketSec, min: Float32Array, max, duration } | null.
   * Streamed samples have it from the PCM cache; decoded ones are computed from the buffer.
   */
  getSamplePeaks(id) {
    const m = this.streamer?.handle(id);
    if (m?.peaks) return { bucketSec: m.peaks.bucket / m.sampleRate, min: m.peaks.min, max: m.peaks.max, duration: m.duration };
    return null;
  }

  getSampleByName(name) {
    const id = findSampleIdByName(this.project, name);
    return id ? this.getSampleBuffer(id) : null;
  }

  /**
   * Decode (and cache) a project sample. Resolves to the AudioBuffer — or, for a long sample that streams (and
   * opts.full is not set), to a light info object { duration, length, sampleRate, numberOfChannels, streamed: true,
   * peaks } without PCM (use engine.getSamplePeaks for drawing).
   */
  decodeSample(id, opts = {}) {
    if (this.buffers.has(id)) return Promise.resolve(this.buffers.get(id));
    if (!opts.full && this._streams(id)) {
      return this.streamer.prepare(id, this.project.samples[id]).then((m) => ({
        duration: m.duration, length: m.frames, sampleRate: m.sampleRate, numberOfChannels: m.channels, streamed: true, peaks: this.getSamplePeaks(id),
      }), () => this.decodeSample(id, { full: true }));
    }
    if (this._decoding.has(id)) return this._decoding.get(id);
    const sample = this.project.samples?.[id];
    if (!sample) return Promise.reject(new Error(`Unknown sample ${id}`));
    const ctx = this.ctx || new OfflineAudioContext(1, 1, 44100);
    const p = decodeSampleData(ctx, sample).then((buf) => {
      this._decoding.delete(id);
      this._failedSamples.delete(id);
      if (this.project.samples?.[id]) this.buffers.set(id, buf);
      this.emit('samples', { id, buffer: buf });
      return buf;
    }, (err) => {
      this._decoding.delete(id);
      this._failedSamples.add(id);
      const e = new Error(`Could not decode sample "${sample.name}": ${err?.message || err}`);
      this._error(e);
      throw e;
    });
    this._decoding.set(id, p);
    return p;
  }

  /** Play a sample once through the master bus (stops the previous audition). */
  async auditionSample(id, { gain = 0.9 } = {}) {
    await this.init();
    const buf = await this.decodeSample(id);
    this.stopAudition();
    const src = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.buffer = buf;
    src.connect(g);
    g.connect(this.graph.master.input);
    src.start();
    src.onended = () => { try { g.disconnect(); } catch { /* */ } if (this._audition?.src === src) this._audition = null; };
    this._audition = { src, g };
    return src;
  }

  stopAudition() {
    if (!this._audition) return;
    const { src, g } = this._audition;
    this._audition = null;
    try {
      const t = this.ctx.currentTime;
      g.gain.setTargetAtTime(0, t, 0.01);
      src.stop(t + 0.06);
    } catch { /* */ }
  }

  // ------------------------------------------------------------------ automation
  // Automation plays in SONG mode only. Mixer targets are AudioParam ramps scheduled per
  // scheduler window; instrument params are evaluated at each window start (so the notes of
  // that window get them) and effect params at the audible position on every tick.
  // t0 = dispatch time of beat b0 (heard time minus the PDC pre-roll)
  _automateWindow(project, b0, b1, t0, spb, jump) {
    if (project.mode !== 'song') { this._endAutomation(project); return; }
    project = this._withoutOverrides(project);
    this._autoActive = true;
    this.graph.automateMixer(project, b0, b1, t0, spb, jump);
    // after play/seek effect params jump straight to the automated value (no glide from static)
    this.graph.applyControl(project, b0, { inst: true, fx: jump === 'seek', immediate: jump === 'seek' });
  }

  _automateTick(project) {
    if (project.mode !== 'song' || !this._autoActive) return;
    project = this._withoutOverrides(project);
    const beat = this.scheduler.getPosition();
    if (beat != null) this.graph.applyControl(project, beat, { inst: false, fx: true });
  }

  /**
   * Automation write (recording): while a target is overridden its lane is ignored by playback, so the
   * live (store) value the user is moving is heard instead. ownerId: track id | bus id | 'master'.
   */
  setAutomationOverride(ownerId, target, on) {
    const k = `${ownerId}|${target}`;
    if (!!on === this._overrides.has(k)) return;
    if (on) this._overrides.add(k); else this._overrides.delete(k);
    // apply right away (mixer AudioParams follow on the next scheduler window, ~25 ms)
    if (this._playing && this._autoActive && this.graph && this.project.mode === 'song') {
      const beat = this.scheduler.getPosition();
      if (beat != null) { try { this.graph.applyControl(this._withoutOverrides(this.project), beat, { inst: true, fx: true }); } catch (e) { this._error(e); } }
    }
  }

  clearAutomationOverrides() {
    const had = this._overrides.size;
    this._overrides.clear();
    if (had && this._playing && this._autoActive && this.graph && this.project.mode === 'song') {
      const beat = this.scheduler.getPosition();
      if (beat != null) { try { this.graph.applyControl(this.project, beat, { inst: true, fx: true }); } catch (e) { this._error(e); } }
    }
  }

  isAutomationOverridden(ownerId, target) { return this._overrides.has(`${ownerId}|${target}`); }

  /** The project as automation playback sees it: lanes of overridden targets removed (shallow copies). */
  _withoutOverrides(project) {
    if (!this._overrides.size) return project;
    const ov = this._overrides;
    const strip = (id, o) => {
      if (!o?.automation?.length || !o.automation.some((l) => ov.has(`${id}|${l.target}`))) return o;
      return { ...o, automation: o.automation.filter((l) => !ov.has(`${id}|${l.target}`)) };
    };
    return {
      ...project,
      master: strip('master', project.master),
      buses: (project.buses || []).map((b) => strip(b.id, b)),
      tracks: project.tracks.map((t) => strip(t.id, t)),
    };
  }

  /**
   * Current automated value (lane number, see core/automation encodeParam) of a target at the audible
   * position, or null when it is not automated right now (stopped, pattern mode, no active lane, or
   * being written by the user). ownerId: track id | bus id | 'master'.
   */
  getAutomatedValue(ownerId, target) {
    if (!this._playing || this.project.mode !== 'song' || this._overrides.has(`${ownerId}|${target}`)) return null;
    const lane = activeLanes(automationOwner(this.project, ownerId)).find((l) => l.target === target);
    return lane ? valueAt(lane.points, this.getAudiblePosition()) : null;
  }

  /** Transport beat the listener hears right now (position minus output latency). */
  getAudiblePosition() {
    if (this._playing && this.ctx && this.scheduler) {
      const lat = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
      const b = this.scheduler.beatAt(this.ctx.currentTime - lat);
      if (b != null) return Math.max(0, b);
    }
    return this.getPosition();
  }

  _endAutomation(project = this.project) {
    if (!this._autoActive || !this.graph) return;
    this._autoActive = false;
    try { this.graph.endAutomation(project); } catch (e) { this._error(e); }
  }

  // ------------------------------------------------------------------ transport
  async play() {
    await this.init();
    if (this._playing) return;
    const p = this.project;
    let beat = Math.max(0, this._pos);
    if (p.mode === 'song' && p.loop?.enabled && p.loop.end > p.loop.start && beat >= p.loop.end) beat = p.loop.start;
    this._playing = true;
    const t0 = this.scheduler.start(beat);
    this.graph.syncLfos(t0);
    this._startPosTimer();
    this.emit('state', { playing: true });
  }

  pause() {
    if (!this._playing) return;
    const pos = this.scheduler.stop();
    this._pos = pos ?? this._pos;
    this._playing = false;
    this.graph.allNotesOff();
    this._endAutomation();
    this._stopPosTimer();
    this.emit('state', { playing: false });
    this.emit('position', this._pos);
  }

  stop() {
    if (this._playing) {
      this.scheduler.stop();
      this._playing = false;
      this.graph.allNotesOff();
      this._endAutomation();
      this._stopPosTimer();
      this._pos = this._returnBeat;
      this.emit('state', { playing: false });
    } else {
      this.graph?.allNotesOff();
      this._pos = 0;
      this._returnBeat = 0;
    }
    this.emit('position', this._pos);
  }

  togglePlay() { return this._playing ? this.pause() : this.play(); }

  setPosition(beat) {
    beat = Math.max(0, Number(beat) || 0);
    this._returnBeat = beat;
    if (this._playing) {
      this.graph.allNotesOff();
      const t = this.scheduler.seek(beat);
      this.graph.syncLfos(t);
    } else {
      this._pos = beat;
    }
    this.emit('position', beat);
  }

  /** Transport beat that sounds at AudioContext time t (null when stopped). */
  beatAtTime(t) { return this._playing ? this.scheduler.beatAt(t) : null; }

  /** Live transport position in beats. */
  getPosition() {
    if (this._playing) {
      const b = this.scheduler.getPosition();
      if (b != null) return b;
    }
    return this._pos;
  }

  /** Position inside the pattern currently playing on a track (beats), or null. */
  getPatternPosition(trackId) {
    const p = this.project;
    const track = p.tracks.find((t) => t.id === trackId);
    if (!track) return null;
    const pos = this.getPosition();
    if (p.mode === 'pattern') {
      const pat = p.patterns[track.activePatternId];
      if (!pat || !(pat.length > 0)) return null;
      return ((pos % pat.length) + pat.length) % pat.length;
    }
    const clip = p.clips.find((c) => c.trackId === trackId && c.type !== 'audio' && pos >= c.start && pos < c.start + c.length);
    const pat = clip && p.patterns[clip.patternId];
    if (!pat || !(pat.length > 0)) return null;
    const r = pos - clip.start + (clip.offset || 0);
    return ((r % pat.length) + pat.length) % pat.length;
  }

  _startPosTimer() {
    this._stopPosTimer();
    this._posTimer = setInterval(() => this.emit('position', this.getPosition()), 33);
  }

  _stopPosTimer() {
    if (this._posTimer) clearInterval(this._posTimer);
    this._posTimer = null;
  }

  // ------------------------------------------------------------------ live play
  noteOn(trackId, pitch, vel = 0.8) {
    const key = `${trackId}:${pitch}`;
    this._held.add(key);
    if (!this.ctx) {
      this.init().then(() => { if (this._held.has(key)) this._noteOn(trackId, pitch, vel); }).catch((e) => this._error(e));
      return;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    this._noteOn(trackId, pitch, vel);
  }

  _noteOn(trackId, pitch, vel) {
    const inst = this.graph?.getInstrument(trackId);
    if (!inst) return;
    try { inst.noteOn(pitch, vel, this.ctx.currentTime); } catch (e) { this._error(e); }
  }

  noteOff(trackId, pitch) {
    this._held.delete(`${trackId}:${pitch}`);
    const inst = this.graph?.getInstrument(trackId);
    if (!inst) return;
    try { inst.noteOff(pitch, this.ctx.currentTime); } catch (e) { this._error(e); }
  }

  /** One-shot preview (e.g. clicking a step / piano-roll note). durBeats at current tempo. */
  async previewNote(trackId, pitch, vel = 0.8, durBeats = 0.5) {
    await this.init();
    const inst = this.graph.getInstrument(trackId);
    if (!inst) return;
    try { inst.trigger(this.ctx.currentTime + 0.005, pitch, vel, (durBeats * 60) / this.project.bpm); } catch (e) { this._error(e); }
  }

  /** Release all sounding notes (panic). */
  allNotesOff() {
    this._held.clear();
    this.graph?.allNotesOff();
  }

  // ------------------------------------------------------------------ meters / analysis
  getMeter(id = 'master') { return this.graph ? this.graph.getMeter(id) : { l: 0, r: 0 }; }
  getAnalyser() { return this.graph ? this.graph.analyser : null; }
  /** Gain reduction (dB) of a compressor / limiter effect by its effect id. */
  getReduction(fxId) { return this.graph ? this.graph.getReduction(fxId) : 0; }
  /** Last code-evaluation status of a code track: {ok, error, cps} | null. */
  getCodeStatus(trackId) { return this._codeStatus.get(trackId) || null; }

  // ------------------------------------------------------------------ rendering
  /** See render.js. Uses (and fills) the engine's decoded-sample cache. */
  renderOffline(opts = {}) {
    return renderOfflineImpl(this.project, {
      ...opts,
      sampleCache: this.buffers,
      onError: (e) => this._error(e),
    });
  }

  // ------------------------------------------------------------------ freeze / bounce (see audio/freeze.js)
  /** Render a track (instrument + inserts | + fader) to audio and play that instead. opts: {mode:'preFx'|'postFx'|'postFader'} */
  freezeTrack(trackId, opts) { return freeze.freezeTrack(this, trackId, opts); }
  unfreezeTrack(trackId) { return freeze.unfreezeTrack(this, trackId); }
  /** Bounce to a new audio track (song mode). opts: {mode='postFader', muteSource=true} -> new track id */
  bounceTrack(trackId, opts) { return freeze.bounceTrack(this, trackId, opts); }
  /** Replace the track by an audio track of its own render (destructive, undoable). opts: {mode='postFx'} */
  flattenTrack(trackId, opts) { return freeze.flattenTrack(this, trackId, opts); }
  /** Render one track to an AudioBuffer without changing the project. -> {buffer, info} */
  renderTrack(trackId, opts = {}) {
    return freeze.renderTrack(this.project, trackId, { sampleRate: this.ctx?.sampleRate || 44100, sampleCache: this.buffers, onError: (e) => this._error(e), ...opts });
  }

  // ------------------------------------------------------------------ latency / health
  /**
   * Plugin delay compensation report: { enabled, total (s, whole-mix pre-roll), align, tracks: {id: s}, buses, master }
   * (null before init). engine.on('latency', report) fires when it changes.
   */
  getLatency() { return this.graph ? this.graph.latencyReport() : null; }

  /** Status-bar metrics (see monitor.js): { load, peakLoad, xruns, late, lateEvents, lateMs, latencyMs, pdcMs, sampleRate, state } */
  getMetrics() { return this.monitor.read(); }

  /**
   * Panic: silence everything now — all notes off on every instrument / code track, held live notes released,
   * audition stopped, and the master output briefly muted so effect tails (reverb, delay feedback) die at once.
   * The transport keeps running.
   */
  panic() {
    this._held.clear();
    this.stopAudition();
    if (!this.graph || !this.ctx) return;
    const t = this.ctx.currentTime;
    try { this.graph.allNotesOff(t); } catch (e) { this._error(e); }
    for (const i of this.graph.strudelInstruments?.() || []) { try { i.hush?.(); } catch { /* */ } }
    const g = this.graph.out.gain;
    try {
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0, t + 0.01);
      g.setValueAtTime(0, t + 0.6);
      g.linearRampToValueAtTime(1, t + 0.65);
    } catch { /* */ }
    this.emit('panic');
  }

  /**
   * Switch the AudioContext sample rate (44100 / 48000 / 96000 … or null = device default). Rebuilds the context
   * and the mix graph; playback resumes where it was. Rejects / falls back if the device refuses the rate.
   */
  async setSampleRate(rate) {
    rate = rate ? Number(rate) : null;
    if (rate === this.sampleRate && (!this.ctx || !rate || this.ctx.sampleRate === rate)) return this.ctx?.sampleRate ?? null;
    this.sampleRate = rate;
    if (!this.ctx) return null;
    const wasPlaying = this._playing;
    const pos = this.getPosition();
    if (wasPlaying) this.pause();
    this.stopAudition();
    try { this.graph?.dispose(); } catch { /* */ }
    try { this.streamer?.dispose(); } catch { /* */ }
    const old = this.ctx;
    this.ctx = null;
    this.graph = null;
    this.scheduler = null;
    this.streamer = null;
    this._initPromise = null;
    await old.close().catch(() => {});
    this.monitor.reset();
    await this.init();
    this._pos = pos;
    if (wasPlaying) await this.play();
    this.emit('samplerate', this.ctx.sampleRate);
    return this.ctx.sampleRate;
  }

  // ------------------------------------------------------------------ misc
  _error(e) {
    const msg = String(e?.message || e);
    const now = Date.now();
    if (now - (this._errTimes.get(msg) || 0) < 2000) return; // throttle floods (bad instrument on every note)
    this._errTimes.set(msg, now);
    if (this._errTimes.size > 100) this._errTimes.clear();
    console.warn('[audio]', e);
    this.emit('error', e);
  }

  async dispose() {
    this.stop();
    this.monitor.stop();
    this._unguard?.();
    try { this.streamer?.dispose(); } catch { /* */ }
    this._unsubs.forEach((u) => u());
    this.graph?.dispose();
    if (this.ctx) await this.ctx.close().catch(() => {});
    this.ctx = null;
    this.graph = null;
  }
}
