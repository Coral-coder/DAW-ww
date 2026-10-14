// Customizable keyboard shortcuts (Node-safe): command registry, key-chord normalization, user overrides,
// conflict detection, import / export. The browser side (src/control/commands.js) registers daW³'s actions
// and dispatches keydown events through ShortcutMap.match().
//
// Chord strings are canonical lower-case, modifiers in fixed order: 'mod+shift+k', 'shift+a', 'space', '1'.
// 'mod' is Cmd on macOS and Ctrl elsewhere; 'ctrl' / 'meta' are only used for the *other* key on each platform.
export const SHORTCUTS_FORMAT = 'daw3-shortcuts';
const MOD_ORDER = ['mod', 'ctrl', 'meta', 'alt', 'shift'];
const KEY_ALIASES = { ' ': 'space', spacebar: 'space', esc: 'escape', del: 'delete', return: 'enter', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', plus: '=', cmd: 'mod', command: 'mod', control: 'ctrl', option: 'alt', opt: 'alt' };

/** Normalize a typed chord ('Ctrl+Shift+K', 'shift + A', 'Mod+k') -> 'mod+shift+k' (ctrl -> mod unless isMac). */
export function normalizeChord(chord, { isMac = false } = {}) {
  if (!chord) return '';
  const parts = String(chord).toLowerCase().split('+').map((s) => s.trim());
  // "ctrl++" / trailing plus
  if (parts.length > 1 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') { parts.splice(-2, 2, '='); }
  let key = parts.pop() || '';
  key = KEY_ALIASES[key] || key;
  const mods = new Set();
  for (let p of parts) {
    p = KEY_ALIASES[p] || p;
    if (p === 'ctrl') mods.add(isMac ? 'ctrl' : 'mod');
    else if (p === 'meta' || p === 'win' || p === 'super') mods.add(isMac ? 'mod' : 'meta');
    else if (MOD_ORDER.includes(p)) mods.add(p);
  }
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
}

/** Key name of a KeyboardEvent-like object (layout-independent for letters / digits via e.code). */
export function eventKey(e) {
  const code = e.code || '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return 'num' + code.slice(6);
  const byCode = { Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Space: 'space' };
  if (byCode[code]) return byCode[code];
  const k = String(e.key || '').toLowerCase();
  return KEY_ALIASES[k] || k;
}

/** KeyboardEvent -> canonical chord (null for bare modifier presses). */
export function eventToChord(e, { isMac = false } = {}) {
  const key = eventKey(e);
  if (!key || ['shift', 'control', 'ctrl', 'alt', 'meta', 'os', 'dead', 'unidentified'].includes(key)) return null;
  const mods = [];
  if (isMac ? e.metaKey : e.ctrlKey) mods.push('mod');
  if (isMac && e.ctrlKey) mods.push('ctrl');
  if (!isMac && e.metaKey) mods.push('meta');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  return [...mods, key].join('+');
}

/** Human label: 'mod+shift+k' -> 'Ctrl+Shift+K' / '⌘⇧K'. */
export function formatChord(chord, { isMac = false } = {}) {
  if (!chord) return '';
  const names = isMac ? { mod: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' } : { mod: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' };
  const keyNames = { space: 'Space', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', escape: 'Esc', enter: 'Enter', delete: 'Del', backspace: '⌫', home: 'Home', end: 'End', pageup: 'PgUp', pagedown: 'PgDn', tab: 'Tab' };
  const parts = chord.split('+');
  const key = parts.pop();
  const k = keyNames[key] || (key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1));
  const mods = parts.map((m) => names[m] || m);
  return isMac ? mods.join('') + k : [...mods, k].join('+');
}

/**
 * Command: { id, label, category, run(ctx), keys: [default chords], scope: 'global' | view id, palette?: false,
 *            when?(ctx) -> bool (enabled), allowInInputs?: bool }
 */
export class CommandRegistry {
  constructor() { this.commands = new Map(); }
  register(cmd) {
    if (!cmd?.id) throw new Error('command needs an id');
    this.commands.set(cmd.id, { scope: 'global', keys: [], category: 'General', ...cmd });
    return this;
  }
  registerAll(list) { for (const c of list) this.register(c); return this; }
  get(id) { return this.commands.get(id) || null; }
  list() { return [...this.commands.values()]; }
}

export class ShortcutMap {
  /** overrides: { commandId: [chords] } (replaces the defaults of that command; [] = unbound). */
  constructor(registry, overrides = {}, { isMac = false } = {}) {
    this.registry = registry;
    this.isMac = isMac;
    this.overrides = {};
    for (const [id, keys] of Object.entries(overrides || {})) if (Array.isArray(keys)) this.overrides[id] = keys.map((k) => normalizeChord(k, { isMac: this.isMac })).filter(Boolean);
  }
  defaults(id) { return (this.registry.get(id)?.keys || []).map((k) => normalizeChord(k, { isMac: this.isMac })); }
  keysFor(id) { return this.overrides[id] ?? this.defaults(id); }
  isCustom(id) { return id in this.overrides; }
  set(id, chords) {
    const keys = chords.map((k) => normalizeChord(k, { isMac: this.isMac })).filter(Boolean);
    const def = this.defaults(id);
    if (keys.length === def.length && keys.every((k, i) => k === def[i])) delete this.overrides[id];
    else this.overrides[id] = keys;
  }
  /** Add a chord to a command; with steal, remove it from commands that clash in the same scope. */
  bind(id, chord, { steal = false, replace = false } = {}) {
    const c = normalizeChord(chord, { isMac: this.isMac });
    if (steal) for (const other of this.commandsFor(c, this.registry.get(id)?.scope)) if (other.id !== id) this.set(other.id, this.keysFor(other.id).filter((k) => k !== c));
    this.set(id, replace ? [c] : [...new Set([...this.keysFor(id), c])]);
  }
  unbind(id, chord) { this.set(id, this.keysFor(id).filter((k) => k !== chord)); }
  reset(id) { if (id) delete this.overrides[id]; else this.overrides = {}; }

  /** Commands bound to a chord whose scopes overlap `scope` (global overlaps everything). */
  commandsFor(chord, scope = null) {
    return this.registry.list().filter((c) => this.keysFor(c.id).includes(chord) && (scope == null || c.scope === 'global' || scope === 'global' || c.scope === scope));
  }
  /** [{ chord, ids:[...] }] — chords bound to more than one command in overlapping scopes. */
  conflicts() {
    const byChord = new Map();
    for (const c of this.registry.list()) for (const k of this.keysFor(c.id)) {
      if (!byChord.has(k)) byChord.set(k, []);
      byChord.get(k).push(c);
    }
    const out = [];
    for (const [chord, cmds] of byChord) {
      if (cmds.length < 2) continue;
      const clash = new Set();
      for (let i = 0; i < cmds.length; i++) for (let j = i + 1; j < cmds.length; j++) {
        const a = cmds[i], b = cmds[j];
        if (a.scope === 'global' || b.scope === 'global' || a.scope === b.scope) { clash.add(a.id); clash.add(b.id); }
      }
      if (clash.size) out.push({ chord, ids: [...clash] });
    }
    return out;
  }
  /** Command for a keydown in a context ({ view }) — view-scoped bindings win over global ones. */
  match(e, ctx = {}) {
    const chord = typeof e === 'string' ? e : eventToChord(e, { isMac: this.isMac });
    if (!chord) return null;
    const cands = this.registry.list().filter((c) => this.keysFor(c.id).includes(chord) && (c.scope === 'global' || c.scope === ctx.view));
    if (!cands.length) return null;
    const scoped = cands.find((c) => c.scope !== 'global' && (!c.when || c.when(ctx)));
    return scoped || cands.find((c) => !c.when || c.when(ctx)) || null;
  }
  label(id) { return this.keysFor(id).map((k) => formatChord(k, { isMac: this.isMac })).join(' / '); }
  export() { return JSON.stringify({ format: SHORTCUTS_FORMAT, version: 1, overrides: this.overrides }, null, 2); }
  import(text) {
    const j = typeof text === 'string' ? JSON.parse(text) : text;
    if (!j || (j.format && j.format !== SHORTCUTS_FORMAT) || typeof j.overrides !== 'object') throw new Error('Not a daW³ shortcuts file');
    this.overrides = {};
    for (const [id, keys] of Object.entries(j.overrides)) if (this.registry.get(id) && Array.isArray(keys)) this.overrides[id] = keys.map((k) => normalizeChord(k, { isMac: this.isMac })).filter(Boolean);
  }
}

/** Fuzzy score of `query` against `text` (0 = no match). Word starts and contiguous runs score higher. */
export function fuzzyScore(query, text) {
  query = query.toLowerCase().trim(); text = text.toLowerCase();
  if (!query) return 1;
  if (text.includes(query)) return 100 - text.indexOf(query) + (text.startsWith(query) ? 50 : 0);
  let ti = 0, score = 0, run = 0;
  for (const ch of query) {
    if (ch === ' ') continue;
    const found = text.indexOf(ch, ti);
    if (found < 0) return 0;
    run = found === ti ? run + 1 : 0;
    score += 1 + run * 2 + (found === 0 || /[\s›/:-]/.test(text[found - 1]) ? 3 : 0);
    ti = found + 1;
  }
  return score;
}
