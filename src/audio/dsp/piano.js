// Additive acoustic-piano tone generator (modal synthesis, rendered offline into cached tables).
// Physical cues that make a piano read as a piano (Fletcher & Rossing; Bank & Sujbert):
//  * inharmonic stiff-string partials  f_n = n f0 sqrt(1 + B n^2)   (B rises towards the treble)
//  * three slightly detuned strings per note -> beating and a two-stage decay
//    (fast "prompt sound" + slow "aftersound"), high partials die much faster than low ones
//  * hammer spectrum: strike-point comb (~1/8 of the string), felt low-pass that opens with velocity
//  * a short soundboard knock / hammer thump at the attack
// Each partial is a damped 2-pole resonator (2 mul + 1 add per sample), so a whole note costs a few ms.
import { rng32 } from './fft.js';
import { cachedBuffer, makeBuffer } from './bufcache.js';

export const PIANO_ZONE = 3; // one table every 3 semitones, pitch-shifted ±1.5 st

/** Inharmonicity coefficient vs MIDI note (≈1e-4 in the bass, ≈1e-2 at the top). */
function inharm(m) { return Math.min(0.02, Math.max(6e-5, 1.1e-4 * Math.pow(2, ((m - 48) / 12) * 1.75))); }

/**
 * Cached piano table for a zone note: { buffer, f0 }.
 * layer 0..2 (pp / mf / ff hammer), tone -1..1 (hammer felt hardness), decay 0.25..4 (T60 scale).
 */
export function pianoTable(sampleRate, zoneMidi, layer = 1, tone = 0, decay = 1, ctx) {
  const m = zoneMidi;
  const tn = Math.round(Math.max(-1, Math.min(1, tone)) * 4) / 4;
  const dc = Math.round(Math.max(0.25, Math.min(4, decay)) * 8) / 8;
  const f0 = 440 * Math.pow(2, (m - 69) / 12);
  const key = `piano:${sampleRate}:${m}:${layer}:${tn}:${dc}`;
  const buffer = cachedBuffer(key, () => {
    const sr = sampleRate, nyq = sr / 2;
    const B = inharm(m);
    const hard = Math.max(0, Math.min(1, 0.3 + 0.32 * layer + 0.2 * tn)); // hammer hardness 0..1
    // aftersound T60 of the fundamental: ~40 s at A0 down to ~1 s at C8
    const t60a = Math.min(30, Math.max(0.7, 36 * Math.pow(2, -(m - 21) / 15))) * dc;
    const t60p = t60a / 5; // prompt sound
    const len = Math.ceil(sr * Math.min(9, Math.max(1.2, t60a * 0.75)));
    const out = new Float32Array(len);
    const rnd = rng32(m * 977 + layer * 13 + 11);
    // felt low-pass cutoff (Hz) and spectral slope rise with velocity
    const fcHammer = f0 * (3 + 22 * hard * hard) + 600 * hard;
    const slope = 1.6 - 0.9 * hard;
    const strike = 0.12 + 0.01 * rnd(); // ~1/8 of the speaking length
    const maxN = Math.min(90, Math.floor((nyq * 0.9) / f0));
    for (let n = 1; n <= maxN; n++) {
      const fn = (n * f0 * Math.sqrt(1 + B * n * n)) / Math.sqrt(1 + B); // partial 1 stays exactly at f0
      if (fn > nyq * 0.92) break;
      let a = Math.pow(n, -slope) / (1 + Math.pow(fn / fcHammer, 2));
      a *= 0.25 + 0.75 * Math.abs(Math.sin(Math.PI * n * strike));
      if (n === 1 && m < 40) a *= 0.6; // weak bass fundamentals (small soundboard radiation)
      if (a < 2e-4) continue;
      // frequency-dependent damping: high partials decay faster
      const damp = 1 + Math.pow(fn / 1800, 2) * 2.2 + n * 0.02;
      const alphaA = 6.91 / (t60a / damp), alphaP = 6.91 / (t60p / damp);
      // three strings: one "prompt" component (strings in phase) + a detuned "aftersound" pair
      const det = (0.4 + rnd() * 1.1) * 0.000578 * fn; // 0.4..1.5 cents in Hz
      const comps = [
        [fn, a * 0.72, alphaP],
        [fn + det, a * 0.16, alphaA],
        [fn - det * 0.7, a * 0.12, alphaA * 1.05],
      ];
      for (const [f, amp, alpha] of comps) {
        const r = Math.exp(-alpha / sr);
        const w = (2 * Math.PI * f) / sr;
        const c2 = 2 * r * Math.cos(w), r2 = r * r;
        const ph = rnd() * 2 * Math.PI;
        let y1 = amp * Math.sin(ph - w) * r, y2 = amp * Math.sin(ph - 2 * w) * r2;
        // render until it is below ~-100 dB absolute
        const nEnd = Math.min(len, Math.ceil((Math.log(Math.max(1e-9, amp) / 1e-5) / alpha) * sr));
        for (let i = 0; i < nEnd; i++) {
          const y = c2 * y1 - r2 * y2;
          out[i] += y;
          y2 = y1; y1 = y;
        }
      }
    }
    // hammer thump / soundboard knock: decaying low-passed noise + a damped ~110 Hz board mode
    const thumpLen = Math.round(0.06 * sr);
    let lp = 0, lp2 = 0;
    const thumpLvl = 0.05 + 0.12 * hard;
    const kA = Math.exp(-1 / (0.012 * sr));
    let env = 1;
    for (let i = 0; i < thumpLen; i++) {
      lp += 0.08 * ((rnd() * 2 - 1) - lp);
      lp2 += 0.25 * (lp - lp2);
      out[i] += thumpLvl * env * lp2 * 2 + thumpLvl * 0.5 * env * Math.sin((2 * Math.PI * 110 * i) / sr);
      env *= kA;
    }
    // 1.5 ms attack smoothing (hammer contact time), normalise, fade the tail
    const att = Math.round(0.0015 * sr);
    for (let i = 0; i < att; i++) out[i] *= i / att;
    let s2 = 0; const nn = Math.min(len, Math.round(0.4 * sr));
    for (let i = 0; i < nn; i++) s2 += out[i] * out[i];
    const g = 0.5 / Math.sqrt(s2 / nn || 1);
    const fade = Math.round(0.25 * sr);
    for (let i = 0; i < len; i++) out[i] *= g * (i > len - fade ? (len - i) / fade : 1);
    return makeBuffer([out], sr, ctx);
  });
  return { buffer, f0 };
}
