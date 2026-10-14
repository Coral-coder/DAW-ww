// High-level user actions shared by every view: transport, tracks, patterns,
// generation, file import/export. Views may also call store.transact directly
// for local edits.
import { h, icon } from './dom.js';
import { modal, toast, fileInput, confirmDialog, contextMenu, promptText, select, button } from './components.js';
import {
  createProject, createTrack, createPattern, createClip, createEffect, createNote, createScene,
  beatsPerBar, songLengthBeats, patternsForTrack, TRACK_COLORS, DRUM_PADS,
} from '../core/model.js';
import { uid, createRng, deepClone } from '../core/util.js';
import { PRESETS, DRUM_KITS } from '../audio/index.js';
import * as gen from '../gen/index.js';
import { GENRES } from '../gen/genres.js';
import { SCALES, pitchClassName } from '../theory/index.js';
import { serializeProject, parseProjectFile, downloadBlob } from '../io/project-file.js';
import { exportMidi, importMidi } from '../io/midi.js';
import { encodeWav } from '../io/wav.js';
import { fileToSample, arrayBufferToBase64 } from '../io/samples.js';
import { createRecorder } from '../record/session.js';
import { readStrudelFile } from '../io/strudel-file.js';
import { saveLocal, listLocal, loadLocal, deleteLocal, createAutosaver } from '../io/autosave.js';
import { codeToPatterns, patternsToCode } from '../code/convert.js';

/** Where daW³'s complete source code lives (offered in the app — AGPL-3.0 §13). */
export const SOURCE_URL = 'https://github.com/Coral-coder/daw3';

const ROLE_COLORS = { drums: '#ff5f6d', bass: '#ffa94d', chords: '#4dabf7', pad: '#9775fa', lead: '#38d9a9', arp: '#3bc9db', fx: '#ced4da', perc: '#f783ac', code: '#ffd43b', audio: '#a9e34b' };

export function createActions(app) {
  const { store, ui, engine } = app;
  const get = () => store.get();
  const rngSeed = () => (Math.random() * 2 ** 31) | 0;

  // ---------------------------------------------------------------- selection
  function selectTrack(trackId) {
    const p = get();
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t) return;
    ui.set({ selectedTrackId: trackId, selectedPatternId: t.activePatternId || patternsForTrack(p, trackId)[0]?.id || null });
  }
  function selectedTrack() {
    const p = get();
    return p.tracks.find((t) => t.id === ui.get('selectedTrackId')) || null;
  }
  function selectPattern(patternId, { activate = true } = {}) {
    const p = get();
    const pat = p.patterns[patternId];
    if (!pat) return;
    ui.set({ selectedPatternId: patternId, selectedTrackId: pat.trackId });
    if (activate) {
      const t = p.tracks.find((x) => x.id === pat.trackId);
      if (t && t.activePatternId !== patternId) store.transact('Select pattern', (pp) => { pp.tracks.find((x) => x.id === pat.trackId).activePatternId = patternId; }, { undo: false });
    }
  }

  // ---------------------------------------------------------------- tracks
  /**
   * addTrack(kind, opts) — kind: 'synth'|'fm'|'organ'|'drums'|'sampler'|'audio'|'code' or a preset id.
   */
  function addTrack(kind = 'synth', opts = {}) {
    const p = get();
    let track;
    const color = opts.color || TRACK_COLORS[p.tracks.length % TRACK_COLORS.length];
    if (kind === 'audio') {
      track = createTrack({ type: 'audio', name: opts.name || `Audio ${p.tracks.length + 1}`, color, role: 'audio' });
    } else if (kind === 'code') {
      track = createTrack({ type: 'code', name: opts.name || 'Code', color: ROLE_COLORS.code, role: 'code' });
      if (opts.code !== undefined) track.code = opts.code;
    } else if (kind === 'drums' || DRUM_KITS[kind]) {
      const kit = DRUM_KITS[kind] ? kind : (opts.kit || (p.genre && GENRES[p.genre]?.drumKit) || '808');
      track = createTrack({ name: opts.name || `${DRUM_KITS[kit]?.name || 'Drums'}`, color: ROLE_COLORS.drums, role: 'drums', instrument: { type: 'drums', preset: kit, params: {} } });
    } else if (kind === 'plugin' && opts.instrument) {
      // plugin instruments (soundfont / faust / wam) — see src/ui/plugins-dialog.js
      track = createTrack({ name: opts.name || 'Plugin', color, role: opts.role || null, instrument: deepClone(opts.instrument) });
    } else if (PRESETS[kind]) {
      const pr = PRESETS[kind];
      track = createTrack({ name: opts.name || pr.name, color: ROLE_COLORS[opts.role || pr.roles?.[0]] || color, role: opts.role || pr.roles?.[0] || null, instrument: { type: pr.instrument.type, preset: kind, params: {} } });
    } else {
      const type = ['synth', 'fm', 'organ', 'sampler'].includes(kind) ? kind : 'synth';
      const names = { synth: 'Synth', fm: 'FM Synth', organ: 'Organ', sampler: 'Sampler' };
      track = createTrack({ name: opts.name || `${names[type]} ${p.tracks.length + 1}`, color, instrument: { type, preset: null, params: opts.params || {} } });
    }
    if (opts.role) track.role = opts.role;
    let pattern = null;
    if (track.type === 'instrument') {
      pattern = createPattern(track.id, { name: `${track.name} 1`, length: opts.length || beatsPerBar(p) * (track.role === 'drums' ? 1 : 2) });
      track.activePatternId = pattern.id;
    }
    store.transact(`Add ${track.name}`, (pp) => {
      pp.tracks.push(track);
      if (pattern) {
        pp.patterns[pattern.id] = pattern;
        if (pp.scenes[0]) pp.scenes[0].slots[track.id] = pattern.id;
      }
    });
    ui.set({ selectedTrackId: track.id, selectedPatternId: pattern?.id || null });
    return track;
  }

  function deleteTrack(trackId) {
    const t = get().tracks.find((x) => x.id === trackId);
    if (!t) return;
    store.transact(`Delete ${t.name}`, (p) => {
      p.tracks = p.tracks.filter((x) => x.id !== trackId);
      p.clips = p.clips.filter((c) => c.trackId !== trackId);
      for (const [id, pat] of Object.entries(p.patterns)) if (pat.trackId === trackId) delete p.patterns[id];
      for (const s of p.scenes) delete s.slots[trackId];
    });
    if (ui.get('selectedTrackId') === trackId) {
      const first = get().tracks[0];
      ui.set({ selectedTrackId: first?.id || null, selectedPatternId: first?.activePatternId || null });
    }
  }

  function duplicateTrack(trackId) {
    const p = get();
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t) return;
    const nt = deepClone(t);
    nt.id = uid('trk');
    nt.name = t.name + ' copy';
    nt.solo = false;
    const patMap = {};
    const newPats = patternsForTrack(p, trackId).map((pat) => {
      const np = deepClone(pat);
      np.id = uid('pat');
      np.trackId = nt.id;
      np.notes = np.notes.map((n) => ({ ...n, id: uid('n') }));
      patMap[pat.id] = np.id;
      return np;
    });
    nt.activePatternId = patMap[t.activePatternId] || null;
    const fxMap = {};
    nt.fx = nt.fx.map((f) => { const id = uid('fx'); fxMap[f.id] = id; return { ...f, id }; });
    if (nt.patch?.nodes) for (const n of nt.patch.nodes) if (n.fxId && fxMap[n.fxId]) n.fxId = fxMap[n.fxId];
    nt.automation = (nt.automation || []).map((l) => ({
      ...l, id: uid('aut'),
      target: String(l.target).replace(/^fx:([^:]+):/, (m, fid) => (fxMap[fid] ? `fx:${fxMap[fid]}:` : m)),
    }));
    const newClips = p.clips.filter((c) => c.trackId === trackId).map((c) => ({ ...c, id: uid('clip'), trackId: nt.id, patternId: patMap[c.patternId] || c.patternId }));
    store.transact(`Duplicate ${t.name}`, (pp) => {
      const idx = pp.tracks.findIndex((x) => x.id === trackId);
      pp.tracks.splice(idx + 1, 0, nt);
      for (const np of newPats) pp.patterns[np.id] = np;
      pp.clips.push(...newClips);
      for (const s of pp.scenes) if (s.slots[trackId]) s.slots[nt.id] = patMap[s.slots[trackId]];
    });
    selectTrack(nt.id);
  }

  function updateTrack(trackId, fn, label = 'Edit track', opts = {}) {
    store.transact(label, (p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      if (t) fn(t, p);
    }, opts);
  }

  function moveTrack(trackId, dir) {
    store.transact('Move track', (p) => {
      const i = p.tracks.findIndex((t) => t.id === trackId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= p.tracks.length) return;
      [p.tracks[i], p.tracks[j]] = [p.tracks[j], p.tracks[i]];
    });
  }

  async function renameTrack(trackId) {
    const t = get().tracks.find((x) => x.id === trackId);
    if (!t) return;
    const name = await promptText('Rename track', t.name);
    if (name) updateTrack(trackId, (tt) => { tt.name = name; }, 'Rename track');
  }

  function trackMenuItems(trackId) {
    const t = get().tracks.find((x) => x.id === trackId);
    if (!t) return [];
    const items = [
      { label: 'Rename…', icon: 'pencil', onClick: () => renameTrack(trackId) },
      { label: 'Duplicate', icon: 'copy', onClick: () => duplicateTrack(trackId) },
      { label: t.mute ? 'Unmute' : 'Mute', icon: 'mute', onClick: () => updateTrack(trackId, (tt) => { tt.mute = !tt.mute; }, 'Mute') },
      { label: t.solo ? 'Unsolo' : 'Solo', icon: 'headphones', onClick: () => updateTrack(trackId, (tt) => { tt.solo = !tt.solo; }, 'Solo') },
      { label: 'Color', submenu: TRACK_COLORS.map((c) => ({ label: c, onClick: () => updateTrack(trackId, (tt) => { tt.color = c; }, 'Track color') })) },
      { label: 'Move up', onClick: () => moveTrack(trackId, -1) },
      { label: 'Move down', onClick: () => moveTrack(trackId, 1) },
    ];
    if (t.type === 'instrument') {
      items.push('-', { header: 'Generate into active pattern' });
      const isDrums = t.instrument?.type === 'drums';
      if (isDrums) items.push({ label: 'Drum pattern', icon: 'dice', onClick: () => generatePart('drums', { trackId }) });
      else {
        for (const role of ['chords', 'bass', 'lead', 'arp', 'pad']) items.push({ label: `${role[0].toUpperCase() + role.slice(1)}`, icon: 'dice', onClick: () => generatePart(role, { trackId }) });
      }
      items.push({ label: 'New pattern', icon: 'plus', onClick: () => newPattern(trackId) });
      items.push({ label: 'Export track as Strudel code', icon: 'code', onClick: () => exportCode([trackId]) });
    }
    if (app.freezeMenuItems) items.push('-', ...app.freezeMenuItems(trackId)); // engine-ui.js: freeze / bounce / flatten
    items.push('-', { label: 'Delete track', icon: 'trash', onClick: () => deleteTrack(trackId) });
    return items;
  }

  // ---------------------------------------------------------------- patterns
  function newPattern(trackId, { length, name, notes } = {}) {
    const p = get();
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t || t.type !== 'instrument') return null;
    const count = patternsForTrack(p, trackId).length;
    const cur = p.patterns[t.activePatternId];
    const pat = createPattern(trackId, { name: name || `${t.name} ${count + 1}`, length: length || cur?.length || beatsPerBar(p), notes: notes || [] });
    store.transact('New pattern', (pp) => {
      pp.patterns[pat.id] = pat;
      pp.tracks.find((x) => x.id === trackId).activePatternId = pat.id;
    });
    ui.set({ selectedTrackId: trackId, selectedPatternId: pat.id });
    return pat;
  }

  function duplicatePattern(patternId) {
    const src = get().patterns[patternId];
    if (!src) return null;
    const np = deepClone(src);
    np.id = uid('pat');
    np.name = src.name.replace(/( \d+)?$/, (m) => ` ${(parseInt(m) || 1) + 1}`);
    np.notes = np.notes.map((n) => ({ ...n, id: uid('n') }));
    store.transact('Duplicate pattern', (p) => {
      p.patterns[np.id] = np;
      const t = p.tracks.find((x) => x.id === src.trackId);
      if (t) t.activePatternId = np.id;
    });
    ui.set({ selectedPatternId: np.id, selectedTrackId: src.trackId });
    return np;
  }

  function deletePattern(patternId) {
    const pat = get().patterns[patternId];
    if (!pat) return;
    store.transact('Delete pattern', (p) => {
      delete p.patterns[patternId];
      p.clips = p.clips.filter((c) => c.patternId !== patternId);
      for (const s of p.scenes) for (const [tid, pid] of Object.entries(s.slots)) if (pid === patternId) delete s.slots[tid];
      const t = p.tracks.find((x) => x.id === pat.trackId);
      if (t && t.activePatternId === patternId) t.activePatternId = Object.values(p.patterns).find((x) => x.trackId === t.id)?.id || null;
    });
    if (ui.get('selectedPatternId') === patternId) {
      const t = get().tracks.find((x) => x.id === pat.trackId);
      ui.set({ selectedPatternId: t?.activePatternId || null });
    }
  }

  /** Make sure the track has an active pattern; returns it. */
  function ensurePattern(trackId) {
    const p = get();
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t || t.type !== 'instrument') return null;
    if (t.activePatternId && p.patterns[t.activePatternId]) return p.patterns[t.activePatternId];
    return newPattern(trackId);
  }

  function setPatternNotes(patternId, notes, label = 'Edit notes', opts = {}) {
    store.transact(label, (p) => {
      const pat = p.patterns[patternId];
      if (pat) pat.notes = notes.map((n) => ({ id: n.id || uid('n'), pitch: n.pitch, start: +n.start.toFixed(5), dur: Math.max(0.01, +n.dur.toFixed(5)), vel: n.vel ?? 0.8 }));
    }, opts);
  }

  // ---------------------------------------------------------------- transport
  async function ensureAudio() {
    try { await engine.init(); } catch (e) { toast('Audio could not start: ' + e.message, { level: 'error' }); throw e; }
  }
  async function togglePlay() {
    await ensureAudio();
    if (engine.isPlaying) engine.pause(); else engine.play();
  }
  async function play() { await ensureAudio(); if (!engine.isPlaying) engine.play(); }
  function stop() {
    if (engine.isPlaying) engine.stop();
    else engine.setPosition(get().mode === 'song' && get().loop.enabled ? get().loop.start : 0);
    ui.set({ recording: false });
  }
  function setPosition(beat) { engine.setPosition(Math.max(0, beat)); }
  function setMode(mode) {
    if (get().mode === mode) return;
    store.transact(`${mode === 'song' ? 'Song' : 'Pattern'} mode`, (p) => { p.mode = mode; }, { undo: false });
    if (engine.isPlaying) engine.setPosition(0);
    app.setStatus?.(mode === 'song' ? 'Song mode: playing the arrangement timeline.' : 'Pattern mode: looping each track\'s active pattern.');
  }
  async function toggleRecord() {
    const rec = !ui.get('recording');
    if (!rec) {
      ui.set({ recording: false });
      if (recorder.active) await recorder.finish();
      return;
    }
    const armedAudio = get().tracks.filter((t) => t.type === 'audio' && t.arm);
    if (armedAudio.length) { await startAudioRecording(); return; }
    ui.set({ recording: true });
    if (ui.get('autoArm')) {
      // Automation armed: Record starts a recording pass (song mode) — move any control to write it
      if (get().mode !== 'song') setMode('song');
      toast('Recording automation: move any knob, fader or switch — each setting gets its own lane. Stop to finish the pass.');
      await play();
      return;
    }
    if (!app.keyboardPiano?.enabled) { app.keyboardPiano.enabled = true; }
    if (get().mode === 'song') {
      // song mode: a recording session (count-in, pre-roll, punch, cycle takes, overdub / replace — src/record)
      try { await ensureAudio(); } catch { ui.set({ recording: false }); return; }
      if (!(await recorder.start({ audio: false, midi: true }))) ui.set({ recording: false });
      return;
    }
    toast('Recording: play notes with your computer keyboard (Z–M, Q–P) or a MIDI keyboard. Notes go into the selected track\'s active pattern. Arm an audio track (●) to record from your microphone instead.');
    await play();
  }

  // ---------------------------------------------------------------- recording sessions (src/record)
  // Record ▸ with armed audio tracks (or MIDI in song mode): count-in / pre-roll, punch, cycle takes, latency-
  // compensated multi-track capture, input monitoring — see src/record/session.js. When the transport stops the
  // takes are committed as one undo step.
  const recorder = createRecorder(app, { toast });
  app.rec = recorder;
  const getCountIn = () => (recorder.prefs().countInBars || 0) > 0;
  const setCountIn = (v) => { recorder.setPrefs({ countInBars: typeof v === 'number' ? v : (v ? 1 : 0) }); ui.set({ countIn: !!v }); };
  ui.set({ countIn: getCountIn(), audioRecording: false });

  async function startAudioRecording() {
    try { await ensureAudio(); } catch { return false; }
    const ok = await recorder.start({ audio: true, midi: true });
    if (!ok) ui.set({ recording: false });
    return ok;
  }
  const finishAudioRecording = () => recorder.finish();

  // live notes + recording
  const liveHeld = new Map(); // `${trackId}|${pitch}` -> {trackId, startBeat, vel}
  const heldKeyOf = (pitch, trackId) => {
    if (trackId != null) return `${trackId}|${pitch}`;
    for (const k of liveHeld.keys()) if (k.endsWith(`|${pitch}`)) return k; // any track (keyboard piano / old callers)
    return null;
  };
  async function liveNoteOn(pitch, vel = 0.8, trackId = ui.get('selectedTrackId')) {
    const t = get().tracks.find((x) => x.id === trackId);
    if (!t || t.type !== 'instrument') { if (!t) toast('Select an instrument track to play it'); return; }
    const held = { trackId, startBeat: engine.getPosition(), vel };
    liveHeld.set(`${trackId}|${pitch}`, held);
    app.emitLiveNote?.(pitch, true);
    // noteOff awaits `ready`, so a quick release during audio start-up can't leave a stuck note.
    held.ready = ensureAudio().then(() => {
      held.startBeat = engine.getPosition();
      engine.noteOn(trackId, pitch, vel);
      recorder.noteOn(trackId, pitch, vel, held.startBeat); // capture buffer / step input / song-mode sessions
    }).catch(() => {});
  }
  /** trackId: which track's note (default: the first held one of that pitch); expr: note expression to record
   * ({bend, bendAt} from MPE / pitch bend, see src/control/router.js). */
  async function liveNoteOff(pitch, trackId = null, expr = null) {
    const hk = heldKeyOf(pitch, trackId);
    const held = hk ? liveHeld.get(hk) : null;
    liveHeld.delete(hk);
    if (!held) return;
    await held.ready;
    engine.noteOff(held.trackId, pitch);
    app.emitLiveNote?.(pitch, false);
    if (recorder.noteOff(held.trackId, pitch, engine.getPosition(), expr)) return;
    if (ui.get('recording') && engine.isPlaying) {
      const p = get();
      const snap = recorder.prefs().inputQuantize || 0;
      // In song mode, record into the pattern of the clip under the playhead (respecting clip start/offset).
      const clip = p.mode === 'song' ? p.clips.find((cl) => cl.trackId === held.trackId && cl.type !== 'audio' && p.patterns[cl.patternId] && held.startBeat >= cl.start && held.startBeat < cl.start + cl.length) : null;
      const pat = clip ? p.patterns[clip.patternId] : ensurePattern(held.trackId);
      if (!pat) return;
      const rel = clip ? held.startBeat - clip.start + (clip.offset || 0) : held.startBeat;
      const localStart = ((rel % pat.length) + pat.length) % pat.length;
      let start = snap ? Math.round(localStart / snap) * snap : localStart;
      if (start >= pat.length) start -= pat.length;
      const raw = engine.getPosition() - held.startBeat;
      const dur = snap ? Math.max(snap, Math.round(raw / snap) * snap) : Math.max(0.01, +raw.toFixed(5));
      store.transact('Record note', (pp) => {
        pp.patterns[pat.id]?.notes.push(expr ? { ...createNote(pitch, start, dur, held.vel), ...expr } : createNote(pitch, start, dur, held.vel));
      });
    }
  }

  // Web MIDI input
  async function enableMidiInput() {
    if (app.control) { app.control.openPrefs('midi'); return; } // src/control: device manager, routing, learn
    if (!navigator.requestMIDIAccess) { toast('Web MIDI is not supported in this browser', { level: 'warn' }); return; }
    try {
      const access = await navigator.requestMIDIAccess();
      let count = 0;
      for (const input of access.inputs.values()) {
        count++;
        input.onmidimessage = (m) => {
          const [st, d1, d2] = m.data;
          const cmd = st & 0xf0;
          if (cmd === 0x90 && d2 > 0) liveNoteOn(d1, d2 / 127);
          else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) liveNoteOff(d1);
        };
      }
      toast(count ? `MIDI input enabled (${count} device${count > 1 ? 's' : ''})` : 'No MIDI devices found — plug one in and try again', { level: count ? 'success' : 'warn' });
    } catch (e) {
      toast('MIDI access denied: ' + e.message, { level: 'error' });
    }
  }

  // ---------------------------------------------------------------- project / genre
  function setGenre(genreId) {
    store.transact('Genre', (p) => { p.genre = genreId; });
    const g = GENRES[genreId];
    if (g) app.setStatus?.(`${g.name}: ${g.bpm?.[0]}–${g.bpm?.[1]} BPM. ${g.tips?.[0] || ''}`);
  }

  function applyGenreDefaults(genreId) {
    const g = GENRES[genreId];
    if (!g) return;
    store.transact(`Apply ${g.name} defaults`, (p) => {
      p.genre = genreId;
      p.bpm = g.defaultBpm || p.bpm;
      p.swing = g.swing ?? p.swing;
      if (g.timeSig) p.timeSig = [...g.timeSig];
      if (g.scales?.[0] && SCALES[g.scales[0]]) p.key.scale = g.scales[0];
    });
  }

  async function newProject({ confirm = true } = {}) {
    if (confirm && get().tracks.length && !(await confirmDialog('New project', 'Start a new project? Unsaved changes are kept in the local autosave list.'))) return false;
    engine.stop?.();
    await saveLocal(get()).catch(() => {});
    store.load(createProject());
    ui.set({ selectedTrackId: null, selectedPatternId: null, selectedClipIds: [] });
    return true;
  }

  function loadProjectObject(project, label = 'Project loaded') {
    engine.stop?.();
    store.load(project);
    const first = get().tracks[0];
    ui.set({ selectedTrackId: first?.id || null, selectedPatternId: first?.activePatternId || null, selectedClipIds: [] });
    toast(`${label}: ${get().name}`, { level: 'success' });
  }

  async function openProject(file) {
    if (!(file instanceof Blob)) [file] = await fileInput('.daW3,.daw3,.json,application/json,.dawproject');
    if (!file) return;
    if (/\.dawproject$/i.test(file.name || '')) return interchange('importDawprojectFile', file);
    try {
      const text = await file.text();
      loadProjectObject(parseProjectFile(text), 'Opened');
    } catch (e) {
      toast('Could not open project: ' + e.message, { level: 'error', timeout: 6000 });
    }
  }

  async function saveProject() {
    const p = get();
    const safe = (p.name || 'project').replace(/[^\w\- ]+/g, '').trim() || 'project';
    downloadBlob(new Blob([serializeProject(p)], { type: 'application/json' }), `${safe}.daW3`);
    await saveLocal(p).catch(() => {});
    toast('Project saved — reload it any time with Open (Ctrl+O)', { level: 'success' });
  }

  async function renameProject() {
    const name = await promptText('Project name', get().name);
    if (name) store.transact('Rename project', (p) => { p.name = name; });
  }

  // ---------------------------------------------------------------- export / import
  /** Interchange formats (DAWproject, stems bundle, MusicXML) — lazy-loaded, see src/io/interchange/ui.js. */
  function interchange(fn, ...args) {
    return import('../io/interchange/ui.js')
      .then((m) => m[fn]({ app, ensureAudio, loadProjectObject, selectTrack }, ...args))
      .catch((e) => { console.error(e); toast(`Interchange failed: ${e.message}`, { level: 'error', timeout: 7000 }); });
  }
  let exportNoticeShown = false;
  async function exportWav({ stems = false } = {}) {
    await ensureAudio();
    const p = get();
    const songMode = p.mode === 'song' && p.clips.length;
    const bpb = beatsPerBar(p);
    let endBeat;
    if (songMode) endBeat = songLengthBeats(p);
    else {
      const lens = p.tracks.map((t) => p.patterns[t.activePatternId]?.length || 0);
      const longest = Math.max(bpb, ...lens);
      endBeat = Math.max(longest, bpb * 4);
    }
    const prog = h('div.progress', h('div'));
    const m = modal({ title: stems ? 'Rendering stems…' : 'Rendering mixdown…', body: h('div.col', h('p', `Rendering ${Math.round(endBeat / bpb)} bars in ${songMode ? 'song' : 'pattern'} mode at ${p.bpm} BPM.`), prog) });
    prog.firstChild.style.width = '35%';
    try {
      const result = await engine.renderOffline({
        startBeat: 0, endBeat, stems, mode: songMode ? 'song' : 'pattern',
        // shown when Strudel-engine code tracks had to be exported with daW³ instruments
        onNotice: (msg) => { if (!exportNoticeShown) toast(msg, { level: 'warn', timeout: 9000 }); exportNoticeShown = true; },
      });
      prog.firstChild.style.width = '90%';
      const safe = (p.name || 'mix').replace(/[^\w\- ]+/g, '').trim() || 'mix';
      if (stems) {
        for (const [id, buf] of Object.entries(result)) {
          const tname = id === 'master' ? 'master' : (p.tracks.find((t) => t.id === id)?.name || id);
          downloadBlob(new Blob([encodeWav(buf, { bitDepth: 24 })], { type: 'audio/wav' }), `${safe} - ${tname}.wav`);
        }
      } else {
        downloadBlob(new Blob([encodeWav(result, { bitDepth: 24 })], { type: 'audio/wav' }), `${safe}.wav`);
      }
      toast('Export complete', { level: 'success' });
    } catch (e) {
      console.error(e);
      toast('Export failed: ' + e.message, { level: 'error', timeout: 7000 });
    } finally {
      m.close();
    }
  }

  function exportMidiFile() {
    const p = get();
    const bytes = exportMidi(p, { mode: p.mode === 'song' && p.clips.length ? 'song' : 'pattern' });
    downloadBlob(new Blob([bytes], { type: 'audio/midi' }), `${(p.name || 'song').replace(/[^\w\- ]+/g, '')}.mid`);
    toast('MIDI exported', { level: 'success' });
  }

  function exportCode(trackIds) {
    // the Code view's "Code style" (localStorage 'daw3-code-style'): live-coder sketch (default) or exact
    let style = 'live';
    try { style = JSON.parse(localStorage.getItem('daw3-code-style') || '"live"') === 'exact' ? 'exact' : 'live'; } catch { /* default */ }
    const code = patternsToCode(get(), { ...(trackIds ? { trackIds } : {}), style });
    const ta = h('textarea.prompt-input', { rows: 18, readOnly: true, style: { width: '100%', fontSize: '12px' } });
    ta.value = code;
    modal({
      title: 'Strudel code', width: 760, body: h('div.col', h('p.muted', 'Paste into strudel.cc, or into a Code track here.'), ta),
      actions: [
        { label: 'Copy', onClick: () => { navigator.clipboard?.writeText(code); toast('Copied'); return false; } },
        { label: 'Download .strudel', onClick: () => { downloadBlob(new Blob([code], { type: 'text/plain' }), `${get().name || 'song'}.strudel`); return false; } },
        { label: 'Open as Code track', primary: true, onClick: () => { addTrack('code', { code, name: 'Exported code' }); ui.set({ view: 'code' }); } },
      ],
    });
  }

  async function importMidiFile(file) {
    if (!(file instanceof Blob)) [file] = await fileInput('.mid,.midi,audio/midi');
    if (!file) return;
    try {
      const data = importMidi(await file.arrayBuffer());
      const p = get();
      const bpb = beatsPerBar(p);
      const newTracks = [], newPats = [], newClips = [];
      for (const mt of data.tracks) {
        if (!mt.notes.length) continue;
        const end = Math.max(...mt.notes.map((n) => n.start + n.dur));
        const length = Math.max(bpb, Math.ceil(end / bpb) * bpb);
        const t = mt.isDrums
          ? createTrack({ name: mt.name || 'MIDI Drums', role: 'drums', color: ROLE_COLORS.drums, instrument: { type: 'drums', preset: '808', params: {} } })
          : createTrack({ name: mt.name || 'MIDI Track', color: TRACK_COLORS[(p.tracks.length + newTracks.length) % TRACK_COLORS.length], instrument: { type: 'synth', preset: guessPresetForNotes(mt.notes), params: {} } });
        const pat = createPattern(t.id, { name: t.name, length, notes: mt.notes.map((n) => createNote(n.pitch, n.start, n.dur, n.vel)) });
        t.activePatternId = pat.id;
        newTracks.push(t); newPats.push(pat);
        newClips.push(createClip(t.id, { patternId: pat.id, start: 0, length }));
      }
      store.transact('Import MIDI', (pp) => {
        if (data.bpm && !pp.tracks.length) pp.bpm = Math.round(data.bpm);
        pp.tracks.push(...newTracks);
        for (const pat of newPats) pp.patterns[pat.id] = pat;
        pp.clips.push(...newClips);
      });
      if (newTracks[0]) selectTrack(newTracks[0].id);
      toast(`Imported ${newTracks.length} MIDI track(s)`, { level: 'success' });
    } catch (e) {
      toast('MIDI import failed: ' + e.message, { level: 'error' });
    }
  }

  function guessPresetForNotes(notes) {
    const avg = notes.reduce((s, n) => s + n.pitch, 0) / Math.max(1, notes.length);
    if (avg < 48) return 'saw-bass';
    const poly = notes.filter((n, i) => notes.some((m, j) => j !== i && Math.abs(m.start - n.start) < 0.01)).length / Math.max(1, notes.length);
    if (poly > 0.4) return 'electric-piano';
    return 'saw-lead';
  }

  async function importStrudel(fileOrText) {
    let file = fileOrText;
    if (!file) [file] = await fileInput('.strudel,.str,.js,.txt,.tidal,text/plain');
    if (!file) return;
    try {
      const { name, code } = await readStrudelFile(file);
      const t = addTrack('code', { code, name: name || 'Strudel' });
      ui.set({ view: 'code', selectedTrackId: t.id });
      toast(`Imported "${name}". Play it live, or use "Render to tracks" to expand it into editable patterns.`, { level: 'success', timeout: 6000 });
    } catch (e) {
      toast('Strudel import failed: ' + e.message, { level: 'error' });
    }
  }

  /** Expand a code track into real instrument tracks + patterns (and clips). */
  function renderCodeToTracks(trackId, { cycles = 4 } = {}) {
    const p = get();
    const src = p.tracks.find((t) => t.id === trackId);
    if (!src) return;
    const bpb = beatsPerBar(p);
    let parts;
    try { parts = codeToPatterns(src.code, { cycles, beatsPerCycle: bpb }); } catch (e) { toast('Code error: ' + e.message, { level: 'error' }); return; }
    if (!parts?.length) { toast('No events produced by this code', { level: 'warn' }); return; }
    const newTracks = [], newPats = [], newClips = [];
    for (const part of parts) {
      const isDrums = part.kind === 'drums';
      const generic = !part.name || /^(pattern|\$)\s*\d*$/i.test(part.name.trim());
      const label = isDrums ? 'Drums' : (part.sound ? part.sound[0].toUpperCase() + part.sound.slice(1) : 'Synth');
      part.name = generic ? label : `${part.name} ${label}`;
      const preset = isDrums ? null : (PRESETS[part.sound] ? part.sound : soundToPreset(part.sound, part.notes));
      const t = isDrums
        ? createTrack({ name: part.name || 'Drums', role: 'drums', color: ROLE_COLORS.drums, instrument: { type: 'drums', preset: bankToKit(part.bank) || '808', params: {} } })
        : createTrack({ name: part.name || part.sound || 'Synth', color: TRACK_COLORS[(p.tracks.length + newTracks.length) % TRACK_COLORS.length], instrument: { type: PRESETS[preset]?.instrument?.type || 'synth', preset, params: {} } });
      const length = part.lengthBeats || cycles * bpb;
      const pat = createPattern(t.id, { name: t.name, length, notes: part.notes.map((n) => createNote(n.pitch, n.start, n.dur, n.vel ?? 0.8)) });
      t.activePatternId = pat.id;
      newTracks.push(t); newPats.push(pat);
      newClips.push(createClip(t.id, { patternId: pat.id, start: 0, length }));
    }
    store.transact('Render code to tracks', (pp) => {
      pp.tracks.push(...newTracks);
      for (const pat of newPats) pp.patterns[pat.id] = pat;
      pp.clips.push(...newClips);
      const ct = pp.tracks.find((t) => t.id === trackId);
      if (ct) ct.mute = true;
    });
    toast(`Expanded into ${newTracks.length} editable track(s). The code track was muted so they don't double up.`, { level: 'success', timeout: 6000 });
    if (newTracks[0]) selectTrack(newTracks[0].id);
  }
  function bankToKit(bank) {
    if (!bank) return null;
    const b = String(bank).toLowerCase();
    if (b.includes('909')) return '909';
    if (b.includes('808')) return '808';
    if (b.includes('707') || b.includes('linn')) return 'house';
    return null;
  }
  function soundToPreset(sound = '', notes = []) {
    const s = String(sound).toLowerCase();
    const avg = notes.reduce((a, n) => a + n.pitch, 0) / Math.max(1, notes.length);
    if (s.includes('square')) return avg < 48 ? 'chip-bass' : 'square-lead';
    if (s.includes('sine')) return avg < 48 ? 'sub-bass' : 'fm-bell-lead';
    if (s.includes('tri')) return 'flute';
    if (s.includes('piano')) return 'grand-piano';
    if (s.includes('epiano') || s.includes('rhodes')) return 'electric-piano';
    if (s.includes('organ')) return 'organ-drawbar';
    if (s.includes('supersaw')) return 'supersaw-lead';
    if (s.includes('pluck')) return 'pluck';
    if (s.includes('pad')) return 'warm-pad';
    return avg < 48 ? 'saw-bass' : 'saw-lead';
  }

  async function importSamples(files) {
    if (!files) files = await fileInput('audio/*,.wav,.mp3,.ogg,.flac,.aiff,.m4a', true);
    if (!files?.length) return [];
    const added = [];
    for (const f of files) {
      try {
        const s = await fileToSample(f);
        added.push(s);
      } catch (e) { toast(`Could not import ${f.name}: ${e.message}`, { level: 'error' }); }
    }
    if (added.length) {
      store.transact('Import samples', (p) => { for (const s of added) p.samples[s.id] = s; });
      for (const s of added) engine.decodeSample?.(s.id).catch(() => {});
      toast(`Imported ${added.length} sample(s). Drag them onto tracks, drum pads or a sampler.`, { level: 'success' });
    }
    return added;
  }

  /** Create an audio clip for a sample at a beat position (creates an audio track if needed). */
  async function placeSample(sampleId, { trackId, start = 0 } = {}) {
    const p = get();
    const s = p.samples[sampleId];
    if (!s) return;
    let track = p.tracks.find((t) => t.id === trackId && t.type === 'audio');
    if (!track) track = addTrack('audio', { name: s.name.replace(/\.[^.]+$/, '') });
    let dur = s.duration;
    if (!dur) {
      try { const buf = await engine.decodeSample(sampleId); dur = buf.duration; } catch { dur = 2; }
    }
    const lengthBeats = Math.max(0.25, Math.round((dur * get().bpm) / 60 * 4) / 4);
    store.transact('Place sample', (pp) => {
      pp.clips.push(createClip(track.id, { type: 'audio', sampleId, start, length: lengthBeats, name: s.name }));
      if (pp.samples[sampleId] && !pp.samples[sampleId].duration) pp.samples[sampleId].duration = dur;
    });
  }

  /** Load a sample into a new (or given) sampler track. */
  function sampleToSampler(sampleId, trackId) {
    const s = get().samples[sampleId];
    if (!s) return;
    if (trackId) {
      updateTrack(trackId, (t) => { if (t.instrument) { t.instrument.type = 'sampler'; t.instrument.preset = null; t.instrument.params = { ...t.instrument.params, sampleId }; } }, 'Load sample');
    } else {
      const t = addTrack('sampler', { name: s.name.replace(/\.[^.]+$/, ''), params: { sampleId } });
      updateTrack(t.id, (tt) => { tt.instrument.params.sampleId = sampleId; }, 'Load sample', { undo: false });
    }
  }

  // ---------------------------------------------------------------- generation
  function projectKey() {
    const p = get();
    return { root: p.key.root, scale: p.key.scale };
  }

  /** Generate a part into a track's active pattern (creates the track if missing). */
  function generatePart(role, { trackId, genre, bars, seed, replace = true } = {}) {
    const p = get();
    const genreId = genre || p.genre || 'pop';
    const g = GENRES[genreId] || {};
    const rng = createRng(seed ?? rngSeed());
    const bpb = beatsPerBar(p);
    let track = trackId ? p.tracks.find((t) => t.id === trackId) : null;
    if (!track) {
      if (role === 'drums') track = addTrack('drums', { kit: g.drumKit });
      else {
        const preset = g.presets?.[role] || { bass: 'saw-bass', chords: 'electric-piano', pad: 'warm-pad', lead: 'saw-lead', arp: 'arp-pluck' }[role] || 'saw-lead';
        track = addTrack(PRESETS[preset] ? preset : 'synth', { role });
      }
    }
    const pat = ensurePattern(track.id);
    const nBars = bars || Math.max(1, Math.round(pat.length / bpb)) || (role === 'drums' ? 1 : 4);
    const { root, scale } = projectKey();
    let notes = [];
    try {
      notes = gen.generatePartNotes
        ? gen.generatePartNotes(role, { genre: genreId, key: root, root, scale, bars: nBars, beatsPerBar: bpb, rng, project: p })
        : fallbackGenerate(role, { genreId, root, scale, nBars, bpb, rng, p });
    } catch (e) {
      console.error(e);
      toast('Generator error: ' + e.message, { level: 'error' });
      return;
    }
    const length = nBars * bpb;
    store.transact(`Generate ${role}`, (pp) => {
      const pt = pp.patterns[pat.id];
      if (!pt) return;
      pt.length = Math.max(pt.length, length);
      const fresh = notes.filter((n) => n.start < pt.length).map((n) => createNote(n.pitch, n.start, n.dur, n.vel));
      pt.notes = replace ? fresh : [...pt.notes, ...fresh];
    });
    ui.set({ selectedTrackId: track.id, selectedPatternId: pat.id });
    app.setStatus?.(`Generated ${role} for ${track.name} in ${pitchClassName(root)} ${SCALES[scale]?.name || scale} (${GENRES[genreId]?.name || genreId}).`);
    return track;
  }

  function fallbackGenerate(role, { genreId, root, scale, nBars, bpb, rng, p }) {
    if (role === 'drums') return gen.generateDrumPattern({ genre: genreId, bars: nBars, rng });
    const progression = currentProgression(nBars, rng);
    const key = { root, scale };
    if (role === 'chords' || role === 'pad') return gen.progressionToNotes(progression, { style: role === 'pad' ? 'whole' : (GENRES[genreId]?.chordStyle || 'whole'), key, rng, beatsPerBar: bpb });
    if (role === 'bass') return gen.generateBass({ progression, key, style: GENRES[genreId]?.bassStyle || 'root', bars: nBars, rng, beatsPerBar: bpb });
    if (role === 'arp') return gen.arpeggiate(progression, { mode: 'updown', rate: 0.25, octaves: 2, rng });
    return gen.generateMelody({ progression, key, root, scale, style: GENRES[genreId]?.melodyStyle || 'lead', bars: nBars, rng, beatsPerBar: bpb });
  }

  /** Progression shared by all parts: derived from an existing chords track if present, else generated & cached. */
  let cachedProg = null;
  function currentProgression(nBars, rng) {
    const p = get();
    const sig = `${p.key.root}|${p.key.scale}|${p.genre}|${nBars}`;
    if (cachedProg && cachedProg.sig === sig) return cachedProg.prog;
    const prog = gen.generateProgression({ key: p.key.root, root: p.key.root, scale: p.key.scale, genre: p.genre || 'pop', bars: nBars, chordsPerBar: 1, rng, beatsPerBar: beatsPerBar(p) });
    cachedProg = { sig, prog };
    return prog;
  }
  function newProgression() { cachedProg = null; }

  async function generateSong(opts = {}) {
    const genre = opts.genre || get().genre || 'house';
    const seed = opts.seed ?? rngSeed();
    let partial;
    try {
      partial = gen.generateSong({ genre, key: opts.key, root: opts.key, scale: opts.scale, bpm: opts.bpm, seed, length: opts.length, targetMinutes: opts.targetMinutes });
    } catch (e) {
      console.error(e);
      toast('Song generation failed: ' + e.message, { level: 'error' });
      return;
    }
    const base = opts.keepProject ? deepClone({ ...get(), samples: undefined }) : createProject();
    const project = {
      ...base,
      ...partial,
      samples: opts.keepProject ? get().samples : {},
      name: opts.name || `${GENRES[genre]?.name || genre} sketch`,
      mode: 'song',
      // the generator mixes the song: its own Reverb/Delay buses (tracks send to them) and master chain
      buses: partial.buses || base.buses,
      master: partial.master || base.master,
    };
    // Older generators: give generated tracks tasteful sends to the shared reverb/delay buses.
    const [rev, dly] = partial.buses ? [] : project.buses;
    for (const t of project.tracks) {
      t.sends = t.sends || {};
      const role = t.role;
      if (rev && ['pad', 'lead', 'chords', 'arp'].includes(role)) t.sends[rev.id] = role === 'pad' ? 0.35 : 0.2;
      if (dly && ['lead', 'arp'].includes(role)) t.sends[dly.id] = 0.15;
    }
    const end = (project.clips || []).reduce((m, c) => Math.max(m, c.start + c.length), 0);
    project.loop = { enabled: false, start: 0, end: end || 16 };
    engine.stop?.();
    store.load(project);
    const first = get().tracks[0];
    ui.set({ selectedTrackId: first?.id || null, selectedPatternId: first?.activePatternId || null, view: 'arrange' });
    toast(`Generated a ${GENRES[genre]?.name || genre} song in ${pitchClassName(get().key.root)} ${SCALES[get().key.scale]?.name || ''} at ${get().bpm} BPM. Press Space!`, { level: 'success', timeout: 6000 });
  }

  // ---------------------------------------------------------------- assistant
  function applyAssistantAction(action) {
    if (!action) return;
    if (action.kind === 'generate-part') { generatePart(action.payload.role, { genre: action.payload.genre, trackId: action.payload.trackId }); return; }
    if (action.kind === 'open-view') { ui.set({ view: action.payload.view }); return; }
    try {
      store.transact(action.label || 'Assistant', (p) => gen.applyAssistantAction(p, action, { createRng, rng: createRng(rngSeed()) }));
    } catch (e) {
      console.error(e);
      toast('Could not apply: ' + e.message, { level: 'error' });
    }
  }

  // ---------------------------------------------------------------- menus & dialogs
  function mainMenuItems() {
    return [
      { header: get().name },
      { label: 'New project', icon: 'file', onClick: () => newProject() },
      { label: 'New from genre…', icon: 'wand', onClick: () => showSongWizard() },
      { label: 'Guided session…', icon: 'sparkles', onClick: () => { ui.set({ assistantOpen: true }); app.panels?.assistant?.startGuide?.(); } },
      { label: 'Open project…', icon: 'folder', shortcut: 'Ctrl+O', onClick: () => openProject() },
      { label: 'Recent (browser storage)…', icon: 'layers', onClick: () => showLocalProjects() },
      { label: 'Save / download project', icon: 'save', shortcut: 'Ctrl+S', onClick: () => saveProject() },
      { label: 'Rename project…', icon: 'pencil', onClick: () => renameProject() },
      { label: 'Version history…', icon: 'history', onClick: () => app.showHistory?.() },
      '-',
      { label: 'Import', icon: 'upload', submenu: [
        { label: 'Audio samples…', icon: 'wave', onClick: () => importSamples() },
        { label: 'MIDI file…', icon: 'music', onClick: () => importMidiFile() },
        { label: 'DAWproject (Bitwig, Studio One, Cubase)…', icon: 'folder', onClick: () => interchange('importDawprojectFile') },
        { label: 'MusicXML melody…', icon: 'music', onClick: () => interchange('importMusicXmlFile') },
        { label: 'Strudel / code file…', icon: 'code', onClick: () => importStrudel() },
        { label: 'Paste Strudel code…', icon: 'code', onClick: async () => { const code = await promptText('Paste Strudel code', '', { multiline: true }); if (code) importStrudel(new File([code], 'pasted.strudel')); } },
      ] },
      { label: 'Export', icon: 'download', submenu: [
        { label: 'Mixdown WAV', icon: 'wave', shortcut: 'Ctrl+E', onClick: () => exportWav() },
        { label: 'Stems (WAV per track)', icon: 'layers', onClick: () => exportWav({ stems: true }) },
        { label: 'MIDI file', icon: 'music', onClick: () => exportMidiFile() },
        { label: 'DAWproject (Bitwig, Studio One, Cubase)…', icon: 'folder', onClick: () => interchange('exportDawprojectDialog') },
        { label: 'For mixing engineer (stems + MIDI ZIP)…', icon: 'layers', onClick: () => interchange('exportMixBundleDialog') },
        { label: 'MusicXML lead sheet…', icon: 'music', onClick: () => interchange('exportMusicXmlDialog') },
        { label: 'Strudel code', icon: 'code', onClick: () => exportCode() },
        { label: 'Project file (.daW3)', icon: 'save', onClick: () => saveProject() },
      ] },
      '-',
      { label: 'Plugins (SoundFonts, Faust, WAM)…', icon: 'plug', onClick: () => import('./plugins-dialog.js').then((m) => m.openPluginsDialog(app)) },
      '-',
      { label: 'MIDI devices, controllers & sync…', icon: 'piano', onClick: () => (app.control ? app.control.openPrefs('midi') : enableMidiInput()) },
      ...(app.control ? [
        { label: 'Preferences (shortcuts, MIDI, sync)…', icon: 'sliders', onClick: () => app.control.openPrefs() },
        { label: 'Command palette', icon: 'search', shortcut: app.control.shortcutLabel('palette.open'), onClick: () => app.control.openPalette() },
      ] : []),
      { label: `Computer keyboard piano (\`)`, icon: 'keyboard', onClick: () => { app.keyboardPiano.enabled = !app.keyboardPiano.enabled; toast(`Keyboard piano ${app.keyboardPiano.enabled ? 'ON' : 'OFF'}`); } },
      { label: `Theme: ${ui.get('theme') === 'dark' ? 'switch to light' : 'switch to dark'}`, icon: 'sun', onClick: () => ui.set({ theme: ui.get('theme') === 'dark' ? 'light' : 'dark' }) },
      { label: 'Help & shortcuts', icon: 'help', shortcut: '?', onClick: () => showHelp() },
      { label: 'About / credits & source code', icon: 'code', onClick: () => showAbout() },
    ];
  }

  function addTrackMenuItems(extra = {}) {
    const cat = (c) => Object.entries(PRESETS).filter(([, pr]) => pr.category === c).map(([id, pr]) => ({ label: pr.name, onClick: () => addTrack(id, extra) }));
    const cats = [...new Set(Object.values(PRESETS).map((pr) => pr.category))];
    return [
      { header: 'Add track' },
      { label: 'Drum machine', icon: 'drum', submenu: Object.entries(DRUM_KITS).map(([id, k]) => ({ label: k.name, onClick: () => addTrack(id, extra) })) },
      { label: 'Instrument preset', icon: 'music', submenu: cats.map((c) => ({ label: c, submenu: cat(c) })) },
      { label: 'Init: Analog synth', icon: 'wave', onClick: () => addTrack('synth', extra) },
      { label: 'Init: FM synth', icon: 'wave', onClick: () => addTrack('fm', extra) },
      { label: 'Init: Organ', icon: 'wave', onClick: () => addTrack('organ', extra) },
      { label: 'Sampler', icon: 'wave', onClick: () => addTrack('sampler', extra) },
      { label: 'Plugin instrument (SoundFont / Faust / WAM)…', icon: 'plug', onClick: () => import('./plugins-dialog.js').then((m) => m.openPluginsDialog(app, { type: 'instrument' })) },
      { label: 'Audio track', icon: 'wave', onClick: () => addTrack('audio', extra) },
      { label: 'Code track (Strudel)', icon: 'code', onClick: () => { addTrack('code', extra); ui.set({ view: 'code' }); } },
    ];
  }

  function generateMenuItems() {
    const p = get();
    const t = selectedTrack();
    return [
      { header: 'Create' },
      { label: 'Full song from genre…', icon: 'wand', onClick: () => showSongWizard() },
      { label: `Regenerate song (${GENRES[p.genre]?.name || 'current genre'})`, icon: 'dice', submenu: Object.entries(gen.LENGTH_PRESETS).map(([id, lp]) => {
        const g = GENRES[p.genre || 'house'] || GENRES.house;
        const est = gen.planSongLength(g, { length: id, bpm: p.bpm });
        return { label: `${lp.label} · ${gen.formatMinutes(est.minutes)} (${est.bars} bars)`, onClick: () => generateSong({ genre: p.genre || 'house', key: p.key.root, scale: p.key.scale, bpm: p.bpm, length: id }) };
      }) },
      { label: 'Extend song…', icon: 'plus', disabled: !p.clips.length, onClick: () => showExtendDialog() },
      '-',
      { header: 'Add a generated part' },
      { label: 'Drums', icon: 'drum', onClick: () => generatePart('drums') },
      { label: 'Bassline', icon: 'music', onClick: () => generatePart('bass') },
      { label: 'Chords', icon: 'piano', onClick: () => generatePart('chords') },
      { label: 'Pad', icon: 'layers', onClick: () => generatePart('pad') },
      { label: 'Lead melody', icon: 'sparkles', onClick: () => generatePart('lead') },
      { label: 'Arpeggio', icon: 'wave', onClick: () => generatePart('arp') },
      { label: 'New chord progression (for next parts)', icon: 'dice', onClick: () => { newProgression(); toast('Next generated parts will use a fresh progression'); } },
      '-',
      t && t.type === 'instrument' ? { label: `Regenerate "${t.name}"`, icon: 'dice', onClick: () => generatePart(t.role || (t.instrument?.type === 'drums' ? 'drums' : 'lead'), { trackId: t.id }) } : { label: 'Select a track to regenerate it', disabled: true },
    ];
  }

  function showSongWizard() {
    let genre = get().genre || 'house';
    let root = get().key.root;
    let scale = null;
    let bpm = null;
    let filter = '';
    const grid = h('div.welcome-grid');
    const renderGrid = () => {
      grid.replaceChildren(...Object.entries(GENRES)
        .filter(([id, g]) => !filter || (g.name + ' ' + (g.family || '')).toLowerCase().includes(filter))
        .map(([id, g]) => {
          const c = h(`button.genre-card${id === genre ? '.selected' : ''}`, { type: 'button' }, h('b', g.name), h('span', `${g.family || ''} · ${g.defaultBpm || g.bpm?.[0]} BPM`));
          c.addEventListener('click', () => { genre = id; bpm = null; scale = null; renderGrid(); syncFields(); });
          return c;
        }));
    };
    const search = h('input', { type: 'search', placeholder: 'Search genres…', style: { width: '100%' } });
    search.addEventListener('input', () => { filter = search.value.toLowerCase(); renderGrid(); });
    search.addEventListener('keydown', (e) => e.stopPropagation());
    const rootSel = select({ options: Array.from({ length: 12 }, (_, i) => ({ value: i, label: pitchClassName(i) })), value: root, onChange: (v) => { root = Number(v); } });
    const scaleSel = select({ options: [{ value: '', label: 'Genre default' }, ...Object.entries(SCALES).map(([id, s]) => ({ value: id, label: s.name }))], value: '', onChange: (v) => { scale = v || null; } });
    const bpmInput = h('input', { type: 'text', placeholder: 'auto', style: { width: '70px' } });
    bpmInput.addEventListener('keydown', (e) => e.stopPropagation());
    bpmInput.addEventListener('input', () => syncLength());
    // song length: presets with the minutes they give for this genre / tempo (live)
    let length = 'standard';
    const lengthSel = h('select.wizard-length', { title: 'Song length. Standard = the genre\'s usual length; Club = DJ edit with long intro / outro (dance genres)' });
    lengthSel.addEventListener('change', () => { length = lengthSel.value; syncLength(); });
    const lengthInfo = h('span.muted.wizard-length-info');
    const syncLength = () => {
      const g = GENRES[genre];
      if (!g) return;
      const b = parseInt(bpmInput.value) || g.defaultBpm;
      lengthSel.replaceChildren(...Object.entries(gen.LENGTH_PRESETS).map(([id, lp]) => {
        const est = gen.planSongLength(g, { length: id, bpm: b });
        return h('option', { value: id }, `${lp.label} · ${gen.formatMinutes(est.minutes)}`);
      }));
      lengthSel.value = length;
      const est = gen.planSongLength(g, { length, bpm: b });
      lengthInfo.textContent = `≈ ${gen.formatMinutes(est.minutes)} · ${est.bars} bars · ${est.structure.map((x) => x.name).filter((n, i, a) => n !== a[i - 1]).join(' → ')}`;
    };
    const info = h('p.muted');
    const syncFields = () => {
      const g = GENRES[genre];
      bpmInput.placeholder = String(g?.defaultBpm || 'auto');
      info.textContent = g?.tips?.length ? `Tip: ${g.tips[0]}` : '';
      syncLength();
    };
    renderGrid(); syncFields();
    const body = h('div.wizard-step',
      search, h('div', { style: { maxHeight: '46vh', overflow: 'auto' } }, grid),
      h('div.row.wrap', h('label.field', 'Key', rootSel), h('label.field', 'Scale', scaleSel), h('label.field', 'BPM', bpmInput), h('label.field', 'Length', lengthSel)),
      h('p.wizard-length-line', lengthInfo),
      info);
    modal({
      title: 'Create a song', width: 860, body,
      actions: [
        { label: 'Cancel' },
        { label: 'Just set genre', onClick: () => applyGenreDefaults(genre) },
        { label: 'Generate song', primary: true, onClick: () => { bpm = parseInt(bpmInput.value) || null; generateSong({ genre, key: root, scale: scale || undefined, bpm: bpm || undefined, length }); } },
      ],
    });
    setTimeout(() => search.focus(), 30);
  }

  // ---------------------------------------------------------------- extend / shorten the song
  /** Show [a, b) beats in the arrange view (after the arrangement grew). */
  function revealInArrange(a, b) {
    if (ui.get('view') !== 'arrange') ui.set({ view: 'arrange' });
    setTimeout(() => app.views?.arrange?.revealRange?.(a, b), 60);
  }

  /** Extend the song by an amount (one undo step). opts: see gen.extendSong. -> the extension (or null) */
  function extendSongBy(opts = {}) {
    let res = null;
    try {
      store.transact('Extend song', (p) => {
        res = gen.extendSong(p, opts);
        if (!res.items.length) return;
        gen.applyExtension(p, res);
        if (p.mode !== 'song') p.mode = 'song';
      });
    } catch (e) {
      console.error(e);
      toast('Could not extend the song: ' + e.message, { level: 'error' });
      return null;
    }
    if (!res?.items.length) { toast('Nothing to extend — the arrangement is empty.', { level: 'warn' }); return null; }
    const first = res.items[0];
    revealInArrange(first.start, first.start + res.addBeats);
    const p = get();
    toast(`${res.summary.replace(/^Adds /, 'Added ')} → ${gen.formatMinutes(gen.songEnd(p) / p.bpm)} total`, { level: 'success', timeout: 6000 });
    return res;
  }

  /**
   * "Extend song…" dialog: amount (bars / minutes, quick buttons), mode, live preview. opts preset the dialog:
   * {mode, markerId (insert before), templateMarkerId (extend this section), at}
   */
  function showExtendDialog(preset = {}) {
    const p0 = get();
    if (!p0.clips.length) { toast('Generate or arrange a song first — there is nothing to extend yet.', { level: 'warn' }); return; }
    const seed = rngSeed();
    const bpb = beatsPerBar(p0);
    const st = { mode: preset.mode || 'continue', unit: 'bars', amount: preset.bars ?? 32, kind: preset.kind || '', markerId: preset.markerId || null };
    if (preset.templateMarkerId) {
      const sec = gen.songSections(p0).find((x) => x.markerId === preset.templateMarkerId);
      if (sec && preset.bars == null) st.amount = Math.max(4, Math.round(sec.bars));
    }
    const optsNow = () => {
      const o = { mode: st.mode, seed };
      if (st.unit === 'minutes') o.minutes = Math.max(0.1, Number(st.amount) || 1);
      else if (st.unit === 'to') o.toMinutes = Number(st.amount) || 6;
      else o.bars = Math.max(4, Math.round(Number(st.amount) || 16));
      if (st.mode === 'insert-section') {
        if (preset.templateMarkerId) {
          o.templateMarkerId = preset.templateMarkerId;
          const ms = [...(get().markers || [])].sort((a, b) => a.beat - b.beat);
          const i = ms.findIndex((m) => m.id === preset.templateMarkerId);
          if (ms[i + 1]) o.markerId = ms[i + 1].id; else o.at = gen.songEnd(get());
        } else {
          if (st.markerId) o.markerId = st.markerId; else o.at = preset.at ?? 0;
          if (st.kind) o.kind = st.kind;
        }
      }
      return o;
    };
    const modeSel = select({ options: Object.entries(gen.EXTEND_MODES).map(([id, m]) => ({ value: id, label: m.label })), value: st.mode, onChange: (v) => { st.mode = v; sync(); } });
    const amountIn = h('input.extend-amount', { type: 'number', min: '1', step: '1', value: String(st.amount), style: { width: '76px' } });
    amountIn.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') applyBtn.click(); });
    amountIn.addEventListener('input', () => { st.amount = amountIn.value; sync(); });
    const unitSel = select({ options: [{ value: 'bars', label: 'bars' }, { value: 'minutes', label: 'minutes' }, { value: 'to', label: 'minutes total (extend to)' }], value: st.unit, onChange: (v) => { st.unit = v; sync(); } });
    const quick = (label, unit, amount) => {
      return button(label, () => { st.unit = unit; st.amount = amount; amountIn.value = String(amount); unitSel.setValue(unit); sync(); }, { cls: 'small extend-quick' });
    };
    const markerOpts = () => [...(get().markers || [])].sort((a, b) => a.beat - b.beat).map((m) => ({ value: m.id, label: `before ${m.name} (bar ${Math.floor(m.beat / bpb) + 1})` }));
    const markerSel = select({ options: markerOpts(), value: st.markerId || markerOpts()[0]?.value || '', onChange: (v) => { st.markerId = v; sync(); } });
    if (!st.markerId) st.markerId = markerOpts()[0]?.value || null;
    const kindSel = select({ options: [{ value: '', label: 'Auto (genre)' }, { value: 'break', label: 'Breakdown / bridge' }, { value: 'build', label: 'Build-up' }, { value: 'main', label: 'Drop / chorus' }, { value: 'verse', label: 'Verse / groove' }, { value: 'solo', label: 'Solo' }], value: st.kind, onChange: (v) => { st.kind = v; sync(); } });
    const insertRow = h('div.row.wrap.extend-insert', h('label.field', 'Where', markerSel), h('label.field', 'Section', kindSel));
    const hint = h('p.muted.extend-hint');
    const preview = h('p.extend-preview');
    const sync = () => {
      const p = get();
      insertRow.style.display = st.mode === 'insert-section' && !preset.templateMarkerId ? '' : 'none';
      hint.textContent = preset.templateMarkerId && st.mode === 'insert-section'
        ? `Extends "${(p.markers || []).find((m) => m.id === preset.templateMarkerId)?.name || 'section'}" with a varied repeat; everything after it moves right.`
        : gen.EXTEND_MODES[st.mode]?.hint || '';
      try {
        const plan = gen.planExtension(p, optsNow());
        preview.textContent = plan.items.length ? `${plan.summary} → ${gen.formatMinutes(plan.newEnd / p.bpm)} total` : plan.summary;
        applyBtn.disabled = !plan.items.length;
      } catch (e) {
        preview.textContent = 'Preview failed: ' + e.message;
      }
    };
    const body = h('div.extend-dialog',
      h('div.row.wrap', h('label.field', 'Mode', modeSel), h('label.field', 'Amount', h('span.row', amountIn, unitSel))),
      h('div.row.wrap.extend-quicks', quick('+16 bars', 'bars', 16), quick('+32 bars', 'bars', 32), quick('+1 min', 'minutes', 1), quick('+2 min', 'minutes', 2), quick('to 6 min', 'to', 6)),
      insertRow, hint, preview,
      h('p.muted', `Now ${gen.formatMinutes(gen.songEnd(p0) / p0.bpm)} (${gen.songEnd(p0) / bpb} bars). New sections re-use and vary your patterns, follow the song's chords, continue its automation and keep the same mix. One undo step.`));
    let applyBtn;
    const dlg = modal({
      title: preset.templateMarkerId ? 'Extend this section' : st.mode === 'insert-section' ? 'Insert a section' : 'Extend song', width: 600, body,
      actions: [
        { label: 'Cancel' },
        { label: 'Extend', primary: true, onClick: () => { extendSongBy(optsNow()); } },
      ],
    });
    applyBtn = [...dlg.el.querySelectorAll('.modal-footer button')].pop();
    applyBtn.classList.add('extend-apply');
    sync();
    setTimeout(() => amountIn.focus(), 30);
  }

  /** Remove the section that starts at a marker and close the gap (one undo step). */
  function removeSectionAt(markerId) {
    const m = (get().markers || []).find((x) => x.id === markerId);
    if (!m) return;
    let r = null;
    store.transact('Remove section', (p) => { r = gen.removeSection(p, { markerId }); });
    if (!r) return;
    const p = get();
    toast(`Removed "${m.name}" (${r.beats / beatsPerBar(p)} bars) — now ${gen.formatMinutes(gen.songEnd(p) / p.bpm)}. Ctrl+Z to undo.`, { level: 'success' });
    revealInArrange(Math.max(0, r.start - beatsPerBar(p) * 4), r.start + beatsPerBar(p) * 8);
  }

  async function showLocalProjects() {
    const list = await listLocal().catch(() => []);
    const body = h('div.local-list');
    if (!list.length) body.appendChild(h('p.muted', 'No projects saved in this browser yet. Projects are autosaved as you work.'));
    const m = modal({ title: 'Projects in this browser', body, width: 520, actions: [{ label: 'Close' }] });
    for (const item of list) {
      const row = h('div.local-item', icon('file'), h('div', { style: { flex: 1 } }, h('div', item.name), h('div.muted', { style: { fontSize: '11px' } }, new Date(item.modifiedAt).toLocaleString())));
      const del = h('button.icon-btn', { title: 'Delete' }, icon('trash'));
      del.addEventListener('click', async (e) => { e.stopPropagation(); await deleteLocal(item.id); row.remove(); });
      row.appendChild(del);
      row.addEventListener('click', async () => {
        const proj = await loadLocal(item.id);
        if (proj) { loadProjectObject(proj, 'Restored'); m.close(); }
      });
      body.appendChild(row);
    }
  }

  function showWelcome() {
    const card = (ic, title, text, fn) => {
      const b = h('button.welcome-action', { type: 'button' }, icon(ic, 22), h('b', title), h('span', text));
      b.addEventListener('click', () => { m.close(); fn(); });
      return b;
    };
    const body = h('div',
      h('div.welcome-hero', h('div.logo-mark', { style: { width: '48px', height: '48px', fontSize: '26px', margin: '0 auto', borderRadius: '12px' } }, '⚡'), h('h1', 'daW³'), h('p', 'Sequence, synthesize, sample, generate and live-code — every genre, right in your browser.')),
      h('div.welcome-actions',
        card('wand', 'Generate a song', 'Pick a genre and get a full arrangement to remix', () => showSongWizard()),
        card('drum', 'Start with a beat', 'Drum machine + step sequencer', () => { addTrack('drums'); generatePart('drums', { trackId: get().tracks.at(-1).id }); ui.set({ view: 'rack' }); }),
        card('piano', 'Empty project', 'Blank canvas with a synth track', () => { addTrack('electric-piano'); ui.set({ view: 'piano' }); }),
        card('code', 'Live code', 'Strudel-style patterns, import .strudel files', () => { addTrack('code'); ui.set({ view: 'code' }); }),
        card('folder', 'Open project', 'Continue a saved .daW3 file', () => openProject()),
        card('layers', 'Recent in browser', 'Restore an autosaved session', () => showLocalProjects()),
      ),
      h('p.muted', { style: { textAlign: 'center', fontSize: '12px' } }, 'Tip: press ? any time for shortcuts. Space plays, 1–8 switch views, ` toggles the keyboard piano.'));
    const m = modal({ title: '', body, width: 820, cls: 'welcome' });
  }

  function showHelp() {
    const sc = [
      ['Space', 'Play / pause'], ['Enter', 'Stop (twice: return to start)'], ['1 – 7', 'Arrange, Scenes, Step Rack, Piano Roll, Mixer, Code, Plugboard'],
      ['P', 'Toggle Pattern / Song mode'], ['L', 'Toggle loop'], ['M', 'Metronome'], ['R', 'Record'], ['Shift+A', 'Arm automation recording (move any control while playing)'], ['`', 'Computer keyboard piano'],
      ['Z…M / Q…P', 'Play notes (keyboard piano on)'], ['- / =', 'Octave down / up'], ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
      ['Ctrl/Cmd+K', 'Command palette — search every action'], ['Ctrl+Shift+M', 'MIDI learn mode (map hardware knobs to any control)'],
      ['Ctrl+S / Ctrl+O', 'Save / open project'], ['Ctrl+E', 'Export WAV'], ['B / D / A', 'Toggle browser / device / assistant panels'],
      ['Piano roll', 'Click empty = add note, drag = move, edge = resize, right-click/Alt = delete, Shift-drag = select, Ctrl+A/C/V/D'],
      ['Arrange', 'Double-click lane = new clip, drag clips, edge resize, Alt-drag = copy, Delete removes'],
    ];
    const body = h('div',
      h('div.help-grid',
        h('div', h('h4', 'Workflow'), h('ul',
          h('li', 'Create → generate a full song for any genre, or single parts (drums, bass, chords, leads, arps).'),
          h('li', 'Pattern mode loops each track\'s active pattern — great for sketching. Song mode plays the arrangement.'),
          h('li', 'Select a track → edit it in the Device panel (bottom). Click section headers to fold; "Advanced" reveals deep controls.'),
          h('li', 'The Assistant (right) watches your project and suggests chords, fixes and ideas you can apply with one click.'))),
        h('div', h('h4', 'Sound'), h('ul',
          h('li', 'Analog, FM and Organ synth engines with presets for every role.'),
          h('li', '20 synthesized drum kits; drop samples on pads to replace sounds.'),
          h('li', 'Sampler with slicing; audio tracks for loops and vocals.'),
          h('li', 'Insert effects per track, Reverb & Delay buses, master limiter.'),
          h('li', 'Plugboard (7): patch effects with cables — parallel chains, splits, sidechain ducking.'))),
        h('div', h('h4', 'Code'), h('ul',
          h('li', 'Code tracks run Strudel-compatible mini-notation: s("bd*4, ~ cp"), note("c3 e3 g3").s("sawtooth").'),
          h('li', 'Import .strudel files, play them alongside the rest of the song, then "Render to tracks" to edit them as patterns.'),
          h('li', 'Export any project as Strudel code.'),
          h('li', 'Code runs on the real Strudel engine (strudel.cc, AGPL-3.0) — see About / credits.'))),
        h('div', h('h4', 'Save & share'), h('ul',
          h('li', 'Projects autosave in your browser. Download a .daW3 file (Ctrl+S) to keep or share — samples included.'),
          h('li', 'Export WAV mixdowns, stems, MIDI or Strudel code.')))),
      h('div.section-title', 'Shortcuts'),
      h('table.shortcut-table', sc.map(([k, v]) => h('tr', h('td', h('kbd', k)), h('td', v)))),
      h('p.muted', 'daW³ is free software (AGPL-3.0-or-later) built on Strudel. ',
        h('a', { href: SOURCE_URL, target: '_blank', rel: 'noopener' }, 'Source code'), ' · ',
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); showAbout(); } }, 'About / credits')));
    modal({ title: 'daW³ — Help', body, width: 860, actions: [{ label: 'Close', primary: true }] });
  }

  // AGPL §13: everyone using daW³ over the network is offered its complete source code
  function showAbout() {
    const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text || href);
    const body = h('div.about',
      h('p', h('b', 'daW³'), ' — a browser DAW. Free software under the ',
        link('https://www.gnu.org/licenses/agpl-3.0.html', 'GNU Affero General Public License v3.0 or later'), '.'),
      h('p', h('b', 'Source code: '), link(SOURCE_URL), ' — you may use, study, change and share it under the same license.'),
      h('h4', 'Built on Strudel'),
      h('p', 'Code tracks run ', link('https://strudel.cc', 'Strudel'), ' — the JavaScript port of TidalCycles by Felix Roos, Alex McLean and the Strudel contributors (',
        link('https://codeberg.org/uzu/strudel', 'codeberg.org/uzu/strudel'), ', AGPL-3.0-or-later). daW³ ships Strudel’s pattern engine, mini-notation, tonal functions, transpiler and its sound engine superdough unmodified (one documented node-pool patch), see ',
        h('code', 'vendor/strudel/VERSION'), ' for the exact versions and licenses.'),
      h('h4', 'Sounds'),
      h('p', 'Samples are loaded at runtime from their public homes: Dirt-Samples (TidalCycles), tidal-drum-machines, VCSL (CC0), Salamander Grand Piano by Alexander Holm (CC-BY 3.0), dough-samples, the webaudiofont General MIDI soundfonts. See docs/SAMPLES.md.'));
    modal({ title: 'About daW³', body, width: 640, actions: [{ label: 'Close', primary: true }] });
  }

  // ---------------------------------------------------------------- boot / autosave
  async function boot() {
    let restored = false;
    try {
      const list = await listLocal();
      if (list?.length) {
        const latest = list.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)))[0];
        const proj = await loadLocal(latest.id);
        if (proj && proj.tracks?.length) {
          store.load(proj);
          const first = get().tracks[0];
          ui.set({ selectedTrackId: first?.id || null, selectedPatternId: first?.activePatternId || null });
          restored = true;
          toast(`Restored "${get().name}" from your last session`, { level: 'success' });
        }
      }
    } catch (e) { console.warn('autosave restore failed', e); }
    try { createAutosaver(store, { intervalMs: 4000 }); } catch (e) { console.warn('autosave unavailable', e); }
    if (!restored && !new URLSearchParams(location.search).has('nowelcome')) showWelcome();
    ui.set({ booted: true }); // panels that remember per-project state (the guide) can now check which project is open
  }

  return {
    boot, selectTrack, selectedTrack, selectPattern, addTrack, deleteTrack, duplicateTrack, updateTrack, moveTrack, renameTrack, trackMenuItems, addTrackMenuItems,
    newPattern, duplicatePattern, deletePattern, ensurePattern, setPatternNotes,
    togglePlay, play, stop, setPosition, setMode, toggleRecord, liveNoteOn,
    recorder, startAudioRecording, finishAudioRecording, getCountIn, setCountIn,
    showRecordSettings: () => import('./record-panel.js').then((m) => m.showRecordSettings(app)).catch((e) => toast('Recording settings: ' + e.message, { level: 'error' })),
    captureMidi: (trackId) => recorder.captureMidi(trackId), liveNoteOff, enableMidiInput, ensureAudio,
    setGenre, applyGenreDefaults, newProject, openProject, saveProject, renameProject, loadProjectObject,
    exportWav, exportMidiFile, exportCode, importMidiFile, interchange, importStrudel, renderCodeToTracks, importSamples, placeSample, sampleToSampler,
    generatePart, generateSong, newProgression, currentProgression, applyAssistantAction, showExtendDialog, extendSongBy, removeSectionAt,
    mainMenuItems, generateMenuItems, showSongWizard, showHelp, showAbout, showWelcome, showLocalProjects,
    undo: () => { const l = store.undo(); if (l) app.setStatus?.(`Undo: ${l}`); },
    redo: () => { const l = store.redo(); if (l) app.setStatus?.(`Redo: ${l}`); },
  };
}
