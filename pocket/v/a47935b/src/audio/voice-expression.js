// Per-voice MPE expression for the built-in engines (FM, organ, sampler, strudel lanes — the analog synth has its
// own filter-based version in synth.js). A voice gets a tiny expression stage on its output (one GainNode); the
// first timbre / pressure message lazily inserts a low-pass after it (open at the neutral timbre, so inserting it
// is inaudible). Bend goes to the voice's oscillator / buffer-source detune params through one lazily created
// ConstantSource. Pure mapping functions are Node-testable.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Pressure (0..1) -> per-voice gain multiplier: 1 at no pressure, up to ≈ +3.5 dB at full pressure. */
export const pressureGain = (pressure) => 1 + 0.5 * clamp(Number(pressure) || 0, 0, 1);

/**
 * Timbre (CC74, 0..1, 0.5 = neutral) + pressure -> low-pass cutoff (Hz) for engines without their own filter.
 * Neutral or brighter = fully open (20 kHz); darker closes up to 7 octaves; pressure re-opens up to one octave.
 */
export function timbreCutoff(timbre = 0.5, pressure = 0) {
  const tb = Number.isFinite(timbre) ? clamp(timbre, 0, 1) : 0.5;
  const oct = (tb >= 0.5 ? 0 : (tb - 0.5) * 14) + clamp(Number(pressure) || 0, 0, 1);
  return clamp(20000 * Math.pow(2, Math.min(0, oct)), 40, 20000);
}

/** Cents of filter detune for engines WITH a filter (same law as the analog synth). */
export const timbreCents = (timbre, pressure) => (Number.isFinite(timbre) ? (timbre - 0.5) * 2400 : 0) + (Number.isFinite(pressure) ? pressure * 1200 : 0);

/**
 * Put an expression stage between `node` and `dest` for voice `v` (nodes registered with v.node for cleanup).
 * Returns the stage; the voice keeps it as v.xs.
 */
export function exprStage(ctx, v, node, dest) {
  const g = v.node(ctx.createGain());
  g.gain.value = 1;
  node.connect(g);
  g.connect(dest);
  return { ctx, v, gain: g, dest, filter: null, timbre: 0.5, pressure: 0 };
}

/** Apply { pressure, timbre } to a stage at time t (ownFilters: BiquadFilterNodes of the voice to detune instead). */
export function applyStage(xs, x, t, ownFilters = null) {
  if (!xs) return;
  if (Number.isFinite(x.pressure)) xs.pressure = clamp(x.pressure, 0, 1);
  if (Number.isFinite(x.timbre)) xs.timbre = clamp(x.timbre, 0, 1);
  if (Number.isFinite(x.pressure)) xs.gain.gain.setTargetAtTime(pressureGain(xs.pressure), t, 0.015);
  if (!Number.isFinite(x.timbre) && !Number.isFinite(x.pressure)) return;
  if (ownFilters?.length) {
    const c = timbreCents(xs.timbre, xs.pressure);
    for (const f of ownFilters) f.detune.setTargetAtTime(c, t, 0.02);
    return;
  }
  const hz = timbreCutoff(xs.timbre, xs.pressure);
  if (!xs.filter) {
    if (hz >= 19999) return; // still neutral: nothing to insert
    const f = xs.v.node(xs.ctx.createBiquadFilter());
    f.type = 'lowpass';
    f.Q.value = 0.5;
    f.frequency.value = 20000;
    // re-route gain -> filter -> dest (the filter starts fully open, so the swap is inaudible)
    f.connect(xs.dest);
    xs.gain.connect(f);
    try { xs.gain.disconnect(xs.dest); } catch { /* */ }
    xs.filter = f;
  }
  xs.filter.frequency.setTargetAtTime(Math.min(hz, xs.ctx.sampleRate / 2 - 100), t, 0.02);
}

/** Per-voice bend (semitones) on the voice's detune params (v.detuneTargets: AudioParams in cents). */
export function applyBend(ctx, v, bend, t) {
  if (!Number.isFinite(bend) || !v.detuneTargets?.length) return false;
  if (!v.mpeBend) {
    const s = v.node(ctx.createConstantSource());
    s.offset.value = 0;
    s.start(t);
    (v.lazy || (v.lazy = [])).push(s);
    for (const d of v.detuneTargets) s.connect(Array.isArray(d) ? d[0] : d);
    v.mpeBend = s;
  }
  v.mpeBend.offset.setTargetAtTime(clamp(bend, -96, 96) * 100, t, 0.006);
  return true;
}
