// Custom UI for analysis effects, keyed by effect type. Each entry is (el, api) => ({ update?(fx), dispose?() }).
// el is the effect card body (generic param knobs are already in it); api = { fx, tgt, engine, app, probe(), edit }.
// Animation loops must stop by themselves once el.isConnected is false (cards are rebuilt without a dispose call).
export default {};
