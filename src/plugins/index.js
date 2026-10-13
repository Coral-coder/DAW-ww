// Plugin host entry points used by the UI: detect a plugin from a link, turn a plugin into project
// JSON, preview it. Browser-only (lazy-imported by the plugins dialog).
import { resolveGitHubUrl, manifestUrls, validateManifest, detectPluginKind, joinUrl, nameFromUrl } from './github.js';
import { fetchText } from './fetch-cache.js';
import { parseSoundfontText } from './soundfont-parse.js';
import { userError, friendlyError } from './status.js';
import { gmLabel } from './gm.js';

export * from './status.js';
export { resolveGitHubUrl } from './github.js';

const ENGINES = {
  soundfont: () => import('./soundfont.js'),
  faust: () => import('./faust.js'),
  wam: () => import('./wam.js'),
};

/**
 * detectPlugin(link, {onStage}) -> { kind, type:'instrument'|'effect', name, url, code?, description, resolved, experimental? }
 * Throws Errors with friendly messages.
 */
export async function detectPlugin(link, { onStage } = {}) {
  const r = resolveGitHubUrl(link);
  if (r.isDir || r.isRepoRoot) {
    onStage?.('Looking for a daWWW.json / plugin.json manifest…');
    const tried = [];
    for (const mu of manifestUrls(r)) {
      let text;
      try { text = await fetchText(mu, { cache: false }); } catch (e) { tried.push(mu); continue; }
      const v = validateManifest(text, mu);
      if (!v.ok) throw userError(`Invalid manifest (${mu.split('/').pop()}): ${v.errors.join(' ')}`);
      return describe(v.manifest.kind, v.manifest.url, { r, name: v.manifest.name, description: v.manifest.description, type: v.manifest.type, onStage });
    }
    throw userError('No daWWW.json or plugin.json manifest was found there. Link directly to a Faust .dsp file, a midi-js soundfont (*-mp3.js) or a WAM index.js — or add a manifest {"name","kind","entry"} to the repository.');
  }
  let kind = detectPluginKind(r.url);
  if (kind === 'manifest') {
    onStage?.('Reading the manifest…');
    const text = await fetchText(r.url, { cache: false });
    const v = validateManifest(text, r.url);
    if (!v.ok) throw userError(`Invalid manifest: ${v.errors.join(' ')}`);
    return describe(v.manifest.kind, v.manifest.url, { r, name: v.manifest.name, description: v.manifest.description, type: v.manifest.type, onStage });
  }
  if (!kind || kind === 'wam') {
    // sniff the content (a .js file might be a soundfont with an unusual name, or not a plugin at all)
    onStage?.('Downloading…');
    const text = await fetchText(r.url);
    kind = detectPluginKind(r.url, text) || null;
    if (!kind) throw userError('Could not tell what kind of plugin this is. Supported: Faust .dsp source, midi-js soundfonts (*-mp3.js / *-ogg.js) and Web Audio Modules (ES module with a default export).');
  }
  return describe(kind, r.url, { r, onStage });
}

async function describe(kind, url, { r, name, description = '', type, onStage }) {
  const base = { kind, url, resolved: r, name: name || nameFromUrl(url), description };
  if (kind === 'faust') {
    onStage?.('Downloading the Faust source…');
    const { fetchFaustSource, looksPolyphonic } = await import('./faust.js');
    const code = await fetchFaustSource(url);
    const declared = /declare\s+name\s+"([^"]+)"/.exec(code)?.[1];
    return { ...base, name: name || declared || base.name, code, type: type || (looksPolyphonic(code) ? 'instrument' : 'effect'), description: description || /declare\s+description\s+"([^"]+)"/.exec(code)?.[1] || '' };
  }
  if (kind === 'soundfont') {
    onStage?.('Downloading the soundfont…');
    const parsed = parseSoundfontText(await fetchText(url));
    return { ...base, type: 'instrument', name: name || (parsed.name ? gmLabel(parsed.name) : base.name), description: description || `${parsed.samples.length} sampled notes (${parsed.samples[0].note}–${parsed.samples[parsed.samples.length - 1].note})` };
  }
  if (kind === 'wam') {
    onStage?.('Reading the plugin descriptor…');
    let d = null;
    try { d = JSON.parse(await fetchText(joinUrl(url, 'descriptor.json'), { cache: false })); } catch { /* optional */ }
    return {
      ...base, experimental: true,
      name: name || d?.name || base.name,
      description: description || d?.description || 'Web Audio Module (experimental — runs live; offline export may be silent).',
      type: type || (d ? (d.isInstrument ? 'instrument' : 'effect') : 'instrument'),
      vendor: d?.vendor,
    };
  }
  throw userError(`Unsupported plugin kind “${kind}”.`);
}

/** Instrument JSON for a detected plugin / catalog-style info {kind, name, url, code, library, instrument}. */
export function pluginInstrument(info) {
  if (info.kind === 'soundfont') {
    if (info.library && info.instrument) return { type: 'soundfont', preset: null, params: { library: info.library, instrument: info.instrument } };
    return { type: 'soundfont', preset: null, params: { url: info.url, name: info.name } };
  }
  if (info.kind === 'faust') return { type: 'faust', preset: null, params: { name: info.name, code: info.code || '', url: info.url || '' } };
  return { type: 'wam', preset: null, params: { name: info.name, url: info.url } };
}

/** Effect params for a detected plugin (Effect { type: info.kind, params }). */
export function pluginEffectParams(info) {
  if (info.kind === 'faust') return { name: info.name, code: info.code || '', url: info.url || '' };
  return { name: info.name, url: info.url };
}

// ----------------------------------------------------------------------------- preview
let current = null;

/** Stop the running preview (if any). */
export function stopPreview() {
  const c = current;
  current = null;
  if (c) c.stop();
}

/**
 * previewPlugin(engine, info{kind, type, ...params}, {onStage}) — plays a short phrase (instruments)
 * or a plucked riff through the effect. Resolves when the sound starts; throws friendly errors.
 */
export async function previewPlugin(engine, info, { onStage } = {}) {
  stopPreview();
  await engine.init();
  const ctx = engine.ctx;
  const dest = engine.graph?.master?.input || ctx.destination;
  const out = ctx.createGain();
  out.gain.value = 0.9;
  out.connect(dest);
  const mod = await ENGINES[info.kind]();
  const token = {};
  let impl;
  let src = null;
  const stop = () => {
    try { impl?.allNotesOff?.(ctx.currentTime); } catch { /* */ }
    try { out.gain.setTargetAtTime(0, ctx.currentTime, 0.05); } catch { /* */ }
    setTimeout(() => { try { impl?.dispose(); } catch { /* */ } try { src?.disconnect(); out.disconnect(); } catch { /* */ } }, 400);
  };
  current = { stop, token };
  onStage?.('Loading…');
  if (info.type === 'effect') {
    src = ctx.createGain();
    impl = new mod.Effect(ctx, src, out);
    impl.setParams(pluginEffectParams(info));
  } else {
    impl = new mod.Engine(ctx, out, { ...pluginInstrument(info).params, gain: 0.8, voices: 8 });
  }
  const ok = await impl.ready;
  if (current?.token !== token) { stop(); return false; }
  if (!ok) { stop(); current = null; throw userError(impl.error || 'The plugin failed to load.'); }
  onStage?.('Playing…');
  const t0 = ctx.currentTime + 0.08;
  if (info.type === 'effect') {
    // a plucked riff through the effect
    const riff = [57, 60, 64, 69, 67, 64, 60, 62];
    riff.forEach((p, i) => {
      const t = t0 + i * 0.22;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sawtooth';
      o.frequency.value = 440 * Math.pow(2, (p - 69) / 12);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.25, t + 0.005);
      g.gain.setTargetAtTime(0, t + 0.01, 0.08);
      o.connect(g); g.connect(src);
      o.start(t); o.stop(t + 0.6);
    });
    setTimeout(() => { if (current?.token === token) stopPreview(); }, 4500);
  } else {
    const phrase = [[60, 0, 0.22], [64, 0.25, 0.22], [67, 0.5, 0.22], [72, 0.75, 0.45]];
    for (const [p, t, d] of phrase) impl.trigger(t0 + t, p, 0.85, d);
    for (const p of [60, 64, 67, 71]) impl.trigger(t0 + 1.3, p, 0.7, 1.2);
    setTimeout(() => { if (current?.token === token) stopPreview(); }, 4200);
  }
  return true;
}

export { friendlyError };
