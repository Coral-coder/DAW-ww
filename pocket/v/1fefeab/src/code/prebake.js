// Prebake: Strudel helper libraries evaluated before the user's code (strudel.cc Settings → "prebake").
//
//   createPrebakeManager({ storage, fetch, engine, confirmProjectUrl }) -> manager (see below)
//   parsePrebakeDocs(code, sourceName)  -> [{name, kind: 'method'|'function', params, signature, title, desc, example, line, source}]
//   normalizeProjectPrebake(list)       -> [{name, url} | {name, code}]   (project.prebake, as saved in .daW3)
//   mergeProjectPrebake(list, refs)     -> list with refs added (by url / code), or the same list when nothing is new
//   undefinedCalls(evaluated)           -> names the code calls that neither Strudel nor a loaded prebake define
//   looksLikeHelperName(name)           -> boolean   names helper libraries typically define (dly, acidenv, rlpf …)
//   toRawUrl(url)                       -> GitHub / Gist / Codeberg page URLs -> their raw file URL
//
// Sources: [{id, name, kind: 'url'|'text', url?, code, enabled, fetchedAt, etag?, lastModified?, error?, stale?}],
// stored per user (localStorage, with the fetched text as an offline cache). A project can carry references too
// (project.prebake: [{name, url}] by default, [{name, code}] for pasted snippets) so a song that needs a helper
// library opens with it. The engine side (strudel-real.js setPrebake) runs the effective list once per change.
import { prebakeDefinedNames } from './strudel-real.js';

export const PREBAKE_STORAGE_KEY = 'daw3-prebake';

const VALID = /^[A-Za-z_$][\w$]*$/;

/** GitHub / Gist / Codeberg / GitLab page URLs -> the raw file URL (other URLs unchanged). */
export function toRawUrl(url) {
  const u = String(url || '').trim();
  let m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(u);
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  m = /^https?:\/\/gist\.github\.com\/([^/]+)\/([0-9a-f]+)\/?$/.exec(u);
  if (m) return `https://gist.githubusercontent.com/${m[1]}/${m[2]}/raw`;
  m = /^https?:\/\/codeberg\.org\/([^/]+)\/([^/]+)\/src\/(?:branch\/)?(.+)$/.exec(u);
  if (m) return `https://codeberg.org/${m[1]}/${m[2]}/raw/branch/${m[3]}`;
  m = /^https?:\/\/gitlab\.com\/(.+?)\/-\/blob\/(.+)$/.exec(u);
  if (m) return `https://gitlab.com/${m[1]}/-/raw/${m[2]}`;
  return u;
}

const nameFromUrl = (url) => {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const file = parts[parts.length - 1] || u.hostname;
    if (u.hostname === 'raw.githubusercontent.com' && parts.length >= 2) return `${parts[0]}/${parts[1]} · ${file}`;
    return file;
  } catch { return String(url); }
};

// ------------------------------------------------------------------------------------------------ docs

/** The comment block right above `line` (0-based line index): text without markers, or ''. */
function commentAbove(lines, i) {
  const out = [];
  let j = i - 1;
  while (j >= 0 && !lines[j].trim()) j--;
  if (j >= 0 && /\*\/\s*$/.test(lines[j])) {
    const end = j;
    while (j >= 0 && !/\/\*/.test(lines[j])) j--;
    if (j < 0) return '';
    for (let k = j; k <= end; k++) out.push(lines[k].replace(/^\s*\/\*\*?/, '').replace(/\*\/\s*$/, '').replace(/^\s*\*\s?/, ''));
    return out.join('\n').trim();
  }
  while (j >= 0 && /^\s*\/\//.test(lines[j])) { out.unshift(lines[j].replace(/^\s*\/\/+\s?/, '')); j--; }
  return out.join('\n').trim();
}

/** Parameter list text after `pos` (an arrow function's `(a, b) =>`, `x =>` or `function (a, b)`). */
function paramsAt(code, pos) {
  const rest = code.slice(pos, pos + 400);
  let m = /^\s*(?:async\s*)?function\s*[\w$]*\s*\(([^)]*)\)/.exec(rest);
  if (m) return m[1];
  m = /^\s*(?:async\s*)?\(([^)]*)\)\s*=>/.exec(rest);
  if (m) return m[1];
  m = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(rest);
  if (m) return m[1];
  return null;
}
const splitParams = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Functions a prebake defines, with signatures and docs read from the code: `register('name', (args, pat) =>`
 * (a pattern method — the last parameter is the pattern), `registerFunc('name', (args) =>` / `window.name = (args) =>`
 * (functions), `Pattern.prototype.name = function (args)` (methods). The comment above is the description;
 * `@title` / `@example` tags are read when present.
 */
export function parsePrebakeDocs(code, sourceName = '') {
  const src = String(code ?? '');
  const lines = src.split('\n');
  const lineAt = (pos) => src.slice(0, pos).split('\n').length - 1;
  const out = [];
  const seen = new Set();
  const add = (name, kind, params, pos, alsoFunction = false) => {
    if (!VALID.test(name)) return;
    const key = `${kind}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const li = lineAt(pos);
    const raw = commentAbove(lines, li);
    const title = /@title\s+(.+)/.exec(raw)?.[1]?.trim() || null;
    const exm = /@example\s+([\s\S]*?)(?=\n\s*@\w|$)/.exec(raw);
    const example = exm ? exm[1].trim() : null;
    const desc = raw.replace(/@title\s+.+/, '').replace(/@example\s+[\s\S]*?(?=\n\s*@\w|$)/, '').replace(/@\w+[^\n]*/g, '').replace(/\s*\n\s*/g, ' ').trim();
    const ps = splitParams(params);
    const shown = kind === 'method' ? ps.slice(0, -1) : ps;
    const signature = kind === 'method' ? `pat.${name}(${shown.join(', ')})` : `${name}(${shown.join(', ')})`;
    const entry = { name, kind, params: shown, signature, title, desc, example, line: li + 1, source: sourceName };
    out.push(entry);
    if (alsoFunction) add(name, 'function', params, pos);
  };
  for (const m of src.matchAll(/\b(registerFunc|register)\s*\(\s*['"`]([A-Za-z_$][\w$]*)['"`]\s*,/g)) {
    const pos = m.index + m[0].length;
    const params = paramsAt(src, pos);
    const head = src.slice(Math.max(0, src.lastIndexOf('\n', m.index) + 1), m.index);
    const isWindow = /\bwindow\.[\w$]+\s*=\s*$/.test(head);
    // (a comment above `window.x = register(` belongs to the whole line)
    const at = isWindow ? src.lastIndexOf('\n', m.index) + 1 : m.index;
    if (m[1] === 'registerFunc') add(m[2], 'function', params, at);
    else add(m[2], 'method', params, at);
  }
  for (const m of src.matchAll(/^[ \t]*(?:window|globalThis)\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)\s*/gm)) {
    const pos = m.index + m[0].length;
    const after = src.slice(pos, pos + 40);
    if (/^register(Func)?\s*\(/.test(after)) { const r = /['"`]([A-Za-z_$][\w$]*)['"`]/.exec(after); if (r && r[1] !== m[1]) add(m[1], 'function', paramsAt(src, src.indexOf(',', pos) + 1), m.index); continue; }
    const params = paramsAt(src, pos);
    if (params === null) continue; // a value, not a function (state, constants)
    if (m[1] === 'registerFunc') continue; // the helper that registers the others
    add(m[1], 'function', params, m.index);
  }
  for (const m of src.matchAll(/^[ \t]*Pattern\s*\.\s*prototype\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*/gm)) {
    const params = paramsAt(src, m.index + m[0].length);
    add(m[1], 'method', params === null ? '' : `${params}${params ? ', ' : ''}pat`, m.index);
  }
  return out.sort((a, b) => a.line - b.line);
}

// ------------------------------------------------------------------------------------------- project refs

/** project.prebake as stored: [{name, url}] / [{name, code}] (anything else dropped). */
export function normalizeProjectPrebake(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    const name = String(x.name || '').slice(0, 120);
    if (typeof x.url === 'string' && /^https?:\/\//.test(x.url)) out.push({ name: name || nameFromUrl(x.url), url: x.url });
    else if (typeof x.code === 'string' && x.code.trim()) out.push({ name: name || 'Pasted prebake', code: x.code });
  }
  return out;
}

const refKey = (r) => (r.url ? `u:${r.url}` : `c:${r.code}`);
/** Adds refs not already in list (by url / identical code). Returns the same array when nothing is new. */
export function mergeProjectPrebake(list, refs) {
  const cur = normalizeProjectPrebake(list);
  const have = new Set(cur.map(refKey));
  const add = normalizeProjectPrebake(refs).filter((r) => !have.has(refKey(r)));
  return add.length ? [...cur, ...add] : list;
}

// ------------------------------------------------------------------------------------------- detection

// Strudel packages daW³ doesn't ship (their functions are "not available" for another reason than a missing prebake)
const PACKAGE_NAMES = new Set(['midi', 'midin', 'midichan', 'midicmd', 'midiport', 'ccn', 'ccv', 'cc', 'nrpnn', 'nrpv', 'osc', 'oscport',
  'initHydra', 'H', 'csound', 'csoundm', 'loadCsound', 'loadOrc', 'serial', 'mqtt', 'gamepad', 'motion', 'mouseX', 'mouseY',
  'xen', 'tuning', 'sysex', 'progNum', 'midibend', 'miditouch', 'pianoroll', 'punchcard', 'scope', 'spiral', 'markcss']);

// names helper libraries typically define (used to decide how strongly to suggest a prebake)
const HELPER_HINT = /^(acidenv|trancegate|tgate|dly|rlpf|rhpf|rbpf|chrd|trancearp|pg|pk|o|fill|grab|swap|flood|comb|stxt|ifit|sb|accent|octave|glitch|humanize|strum|disperse|noisehat|zap|roller\d?|spinor|blockArrange|track|ar|cue|setScale|voc|fmtime|oneshot|filtval|sq|vstruct|mpan|colorparty|irando|randm|DX)$/;
export const looksLikeHelperName = (name) => HELPER_HINT.test(String(name));

/** Names an evaluate() result reports as not available (its warnings), minus Strudel packages we don't ship. */
export function undefinedCalls(evaluated) {
  const out = new Set();
  for (const w of evaluated?.warnings || []) {
    const m = /^\.?([A-Za-z_$][\w$]*)\(\) is not (?:available|supported)/.exec(String(w));
    if (m && !PACKAGE_NAMES.has(m[1])) out.add(m[1]);
  }
  return [...out];
}

/** Which of `sources` define which of `names`: [{source, names}] (most names first). */
export function sourcesDefining(names, sources) {
  const want = new Set(names);
  const out = [];
  for (const s of sources || []) {
    if (!s?.code) continue;
    const d = prebakeDefinedNames(s.code);
    const hit = [...new Set([...d.methods, ...d.functions, ...d.globals])].filter((n) => want.has(n));
    if (hit.length) out.push({ source: s, names: hit });
  }
  return out.sort((a, b) => b.names.length - a.names.length);
}

/** Does `code` call / reference any of `names` (as a function, method or identifier, outside strings / comments)? */
export function codeUses(code, names) {
  const src = String(code ?? '').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ' ').replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
  return [...names].filter((n) => VALID.test(n) && new RegExp(`(^|[^\\w$])${n.replace(/\$/g, '\\$')}\\s*\\(`).test(src));
}

// ------------------------------------------------------------------------------------------- manager

let idSeq = 0;
const newId = () => `pb${Date.now().toString(36)}${(++idSeq).toString(36)}`;
const inBrowserPage = () => typeof window !== 'undefined' && typeof document !== 'undefined';

/**
 * opts: { storage (getItem/setItem, default localStorage), fetch (default globalThis.fetch), engine: { setPrebake,
 *   prebakeStatus } (strudel-real.js), confirmProjectUrl(ref) -> Promise<boolean> (a project wants a URL the user has
 *   never loaded) }.
 *
 * manager.sources()                 user sources (copies)
 * manager.add({url} | {code, name}) -> Promise<source>   fetches a URL first
 * manager.update(id, patch) / remove(id) / move(id, delta) / setEnabled(id, on)
 * manager.reload(id?)               -> Promise   re-fetches URL sources (all when no id), then re-applies
 * manager.setProject(project)       -> Promise   the project's prebake refs join the effective list
 * manager.effective()               -> [{id, name, code}]  what the engine runs (enabled user sources, then the project's)
 * manager.refsFor(code)             -> project refs ([{name, url}|{name, code}]) of the sources `code` uses
 * manager.status()                  -> { state: 'none'|'loading'|'ok'|'error', engine, fetchErrors, loading }
 * manager.docs()                    -> parsePrebakeDocs() of every effective source
 * manager.subscribe(fn)             -> unsubscribe   called after every change / apply
 */
export function createPrebakeManager(opts = {}) {
  const storage = opts.storage !== undefined ? opts.storage : (typeof localStorage !== 'undefined' ? localStorage : null);
  const fetchImpl = opts.fetch || (typeof fetch !== 'undefined' ? (...a) => fetch(...a) : null);
  const engine = opts.engine || {};
  const confirmProjectUrl = opts.confirmProjectUrl || (async () => false);
  const listeners = new Set();
  let user = [];
  let projectRefs = [];
  let projectSources = []; // resolved project refs: [{id, name, code, url?, error?}]
  let loading = 0;
  let declined = new Set(); // project URLs the user declined this session

  function load() {
    try {
      const raw = storage?.getItem(PREBAKE_STORAGE_KEY);
      const v = raw ? JSON.parse(raw) : null;
      user = Array.isArray(v?.sources) ? v.sources.filter((s) => s && s.id).map((s) => ({ enabled: true, code: '', ...s })) : [];
    } catch { user = []; }
  }
  function save() {
    try { storage?.setItem(PREBAKE_STORAGE_KEY, JSON.stringify({ sources: user })); } catch (e) { console.warn('[prebake] could not save:', e?.message || e); }
  }
  const emit = () => { for (const fn of [...listeners]) { try { fn(api.status()); } catch (e) { console.warn('[prebake]', e); } } };

  async function fetchText(src, { force = false } = {}) {
    if (!fetchImpl) throw new Error('No network access here');
    const headers = {};
    // (a page can't send conditional headers cross-origin without a preflight — it revalidates through its HTTP cache)
    if (!inBrowserPage() && !force) {
      if (src.etag) headers['If-None-Match'] = src.etag;
      if (src.lastModified) headers['If-Modified-Since'] = src.lastModified;
    }
    const res = await fetchImpl(src.url, { cache: force ? 'reload' : 'no-cache', headers });
    if (res.status === 304 && src.code) return { notModified: true };
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
    const text = await res.text();
    if (/^\s*<!doctype html|^\s*<html/i.test(text)) throw new Error('That URL is a web page, not a .strudel / .js file (use the "raw" link)');
    const get = (k) => { try { return res.headers?.get?.(k) || null; } catch { return null; } };
    return { text, etag: get('etag'), lastModified: get('last-modified') };
  }

  /** Fetches a URL source in place (keeps the cached copy when offline). */
  async function refresh(src, { force = false } = {}) {
    loading++; emit();
    try {
      const r = await fetchText(src, { force });
      if (!r.notModified) { src.code = r.text; src.etag = r.etag; src.lastModified = r.lastModified; }
      src.fetchedAt = Date.now();
      delete src.error; delete src.stale;
    } catch (e) {
      const msg = String(e?.message || e);
      if (src.code) { src.stale = true; src.error = `Could not refresh (${msg}) — using the cached copy`; } else src.error = `Could not load: ${msg}`;
    } finally { loading--; }
    return src;
  }

  function effective() {
    const out = [];
    const urls = new Set();
    const codes = new Set();
    for (const s of user) {
      if (!s.enabled || !s.code) continue;
      out.push({ id: s.id, name: s.name, code: s.code });
      if (s.url) urls.add(s.url);
      codes.add(s.code);
    }
    for (const s of projectSources) {
      if (!s.code || (s.url && urls.has(s.url)) || codes.has(s.code)) continue;
      out.push({ id: s.id, name: s.name, code: s.code });
    }
    return out;
  }

  function apply() {
    try { engine.setPrebake?.(effective()); } catch (e) { console.warn('[prebake] apply failed:', e); }
    emit();
  }

  async function resolveProject() {
    const out = [];
    for (let i = 0; i < projectRefs.length; i++) {
      const r = projectRefs[i];
      if (r.code) { out.push({ id: `project:${i}`, name: r.name, code: r.code }); continue; }
      const mine = user.find((s) => s.url === r.url);
      if (mine) {
        if (!mine.code) await refresh(mine);
        // (a source the user disabled still plays the song that needs it)
        out.push({ id: mine.enabled ? `project:${i}` : mine.id, name: mine.name, url: r.url, code: mine.code, error: mine.error });
        continue;
      }
      if (declined.has(r.url)) { out.push({ id: `project:${i}`, name: r.name, url: r.url, code: '', error: 'Not loaded (declined)' }); continue; }
      let ok = false;
      try { ok = await confirmProjectUrl(r); } catch { ok = false; }
      if (!ok) { declined.add(r.url); out.push({ id: `project:${i}`, name: r.name, url: r.url, code: '', error: 'Not loaded (declined)' }); continue; }
      // remembered (disabled for other projects) so it is cached for offline use and never asked for again
      const src = { id: newId(), name: r.name, kind: 'url', url: r.url, code: '', enabled: false, fetchedAt: null };
      await refresh(src);
      user.push(src);
      save();
      out.push({ id: `project:${i}`, name: r.name, url: r.url, code: src.code, error: src.error });
    }
    projectSources = out;
  }

  const api = {
    sources: () => user.map((s) => ({ ...s })),
    projectSources: () => projectSources.map((s) => ({ ...s })),
    effective,
    async add(spec = {}) {
      let src;
      if (spec.url) {
        const url = toRawUrl(spec.url);
        const dup = user.find((s) => s.url === url);
        if (dup) { dup.enabled = true; await refresh(dup, { force: true }); save(); apply(); return { ...dup }; }
        src = { id: newId(), name: spec.name || nameFromUrl(url), kind: 'url', url, code: '', enabled: spec.enabled !== false, fetchedAt: null };
        await refresh(src, { force: true });
      } else {
        const code = String(spec.code ?? '');
        if (!code.trim()) throw new Error('The prebake code is empty');
        src = { id: newId(), name: spec.name || 'Pasted prebake', kind: 'text', code, enabled: spec.enabled !== false, fetchedAt: Date.now() };
      }
      user.push(src);
      save();
      apply();
      return { ...src };
    },
    update(id, patch) {
      const s = user.find((x) => x.id === id);
      if (!s) return;
      for (const k of ['name', 'code', 'enabled']) if (patch[k] !== undefined) s[k] = patch[k];
      save(); apply();
    },
    setEnabled(id, on) { api.update(id, { enabled: !!on }); },
    remove(id) { user = user.filter((s) => s.id !== id); save(); apply(); },
    move(id, delta) {
      const i = user.findIndex((s) => s.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= user.length) return;
      [user[i], user[j]] = [user[j], user[i]];
      save(); apply();
    },
    async reload(id) {
      const list = user.filter((s) => s.kind === 'url' && (!id || s.id === id));
      await Promise.all(list.map((s) => refresh(s, { force: true })));
      save();
      if (!id && projectRefs.length) await resolveProject();
      apply();
    },
    async setProject(project) {
      const refs = normalizeProjectPrebake(project?.prebake);
      if (JSON.stringify(refs) === JSON.stringify(projectRefs)) return;
      projectRefs = refs;
      await resolveProject();
      apply();
    },
    refsFor(code) {
      const refs = [];
      for (const s of effective()) {
        const d = prebakeDefinedNames(s.code);
        const names = [...new Set([...d.methods, ...d.functions, ...d.globals])];
        if (!codeUses(code, names).length) continue;
        const u = user.find((x) => x.id === s.id) || projectSources.find((x) => x.id === s.id);
        if (u?.url) refs.push({ name: s.name, url: u.url });
        else refs.push({ name: s.name, code: s.code });
      }
      return refs;
    },
    status() {
      const eng = engine.prebakeStatus?.() || { sources: [] };
      const eff = effective();
      const fetchErrors = [...user.filter((s) => s.enabled), ...projectSources].filter((s) => s.error).map((s) => ({ id: s.id, name: s.name, message: s.error, stale: !!s.stale }));
      const evalErrors = (eng.sources || []).filter((s) => s.errors?.length);
      let state = 'none';
      if (loading || (eff.length && eng.applied === false)) state = 'loading'; // (the engine runs it once it loads)
      else if (eff.length || fetchErrors.length) state = fetchErrors.some((e) => !e.stale) || evalErrors.length ? 'error' : 'ok';
      return { state, loading: loading > 0, engine: eng, fetchErrors, evalErrors, count: eff.length };
    },
    docs() {
      return effective().flatMap((s) => parsePrebakeDocs(s.code, s.name));
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Re-fetches enabled URL sources in the background (startup); the cached copies apply immediately. */
    async start() {
      apply();
      const stale = user.filter((s) => s.enabled && s.kind === 'url');
      if (!stale.length) return;
      const before = stale.map((s) => s.code);
      await Promise.all(stale.map((s) => refresh(s)));
      save();
      if (stale.some((s, i) => s.code !== before[i])) apply(); else emit();
    },
  };
  load();
  return api;
}
