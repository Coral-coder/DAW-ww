// Stereo analysis taps (browser or offline context): node -> splitter -> two AnalyserNodes, wrapped in the "probe"
// the analyzer views read (src/ui/scopes). Used by the analysis effects (src/audio/fx/builders/analysis.js) and by
// the Scopes panel, which taps a channel strip directly without inserting an effect.
//
//   probe = { sampleRate, size, time, hasKey, ensure(n), read(l, r, which = 'main' | 'key') }
//   read() fills Float32Arrays of exactly `size` samples with the newest audio (AnalyserNode drops the NEWEST
//   samples into a shorter array, so other lengths are refused).

export const MAX_TAP = 32768;
const pow2 = (n) => { let p = 32; while (p < n && p < MAX_TAP) p <<= 1; return p; };

function stereoIn(ctx) {
  const g = ctx.createGain();
  g.channelCount = 2; g.channelCountMode = 'explicit'; g.channelInterpretation = 'speakers';
  return g;
}

/** src -> (stereo up-mix) -> splitter -> AnalyserNode L / R. */
export function stereoTap(ctx, src, size = 2048) {
  const st = stereoIn(ctx);
  const split = ctx.createChannelSplitter(2);
  const mk = () => { const a = ctx.createAnalyser(); a.fftSize = pow2(size); a.smoothingTimeConstant = 0; return a; };
  const L = mk(), R = mk();
  if (src) src.connect(st);
  st.connect(split);
  split.connect(L, 0); split.connect(R, 1);
  return {
    input: st, L, R,
    dispose() {
      if (src) { try { src.disconnect(st); } catch { /* */ } }
      for (const n of [st, split, L, R]) { try { n.disconnect(); } catch { /* */ } }
    },
  };
}

/** The probe over a main tap (and optionally a key tap). getHasKey() says whether the key carries a signal. */
export function makeProbe(ctx, main, key = null, getHasKey = () => false) {
  let size = main.L.fftSize;
  const taps = key ? [main, key] : [main];
  return {
    get sampleRate() { return ctx.sampleRate; },
    get size() { return size; },
    get time() { return ctx.currentTime; },
    get hasKey() { return !!key && !!getHasKey(); },
    ensure(n) {
      const s = pow2(n);
      if (s > size) { size = s; for (const t of taps) { t.L.fftSize = s; t.R.fftSize = s; } }
      return size;
    },
    read(l, r, which = 'main') {
      const t = which === 'key' ? key : main;
      if (!t || l.length !== size || (r && r.length !== size)) return false;
      t.L.getFloatTimeDomainData(l);
      if (r) t.R.getFloatTimeDomainData(r);
      return true;
    },
  };
}

/** A stand-alone tap on any node (Scopes panel): { probe, node, dispose() }. */
export function createNodeTap(ctx, node, size = 4096) {
  const tap = stereoTap(ctx, node, size);
  return { node, probe: makeProbe(ctx, tap), dispose: () => tap.dispose() };
}
