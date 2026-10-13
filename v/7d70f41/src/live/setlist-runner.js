// Setlist runner (browser): drives src/live/setlist-engine.js against the store + audio engine.
// Phrases are placed as clips on the song timeline (song mode), one phrase ahead of the playhead, so swaps land
// exactly on phrase boundaries with no gaps (the clip is in the project long before the lookahead scheduler gets
// there). Automatic placements are not undo steps (Ctrl+Z keeps undoing the user's own edits); "Capture" makes the
// played set a normal, editable / exportable arrangement in one undo step.
import { Emitter, uid, deepClone } from '../core/util.js';
import { createProject, createPattern, createClip } from '../core/model.js';
import {
  createSetlist, planPhrase, prepareBeat, queueKeyMove, freshIdea, setPhraseBars, buildSweepPoints, keyName, SECTIONS,
} from './setlist-engine.js';

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
      const plan = planPhrase(st, { current, edited });
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
  setAutoDrift(on, every) { if (!this.state) return; this.state.autoDrift = !!on; if (every) this.state.driftEvery = every; this.emit('change', { kind: 'drift' }); }

  /** Write the played set into the arrangement as a finished song: markers per section, future phrases trimmed. */
  capture() {
    const { store, engine } = this.app;
    if (!this.phrases.length) return null;
    const pos = engine.getPosition();
    const cur = this.phraseAt(pos);
    const end = cur ? cur.start + cur.length : this.lastPhrase.start + this.lastPhrase.length;
    this.stop();
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

