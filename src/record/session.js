// Recording sessions (browser): multi-track audio + MIDI recording in song mode with count-in, pre-roll / post-roll,
// punch in / out, cycle (loop) recording into takes, latency compensation; plus take audition, flatten comp,
// consolidate / reverse / normalize, retrospective MIDI capture, step input and the loopback latency wizard.
//
//   const rec = createRecorder(app)      app = { store, ui, engine, actions?, toast? }
//   rec.inputs                           InputManager (sources, routes, meters, monitoring)
//   await rec.start({ audio, midi })     -> true when a session started
//   await rec.finish()                   commit (one undo step)
//   rec.noteOn / noteOff(trackId, pitch, vel|expr, beat)   live notes while a session runs (actions.liveNote*)
//   rec.prefs() / rec.setPrefs(patch)    DEFAULT_REC_PREFS (localStorage 'daw3-rec-prefs')
import { Emitter, uid, deepClone } from '../core/util.js';
import { beatsPerBar, createClip, createPattern } from '../core/model.js';
import { encodeWav } from '../io/wav.js';
import { arrayBufferToBase64 } from '../io/samples.js';
import { scheduleClick } from '../audio/metronome.js';
import { InputManager, deviceLatency, setDeviceLatency, DEFAULT_SOURCE, loadCaptureWorklet } from './inputs.js';
import { roundTrip, beatOfFrame, beatAtTime, recordPlan, detectPing, DEFAULT_REC_PREFS } from './timing.js';
import { computePasses, createTake, addRecordedTakes, compClips, clearTakes, findTake, takeEnd, hasTakes } from './takes.js';
import { mixClipsToPcm, trackClips, reverseFrames, peakOf, normalizeGain } from './clips.js';
import { MidiPassRecorder, buildMidiTakes, CaptureBuffer, StepInput, quantizeNote, replaceRange } from './midi.js';

const PREF_KEY = 'daw3-rec-prefs';
const EPS = 1e-6;

export function loadRecPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch { /* */ }
  // the old 1-bar count-in switch
  try { if (p.countInBars == null && localStorage.getItem('daw3-countin') === '1') p.countInBars = 1; } catch { /* */ }
  return { ...DEFAULT_REC_PREFS, ...p };
}

/** Float channels -> project sample (24-bit WAV) + an AudioBuffer for the engine cache when possible. */
export function pcmToSample(channels, sampleRate, name) {
  const wav = encodeWav({ channels, sampleRate }, { bitDepth: 24, dither: 'none' });
  const sample = { id: uid('smp'), name, mime: 'audio/wav', data: arrayBufferToBase64(wav), duration: channels[0].length / sampleRate, sampleRate };
  let buffer = null;
  if (typeof AudioBuffer === 'function' && channels[0].length) {
    try {
      buffer = new AudioBuffer({ numberOfChannels: channels.length, length: channels[0].length, sampleRate });
      channels.forEach((d, c) => buffer.getChannelData(c).set(d));
    } catch { buffer = null; }
  }
  return { sample, buffer };
}

export function createRecorder(app, { toast: toastFn = null } = {}) {
  const { store, ui, engine } = app;
  const get = () => store.get();
  const toast = (msg, opts) => (toastFn || app.toast)?.(msg, opts);
  const em = new Emitter();
  let prefs = loadRecPrefs();
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* */ } };
  const inputs = new InputManager(engine, store, { getPrefs: () => prefs });
  const capture = new CaptureBuffer({ seconds: 120 });
  let step = null; // StepInput when step mode is on
  let session = null;
  let lastNoteTrack = null;

  const spb = () => 60 / get().bpm;
  const now = () => (typeof performance !== 'undefined' ? performance.now() / 1000 : Date.now() / 1000);

  store.on('change', () => { if (engine.ctx) inputs.sync().catch(() => {}); });
  engine.on?.('ready', () => inputs.sync().catch(() => {}));
  engine.on?.('context', (ctx) => { if (ctx) loadCaptureWorklet(ctx); }); // pre-load so arming is instant
  engine.on?.('state', ({ playing }) => {
    inputs.setState({ playing });
    if (!playing && session && !session.finishing) {
      session.stopTime = engine.ctx?.currentTime ?? null;
      finish();
    }
  });
  inputs.on('error', ({ message }) => toast(message, { level: 'error', timeout: 6000 }));

  // ------------------------------------------------------------------------------------------- start
  async function start({ audio = true, midi = true } = {}) {
    if (session) return false;
    await engine.init();
    const p = get();
    const audioTracks = audio ? p.tracks.filter((t) => t.type === 'audio' && t.arm) : [];
    if (audioTracks.length) {
      await inputs.sync();
      const missing = audioTracks.filter((t) => !inputs.routes.has(t.id));
      if (missing.length) {
        await inputs.retry().catch(() => {});
        const still = audioTracks.filter((t) => !inputs.routes.has(t.id));
        if (still.length) {
          const err = [...inputs.errors.values()][0];
          toast(err || `The input of ${still.map((t) => t.name).join(', ')} could not be opened.`, { level: 'error', timeout: 6000 });
          return false;
        }
      }
    }
    if (p.mode !== 'song') {
      store.transact('Song mode', (pp) => { pp.mode = 'song'; }, { undo: false });
    }
    const pp = get();
    const bpb = beatsPerBar(pp);
    const wasPlaying = engine.isPlaying;
    const pos = engine.getPosition() || 0;
    const plan = recordPlan({
      pos: wasPlaying ? pos : pos, punch: pp.punch, loop: pp.loop,
      preRollBars: wasPlaying ? 0 : prefs.preRollBars, postRollBars: prefs.postRollBars, bpb,
    });
    const s = {
      plan, recIn: plan.recIn, loop: pp.loop?.enabled ? { ...pp.loop } : null, punch: plan.punched ? { ...pp.punch } : null,
      audioIds: audioTracks.map((t) => t.id), midi, bpm: pp.bpm,
      midiRec: new MidiPassRecorder({ recIn: plan.recIn, loop: pp.loop }), lastPos: pos, finishing: false,
    };
    session = s;
    ui.set({ recording: true, audioRecording: audioTracks.length > 0 });
    if (audioTracks.length) s.captureFrame = inputs.startCapture();
    if (wasPlaying) {
      const t = engine.ctx.currentTime;
      s.anchor = { time: t, beat: engine.beatAtTime(t) ?? pos, bpm: pp.bpm };
      // punch-on-the-fly: record from now (or the punch-in when it's ahead)
      if (!plan.punched) s.recIn = s.anchor.beat;
      s.midiRec.recIn = s.recIn;
    } else {
      const ctx = engine.ctx;
      const bars = Math.max(0, Math.round(prefs.countInBars || 0));
      const t0 = ctx.currentTime + 0.12;
      const sp = 60 / pp.bpm;
      const n = bars * bpb;
      if (n && !pp.metronome) for (let i = 0; i < n; i++) scheduleClick(ctx, engine.graph.clickOut, t0 + i * sp, i % bpb === 0);
      if (n) app.setStatus?.(`Count-in: ${bars} bar${bars > 1 ? 's' : ''}…`);
      await engine.play({ from: plan.playFrom - (pp.metronome ? n : 0), at: t0 + (pp.metronome ? 0 : n * sp) });
      const a = engine.scheduler.anchors[0];
      s.anchor = { time: a.time, beat: a.beat, bpm: a.bpm };
    }
    inputs.setState({ playing: true, recording: true, punched: plan.punched, inPunch: !plan.punched });
    s.timer = setInterval(() => tick(s), 20);
    const what = [audioTracks.length ? `${audioTracks.length} audio track${audioTracks.length > 1 ? 's' : ''}` : '', midi ? 'MIDI' : ''].filter(Boolean).join(' + ');
    app.setStatus?.(`Recording ${what}${s.loop ? ' — cycle: every loop pass becomes a take' : ''}${plan.punched ? ` — punch ${fmtBar(s.punch.start, bpb)}–${fmtBar(s.punch.end, bpb)}` : ''}. Stop (Space) to finish.`);
    em.emit('session', { active: true });
    return true;
  }
  const fmtBar = (b, bpb) => `${Math.floor(b / bpb) + 1}.${+((b % bpb) + 1).toFixed(2)}`;

  function tick(s) {
    if (session !== s || !engine.isPlaying) return;
    const pos = engine.getPosition();
    if (pos == null) return;
    s.midiRec.position(pos);
    s.lastPos = pos;
    if (s.punch) {
      const inP = pos >= s.punch.start - EPS && pos < s.punch.end;
      if (inP !== inputs.state.inPunch) inputs.setState({ inPunch: inP });
    }
    if (s.plan.stopAt != null && pos >= s.plan.stopAt) { clearInterval(s.timer); engine.stop(); }
  }

  // ------------------------------------------------------------------------------------------- live notes
  /** A live note while recording (song mode). Returns true when the session took it. */
  function noteOn(trackId, pitch, vel, beat) {
    lastNoteTrack = trackId;
    capture.noteOn(trackId, pitch, vel, now(), engine.isPlaying ? beat : null);
    if (step && !engine.isPlaying) { step.noteOn(pitch, vel); return false; }
    if (!session?.midi) return false;
    session.midiRec.noteOn(trackId, pitch, vel, beat);
    return true;
  }
  function noteOff(trackId, pitch, beat, expr = null) {
    capture.noteOff(trackId, pitch, now(), engine.isPlaying ? beat : null);
    if (step && !engine.isPlaying) { stepNotes(trackId, step.noteOff(pitch)); return true; }
    if (!session?.midi) return false;
    session.midiRec.noteOff(trackId, pitch, beat, expr);
    return true;
  }
  const isRecordingSong = () => !!session;

  // ------------------------------------------------------------------------------------------- finish
  async function finish() {
    const s = session;
    if (!s || s.finishing) return null;
    s.finishing = true;
    clearInterval(s.timer);
    const stopTime = s.stopTime ?? engine.ctx?.currentTime ?? 0;
    if (engine.isPlaying) engine.stop();
    let captured = new Map();
    if (s.audioIds.length) { try { captured = await inputs.stopCapture(); } catch (e) { toast('Recording failed: ' + (e?.message || e), { level: 'error' }); } }
    session = null;
    ui.set({ recording: false, audioRecording: false });
    inputs.setState({ playing: false, recording: false, punched: false, inPunch: true });
    const u1 = beatAtTime(s.anchor, stopTime); // unwrapped beat heard when the transport stopped
    const p = get();
    const buffers = [];
    const report = [];
    const recorded = [];
    // audio: one sample per track (the whole pass incl. handles), takes reference it
    for (const tid of s.audioIds) {
      const track = p.tracks.find((t) => t.id === tid);
      if (!track) continue;
      const au = inputs.trackAudio(track, captured);
      if (!au || !au.channels[0]?.length) continue;
      const sr = au.sampleRate;
      const dl = deviceLatency(au.sourceId);
      const rt = roundTrip({ estimate: inputs.estimateRoundTrip(au.sourceId), calibratedMs: dl.calibratedMs ?? null, manualMs: dl.manualMs || 0 });
      const origin = beatOfFrame(au.frame, sr, s.anchor, rt);
      const lastBeat = origin + (au.channels[0].length / sr) / (60 / s.bpm);
      const passes = computePasses({ u0: s.recIn, u1: Math.min(u1, lastBeat), loop: s.loop, punch: s.punch, origin, minLen: 1 });
      if (!passes.length) continue;
      // trim to the takes + one bar of handle on each side
      const bpb = beatsPerBar(p);
      const sp = 60 / s.bpm;
      const lo = Math.max(0, Math.min(...passes.map((x) => x.offset)) - bpb);
      const hi = Math.max(...passes.map((x) => x.offset + x.end - x.start)) + bpb;
      const f0 = Math.max(0, Math.round(lo * sp * sr)), f1 = Math.min(au.channels[0].length, Math.round(hi * sp * sr));
      const chans = au.channels.map((d) => d.slice(f0, f1));
      const shift = f0 / sr / sp;
      const n = Object.values(p.samples || {}).filter((x) => /^Rec \d+/.test(x.name)).length + 1 + recorded.length;
      const { sample, buffer } = pcmToSample(chans, sr, `Rec ${n} · ${track.name}`);
      const srcLength = chans[0].length / sr / sp;
      recorded.push({ track, sample, buffer, srcLength, passes: passes.map((x) => ({ ...x, offset: x.offset - shift })) });
      if (buffer) buffers.push([sample.id, buffer]);
    }
    // MIDI per track
    const notes = s.midi ? s.midiRec.finish(s.lastPos) : [];
    const byTrack = new Map();
    for (const nt of notes) {
      // only what was played from the record-in point (and inside the punch range)
      if (nt.pass === 0 && nt.start < s.recIn - 0.125) continue;
      if (s.punch && (nt.start < s.punch.start - 0.125 || nt.start >= s.punch.end)) continue;
      if (!byTrack.has(nt.trackId)) byTrack.set(nt.trackId, []);
      byTrack.get(nt.trackId).push(nt);
    }
    if (!recorded.length && !byTrack.size) {
      if (s.audioIds.length) toast('Nothing was recorded.', { level: 'warn' });
      app.setStatus?.('');
      em.emit('session', { active: false });
      return null;
    }
    store.transact('Record', (pp) => {
      for (const r of recorded) {
        const t = pp.tracks.find((x) => x.id === r.track.id);
        if (!t) continue;
        pp.samples[r.sample.id] = r.sample;
        const takes = r.passes.map((x) => createTake({ name: '', sampleId: r.sample.id, start: x.start, length: x.end - x.start, offset: x.offset, srcLength: r.srcLength }));
        const lo = Math.min(...takes.map((x) => x.start)), hi = Math.max(...takes.map(takeEnd));
        const overlaps = pp.clips.some((c) => c.trackId === t.id && c.type === 'audio' && c.start < hi - EPS && c.start + c.length > lo + EPS)
          || (t.comp || []).some((c) => c.start < hi - EPS && c.end > lo + EPS);
        if (takes.length === 1 && !s.punch && !overlaps) {
          const k = takes[0];
          pp.clips.push(createClip(t.id, { type: 'audio', sampleId: r.sample.id, start: k.start, length: k.length, offset: k.offset, name: r.sample.name }));
          report.push(`${t.name}: 1 clip`);
        } else {
          const { absorbed } = addRecordedTakes(pp, t, takes, { kind: 'audio' });
          for (const k of takes) k.name = `Take ${k.pass}`;
          const ab = new Set(absorbed);
          pp.clips = pp.clips.filter((c) => !ab.has(c.id));
          report.push(`${t.name}: ${takes.length} take${takes.length > 1 ? 's' : ''}`);
        }
      }
      for (const [tid, list] of byTrack) commitMidi(pp, tid, list, s, report);
    });
    for (const [id, b] of buffers) engine.buffers?.set(id, b);
    if (buffers.length) engine.emit?.('samples', {});
    toast(`Recorded — ${report.join(' · ')}`, { level: 'success' });
    app.setStatus?.(`Recorded: ${report.join(' · ')}. Show the take lanes with “T” on the track header to comp.`);
    em.emit('session', { active: false, report });
    em.emit('takes');
    return report;
  }

  function commitMidi(pp, tid, list, s, report) {
    const t = pp.tracks.find((x) => x.id === tid);
    if (!t || t.type !== 'instrument') return;
    const grid = prefs.inputQuantize || 0;
    const mode = prefs.midiMode || 'overdub';
    const bpb = beatsPerBar(pp);
    const cyc = !!s.loop;
    if (mode === 'takes' || (mode === 'merge' && cyc)) {
      const takes = buildMidiTakes(list, { recIn: s.recIn, stop: s.lastPos, loop: s.loop, mode: mode === 'merge' ? 'merge' : 'takes', grid, quantizeLength: prefs.quantizeLength, passes: s.midiRec.pass });
      if (!takes.length) return;
      const tks = takes.map((tk) => {
        const pat = createPattern(t.id, { name: `${t.name} take`, length: tk.length, notes: tk.notes.map((n) => ({ id: uid('n'), ...n })) });
        pp.patterns[pat.id] = pat;
        return createTake({ name: '', patternId: pat.id, start: tk.start, length: tk.length, offset: 0 });
      });
      const { absorbed } = addRecordedTakes(pp, t, tks, { kind: 'pattern' });
      for (const k of tks) { k.name = `Take ${k.pass}`; pp.patterns[k.patternId].name = `${t.name} take ${k.pass}`; }
      const ab = new Set(absorbed);
      pp.clips = pp.clips.filter((c) => !ab.has(c.id));
      if (!t.activePatternId) t.activePatternId = tks[tks.length - 1].patternId;
      report.push(`${t.name}: ${tks.length} MIDI take${tks.length > 1 ? 's' : ''}`);
      return;
    }
    // overdub / replace: into the pattern clips under the notes, the rest into a new clip
    const clipsOf = () => pp.clips.filter((c) => c.trackId === t.id && c.type !== 'audio' && pp.patterns[c.patternId]);
    if (mode === 'replace') {
      const rr = replaceRange(list, { recIn: s.recIn, stop: s.lastPos, loop: s.loop });
      for (const c of clipsOf()) {
        const pat = pp.patterns[c.patternId];
        const a = Math.max(rr.start, c.start), b = Math.min(rr.end, c.start + c.length);
        if (b <= a) continue;
        pat.notes = pat.notes.filter((n) => {
          const L = pat.length;
          // first song position of this note inside the clip
          let sPos = c.start - (c.offset || 0) + n.start;
          while (sPos < c.start - EPS) sPos += L;
          for (; sPos < c.start + c.length - EPS; sPos += L) if (sPos >= a - EPS && sPos < b - EPS) return false;
          return true;
        });
      }
    }
    const loose = [];
    for (const nt of list) {
      const q = quantizeNote(nt.start, nt.end - nt.start, grid, { length: prefs.quantizeLength });
      const c = clipsOf().find((cl) => q.start >= cl.start - EPS && q.start < cl.start + cl.length - EPS);
      if (!c) { loose.push({ ...nt, start: q.start, dur: q.dur }); continue; }
      const pat = pp.patterns[c.patternId];
      const L = pat.length;
      let st = ((q.start - c.start + (c.offset || 0)) % L + L) % L;
      if (st >= L - EPS) st = 0;
      pat.notes.push({ id: uid('n'), pitch: nt.pitch, start: +st.toFixed(5), dur: Math.min(q.dur, L), vel: nt.vel, ...(nt.x || {}) });
    }
    if (loose.length) {
      const a = Math.max(0, Math.floor(Math.min(...loose.map((n) => n.start)) / bpb + EPS) * bpb);
      const b = Math.max(a + bpb, Math.ceil(Math.max(...loose.map((n) => n.start + n.dur)) / bpb - EPS) * bpb);
      const pat = createPattern(t.id, { name: `${t.name} rec`, length: b - a, notes: loose.map((n) => ({ id: uid('n'), pitch: n.pitch, start: +(n.start - a).toFixed(5), dur: n.dur, vel: n.vel, ...(n.x || {}) })) });
      pp.patterns[pat.id] = pat;
      pp.clips.push(createClip(t.id, { patternId: pat.id, start: a, length: b - a }));
      if (!t.activePatternId) t.activePatternId = pat.id;
    }
    report.push(`${t.name}: ${list.length} note${list.length === 1 ? '' : 's'}${mode === 'replace' ? ' (replaced)' : ''}`);
  }

  // ------------------------------------------------------------------------------------------- PCM helpers
  async function pcmOf(sampleId) {
    const buf = await engine.decodeSample(sampleId, { full: true });
    if (!buf?.getChannelData) return null;
    const channels = [];
    for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));
    return { channels, sampleRate: buf.sampleRate };
  }
  async function pcmMap(ids) {
    const m = new Map();
    for (const id of new Set(ids)) { const x = await pcmOf(id); if (x) m.set(id, x); }
    return m;
  }

  /** Render audio clips (playback-exact) to a new sample. */
  async function renderClips(clips, name) {
    const audio = clips.filter((c) => c.type === 'audio' && c.sampleId);
    if (!audio.length) return null;
    const pcm = await pcmMap(audio.map((c) => c.sampleId));
    const sr = engine.ctx?.sampleRate || [...pcm.values()][0]?.sampleRate || 48000;
    const a = Math.min(...audio.map((c) => c.start)), b = Math.max(...audio.map((c) => c.start + c.length));
    const ch = Math.max(1, ...[...pcm.values()].map((x) => Math.min(2, x.channels.length)));
    const channels = mixClipsToPcm({ clips: audio, getPcm: (id) => pcm.get(id), bpm: get().bpm, sampleRate: sr, startBeat: a, endBeat: b, channels: ch });
    const { sample, buffer } = pcmToSample(channels, sr, name);
    return { sample, buffer, start: a, length: b - a };
  }

  // ------------------------------------------------------------------------------------------- takes
  let aud = null;
  function stopAudition() {
    if (!aud) return;
    try { aud.g.gain.setTargetAtTime(0, engine.ctx.currentTime, 0.01); aud.src.stop(engine.ctx.currentTime + 0.05); } catch { /* */ }
    aud = null;
    em.emit('audition', null);
  }
  /** Play one take on its own (through the track's channel) from `fromBeat`. */
  async function auditionTake(trackId, takeId, fromBeat = null) {
    await engine.init();
    stopAudition();
    const t = get().tracks.find((x) => x.id === trackId);
    const take = t && findTake(t, takeId);
    if (!take?.sampleId) return;
    const buf = await engine.decodeSample(take.sampleId, { full: true });
    if (!buf?.getChannelData) return;
    if (engine.isPlaying) engine.pause();
    const sp = spb();
    const from = Math.min(Math.max(fromBeat ?? take.start, take.start), takeEnd(take) - 0.01);
    const off = (take.offset + from - take.start) * sp;
    const dur = (takeEnd(take) - from) * sp;
    const ctx = engine.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = take.gain ?? 1;
    src.connect(g);
    g.connect(engine.graph.tracks.get(trackId)?.strip.input || engine.graph.master.input);
    src.start(ctx.currentTime + 0.02, Math.max(0, off), Math.max(0.01, dur));
    aud = { src, g, trackId, takeId, t0: ctx.currentTime + 0.02, from, spb: sp };
    src.onended = () => { if (aud?.src === src) { aud = null; em.emit('audition', null); } };
    em.emit('audition', { trackId, takeId });
  }
  /** Beat the take audition is at (null when none). */
  const auditionPos = () => (aud && engine.ctx ? { trackId: aud.trackId, takeId: aud.takeId, beat: aud.from + Math.max(0, engine.ctx.currentTime - aud.t0) / aud.spb } : null);

  /** Flatten the comp of a track into one clip (audio: rendered with its crossfades; MIDI: one merged pattern). */
  async function flattenComp(trackId) {
    const p = get();
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t || !hasTakes(t) || !t.comp?.length) { toast('Nothing to flatten — this track has no comp.'); return null; }
    const cc = compClips(p, t);
    const audio = cc.filter((c) => c.type === 'audio');
    if (audio.length) {
      const r = await renderClips(audio, `${t.name} comp`);
      if (!r) return null;
      store.transact('Flatten comp', (pp) => {
        const tt = pp.tracks.find((x) => x.id === trackId);
        pp.samples[r.sample.id] = r.sample;
        pp.clips.push(createClip(trackId, { type: 'audio', sampleId: r.sample.id, start: +r.start.toFixed(6), length: +r.length.toFixed(6), name: r.sample.name }));
        if (tt) clearTakes(tt);
      });
      if (r.buffer) engine.buffers?.set(r.sample.id, r.buffer);
      toast('Comp flattened to one clip.', { level: 'success' });
      return r.sample.id;
    }
    // MIDI comp
    const a = Math.min(...cc.map((c) => c.start)), b = Math.max(...cc.map((c) => c.start + c.length));
    const notes = [];
    for (const c of cc) {
      const pat = p.patterns[c.patternId];
      if (!pat) continue;
      for (const n of pat.notes) {
        if (n.start < c.offset - EPS || n.start >= c.offset + c.length - EPS) continue;
        notes.push({ ...deepClone(n), id: uid('n'), start: +(n.start - c.offset + c.start - a).toFixed(5), dur: Math.min(n.dur, c.offset + c.length - n.start) });
      }
    }
    let patId = null;
    store.transact('Flatten comp', (pp) => {
      const pat = createPattern(trackId, { name: `${t.name} comp`, length: b - a, notes });
      pp.patterns[pat.id] = pat;
      patId = pat.id;
      pp.clips.push(createClip(trackId, { patternId: pat.id, start: a, length: b - a }));
      const tt = pp.tracks.find((x) => x.id === trackId);
      if (tt) clearTakes(tt);
    });
    toast('Comp flattened to one clip.', { level: 'success' });
    return patId;
  }

  /** Consolidate audio clips (one track) into one clip, rendered exactly as they play (fades, crossfades, gain). */
  async function consolidate(clipIds) {
    const p = get();
    const ids = new Set(clipIds);
    const sel = p.clips.filter((c) => ids.has(c.id) && c.type === 'audio');
    const tracks = new Set(sel.map((c) => c.trackId));
    if (sel.length < 1 || tracks.size !== 1) { toast('Select audio clips on one track to consolidate.'); return null; }
    const tid = [...tracks][0];
    const playing = trackClips(p, p.tracks.find((t) => t.id === tid)).filter((c) => ids.has(c.id));
    const r = await renderClips(playing, 'Consolidated');
    if (!r) return null;
    let nid = null;
    store.transact('Consolidate clips', (pp) => {
      pp.samples[r.sample.id] = r.sample;
      pp.clips = pp.clips.filter((c) => !ids.has(c.id));
      const c = createClip(tid, { type: 'audio', sampleId: r.sample.id, start: +r.start.toFixed(6), length: +r.length.toFixed(6), name: r.sample.name });
      nid = c.id;
      pp.clips.push(c);
    });
    if (r.buffer) engine.buffers?.set(r.sample.id, r.buffer);
    return nid;
  }

  /** Reverse audio clips (new reversed audio for the part each clip plays; fades swap). */
  async function reverseClips(clipIds) {
    const p = get();
    const sel = p.clips.filter((c) => clipIds.includes(c.id) && c.type === 'audio' && c.sampleId);
    const sp = spb();
    const out = [];
    for (const c of sel) {
      const pcm = await pcmOf(c.sampleId);
      if (!pcm) continue;
      const sr = pcm.sampleRate;
      const a = Math.round((c.offset || 0) * sp * sr), b = Math.round(((c.offset || 0) + c.length) * sp * sr);
      const { sample, buffer } = pcmToSample(reverseFrames(pcm.channels, a, b), sr, `${p.samples[c.sampleId]?.name || 'Audio'} (rev)`);
      out.push({ id: c.id, sample, buffer });
    }
    if (!out.length) return;
    store.transact('Reverse clip', (pp) => {
      for (const r of out) {
        pp.samples[r.sample.id] = r.sample;
        const c = pp.clips.find((x) => x.id === r.id);
        if (!c) continue;
        c.sampleId = r.sample.id;
        c.offset = 0;
        c.reversed = !c.reversed;
        [c.fadeIn, c.fadeOut] = [c.fadeOut, c.fadeIn];
        [c.fadeInShape, c.fadeOutShape] = [c.fadeOutShape, c.fadeInShape];
        for (const k of ['fadeIn', 'fadeOut', 'fadeInShape', 'fadeOutShape']) if (c[k] == null) delete c[k];
        if (c.gainEnv?.length) c.gainEnv = c.gainEnv.map((q) => ({ beat: +(c.length - q.beat).toFixed(6), gain: q.gain })).reverse();
      }
    });
    for (const r of out) if (r.buffer) engine.buffers?.set(r.sample.id, r.buffer);
  }

  /** Normalize audio clips: clip gain so the loudest sample the clip plays reaches targetDb. */
  async function normalizeClips(clipIds, targetDb = -0.3) {
    const p = get();
    const sel = p.clips.filter((c) => clipIds.includes(c.id) && c.type === 'audio' && c.sampleId);
    const sp = spb();
    const gains = new Map();
    for (const c of sel) {
      const pcm = await pcmOf(c.sampleId);
      if (!pcm) continue;
      const sr = pcm.sampleRate;
      const g = normalizeGain(peakOf(pcm.channels, Math.round((c.offset || 0) * sp * sr), Math.round(((c.offset || 0) + c.length) * sp * sr)), targetDb);
      if (g) gains.set(c.id, g);
    }
    if (gains.size) store.transact('Normalize', (pp) => { for (const c of pp.clips) if (gains.has(c.id)) c.gain = gains.get(c.id); });
  }

  // ------------------------------------------------------------------------------------------- capture / step
  /** Retrospective record: drop what was just played (last 2 minutes) into a clip. */
  function captureMidi(trackId = lastNoteTrack || ui.get('selectedTrackId')) {
    const p = get();
    const t = p.tracks.find((x) => x.id === trackId && x.type === 'instrument');
    if (!t) { toast('Play something on an instrument track first — Capture MIDI keeps the last 2 minutes of what you played.'); return null; }
    const bpb = beatsPerBar(p);
    const at = Math.floor((engine.getPosition() || 0) / bpb + EPS) * bpb;
    const c = capture.capture({ trackId: t.id, bpm: p.bpm, bpb, atBeat: at, grid: prefs.inputQuantize || 0, now: now() });
    if (!c?.notes.length) { toast('Nothing was played on this track in the last 2 minutes.'); return null; }
    let clipId = null;
    store.transact('Capture MIDI', (pp) => {
      const pat = createPattern(t.id, { name: `${t.name} capture`, length: c.length, notes: c.notes.map((n) => ({ id: uid('n'), pitch: n.pitch, start: +n.start.toFixed(5), dur: +n.dur.toFixed(5), vel: n.vel })) });
      pp.patterns[pat.id] = pat;
      const tt = pp.tracks.find((x) => x.id === t.id);
      if (pp.mode === 'song') { const cl = createClip(t.id, { patternId: pat.id, start: c.start, length: c.length }); clipId = cl.id; pp.clips.push(cl); }
      else if (tt) tt.activePatternId = pat.id;
    });
    toast(`Captured ${c.notes.length} note${c.notes.length === 1 ? '' : 's'} into ${t.name}${p.mode === 'song' ? ` at bar ${c.start / bpb + 1}` : ' (new pattern)'}.`, { level: 'success' });
    return clipId;
  }

  function setStepMode(on, { cursor = 0 } = {}) {
    step = on ? new StepInput({ cursor, step: prefs.stepLength || 0.25 }) : null;
    ui.set({ stepInput: !!on });
    em.emit('step', step);
    return step;
  }
  function stepTarget() {
    const p = get();
    const pat = p.patterns[ui.get('selectedPatternId')];
    if (pat) return pat;
    const t = p.tracks.find((x) => x.id === ui.get('selectedTrackId') && x.type === 'instrument');
    return t ? app.actions?.ensurePattern?.(t.id) : null;
  }
  function stepNotes(trackId, notes) {
    if (!notes) return;
    const pat = stepTarget();
    if (!pat) { toast('Select an instrument pattern for step input.'); return; }
    store.transact('Step input', (pp) => {
      const pt = pp.patterns[pat.id];
      if (!pt) return;
      for (const n of notes) pt.notes.push({ id: uid('n'), ...n });
      const need = Math.ceil((step.cursor) / 4 - EPS) * 4;
      if (need > pt.length) pt.length = need;
    });
    em.emit('step', step);
  }
  function stepRest() { if (step) { step.rest(); em.emit('step', step); } }
  function stepBack() {
    if (!step) return;
    const gone = step.back();
    const pat = stepTarget();
    if (pat && gone.length) store.transact('Step input', (pp) => { const pt = pp.patterns[pat.id]; if (pt) pt.notes = pt.notes.filter((n) => !gone.some((g) => g.pitch === n.pitch && Math.abs(g.start - n.start) < EPS)); });
    em.emit('step', step);
  }

  // ------------------------------------------------------------------------------------------- latency wizard
  /**
   * Loopback calibration: plays `count` pings through the output and finds them in the input (connect the output to
   * the input with a cable, or hold the mic to the speaker). Stores the measured round trip for that device.
   */
  async function calibrate(sourceId = DEFAULT_SOURCE, { count = 8, store: keep = true } = {}) {
    await engine.init();
    const ctx = engine.ctx;
    if (!inputs.sources.has(sourceId)) {
      try { await inputs._open(sourceId); } catch (e) { return { ok: false, message: e.message }; }
    }
    const src = inputs.sources.get(sourceId);
    if (!src || src.opening) return { ok: false, message: 'The input is not open yet.' };
    const sr = ctx.sampleRate;
    const ping = ctx.createBuffer(1, Math.round(sr * 0.01), sr);
    const d = ping.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.sin(2 * Math.PI * 2000 * i / sr) * Math.exp(-i / (sr * 0.002)) * 0.9;
    const startFrame = inputs.startCapture();
    void startFrame;
    const t0 = ctx.currentTime + 0.3;
    const times = [];
    for (let k = 0; k < count; k++) {
      const s = ctx.createBufferSource();
      s.buffer = ping;
      s.connect(ctx.destination);
      const t = t0 + k * 0.35;
      s.start(t);
      times.push(t);
    }
    await new Promise((r) => setTimeout(r, (t0 - ctx.currentTime + count * 0.35 + 0.4) * 1000));
    const cap = (await inputs.stopCapture()).get(sourceId);
    if (!cap) return { ok: false, message: 'Nothing was captured.' };
    const ch = cap.channels[0];
    const res = detectPing(ch, sr, times.map((t) => Math.round(t * sr) - cap.frame));
    if (!res) return { ok: false, message: 'No ping found in the input. Connect the output to the input (or hold the microphone to the speaker), turn the volume up and try again.' };
    if (keep) setDeviceLatency(sourceId, { calibratedMs: +res.ms.toFixed(2) });
    return { ok: true, ...res };
  }

  Object.defineProperties(em, {
    active: { get: () => !!session },
    session: { get: () => session },
    step: { get: () => step },
  });
  return Object.assign(em, {
    inputs, capture,
    prefs: () => prefs,
    setPrefs(patch) { prefs = { ...prefs, ...patch }; savePrefs(); inputs.sync().catch(() => {}); em.emit('prefs', prefs); return prefs; },
    start, finish, noteOn, noteOff, isRecordingSong,
    auditionTake, stopAudition, auditionPos, flattenComp, consolidate, reverseClips, normalizeClips,
    captureMidi, setStepMode, stepRest, stepBack, calibrate, renderClips,
  });
}
