// Extended Karplus-Strong plucked string (Jaffe & Smith 1983; loop filter from the Faust
// physmodels.lib `bridgeFilter`): noise-burst excitation shaped by pick position and pluck
// hardness, a 3-tap linear-phase loss filter (exactly 1 sample of delay), a first-order allpass
// for exact fractional tuning and a per-period loss factor from the wanted T60. Rendered once per
// (pitch, velocity layer, tone, decay) into a cached AudioBuffer — a DelayNode feedback loop can't
// go below 128 samples in Web Audio, so high notes would otherwise be impossible.
import { rng32 } from './fft.js';
import { cachedBuffer, makeBuffer } from './bufcache.js';

/** Phase delay of a 1st-order allpass (C + z^-1)/(1 + C z^-1) at w (rad/sample). */
function apDelay(C, w) {
  const num = Math.atan2(-Math.sin(w), C + Math.cos(w));
  const den = Math.atan2(-C * Math.sin(w), 1 + C * Math.cos(w));
  return -(num - den) / w;
}
function solveAllpass(d, w) {
  // find C so that the phase delay at w equals d (0.1 .. 1.1 samples)
  let lo = -0.999, hi = 0.999;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (apDelay(mid, w) > d) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function biquadInPlace(x, type, f, q, gainDb, sr) {
  const w = (2 * Math.PI * f) / sr, cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'peak') {
    const A = Math.pow(10, gainDb / 40);
    b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A;
  } else if (type === 'hp') {
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al;
  } else { // lp
    b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al;
  }
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; x[i] = v;
  }
}

/** String models: pick position, loop brightness, T60 at 110 Hz and its pitch slope, body EQ. */
export const PLUCK_MODELS = {
  guitar: { pick: 0.14, bright: 0.55, t60: 5.5, slope: 0.55, body: [['hp', 70, 0.7], ['peak', 110, 2.5, 5], ['peak', 220, 2, 3], ['peak', 2800, 1, 2]] },
};

/**
 * Cached plucked-string table for an integer MIDI pitch: { buffer, f0 }.
 * layer 0..2 = soft/medium/hard pluck; tone -1..1 brightness; decay 0.25..4 T60 multiplier.
 */
export function pluckTable(sampleRate, midi, layer = 1, tone = 0, decay = 1, ctx, modelId = 'guitar') {
  const M = PLUCK_MODELS[modelId] || PLUCK_MODELS.guitar;
  const m = Math.round(midi);
  const tn = Math.round(Math.max(-1, Math.min(1, tone)) * 4) / 4;
  const dc = Math.round(Math.max(0.25, Math.min(4, decay)) * 8) / 8;
  const f0 = 440 * Math.pow(2, (m - 69) / 12);
  const key = `ks:${sampleRate}:${modelId}:${m}:${layer}:${tn}:${dc}`;
  const buffer = cachedBuffer(key, () => {
    const sr = sampleRate;
    const P = sr / f0; // total loop delay in samples
    // loop brightness (Faust bridgeFilter): B in 0..1, harder plucks / brighter tone open it up
    const B = Math.max(0.05, Math.min(0.98, M.bright + 0.12 * (layer - 1) + 0.25 * tn - Math.max(0, (m - 84) / 60)));
    const h0 = (1 + B) / 2, h1 = (1 - B) / 4;
    const t60 = Math.max(0.25, M.t60 * dc * Math.pow(110 / f0, M.slope));
    const rho = Math.pow(0.001, 1 / (f0 * t60));
    // integer + fractional delay: FIR contributes exactly 1 sample, allpass d in [0.3, 1.3)
    let Nint = Math.floor(P - 1 - 0.3);
    let frac = P - 1 - Nint;
    if (Nint < 2) { Nint = 2; frac = Math.max(0.05, P - 3); }
    const C = solveAllpass(frac, (2 * Math.PI * f0) / sr);
    const len = Math.min(Math.ceil(sr * Math.min(8, t60 * 1.15 + 0.3)), sr * 8);
    const out = new Float32Array(len);
    // excitation: one period of noise, lowpassed by pluck hardness, pick-position comb
    const rnd = rng32(m * 131 + layer * 7 + 3);
    const L = Math.max(4, Math.round(P));
    const ex = new Float32Array(L);
    const lpA = Math.max(0.05, Math.min(0.95, 0.25 + 0.3 * layer + 0.15 * tn)); // one-pole coefficient (higher = brighter)
    let lp = 0;
    for (let i = 0; i < L; i++) { lp += lpA * ((rnd() * 2 - 1) - lp); ex[i] = lp; }
    let mean = 0; for (let i = 0; i < L; i++) mean += ex[i]; mean /= L;
    for (let i = 0; i < L; i++) ex[i] -= mean;
    const pk = Math.max(1, Math.round(M.pick * L));
    const exc = new Float32Array(L);
    for (let i = 0; i < L; i++) exc[i] = ex[i] - (i >= pk ? ex[i - pk] : 0);
    // the loop
    const dl = new Float32Array(Nint + 4);
    let w = 0; // write index into circular delay
    let f1 = 0, f2 = 0; // FIR state
    let apx = 0, apy = 0; // allpass state
    for (let n = 0; n < len; n++) {
      const rd = dl[w]; // delayed by Nint samples
      // loss filter (symmetric 3-tap) + allpass tuning
      const y = rho * (h1 * rd + h0 * f1 + h1 * f2);
      f2 = f1; f1 = rd;
      const a = C * y + apx - C * apy;
      apx = y; apy = a;
      const v = a + (n < L ? exc[n] : 0);
      dl[w] = v;
      w = (w + 1) % Nint;
      out[n] = v;
    }
    for (const b of M.body) biquadInPlace(out, b[0], b[1], b[2], b[3] || 0, sr);
    // normalise loudness of the first 0.25 s; fade the tail
    let s2 = 0; const nn = Math.min(len, Math.round(0.25 * sr));
    for (let i = 0; i < nn; i++) s2 += out[i] * out[i];
    const g = 0.6 / Math.sqrt(s2 / nn || 1);
    const fade = Math.round(0.05 * sr);
    for (let i = 0; i < len; i++) out[i] *= g * (i > len - fade ? (len - i) / fade : 1);
    return makeBuffer([out], sr, ctx);
  });
  return { buffer, f0 };
}
