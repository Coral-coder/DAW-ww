// Global shortcuts + computer-keyboard piano (two rows, like most DAWs).
import { buildCommands, createShortcutMap } from '../control/commands.js';

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

  // Global shortcuts are commands (src/control/commands.js): rebindable in Preferences → Shortcuts and listed
  // in the command palette (Ctrl/Cmd+K). The keyboard piano keeps priority while it is on.
  const registry = buildCommands(app);
  const shortcuts = createShortcutMap(registry);
  app.commands = registry;
  app.shortcuts = shortcuts;

  window.addEventListener('keydown', (e) => {
    if (isTyping(e)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();

    if (app.keyboardPiano.enabled && !mod && !e.altKey) {
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

    const cmd = shortcuts.match(e, { view: ui.get('view') });
    if (!cmd) return;
    e.preventDefault();
    if (e.repeat && !cmd.repeat) return;
    try { cmd.run(); } catch (err) { console.error(`[command:${cmd.id}]`, err); }
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
