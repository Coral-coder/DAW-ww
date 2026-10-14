// Native plugin database (VST3 / AU / CLAP): scanning orchestration with crash isolation, the
// persisted DB format, and conversion to daW³ plugin-browser entries (kind 'native').
// Pure (all I/O is injected), so it runs in Node tests and in the app's audio server.

export const DB_VERSION = 1;
export const FORMATS = ['vst3', 'au', 'clap'];
export const FORMAT_LABELS = { vst3: 'VST3', au: 'Audio Unit', clap: 'CLAP' };

/** Default plugin folders per format (macOS conventions). */
export function defaultFolders(home, platform = 'darwin', env = {}) {
  if (platform === 'darwin') {
    return {
      vst3: [`${home}/Library/Audio/Plug-Ins/VST3`, '/Library/Audio/Plug-Ins/VST3'],
      clap: [`${home}/Library/Audio/Plug-Ins/CLAP`, '/Library/Audio/Plug-Ins/CLAP'],
      au: ['all'], // AudioComponent registry, not folders
    };
  }
  if (platform === 'win32') {
    // Steinberg / CLAP-spec Windows locations: per user under %LOCALAPPDATA%\Programs\Common, system-wide under
    // %CommonProgramFiles% (C:\Program Files\Common Files). The per-user folder follows `home` (tests pass a fake one).
    const common = String(env.CommonProgramFiles || env.COMMONPROGRAMFILES || 'C:\\Program Files\\Common Files').replace(/[\\/]+$/, '');
    const local = `${home}\\AppData\\Local\\Programs\\Common`;
    return { vst3: [`${local}\\VST3`, `${common}\\VST3`], clap: [`${local}\\CLAP`, `${common}\\CLAP`], au: [] };
  }
  return { vst3: [`${home}/.vst3`, '/usr/lib/vst3', '/usr/local/lib/vst3'], clap: [`${home}/.clap`, '/usr/lib/clap', '/usr/local/lib/clap'], au: [] };
}

export const emptyDb = () => ({ version: DB_VERSION, scannedAt: 0, plugins: [], bundles: {}, failed: [] });

/** Validate / upgrade a stored DB (bad input -> empty DB). */
export function parseDb(text) {
  let d;
  try { d = typeof text === 'string' ? JSON.parse(text) : text; } catch { return emptyDb(); }
  if (!d || typeof d !== 'object' || d.version !== DB_VERSION || !Array.isArray(d.plugins)) return emptyDb();
  const plugins = d.plugins.filter(isPluginDesc).map(cleanDesc);
  return {
    version: DB_VERSION,
    scannedAt: Number(d.scannedAt) || 0,
    plugins,
    bundles: d.bundles && typeof d.bundles === 'object' ? d.bundles : {},
    failed: Array.isArray(d.failed) ? d.failed.filter((f) => f && typeof f.path === 'string') : [],
  };
}

export function isPluginDesc(p) {
  return !!p && typeof p === 'object' && FORMATS.includes(p.format) && typeof p.uid === 'string' && p.uid.length > 0 && typeof p.name === 'string';
}

function cleanDesc(p) {
  const s = (v, n = 256) => (typeof v === 'string' ? v.slice(0, n) : '');
  return {
    key: `${p.format}:${p.uid}`, format: p.format, uid: s(p.uid, 512), name: s(p.name) || p.uid, vendor: s(p.vendor), version: s(p.version, 64),
    category: s(p.category), path: s(p.path, 2048), instrument: !!p.instrument, midiInput: !!p.midiInput,
    numInputs: Number.isInteger(p.numInputs) ? p.numInputs : 2, numOutputs: Number.isInteger(p.numOutputs) ? p.numOutputs : 2,
  };
}

/** Parse the plugin host's `--describe` output (one JSON line; anything else is noise). */
export function parseDescribeOutput(stdout) {
  const lines = String(stdout || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i]);
      if (j && typeof j === 'object' && 'ok' in j) {
        return { ok: !!j.ok, error: j.error || null, plugins: Array.isArray(j.plugins) ? j.plugins.filter(isPluginDesc).map(cleanDesc) : [] };
      }
    } catch { /* keep looking */ }
  }
  return { ok: false, error: 'The plugin scanner returned nothing', plugins: [] };
}

/**
 * Scan plugin folders. Each bundle is described by a separate scanner process (`describe`), so a
 * crashing plugin only fails itself; unchanged bundles (same mtime) are reused from `db`.
 * io: { listBundles(format, folders) -> Promise<string[]>, mtime(path) -> Promise<number>,
 *       describe(format, path) -> Promise<{ok, plugins, error, crashed?, timedOut?}> }
 */
export async function scanPlugins({ db = emptyDb(), folders, io, force = false, formats = FORMATS, concurrency = 4, onProgress, now = Date.now() }) {
  const jobs = [];
  for (const format of formats) {
    const dirs = folders?.[format] || [];
    if (!dirs.length) continue;
    const bundles = await io.listBundles(format, dirs);
    for (const path of bundles) jobs.push({ format, path });
  }
  const next = { version: DB_VERSION, scannedAt: now, plugins: [], bundles: {}, failed: [] };
  const prevByBundle = new Map();
  for (const p of db.plugins) {
    const k = `${p.format}|${p.path}`;
    if (!prevByBundle.has(k)) prevByBundle.set(k, []);
    prevByBundle.get(k).push(p);
  }
  let done = 0;
  const runOne = async ({ format, path }) => {
    const bk = `${format}|${path}`;
    let mtime = 0;
    try { mtime = format === 'au' ? now : await io.mtime(path); } catch { mtime = 0; }
    const prev = db.bundles?.[bk];
    const prevFail = (db.failed || []).find((f) => f.path === path && f.format === format);
    if (!force && format !== 'au' && prev && prev.mtime === mtime && mtime) {
      if (prev.ok) next.plugins.push(...(prevByBundle.get(bk) || []));
      else if (prevFail) next.failed.push(prevFail);
      next.bundles[bk] = prev;
    } else {
      let r;
      try { r = await io.describe(format, path); } catch (e) { r = { ok: false, error: e?.message || String(e) }; }
      const ok = !!r?.ok;
      if (ok) next.plugins.push(...(r.plugins || []).filter(isPluginDesc).map((p) => cleanDesc({ ...p, path: p.path || path })));
      else next.failed.push({ format, path, error: r?.error || 'scan failed', crashed: !!r?.crashed, timedOut: !!r?.timedOut });
      next.bundles[bk] = { mtime, ok };
    }
    done++;
    onProgress?.({ done, total: jobs.length, format, path });
  };
  const queue = jobs.slice();
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    while (queue.length) await runOne(queue.shift());
  });
  await Promise.all(workers);
  // stable order + de-duplicate keys (the same plugin installed twice: keep the first folder's)
  const seen = new Set();
  next.plugins = next.plugins
    .sort((a, b) => a.name.localeCompare(b.name) || a.format.localeCompare(b.format))
    .filter((p) => (seen.has(p.key) ? false : (seen.add(p.key), true)));
  return next;
}

/** Short stable id for a plugin key (used in catalog ids / status keys). */
export function keyHash(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

const CATEGORY_NAMES = [
  [/synth|instrument|generator/i, 'Synth'], [/sampler|drum/i, 'Sampler'], [/reverb/i, 'Reverb'], [/delay|echo/i, 'Delay'],
  [/eq|equalizer|filter/i, 'EQ / Filter'], [/dynamics|compressor|limiter|gate/i, 'Dynamics'], [/distortion|saturat|amp/i, 'Distortion'],
  [/chorus|flanger|phaser|modulation/i, 'Modulation'], [/pitch/i, 'Pitch'], [/analy[sz]er|meter/i, 'Analyzer'], [/utility|tools/i, 'Utility'],
];

/** Plugin-browser entries (kind 'native') for the DB's plugins. */
export function catalogEntries(db) {
  return (db?.plugins || []).map((p) => {
    const cat = CATEGORY_NAMES.find(([re]) => re.test(p.category))?.[1] || (p.instrument ? 'Synth' : 'Effect');
    return {
      id: `native-${p.format}-${keyHash(p.key)}`,
      name: p.name,
      kind: 'native',
      type: p.instrument ? 'instrument' : 'effect',
      category: cat,
      description: `${FORMAT_LABELS[p.format]} ${p.instrument ? 'instrument' : 'effect'}${p.vendor ? ` by ${p.vendor}` : ''}${p.version ? ` · v${p.version}` : ''}`,
      author: p.vendor || '',
      license: 'Installed on this Mac (see the vendor’s license)',
      source: { key: p.key, format: p.format, uid: p.uid, path: p.path },
      homepage: '',
      format: p.format,
      tags: [FORMAT_LABELS[p.format], p.vendor].filter(Boolean),
    };
  });
}
