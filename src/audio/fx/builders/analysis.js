// Analysis effect builders. Receives the shared DSP helpers from effects.js and returns { type: builder }
// entries merged into BUILDERS. A builder is (ctx, sh, env) => { apply(p, immediate), setTempo?(bpm),
// sync?(time), dispose?(), getReduction?(), probe? } — see the comment above BUILDERS in effects.js.
// probe: optional live data for the effect's custom UI (read through engine.getFxProbe(fxId)).
//
// Every analyzer is a straight wire (fxIn -> wet: no processing, no latency) plus a stereo tap: a splitter into two
// AnalyserNodes the UI reads (src/ui/scopes, probe API in src/audio/scope-tap.js). The spectrum analyzer also has a
// stereo key input — the mixer feeds the 'Compare' track there exactly like a sidechain key (core/patch.js KEYED_FX),
// PDC-aligned with this channel. AnalyserNodes are passive (no timers, no worklet): offline renders are unaffected.
import { stereoTap, makeProbe } from '../../scope-tap.js';

function analyzer(H, initialSize, { keyed = false } = {}) {
  return (ctx, sh) => {
    sh.fxIn.connect(sh.wet); // pass-through: no processing, zero latency
    const main = stereoTap(ctx, sh.fxIn, initialSize);
    let keyIn = null, key = null, cur = null;
    if (keyed) {
      keyIn = H.stereoGain(ctx);
      key = stereoTap(ctx, keyIn, initialSize);
    }
    const probe = makeProbe(ctx, main, key, () => !!cur?.sourceTrackId);
    return {
      ...(keyIn ? { keyInput: keyIn } : {}),
      probe,
      apply(p) { cur = p; },
      dispose() {
        main.dispose();
        key?.dispose();
        try { keyIn?.disconnect(); } catch { /* */ }
      },
    };
  };
}

export default function analysisBuilders(H) {
  return {
    oscilloscope: analyzer(H, 8192),
    vectorscope: analyzer(H, 2048),
    spectrum: analyzer(H, 8192, { keyed: true }),
    spectrogram: analyzer(H, 4096),
    tuner: analyzer(H, 8192),
  };
}
