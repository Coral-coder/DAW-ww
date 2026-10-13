// Global shortcuts + computer-keyboard piano (two rows, like most DAWs).
import { VIEWS } from './app.js';

// Lower row: Z S X D C V G B H N J M  , → C..C ; upper row: Q 2 W 3 E R 5 T 6 Y 7 U I → C+1oct..
const PIANO_KEYS = {
  z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11, ',': 12, l: 13, '.': 14,
  q: 12, 2: 13, w: 14, 3: 15, e: 16, r: 17, 5: 18, t: 19, 6: 20, y: 21, 7: 22, u: 23, i: 24, 9: 25, o: 26, 0: 27, p: 28,
};

export function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || t.closest?.('.code-editor'));
}

export function installKeyboard(app) {
  const { ui, actions } = app;
  const held = new Map();

  // Piano mode: keys play notes when the keyboard piano is enabled (toggle with ` backtick) or in piano/rack views with Caps-free letters.
  app.keyboardPiano = { enabled: false };

  window.addEventListener('keydown', (e) => {
    if (isTyping(e)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();

    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) actions.redo(); else actions.undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); actions.redo(); return; }
    if (mod && k === 's') { e.preventDefault(); actions.saveProject(); return; }
    if (mod && k === 'o') { e.preventDefault(); actions.openProject(); return; }
    if (mod && k === 'e') { e.preventDefault(); actions.exportWav(); return; }
    if (mod) return; // leave other ctrl combos (copy/paste handled by views)

    if (e.code === 'Space') { e.preventDefault(); actions.togglePlay(); return; }
    if (e.key === 'Enter' && !e.repeat) { actions.stop(); return; }
    if (e.key === '`') { app.keyboardPiano.enabled = !app.keyboardPiano.enabled; app.toast(`Computer keyboard piano ${app.keyboardPiano.enabled ? 'ON — play with Z…M / Q…P, octave with - and =' : 'OFF'}`); return; }

    if (app.keyboardPiano.enabled) {
      if (k === '-') { ui.set({ keyboardOctave: Math.max(0, ui.get('keyboardOctave') - 1) }); app.toast(`Octave ${ui.get('keyboardOctave')}`, { timeout: 900 }); return; }
      if (k === '=') { ui.set({ keyboardOctave: Math.min(8, ui.get('keyboardOctave') + 1) }); app.toast(`Octave ${ui.get('keyboardOctave')}`, { timeout: 900 }); return; }
      if (k in PIANO_KEYS) {
        e.preventDefault();
        if (e.repeat || held.has(k)) return;
        const pitch = (ui.get('keyboardOctave') + 1) * 12 + PIANO_KEYS[k];
        held.set(k, pitch);
        actions.liveNoteOn(pitch, 0.85);
        return;
      }
    }

    const view = VIEWS.find((v) => v.key === e.key);
    if (view) { ui.set({ view: view.id }); return; }
    if (k === 'b') ui.set({ browserOpen: !ui.get('browserOpen') });
    else if (k === 'a' && e.shiftKey) ui.set({ autoArm: !ui.get('autoArm') }); // automation recording arm
    else if (k === 'a') ui.set({ assistantOpen: !ui.get('assistantOpen') });
    else if (k === 'd') ui.set({ deviceOpen: !ui.get('deviceOpen') });
    else if (k === 'l') app.store.transact('Toggle loop', (p) => { p.loop.enabled = !p.loop.enabled; });
    else if (k === 'm') app.store.transact('Toggle metronome', (p) => { p.metronome = !p.metronome; }, { undo: false });
    else if (k === 'r') actions.toggleRecord();
    else if (k === 'p') actions.setMode(app.store.get().mode === 'song' ? 'pattern' : 'song');
    else if (e.key === '?') actions.showHelp();
    else if (e.key === 'Home') actions.setPosition(0);
  });

  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (held.has(k)) {
      actions.liveNoteOff(held.get(k));
      held.delete(k);
    }
  });
  window.addEventListener('blur', () => {
    for (const p of held.values()) actions.liveNoteOff(p);
    held.clear();
  });
}
