// Effect builders for plugin effects ('faust', 'wam'), used by effects.js BUILDERS.
// builder(ctx, sh) wires sh.fxIn -> [plugin node, lazily created] -> sh.wet; audio passes through
// unchanged until the plugin is ready (or when it fails). `ready` resolves true/false (never rejects).
const LOADERS = {
  faust: () => import('../plugins/faust.js'),
  wam: () => import('../plugins/wam.js'),
  native: () => import('../plugins/native.js'),
};

export const PLUGIN_EFFECT_TYPES = Object.keys(LOADERS);

export function pluginEffectBuilder(type) {
  return (ctx, sh) => {
    const inNode = ctx.createGain();
    const outNode = ctx.createGain();
    sh.fxIn.connect(inNode);
    outNode.connect(sh.wet);
    let impl = null;
    let pending = null;
    let disposed = false;
    let loadError = null;
    const loaded = LOADERS[type]().then((m) => {
      if (disposed) return null;
      impl = new m.Effect(ctx, inNode, outNode);
      if (pending) impl.setParams(pending);
      return impl;
    }, (e) => { loadError = `Could not load the ${type} plugin host: ${e?.message || e}`; inNode.connect(outNode); return null; });
    return {
      apply(p, _immediate, def) {
        const params = { ...(def?.params || {}), ...p };
        pending = params;
        impl?.setParams(params);
      },
      get ready() { return loaded.then((i) => (i ? i.ready : false)); },
      /** Take the plugin out of the signal path for good (its `fallback` effect takes over). */
      detach() { try { sh.fxIn.disconnect(inNode); } catch { /* */ } try { outNode.disconnect(); } catch { /* */ } },
      get error() { return loadError || impl?.error || null; },
      get plugin() { return impl; },
      /** Latency the plugin reports (seconds; WAM getCompensationDelay, Faust metadata), 0 until loaded. */
      get latency() { return Number(impl?.latency) || 0; },
      dispose() {
        disposed = true;
        try { impl?.dispose(); } catch { /* */ }
        for (const n of [inNode, outNode]) { try { n.disconnect(); } catch { /* */ } }
      },
    };
  };
}
