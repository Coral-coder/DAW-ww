// GitHub link helpers (pure, Node-safe): URL → jsDelivr CDN, plugin-kind detection, manifests.
//
// Browsers cannot load files from github.com pages (HTML, no CORS) and raw.githubusercontent.com
// serves everything as text/plain (ES modules refuse to load). jsDelivr mirrors every public repo
// with CORS and correct MIME types: https://cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>

export const CDN = 'https://cdn.jsdelivr.net';
export const PLUGIN_KINDS = ['soundfont', 'faust', 'wam'];
export const MANIFEST_FILES = ['daW3.json', 'plugin.json'];

const cdnUrl = (owner, repo, ref, path) =>
  `${CDN}/gh/${owner}/${repo}${ref ? '@' + ref : ''}/${(path || '').replace(/^\/+/, '')}`;

/**
 * resolveGitHubUrl(url) -> { url, original, github: boolean, owner?, repo?, ref?, path?, isDir, isRepoRoot }
 * Handles github.com (repo root, /blob/, /tree/, /raw/), raw.githubusercontent.com (incl. refs/heads/…),
 * <owner>.github.io/<repo>/… (gh-pages) and existing jsDelivr /gh/ URLs. Any other http(s) URL is
 * returned unchanged. Throws on empty / non-http input.
 */
export function resolveGitHubUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) throw new Error('Paste a GitHub or https:// link.');
  if (/^(github\.com|raw\.githubusercontent\.com|cdn\.jsdelivr\.net)\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { throw new Error(`“${s}” is not a valid URL.`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) links are supported.');
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  const out = (o) => ({ original: s, github: true, isDir: false, isRepoRoot: false, ...o });

  if (host === 'github.com' || host === 'www.github.com') {
    const [owner, repo0, mode, ref, ...rest] = parts;
    if (!owner || !repo0) throw new Error('That GitHub link has no repository (expected github.com/<owner>/<repo>/…).');
    const repo = repo0.replace(/\.git$/, '');
    const path = rest.join('/');
    if (!mode) return out({ owner, repo, ref: null, path: '', isDir: true, isRepoRoot: true, url: cdnUrl(owner, repo, null, '') });
    if ((mode === 'blob' || mode === 'raw') && ref && path) return out({ owner, repo, ref, path, url: cdnUrl(owner, repo, ref, path) });
    if (mode === 'tree' && ref) return out({ owner, repo, ref, path, isDir: true, isRepoRoot: !path, url: cdnUrl(owner, repo, ref, path ? path + '/' : '') });
    throw new Error('Unsupported GitHub link — use a link to a file (…/blob/<branch>/<file>) or a repository.');
  }
  if (host === 'raw.githubusercontent.com') {
    let [owner, repo, ...rest] = parts;
    if (!owner || !repo || rest.length < 2) throw new Error('Incomplete raw.githubusercontent.com link.');
    let ref = rest.shift();
    if (ref === 'refs' && (rest[0] === 'heads' || rest[0] === 'tags')) { rest.shift(); ref = rest.shift(); }
    const path = rest.join('/');
    return out({ owner, repo, ref, path, url: cdnUrl(owner, repo, ref, path) });
  }
  const io = /^([a-z0-9-]+)\.github\.io$/i.exec(host);
  if (io) {
    const owner = io[1];
    const [repo, ...rest] = parts;
    if (!repo) return out({ owner, repo: `${owner}.github.io`, ref: null, path: '', isDir: true, isRepoRoot: true, url: cdnUrl(owner, `${owner}.github.io`, null, '') });
    const path = rest.join('/');
    const isDir = !path || u.pathname.endsWith('/');
    return out({ owner, repo, ref: 'gh-pages', path, isDir, isRepoRoot: !path, url: cdnUrl(owner, repo, 'gh-pages', path + (isDir && path ? '/' : '')) });
  }
  if (host === 'cdn.jsdelivr.net' && parts[0] === 'gh' && parts.length >= 3) {
    const owner = parts[1];
    const [repo, ref = null] = parts[2].split('@');
    const path = parts.slice(3).join('/');
    const isDir = !path || u.pathname.endsWith('/');
    return out({ owner, repo, ref, path, isDir, isRepoRoot: !path, url: s });
  }
  return { original: s, github: false, url: u.href, isDir: u.pathname.endsWith('/'), isRepoRoot: false };
}

/** Join a base directory URL and a relative path (manifest `entry`). */
export function joinUrl(base, rel) {
  if (/^https?:\/\//i.test(rel)) return rel;
  const b = String(base || '');
  return new URL(String(rel || ''), b.endsWith('/') ? b : b.replace(/[^/]*$/, '')).href;
}

/** Candidate manifest URLs for a directory / repository URL (resolved CDN form). */
export function manifestUrls(resolved) {
  const r = typeof resolved === 'string' ? resolveGitHubUrl(resolved) : resolved;
  const base = r.url.endsWith('/') ? r.url : r.url + '/';
  return MANIFEST_FILES.map((f) => base + f);
}

/**
 * Guess the plugin kind from a URL and (optionally) the fetched text.
 * -> 'soundfont' | 'faust' | 'wam' | 'manifest' | null
 */
export function detectPluginKind(url, text) {
  const path = String(url || '').split(/[?#]/)[0].toLowerCase();
  const t = typeof text === 'string' ? text.slice(0, 200000) : null;
  if (t != null) {
    if (/MIDI\.Soundfont(\.|\[)/.test(t) || /^\s*\{\s*"[A-G]b?\d"\s*:\s*"data:audio\//.test(t)) return 'soundfont';
    if (/^\s*\{/.test(t) && /"kind"\s*:/.test(t) && /"entry"\s*:/.test(t)) return 'manifest';
    if (/\bprocess\s*=/.test(t) && (/import\s*\(\s*"[a-z]+\.lib"\s*\)/.test(t) || /\b(os|fi|en|ba|re|ef|pm|ve|no|si|de|co|sp)\.\w+/.test(t) || path.endsWith('.dsp'))) return 'faust';
    if (/\bexport\s+(default|\{[^}]*\bas\s+default\b)/.test(t) || /\bWebAudioModule\b/.test(t)) return 'wam';
  }
  if (/\.dsp$/.test(path)) return 'faust';
  if (/-(mp3|ogg)\.js$/.test(path)) return 'soundfont';
  if (/(^|\/)(daw3|plugin)\.json$/i.test(path)) return 'manifest';
  if (/\.(m?js)$/.test(path)) return t == null ? 'wam' : null;
  return null;
}

/**
 * validateManifest(json, baseUrl?) -> { ok, errors: string[], manifest?: {name, kind, entry, url, description, type} }
 * Manifest format: { "name": "...", "kind": "soundfont"|"faust"|"wam", "entry": "path/or/url",
 *                    "description"?: "...", "type"?: "instrument"|"effect" }
 */
export function validateManifest(json, baseUrl = '') {
  const errors = [];
  let m = json;
  if (typeof m === 'string') {
    try { m = JSON.parse(m); } catch (e) { return { ok: false, errors: [`Manifest is not valid JSON: ${e.message}`] }; }
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, errors: ['Manifest must be a JSON object.'] };
  if (typeof m.name !== 'string' || !m.name.trim()) errors.push('"name" (string) is required.');
  if (!PLUGIN_KINDS.includes(m.kind)) errors.push(`"kind" must be one of ${PLUGIN_KINDS.join(', ')}.`);
  if (typeof m.entry !== 'string' || !m.entry.trim()) errors.push('"entry" (path or URL of the plugin file) is required.');
  if (m.type !== undefined && !['instrument', 'effect'].includes(m.type)) errors.push('"type" must be "instrument" or "effect".');
  if (errors.length) return { ok: false, errors };
  let url = m.entry.trim();
  try {
    url = joinUrl(baseUrl, url);
    url = resolveGitHubUrl(url).url;
  } catch { /* keep as given */ }
  return {
    ok: true,
    errors: [],
    manifest: {
      name: m.name.trim(), kind: m.kind, entry: m.entry.trim(), url,
      description: typeof m.description === 'string' ? m.description : '',
      type: m.type || 'instrument',
    },
  };
}

/** Short display name from a URL: '…/FluidR3_GM/marimba-mp3.js' -> 'marimba', 'synth.dsp' -> 'synth'. */
export function nameFromUrl(url) {
  const file = decodeURIComponent(String(url || '').split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop() || '');
  return file.replace(/-(mp3|ogg)\.js$/i, '').replace(/\.(dsp|m?js|json)$/i, '') || 'Plugin';
}

/** Stable, short hash of a string (FNV-1a, hex) — used for Faust source cache keys. */
export function hashString(s) {
  let h = 0x811c9dc5;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * jsDelivr /gh/ URL -> raw.githubusercontent.com equivalent (CORS-enabled fallback when jsDelivr is
 * blocked). Null for other URLs or when no ref is pinned. raw.* serves text/plain, so this is only
 * suitable for fetch() (soundfonts, .dsp sources), not for ES-module imports.
 */
export function rawGitHubUrl(url) {
  const m = /^https:\/\/cdn\.jsdelivr\.net\/gh\/([^/]+)\/([^/@]+)@([^/]+)\/(.+)$/.exec(String(url || ''));
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}` : null;
}
