// Oscillator warp modes (phase distortion of the wavetable read). Pure — shared by the AudioWorklet processor,
// the editor preview and the tests. Every warp maps the oscillator phase x ∈ [0, 1) and an amount a ∈ [0, 1] to
// the phase the table is read at; amount 0 is always the identity.
//   sync      hard sync: the table restarts (1 + 7a) times per cycle
//   bendp     bend +: the cycle's centre is stretched, its ends squeezed (|u|^(1/(1+4a)), u = 2x − 1)
//   bendm     bend −: the opposite (|u|^(1+4a))
//   pwm       squeeze: the whole cycle plays in the first (1 − 0.98a) of the period, then holds its start value
//   mirror    the cycle plays forward to the split point m = 1 − a/2, then backwards
//   quantize  phase resolution reduced from 1024 to 4 steps (stepped, digital)
//   fm        phase modulation by the other oscillator (input s ∈ [−1, 1]): x + 1.5·a·s
//   formant   windowed sync: like sync, but faded by a Hann window over the cycle (formant shift, no click)
export const WARP_MODES = ['none', 'sync', 'bendp', 'bendm', 'pwm', 'mirror', 'quantize', 'fm', 'formant'];
export const WARP_LABELS = {
  none: 'Off', sync: 'Sync', bendp: 'Bend +', bendm: 'Bend −', pwm: 'PWM / squeeze', mirror: 'Mirror', quantize: 'Quantize', fm: 'FM (other osc)', formant: 'Formant',
};
export const WARP_IDS = Object.fromEntries(WARP_MODES.map((m, i) => [m, i]));

const frac = (x) => x - Math.floor(x);

/** Warped read phase. mode: index into WARP_MODES (or its name); fmIn: the other oscillator's output. */
export function warpPhase(mode, x, a, fmIn = 0) {
  const m = typeof mode === 'string' ? WARP_IDS[mode] ?? 0 : mode;
  if (!(a > 0) || m === 0) return x;
  switch (m) {
    case 1: case 8: return frac(x * (1 + 7 * a)); // sync / formant
    case 2: case 3: {
      const u = 2 * x - 1;
      const e = m === 2 ? 1 / (1 + 4 * a) : 1 + 4 * a;
      const v = u < 0 ? -Math.pow(-u, e) : Math.pow(u, e);
      return (v + 1) / 2;
    }
    case 4: { const w = 1 - 0.98 * a; return x < w ? x / w : 0; }
    case 5: { const s = 1 - a / 2; return x < s ? x / s : (1 - x) / (1 - s); }
    case 6: { const steps = Math.max(4, Math.round(Math.pow(2, 10 - 8 * a))); return Math.floor(x * steps) / steps; }
    case 7: return frac(x + 1.5 * a * fmIn);
    default: return x;
  }
}

/** Output gain of the warp at phase x (only 'formant' windows the cycle). */
export function warpGain(mode, x, a) {
  const m = typeof mode === 'string' ? WARP_IDS[mode] ?? 0 : mode;
  if (m !== 8 || !(a > 0)) return 1;
  // Hann window, blended in with the amount so a = 0 stays unwindowed
  const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * x);
  return 1 - Math.min(1, a * 4) * (1 - w);
}

/**
 * How much a warp raises the highest frequency read from the table (mipmap selection: the band limit is chosen
 * for f × this, so warped reads do not alias). Quantize aliases by design (it is a digital effect).
 */
export function warpBandwidth(mode, a) {
  const m = typeof mode === 'string' ? WARP_IDS[mode] ?? 0 : mode;
  if (!(a > 0)) return 1;
  switch (m) {
    case 1: case 8: return 1 + 7 * a;
    case 2: case 3: return 1 + 2 * a;
    case 4: return 1 / (1 - 0.98 * a);
    case 5: return 2;
    case 7: return 1 + 4 * a;
    default: return 1;
  }
}
