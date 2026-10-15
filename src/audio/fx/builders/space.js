// Space effect builders. Receives the shared DSP helpers from effects.js and returns { type: builder }
// entries merged into BUILDERS. A builder is (ctx, sh, env) => { apply(p, immediate), setTempo?(bpm),
// sync?(time), dispose?(), getReduction?(), probe? } — see the comment above BUILDERS in effects.js.
// probe: optional live data for the effect's custom UI (read through engine.getFxProbe(fxId)).
// eslint-disable-next-line no-unused-vars
export default function spaceBuilders(H) {
  return {};
}
