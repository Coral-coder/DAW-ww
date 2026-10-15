// Chord pads: a floating panel with the chords of the project key (triads, sevenths, colour chords, borrowed
// chords), inversion / voicing / octave / voice-leading controls. Click a pad to hear it (Shift-click also adds it to
// the progression strip); drag a pad or the whole progression onto the Arrange chord lane, a MIDI clip, an empty
// spot of a synth track or the piano roll.
import { h, icon, startDrag } from './dom.js';
import { button, iconButton, select, toggle, toast } from './components.js';
import { padChords, padVoicing, chordLabel, sequenceChords, chordDragPayload, CHORD_VOICINGS, DT_CHORDS, placeChords } from '../core/chord-track.js';
import { keyName, chordToRoman } from '../theory/index.js';
import { beatsPerBar } from '../core/model.js';
import { auditionNotes, dropChordsAsNotes } from './chord-actions.js';

const PREF = 'daw3-chord-pads';
let panel = null;

export function toggleChordPads(app, force) {
  if (panel && force !== true) { panel.close(); return null; }
  if (panel) return panel;
  panel = openChordPads(app);
  return panel;
}

function openChordPads(app) {
  const { store } = app;
  const get = () => store.get();
  const S = (() => { try { return { inversion: 0, voicing: 'close', octave: 4, voiceLeading: true, length: 'bar', x: null, y: null, ...JSON.parse(localStorage.getItem(PREF) || '{}') }; } catch { return { inversion: 0, voicing: 'close', octave: 4, voiceLeading: true, length: 'bar' }; } })();
  const save = () => { try { localStorage.setItem(PREF, JSON.stringify(S)); } catch { /* */ } };
  let prog = []; // progression strip [{root, type, bass?}]
  let prev = null; // last voicing (voice leading)
  let keySig = '';

  const lenBeats = () => { const bpb = beatsPerBar(get()); return S.length === 'half' ? bpb / 2 : S.length === '2bars' ? bpb * 2 : bpb; };
  const vopts = () => ({ inversion: S.inversion, voicing: S.voicing, octave: S.octave, voiceLeading: S.voiceLeading });

  const title = h('span.chord-pads-title', 'Chord pads');
  const head = h('div.chord-pads-head', icon('grid', 14), title, h('span.spacer'), iconButton('x', () => close(), 'Close'));
  const controls = h('div.chord-pads-controls',
    select({ options: [{ value: 0, label: 'Root position' }, { value: 1, label: '1st inversion' }, { value: 2, label: '2nd inversion' }, { value: 3, label: '3rd inversion' }], value: S.inversion, title: 'Inversion (ignored while voice leading picks the closest voicing)', onChange: (v) => { S.inversion = Number(v); prev = null; save(); } }),
    select({ options: CHORD_VOICINGS, value: S.voicing, title: 'Voicing', onChange: (v) => { S.voicing = v; prev = null; save(); } }),
    select({ options: [3, 4, 5].map((o) => ({ value: o, label: `Octave ${o}` })), value: S.octave, title: 'Register', onChange: (v) => { S.octave = Number(v); prev = null; save(); } }),
    toggle({ label: 'Voice leading', value: S.voiceLeading, title: 'Each chord is voiced closest to the previous one (smooth motion, common tones held)', onChange: (v) => { S.voiceLeading = v; prev = null; save(); } }),
    select({ options: [{ value: 'half', label: '½ bar each' }, { value: 'bar', label: '1 bar each' }, { value: '2bars', label: '2 bars each' }], value: S.length, title: 'Length of each chord when dragged / placed', onChange: (v) => { S.length = v; save(); } }));
  const grid = h('div.chord-pads-grid');
  const strip = h('div.chord-pads-strip');
  const progHandle = h('div.chord-pads-prog-handle', { draggable: true, title: 'Drag the whole progression onto the chord lane, a MIDI clip or the piano roll' }, icon('layers', 14), h('span', 'Progression'));
  const progBar = h('div.chord-pads-prog', progHandle, strip,
    button('Play', () => playProgression(), { cls: 'small', icon: 'play', title: 'Hear the progression' }),
    button('To chord track', () => toChordTrack(), { cls: 'small', title: 'Place the progression on the chord track at the playhead bar' }),
    button('To track', () => toTrack(), { cls: 'small', title: 'Write the progression as notes on the selected synth track at the playhead (into the clip there, or a new clip)' }),
    button('Clear', () => { prog = []; renderStrip(); }, { cls: 'small' }));
  const hint = h('div.chord-pads-hint', 'Click: play · Shift-click: add to progression · drag a pad or the progression onto the chord lane, a clip or the piano roll');
  const el = h('div.chord-pads', { role: 'dialog', 'aria-label': 'Chord pads' }, head, controls, grid, progBar, hint);

  function render() {
    const key = get().key || { root: 0, scale: 'major' };
    keySig = `${key.root}|${key.scale}`;
    title.textContent = `Chord pads · ${keyName(key.root, key.scale)}`;
    const rows = padChords(key);
    grid.replaceChildren(...rows.map((row) => h('div.chord-pads-row',
      h('span.chord-pads-rowlbl', row.label),
      ...row.chords.map((c) => pad(c, key)))));
  }
  function pad(c, key) {
    const b = h('button.chord-pad', { type: 'button', draggable: true, title: `${c.label} (${chordToRoman(c, key.root)}) — click to play, Shift-click to add to the progression, drag to place` },
      h('span.chord-pad-name', c.label), h('span.chord-pad-roman', chordToRoman(c, key.root)));
    b.addEventListener('click', (e) => {
      play(c);
      if (e.shiftKey) { prog.push({ root: c.root, type: c.type }); renderStrip(); }
    });
    b.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(DT_CHORDS, chordDragPayload(sequenceChords([c], lenBeats()), vopts()));
      e.dataTransfer.setData('text/plain', c.label);
      e.dataTransfer.effectAllowed = 'copy';
    });
    return b;
  }
  function play(c) {
    const v = padVoicing(c, { ...vopts(), prev: S.voiceLeading ? prev : null });
    prev = v;
    auditionNotes(app, v, 700);
  }
  function renderStrip() {
    const key = get().key;
    strip.replaceChildren(...(prog.length ? prog.map((c, i) => {
      const chip = h('button.chord-chip', { type: 'button', title: 'Click to remove' }, chordLabel(c, key));
      chip.addEventListener('click', () => { prog.splice(i, 1); renderStrip(); });
      return chip;
    }) : [h('span.chord-pads-empty', 'Shift-click pads to build a progression')]));
    progHandle.classList.toggle('disabled', !prog.length);
  }
  progHandle.addEventListener('dragstart', (e) => {
    if (!prog.length) { e.preventDefault(); return; }
    e.dataTransfer.setData(DT_CHORDS, chordDragPayload(sequenceChords(prog, lenBeats()), vopts()));
    e.dataTransfer.setData('text/plain', prog.map((c) => chordLabel(c, get().key)).join(' '));
    e.dataTransfer.effectAllowed = 'copy';
  });
  let playTimer = 0;
  function playProgression() {
    clearTimeout(playTimer);
    if (!prog.length) { toast('Shift-click pads to build a progression first'); return; }
    prev = null;
    const spb = 60 / (get().bpm || 120);
    const ms = Math.max(250, Math.min(2000, lenBeats() * spb * 1000));
    let i = 0;
    const next = () => { if (i >= prog.length || !el.isConnected) return; play(prog[i++]); playTimer = setTimeout(next, ms); };
    next();
  }
  const playheadBar = () => { const p = get(); const bpb = beatsPerBar(p); return Math.floor(Math.max(0, app.engine.getPosition?.() || 0) / bpb) * bpb; };
  function toChordTrack() {
    if (!prog.length) { toast('Shift-click pads to build a progression first'); return; }
    const at = playheadBar();
    store.transact('Place chords', (p) => { placeChords(p, at, sequenceChords(prog, lenBeats())); });
    app.chordLane?.toggle(true);
    toast(`Progression placed on the chord track at bar ${at / beatsPerBar(get()) + 1}`, { level: 'success' });
  }
  function toTrack() {
    if (!prog.length) { toast('Shift-click pads to build a progression first'); return; }
    const p = get();
    const at = playheadBar();
    const track = p.tracks.find((t) => t.id === app.ui.get('selectedTrackId'));
    const clip = track && p.clips.find((c) => c.trackId === track.id && c.type !== 'audio' && at >= c.start - 1e-6 && at < c.start + c.length - 1e-6);
    const payload = { chords: sequenceChords(prog, lenBeats()), ...vopts() };
    if (dropChordsAsNotes(app, payload, { track, clip, beat: at })) toast('Progression written as notes', { level: 'success' });
  }

  // drag the panel by its header
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = el.getBoundingClientRect();
    startDrag(e, (dx, dy) => {
      S.x = Math.max(0, Math.min(window.innerWidth - 120, r.left + dx));
      S.y = Math.max(0, Math.min(window.innerHeight - 60, r.top + dy));
      place();
    }, () => save());
  });
  function place() {
    if (S.x == null) return;
    Object.assign(el.style, { left: S.x + 'px', top: S.y + 'px', right: 'auto', bottom: 'auto' });
  }

  const unsub = app.subscribe?.((r) => {
    if (!r.project) return;
    const k = get().key || {};
    if (`${k.root}|${k.scale}` !== keySig) { prev = null; render(); renderStrip(); }
  });
  function close() {
    clearTimeout(playTimer);
    unsub?.();
    el.remove();
    panel = null;
  }
  render();
  renderStrip();
  document.body.appendChild(el);
  place();
  return { el, close };
}
