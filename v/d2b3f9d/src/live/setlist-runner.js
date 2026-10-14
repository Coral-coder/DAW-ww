// Setlist runner (browser): drives src/live/setlist-engine.js against the store + audio engine.
// Phrases are placed as clips on the song timeline (song mode), one phrase ahead of the playhead, so swaps land
// exactly on phrase boundaries with no gaps (the clip is in the project long before the lookahead scheduler gets
// there). Automatic placements are not undo steps (Ctrl+Z keeps undoing the user's own edits); "Capture" makes the
// played set a normal, editable / exportable arrangement in one undo step.
import { Emitter, uid, deepClone } from '../core/util.js';
import { createProject, createPattern, createClip, createTrack } from '../core/model.js';
import {
  createSetlist, planPhrase, prepareBeat, queueKeyMove, freshIdea, setPhraseBars, buildSweepPoints, keyName, SECTIONS,
  soundKey, adoptSound, queueNextSound, addLoopLayer, loopBarsFor, loopLevel,
} from './setlist-engine.js';
import { valueAt } from '../core/automation.js';

const MAX_PHRASES = 256; // older phrases are pruned (clips + patterns) to bound memory
const sig = (notes) => (notes || []).map((n) => `${n.pitch}@${(+n.start).toFixed(3)}:${(+n.dur).toFixed(3)}`).join(',');

export class SetlistRunner extends Emitter {
  constructor(app) {
    super();
    this.app = app;
    this.state = null;
    this.song = null;
    this.phrases = []; // [{index, start, length, section, key, patterns:{layerId: patId}, clips:{layerId: clipId}, active:Set}]
    this.running = false;
    this.pendingBars = null;
    this.sigs = new Map(); // patId -> signature of the notes we wrote (detects the user's edits)
    this.timer = null;
    this.lastError = null;
    this.pendingSwaps = []; // [{beat, id, def, levelDb}] sound swaps applied when the playhead reaches the boundary
    this.instKeys = new Map(); // layerId -> sound we put on the track (detects the user's own preset picks)
  }

  get active() { return !!this.state; }
  get phraseLength() { return this.state ? (this.pendingBars || this.state.phraseBars) * this.state.bpb : 32; }

  /** Start a brand-new set (replaces the project). */
  async start({ genre, key, bpm, phraseBars = 8, energy = 0.7, seed } = {}) {
    const { app } = this;
    const { store, engine } = app;
    seed = seed ?? Math.floor(Math.random() * 1e9);
    const { song, state } = createSetlist({ genre, key, bpm, seed, phraseBars, energy });
    this.song = song;
    this.state = state;
    this.phrases = [];
    this.sigs.clear();
    this.pendingBars = null;
    this.pendingSwaps = [];
    this.instKeys = new Map(song.tracks.map((t) => [t.id, soundKey(t.instrument)]));
    const base = createProject();
    const project = { ...base, ...song, samples: {}, name: `Setlist – ${genre} ${keyName(state.key)}`, mode: 'song', buses: song.buses || base.buses, master: song.master || base.master, clips: [], patterns: {}, markers: [], scenes: [] };
    for (const k of ['sections', 'harmony', 'harmonyLength', 'patternHarmony', 'progression']) delete project[k];
    project.loop = { enabled: false, start: 0, end: state.phraseBars * state.bpb };
    for (const t of project.tracks) { t.activePatternId = null; t.automation = []; t.mute = false; t.solo = false; }
    project.master = deepClone(project.master);
    project.master.automation = [];
    for (const b of project.buses) b.automation = [];
    engine.stop?.();
    store.load(project);
    this._placeNext();
    try { await app.actions.ensureAudio(); } catch { return; }
    engine.setPosition(0);
    await engine.play();
    this.running = true;
    this._startTimer();
    this.emit('change', { kind: 'start' });
  }

  async resume() {
    if (!this.state) return;
    await this.app.actions.ensureAudio();
    this.running = true;
    // if the playhead sits past the placed material (seek), continue from the current phrase
    if (!this.app.engine.isPlaying) await this.app.engine.play();
    this._startTimer();
    this.emit('change', { kind: 'resume' });
  }

  stop() {
    this.running = false;
    if (this.app.engine.isPlaying) this.app.engine.pause();
    this._stopTimer();
    this.emit('change', { kind: 'stop' });
  }

  dispose() { this._stopTimer(); this.state = null; }

  _startTimer() { if (!this.timer) this.timer = setInterval(() => this.tick(), 50); }
  _stopTimer() { clearInterval(this.timer); this.timer = null; }

  /** The phrase sounding at `pos` (or the last one). */
  phraseAt(pos) {
    for (let i = this.phrases.length - 1; i >= 0; i--) if (pos >= this.phrases[i].start - 1e-6) return this.phrases[i];
    return this.phrases[0] || null;
  }
  get lastPhrase() { return this.phrases[this.phrases.length - 1] || null; }
  /** Beat at which the next phrase gets planned. */
  get nextPrepareBeat() {
    const last = this.lastPhrase;
    if (!last) return 0;
    return prepareBeat(0, last.length, { bpb: this.state.bpb, bpm: this.app.store.get().bpm }) + last.start;
  }

  tick() {
    if (!this.running || !this.state) return;
    const { engine } = this.app;
    if (!engine.isPlaying) return;
    // tracks deleted / project replaced elsewhere -> stop generating
    const p = this.app.store.get();
    if (!this.state.layers.some((l) => p.tracks.some((t) => t.id === l.id))) { this.stop(); this.state = null; this.emit('change', { kind: 'lost' }); return; }
    const pos = engine.getPosition();
    this._applySwaps(pos);
    const last = this.lastPhrase;
    if (!last) { this._placeNext(); return; }
    if (pos > last.start + last.length) {
      // the user seeked past the set: continue from the bar the playhead is in
      this._placeNext(Math.floor(pos / this.state.bpb) * this.state.bpb);
      return;
    }
    if (pos >= this.nextPrepareBeat) this._placeNext();
  }

  /** What each layer plays in the phrase `ph` (store notes, incl. the user's edits) + which ones the user edited. */
  _currentNotes(ph) {
    const p = this.app.store.get();
    const current = {}, edited = {};
    if (!ph) return { current, edited };
    for (const [lid, patId] of Object.entries(ph.patterns)) {
      const pat = p.patterns[patId];
      if (!pat) continue;
      current[lid] = pat.notes;
      if (this.sigs.has(patId) && this.sigs.get(patId) !== sig(pat.notes)) edited[lid] = true;
    }
    return { current, edited };
  }

  _placeNext(forceStart = null) {
    const st = this.state;
    if (!st) return;
    try {
      const last = this.lastPhrase;
      const { current, edited } = this._currentNotes(last);
      if (this.pendingBars && this.pendingBars !== st.phraseBars) setPhraseBars(st, this.song, this.pendingBars);
      this.pendingBars = null;
      const plan = planPhrase(st, { current, edited, overridden: this._userSoundEdits() });
      const start = forceStart ?? (last ? last.start + last.length : 0);
      this._apply(plan, start, last);
      this.lastError = null;
    } catch (e) {
      console.error('[setlist]', e);
      this.lastError = e;
      this.app.toast?.('Setlist generation error: ' + e.message, { level: 'error' });
      this.running = false;
    }
  }

  /** The user's own sound edits: a preset picked by hand (adopted, rotation stops) and drift lanes overridden by hand. */
  _userSoundEdits() {
    const p = this.app.store.get();
    const overridden = {};
    for (const l of this.state.layers) {
      const t = p.tracks.find((x) => x.id === l.id);
      if (!t) continue;
      const k = soundKey(t.instrument);
      if (this.instKeys.has(l.id) && k !== this.instKeys.get(l.id) && !this.pendingSwaps.some((s) => s.id === l.id)) {
        adoptSound(this.state, l.id, t.instrument);
        this.instKeys.set(l.id, k);
      }
      const keys = (t.automation || []).filter((a) => a.overridden && a.target.startsWith('inst:')).map((a) => a.target.slice(5));
      if (keys.length) overridden[l.id] = keys;
    }
    return overridden;
  }

  /** Swaps whose boundary the playhead reached (a 1/4-beat early so the downbeat already plays the new sound). */
  _applySwaps(pos, all = false) {
    const due = this.pendingSwaps.filter((s) => all || pos >= s.beat - 0.25);
    if (!due.length) return;
    this.pendingSwaps = this.pendingSwaps.filter((s) => !due.includes(s));
    this.app.store.transact('Setlist sound', (p) => {
      for (const s of due) {
        const t = p.tracks.find((x) => x.id === s.id);
        if (!t) continue;
        t.instrument = deepClone(s.def);
        t.volume = Math.round(Math.min(1.5, Math.max(0.02, t.volume * 10 ** (s.levelDb / 20))) * 1000) / 1000;
        this.instKeys.set(s.id, soundKey(s.def));
      }
    }, { undo: false });
    this.emit('change', { kind: 'sound' });
  }

  _apply(plan, start, prev) {
    const { store } = this.app;
    const st = this.state;
    const P = plan.length;
    const bpb = st.bpb;
    const ph = { index: plan.index, start, length: P, section: plan.section, key: plan.key, keyChanged: plan.keyChanged, patterns: {}, clips: {}, active: new Set() };
    store.transact('Setlist phrase', (p) => {
      const tracks = new Map(p.tracks.map((t) => [t.id, t]));
      // pivot: the last bar of the phrase now playing turns into the new key's dominant (harmonic layers)
      if (plan.pivot && prev && Math.abs(prev.start + prev.length - start) < 1e-6) {
        for (const [lid, notes] of Object.entries(plan.pivot)) {
          const clip = p.clips.find((c) => c.id === prev.clips[lid]);
          if (!clip || !tracks.has(lid)) continue;
          const pat = createPattern(lid, { name: `${tracks.get(lid).name} · pivot → ${keyName(plan.key)}`, length: prev.length, notes: notes.map((n) => ({ ...n, id: uid('n') })) });
          p.patterns[pat.id] = pat;
          const cut = start - bpb;
          if (clip.start < cut - 1e-6) clip.length = cut - clip.start;
          else clip.length = 0;
          const pc = createClip(lid, { patternId: pat.id, start: cut, length: bpb, offset: prev.length - bpb, name: 'pivot' });
          p.clips.push(pc);
          if (clip.length <= 0) p.clips = p.clips.filter((c) => c !== clip);
          prev.pivot = true;
        }
      }
      for (const l of st.layers) {
        const r = plan.layers[l.id];
        const t = tracks.get(l.id);
        // audio-loop layer (no key shift): one audio clip per loop restart inside the phrase
        if (l.sample && !l.sample.keyShift) {
          if (!t || !r?.active || !r.segments?.length) continue;
          for (const g of r.segments) {
            const clip = createClip(l.id, { type: 'audio', sampleId: l.sample.sampleId, start: start + g.start, length: g.length, offset: g.offset, name: l.name });
            p.clips.push(clip);
            if (!ph.clips[l.id]) ph.clips[l.id] = clip.id;
          }
          ph.active.add(l.id);
          continue;
        }
        if (!t || !r || !r.active || !r.notes.length) continue;
        // unchanged (locked) layer continuing right after itself: extend its clip, no new pattern
        const prevClip = prev && p.clips.find((c) => c.id === prev.clips[l.id]);
        const prevPat = prevClip && p.patterns[prevClip.patternId];
        if (prevClip && prevPat && prevClip.start + prevClip.length > start - 1e-6 - 0 && Math.abs(prevClip.start + prevClip.length - start) < 1e-6 && prevPat.length === P && sig(prevPat.notes) === sig(r.notes) && !plan.keyChanged) {
          prevClip.length += P;
          ph.patterns[l.id] = prevPat.id; ph.clips[l.id] = prevClip.id; ph.active.add(l.id);
          continue;
        }
        const pat = createPattern(l.id, { name: `${t.name} · ${plan.index + 1} ${SECTIONS[plan.section]?.label || plan.section}`, length: P, notes: r.notes.map((n) => ({ ...n, id: uid('n') })) });
        p.patterns[pat.id] = pat;
        this.sigs.set(pat.id, sig(pat.notes));
        const clip = createClip(l.id, { patternId: pat.id, start, length: P });
        p.clips.push(clip);
        t.activePatternId = pat.id;
        ph.patterns[l.id] = pat.id; ph.clips[l.id] = clip.id; ph.active.add(l.id);
      }
      // build: open the low-pass filters of the melodic layers over the phrase (riser into the drop)
      if (plan.section === 'build') {
        for (const t of p.tracks) {
          if (t.role === 'drums' || !ph.active.has(t.id)) continue;
          const f = t.fx.find((x) => x.type === 'filter' && x.enabled !== false && (x.params?.type ?? 'lowpass') === 'lowpass');
          if (!f) continue;
          const target = `fx:${f.id}:cutoff`;
          const rest = f.params?.cutoff ?? 2000;
          let lane = t.automation.find((a) => a.target === target);
          if (!lane) { lane = { id: uid('lane'), target, points: [{ beat: 0, value: rest }], enabled: true }; t.automation.push(lane); }
          lane.points = lane.points.filter((q) => q.beat < start - 0.02).concat(buildSweepPoints(start, start + P, rest)).sort((a, b) => a.beat - b.beat);
        }
      }
      // settings drift: one ramp per phrase on `inst:<key>` lanes (a knob moved by hand overrides its lane)
      for (const [lid, snd] of Object.entries(plan.sounds || {})) {
        const t = tracks.get(lid);
        if (!t) continue;
        for (const [key, d] of Object.entries(snd.drift || {})) {
          const target = `inst:${key}`;
          let lane = t.automation.find((a) => a.target === target);
          if (lane?.overridden) continue;
          if (!lane) { lane = { id: uid('lane'), target, points: [{ beat: 0, value: d.from }], enabled: true, setlist: true }; t.automation.push(lane); }
          const held = lane.points.length ? valueAt(lane.points, start) : d.from;
          lane.points = lane.points.filter((q) => q.beat < start - 0.02);
          if (Math.abs(held - d.from) > 1e-9) lane.points.push({ beat: start - 0.01, value: held });
          lane.points.push({ beat: start, value: d.from }, { beat: start + P, value: d.to });
        }
        if (snd.swap) {
          this.pendingSwaps = this.pendingSwaps.filter((s) => s.id !== lid);
          this.pendingSwaps.push({ beat: start, id: lid, def: snd.swap.def, levelDb: snd.swap.levelDb, name: snd.swap.name });
        }
      }
      p.loop.end = start + P;
      this._prune(p);
    }, { undo: false });
    this.phrases.push(ph);
    if (this.phrases.length > MAX_PHRASES) this.phrases.shift();
    this.emit('phrase', { plan, phrase: ph });
  }

  _prune(p) {
    if (this.phrases.length < MAX_PHRASES) return;
    const cutoff = this.phrases[1]?.start ?? 0;
    const drop = new Set(p.clips.filter((c) => c.start + c.length <= cutoff + 1e-6).map((c) => c.id));
    if (!drop.size) return;
    p.clips = p.clips.filter((c) => !drop.has(c.id));
    const used = new Set(p.clips.map((c) => c.patternId));
    for (const t of p.tracks) used.add(t.activePatternId);
    for (const id of Object.keys(p.patterns)) if (!used.has(id)) { delete p.patterns[id]; this.sigs.delete(id); }
    for (const t of p.tracks) for (const a of t.automation || []) {
      if (!a.setlist || a.points.length < 3) continue;
      const i = a.points.findIndex((q) => q.beat >= cutoff);
      if (i > 1) a.points = a.points.slice(i - 1);
    }
  }

  // ---------------------------------------------------------------- controls
  layer(id) { return this.state?.layers.find((l) => l.id === id) || null; }
  setLayer(id, patch) { const l = this.layer(id); if (l) Object.assign(l, patch); this.emit('change', { kind: 'layer', id }); }
  regenerate(id) {
    const l = this.layer(id);
    if (!l) return;
    freshIdea(this.state, id, Math.floor(Math.random() * 1e9));
    l.lock = false;
    this.emit('change', { kind: 'layer', id });
  }
  queueSection(section) { if (this.state) { this.state.queued = section; this.emit('change', { kind: 'section' }); } }
  setHold(on) { if (this.state) { this.state.hold = !!on; this.emit('change', { kind: 'section' }); } }
  setEnergy(v) { if (this.state) this.state.energy = v; }
  setPhraseBars(bars) { if (this.state) { this.pendingBars = bars; this.emit('change', { kind: 'bars' }); } }
  keyMove(moveId) { if (!this.state) return null; const k = queueKeyMove(this.state, moveId); this.emit('change', { kind: 'key' }); return k; }
  setKey(key) { if (this.state) { this.state.pendingKey = { ...key }; this.emit('change', { kind: 'key' }); } }
  cancelKeyMove() { if (this.state) { this.state.pendingKey = null; this.emit('change', { kind: 'key' }); } }
  /** Per-layer sound settings: {rotate, drift}. */
  setSound(id, patch) { const l = this.layer(id); if (!l?.sound) return; if ('rotate' in patch) l.sound.rotate = !!patch.rotate; if ('drift' in patch) l.sound.drift = Math.max(0, Math.min(1, +patch.drift || 0)); this.emit('change', { kind: 'layer', id }); }
  /** Swap this layer's sound at the next phrase boundary. */
  nextSoundNow(id) { if (!this.state) return; queueNextSound(this.state, id); this.emit('change', { kind: 'layer', id }); }
  /** Global freshness 0..1: scales rotation frequency + drift amount (0 = static sounds). */
  setFreshness(v) { if (this.state) { this.state.freshness = Math.max(0, Math.min(1, +v || 0)); this.emit('change', { kind: 'fresh' }); } }
  setAutoDrift(on, every) { if (!this.state) return; this.state.autoDrift = !!on; if (every) this.state.driftEvery = every; this.emit('change', { kind: 'drift' }); }

  /**
   * Add an audio loop (a project sample, already warped to `bpm` — the set tempo) as a layer of the running set.
   * It joins at the next phrase boundary, loops on the phrase grid, follows the energy arc (role 'loop') and is
   * level-matched (track volume from the sample's RMS). keyShift: re-pitch it with key moves (sampler track, one
   * note per loop restart) instead of an audio track with audio clips. `beats` missing -> 1 / 2 / 4 / 8 bars from
   * the sample length at the project tempo. Returns the layer.
   */
  async addSampleLayer({ sampleId, name, beats, bpm, key = null, keyShift = false, mode = 'auto' } = {}) {
    const { store } = this.app;
    if (!this.state) throw new Error('Start a set first, then add loops to it.');
    const p = store.get();
    const smp = p.samples?.[sampleId];
    if (!smp) throw new Error('Unknown sample: ' + sampleId);
    const bpb = this.state.bpb;
    if (!(beats > 0)) beats = loopBarsFor(smp.duration || 2, p.bpm, bpb) * bpb;
    name = name || String(smp.name || 'Loop').replace(/\.[^.]+$/, '');
    const volume = loopLevel(await this._sampleRms(sampleId));
    if (!this.state) throw new Error('The set stopped.');
    const color = '#a9e34b';
    const track = keyShift
      ? createTrack({ name, role: 'loop', color, volume, instrument: { type: 'sampler', preset: null, params: { sampleId, rootNote: 60, attack: 0.002, sustain: 1, release: 0.01, velSens: 0 } } })
      : createTrack({ type: 'audio', name, role: 'loop', color, volume });
    store.transact('Add loop layer', (pp) => { pp.tracks.push(track); }, { undo: false });
    const l = addLoopLayer(this.state, { id: track.id, name, sampleId, beats, bpm: bpm ?? p.bpm, key, keyShift, mode });
    this.emit('change', { kind: 'layers', id: l.id });
    return l;
  }

  /** RMS of a project sample (null when it can't be decoded, e.g. without an AudioContext). */
  async _sampleRms(sampleId) {
    try {
      const buf = await this.app.engine.decodeSample?.(sampleId);
      if (!buf?.length) return null;
      let sum = 0, n = 0;
      const step = Math.max(1, Math.floor(buf.length / 200000));
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i += step) { sum += d[i] * d[i]; n++; }
      }
      return n ? Math.sqrt(sum / n) : null;
    } catch { return null; }
  }

  /** Remove a layer from the next phrase on: its future clips go; the track goes too when nothing of it was played. */
  removeLayer(id) {
    const st = this.state;
    const l = this.layer(id);
    if (!l) return;
    st.layers = st.layers.filter((x) => x !== l);
    const cur = this.phraseAt(this.app.engine.getPosition());
    const cut = cur ? cur.start + cur.length : 0;
    for (const ph of this.phrases) if (ph.start >= cut - 1e-6) { delete ph.clips[id]; delete ph.patterns[id]; ph.active.delete(id); }
    this.app.store.transact('Remove layer', (p) => {
      p.clips = p.clips.filter((c) => !(c.trackId === id && c.start >= cut - 1e-6));
      if (!p.clips.some((c) => c.trackId === id)) p.tracks = p.tracks.filter((t) => t.id !== id);
    }, { undo: false });
    this.emit('change', { kind: 'layers', id });
  }

  /** Write the played set into the arrangement as a finished song: markers per section, future phrases trimmed. */
  capture() {
    const { store, engine } = this.app;
    if (!this.phrases.length) return null;
    const pos = engine.getPosition();
    const cur = this.phraseAt(pos);
    const end = cur ? cur.start + cur.length : this.lastPhrase.start + this.lastPhrase.length;
    this.stop();
    this._applySwaps(pos);
    this.pendingSwaps = [];
    const runs = [];
    for (const ph of this.phrases) {
      if (ph.start >= end - 1e-6) break;
      const last = runs[runs.length - 1];
      if (last && last.section === ph.section && !ph.keyChanged) last.end = ph.start + ph.length;
      else runs.push({ section: ph.section, key: ph.key, start: ph.start, end: ph.start + ph.length, keyChanged: ph.keyChanged });
    }
    store.transact('Capture setlist to arrangement', (p) => {
      p.clips = p.clips.filter((c) => c.start < end - 1e-6).map((c) => (c.start + c.length > end ? { ...c, length: end - c.start } : c));
      const used = new Set(p.clips.map((c) => c.patternId));
      for (const id of Object.keys(p.patterns)) if (!used.has(id)) delete p.patterns[id];
      for (const t of p.tracks) if (t.activePatternId && !p.patterns[t.activePatternId]) t.activePatternId = [...used].find((id) => p.patterns[id]?.trackId === t.id) || null;
      const count = {};
      p.markers = runs.map((r) => {
        const label = SECTIONS[r.section]?.label || r.section;
        count[label] = (count[label] || 0) + 1;
        return { id: uid('mk'), beat: r.start, name: `${label}${count[label] > 1 ? ' ' + count[label] : ''}${r.keyChanged ? ` (${keyName(r.key)})` : ''}` };
      });
      p.loop = { enabled: false, start: 0, end };
      p.mode = 'song';
      p.key = { ...this.state.key };
    });
    this.state = null;
    this.phrases = [];
    engine.setPosition(0);
    this.emit('change', { kind: 'captured' });
    return { bars: end / (store.get().timeSig[0] || 4), sections: runs.length };
  }
}

