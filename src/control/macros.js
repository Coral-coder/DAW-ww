// Action macros (custom actions): a named sequence of existing commands / palette actions run as one command, with
// its own rebindable shortcut. Node-safe core: model, validation, JSON import / export, recorder and runner.
// The browser side (src/ui/macros-ui.js) stores them in user settings (localStorage), registers each as a command
// `macro.<id>` (so it shows in the command palette and binds keys through the ShortcutMap) and records from the
// command registry / palette.
//
// Macro = { id, name, steps: [{ cmd, label, wait? (ms before the step, 0..10000) }], keys: [chord] }
//   cmd: a command id ('transport.play', 'view.mixer', 'macro.<other id>') or a palette menu entry
//        ('menu:Menu › Export › Stems' — resolved again when the macro runs).
export const MACROS_FORMAT = 'daw3-macros';
export const MACROS_VERSION = 1;
export const MAX_STEPS = 200;
export const MAX_DEPTH = 4; // nested macros
const MAX_WAIT = 10000;

let seq = 0;
const newId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const cleanId = (id) => (typeof id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(id) ? id : null);

export const macroCommandId = (m) => `macro.${m.id || m}`;
/** Commands a recording never captures (they would recurse or are about the recorder / palette itself). */
export const UNRECORDABLE = new Set(['palette.open', 'macro.record', 'macro.manager', 'macro.stop']);

/** Normalised step (or null when invalid). */
export function normalizeStep(s) {
  if (!s || typeof s !== 'object') return null;
  const cmd = typeof s.cmd === 'string' ? s.cmd.trim() : '';
  if (!cmd || cmd.length > 300) return null;
  const out = { cmd, label: String(s.label || cmd).slice(0, 200) };
  const wait = Math.round(Number(s.wait) || 0);
  if (wait > 0) out.wait = Math.min(MAX_WAIT, wait);
  return out;
}

/** Normalised macro (or null): name trimmed, invalid steps dropped, keys deduplicated strings. */
export function normalizeMacro(m) {
  if (!m || typeof m !== 'object') return null;
  const name = String(m.name || '').trim().slice(0, 80);
  if (!name) return null;
  const steps = (Array.isArray(m.steps) ? m.steps : []).map(normalizeStep).filter(Boolean).slice(0, MAX_STEPS);
  const keys = [...new Set((Array.isArray(m.keys) ? m.keys : []).filter((k) => typeof k === 'string' && k && k.length < 40))];
  return { id: cleanId(m.id) || newId(), name, steps, keys };
}

export function createMacro(name, steps = [], keys = []) { return normalizeMacro({ name, steps, keys }); }

/** Macro list -> JSON text (the export / settings format). */
export function serializeMacros(list) {
  return JSON.stringify({ format: MACROS_FORMAT, version: MACROS_VERSION, macros: (list || []).map(normalizeMacro).filter(Boolean) }, null, 2);
}

/**
 * JSON text (or object) -> macro list. Accepts the export format, a bare array or a single macro.
 * Duplicate ids get new ones. Throws on anything that is not a macros file.
 */
export function parseMacros(text) {
  const j = typeof text === 'string' ? JSON.parse(text) : text;
  let list;
  if (Array.isArray(j)) list = j;
  else if (j && j.format === MACROS_FORMAT && Array.isArray(j.macros)) list = j.macros;
  else if (j && Array.isArray(j.steps) && j.name) list = [j];
  else throw new Error('Not a daW³ macros file');
  const seen = new Set();
  const out = [];
  for (const m of list) {
    const n = normalizeMacro(m);
    if (!n) continue;
    if (seen.has(n.id)) n.id = newId();
    seen.add(n.id);
    out.push(n);
  }
  return out;
}

/**
 * Merge imported macros into a list: same id -> replaced (opts.replace) or imported as a copy; same name -> the
 * import gets " (2)". -> new list.
 */
export function mergeMacros(existing, incoming, { replace = false } = {}) {
  const out = existing.map((m) => ({ ...m }));
  for (const m of incoming) {
    const i = out.findIndex((x) => x.id === m.id);
    if (i >= 0 && replace) { out[i] = { ...m }; continue; }
    const copy = { ...m, id: i >= 0 ? newId() : m.id };
    let name = copy.name, k = 2;
    while (out.some((x) => x.name === name)) name = `${copy.name} (${k++})`;
    copy.name = name;
    out.push(copy);
  }
  return out;
}

/** Ids of macros a macro reaches (directly or nested). Cycles are cut. */
export function macroDependencies(macro, byId) {
  const seen = new Set();
  const walk = (m) => {
    for (const s of m.steps) {
      if (!s.cmd.startsWith('macro.')) continue;
      const id = s.cmd.slice(6);
      if (seen.has(id)) continue;
      seen.add(id);
      const sub = byId(id);
      if (sub) walk(sub);
    }
  };
  walk(macro);
  return seen;
}

/** Would adding `cmd` as a step of `macro` make it call itself? */
export function createsCycle(macro, cmd, byId) {
  if (!cmd.startsWith('macro.')) return false;
  const id = cmd.slice(6);
  if (id === macro.id) return true;
  const sub = byId(id);
  return !!sub && macroDependencies(sub, byId).has(macro.id);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a macro: each step resolves to a runnable (resolve(cmd) -> fn | null) and runs in order; a returned promise
 * is awaited (file dialogs, async actions). Nested macros run through resolve too (depth-limited).
 * opts: { onStep(step, i), onMissing(step, i), signal: { aborted }, depth }
 * -> { ran, missing: [cmd], errors: [{cmd, error}] }
 */
export async function runMacro(macro, resolve, opts = {}) {
  const res = { ran: 0, missing: [], errors: [] };
  if ((opts.depth || 0) > MAX_DEPTH) { res.errors.push({ cmd: macroCommandId(macro), error: new Error('Macros nested too deeply') }); return res; }
  for (let i = 0; i < macro.steps.length; i++) {
    if (opts.signal?.aborted) break;
    const step = macro.steps[i];
    if (step.wait) await (opts.sleep || sleep)(step.wait);
    const fn = resolve(step.cmd, (opts.depth || 0) + 1);
    if (!fn) { res.missing.push(step.cmd); opts.onMissing?.(step, i); continue; }
    opts.onStep?.(step, i);
    try {
      const r = fn();
      if (r && typeof r.then === 'function') await r;
      res.ran++;
    } catch (error) {
      res.errors.push({ cmd: step.cmd, error });
      if (opts.stopOnError !== false) break;
    }
  }
  return res;
}

/** Records the commands run between start() and stop(). Repeated runs of a repeat-style command are kept. */
export class MacroRecorder {
  constructor() { this.active = false; this.steps = []; this._pause = 0; }
  start() { this.active = true; this.steps = []; this._t = null; }
  /** Commands run while a macro plays are not recorded (the macro step itself is). */
  suspend(fn) { this._pause++; try { return fn(); } finally { this._pause--; } }
  get recording() { return this.active && !this._pause; }
  record(cmd, label, now = Date.now()) {
    if (!this.recording || !cmd || UNRECORDABLE.has(cmd)) return false;
    this.steps.push({ cmd, label: label || cmd });
    this._t = now;
    return true;
  }
  stop() { this.active = false; const s = this.steps; this.steps = []; return s; }
}
