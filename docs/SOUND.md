# daWWW — Sound design notes (built-in instruments)

The built-in instruments are plain Web Audio graphs (no AudioWorklets), so the same code runs in
the live `AudioContext` and in `OfflineAudioContext` renders. Where Web Audio cannot do a model
in real time (Karplus-Strong loops below 128 samples, inharmonic pianos, PADsynth), we render the
model once into a cached `AudioBuffer` (`src/audio/dsp/*`) and play it back at
`playbackRate = f / f0` so pitch, glide, bend and vibrato still work.

## What we took from each open-source synth

| Source | What we studied | What we use |
|---|---|---|
| **OB-Xd** ([2DaT/Obxd `ObxdVoice.h`](https://raw.githubusercontent.com/2DaT/Obxd/master/Source/Engine/ObxdVoice.h)) | per-voice `FltDetune`, `EnvDetune`, `levelDetune`, osc detune factors ("slop"), DC-blocking HPF | `analog` param (synth): per-voice static detune (±2.5 ct), per-osc offsets, cutoff variance (±0.15 oct), envelope-time (±8 %) and level (±0.6 dB) variance, free-running osc phases |
| **Surge XT** ([`OscillatorDriftUnisonCharacter.h`](https://raw.githubusercontent.com/surge-synthesizer/sst-basic-blocks/main/include/sst/basic-blocks/dsp/OscillatorDriftUnisonCharacter.h), `ClassicOscillator.cpp`) | `DriftLFO` = heavily low-passed noise; unison detune bias/offset, `1/sqrt(n)` attenuation, alternating pan law | slow per-voice drift (random-rate triangle, ±3 ct × analog); unison gain `1/sqrt(n)`, neighbours panned to opposite sides |
| **Vital** ([`synth_oscillator.cpp`](https://raw.githubusercontent.com/mtytel/vital/main/src/synthesis/producers/synth_oscillator.cpp)) | random start phase per unison voice, symmetric sharp/flat pairs, power-normalised centre/detuned blend | phase-rotated band-limited PeriodicWaves (8 cached phases) for every stacked oscillator; supersaw centre/side gains power-normalised |
| **JP-8000 supersaw** (Adam Szabo, *How to Emulate the Super Saw*, 2010) | 7 saw offsets, 11th-order detune curve, centre/side mix curves, pitch-tracked HPF | `supersaw` wave: exact offsets + `superDetuneCurve()`, `superMix` param + `superMixCurve()`, 12 dB HPF at the fundamental driven by the voice frequency |
| **Dexed / MSFA** ([`env.cc`](https://raw.githubusercontent.com/google/music-synthesizer-for-android/master/app/src/main/jni/env.cc), [DX7 ROM1A](https://raw.githubusercontent.com/mmontag/dx7-synth-js/master/roms/ROM1A.SYX)) | log-domain EG: 0.75 dB per level step, rate → `(4+(q&3))·2^(q>>2)` speed, rate scaling, ±4π max modulation index, velocity curve | FM engine: `MAX_INDEX = 4π`, DX-style velocity curve, dB-linear decay to a break level (`opNBreak`) + second decay (`opNDecay2`); `dx()` in `presets.js` converts DX7 operator data (R1-4, L1-4, OL, KVS, RS) → our params. E.PIANO 1, TUB BELLS, BASS 1, BRASS 1 rebuilt from the ROM; modulators that are themselves modulated get a DC-blocker (FM ≠ PM: otherwise stacks drift out of tune) |
| **ZynAddSubFX PADsynth** ([`PADnoteParameters.cpp`](https://raw.githubusercontent.com/zynaddsubfx/zynaddsubfx/master/src/Params/PADnoteParameters.cpp)) | Gaussian bandwidth per harmonic growing with frequency, random phases, one IFFT → perfectly looping table | `dsp/padsynth.js`: 2^18-sample tables per zone (`pad`, `ensemble` = string body formants, `choir` = "aah" formants F1 760 / F2 1150 / F3 2600 Hz); fundamental snapped to an FFT bin so the loop and the pitch are exact; two decorrelated read positions = stereo |
| **Faust libraries** ([`physmodels.lib`](https://raw.githubusercontent.com/grame-cncm/faustlibraries/master/physmodels.lib), [`vaeffects.lib`](https://raw.githubusercontent.com/grame-cncm/faustlibraries/master/vaeffects.lib)) | `bridgeFilter` (3-tap loss filter, brightness/absorption), `ks`, `moog_vcf` | `dsp/pluck.js`: extended Karplus-Strong (noise burst, pick-position comb, hardness low-pass, Faust loss filter, allpass fractional tuning solved for exact phase delay, T60-based loss, guitar body EQ); ladder-like 24 dB filter (soft first stage + resonant stage) |
| **Helm / Odin2 / TAL-NoiseMaker** ([helm_oscillators.cpp](https://raw.githubusercontent.com/mtytel/helm/master/src/synthesis/helm_oscillators.cpp), [Odin2 LadderFilter](https://raw.githubusercontent.com/TheWaveWarden/odin2/master/Source/audio/Filters/LadderFilter.cpp)) | resonance taming, pre-filter drive, PWM | `filterQ()` power curve topping out at +21 dB; `filterDrive` per-voice soft saturator; band-limited PWM = `saw(t) − saw(t − wT)` with the LFO sweeping the delay (`pwm` LFO target) |
| Hammond / Leslie folklore | ~3 dB per drawbar step, tonewheel foldback above ~5.9 kHz, single-trigger percussion | organ engine |
| Guitar amp modelling (common cab-sim practice) | tight HPF + mid hump → asymmetric gain stage → 4x12 cab (HPF 80 Hz, low bump, presence peak, steep roll-off ≈ 5 kHz) | `driveType: 'amp'` in every instrument's output stage (`'tube'` = asymmetric soft clip) |

## Engine map

* `synth.js` — envelopes: convex (RC-like) attack ≥ 12 ms, exponential decay/release;
  `velCurve()` (exponent 1.5); new waves `sync`, `pad`, `ensemble`, `choir`, `pluck`, `piano`;
  new params `analog`, `filterDrive`, `superMix`, `modelTone`, `modelDecay`, `padWidth`,
  LFO target `pwm`; output stage `driveType` and `lowCut` (all instrument types).
* `dsp/piano.js` — modal piano: stiff-string partials `f_n = n f0 √(1+Bn²)/√(1+B)` (partial 1 exactly
  on pitch), 3 strings per note (prompt + detuned aftersound → beating, two-stage decay),
  frequency-dependent damping, strike-point comb, velocity-dependent felt low-pass (3 layers),
  soundboard knock. One table per 3 semitones. `grand-piano` now uses it (type `synth`).
* `fm.js` — see Dexed row. `dx()` lives in `presets.js`.
* `organ.js` — dB drawbars, foldback, single-trigger percussion (key click, scanner vibrato and
  rotary unchanged).
* `drums.js` / `kits.js` — `PAD_TRIM_DB`: every pad of every kit is trimmed to the same balance
  (kick ≈ -12 LUFS momentary at vel 0.8 before `KIT_LEVEL_DB`, snare/clap 1.5-3 dB under it,
  toms -15, hats -20/-22, percussion -17..-23); all 20 kits now play a standard groove at
  -14.5..-15.3 LUFS (was -7.4..-18.6).
* Presets — tuning stated explicitly (`osc2Fine` defaults to 0 inside presets; detunes symmetric),
  `MIX` table (low cut on everything that is not bass, tamed top on supersaws), `LEVEL_DB` table
  (loudness normalisation, generated by the QA harness).

## Loudness normalisation

Measured on a standard phrase (C2, C3, C4, C5, C6 held 1 s at vel 0.8, a 4-note chord, a
6-note chord at vel 1) rendered through `createInstrument` in an `OfflineAudioContext`
(48 kHz): metric = mean of BS.1770 gated integrated loudness and max momentary (400 ms)
loudness. Targets: -14 (leads, keys, plucks, guitars, orchestral), -15.5 pads, -11 basses
(low register reads quiet on K-weighting), -18 FX. The gain is capped so a 6-note fortissimo
chord peaks ≤ 1.25 pre-fader (a few percussive keys/plucks are therefore 2-6 dB under target).

## QA harness

Lives outside the repo (scratch). It renders every preset/kit, estimates the fundamental of each
sustained note (harmonic-sum DTFT search + power-weighted centroid, octave-aware), loudness, peaks,
NaN, release clicks (2nd-difference spikes in the release window vs. the sustained part), voice
cleanup, and renders generated songs for band-energy balance. The checks that don't need a
browser are in `tests/sound-dsp.test.js`.
