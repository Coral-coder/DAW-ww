# Roadmap after 1.0

Gaps found by comparing daW³ with Ardour, LMMS, Zrythm, Waveform, Cakewalk/Sonar, Reaper's stock plugins,
Audacity, Sonic Visualiser, Surge XT, Vital and the free Kilohearts / Melda / Voxengo / Youlean / x42 tools.

New effect families plug in through `src/audio/fx/defs/*`, `src/audio/fx/builders/*` and `src/ui/fx-ui/*`
(one module per family, merged into `EFFECT_DEFS`, `BUILDERS` and the effect card). Builders can expose live
data as `probe`, read by the UI through `engine.getFxProbe(fxId)`.

## Phase 0 — Plugin loading
- Faust plugins: load reliably in the web app and the desktop app, with clear errors.
- Native plugins (desktop): Intel-only plugins on Apple Silicon (Rosetta host), real load errors (quarantine,
  architecture, signature), failed plugins listed with the reason, automatic incremental rescan, async AUv3
  instantiation, a plugin manager (favorites, hide, blocklist), CI that scans and loads a real plugin.

## Phase 1 — Analysis
- Insertable analyzers for any track or bus: oscilloscope (cycle-locked, pitch readout), vectorscope /
  goniometer with correlation and balance, spectrum analyzer (FFT size, slope, averaging, peak hold, compare
  overlay), spectrogram and 3D waterfall, chromatic tuner.
- Metering: per-track loudness, loudness histogram, PLR / PSR, VU / PPM / K-system meter modes, bit meter,
  DC offset, clip counter, an analysis report after export, a live response curve on the 8-band EQ.

## Phase 2 — Rhythm effects
- Trance gate (step sequenced), volume shaper / LFO tool (drawable curve), beat repeat / stutter, tape stop,
  reverse and half-speed.

## Phase 3 — More effects
- Dynamics and EQ: multiband compressor, transient shaper, de-esser, expander, dynamic EQ, linear-phase EQ,
  match EQ.
- Space, pitch and character: algorithmic and shimmer reverb, tape / multitap / granular delay, pitch shifter /
  harmonizer, vocoder, formant shifter, frequency shifter, ring modulator, comb / resonator, envelope-follower
  filter, more distortion shapes, mid/side tool, Haas widener.

## Phase 4 — Wavetable synth and modulation
- Wavetable oscillator with morphing, WAV / Serum table import, warp modes, unison and factory tables.
- Mod matrix, macros, drawable LFOs / multi-segment envelopes, modulators on any parameter.

## Phase 5 — Presets
- 10–20 factory presets per effect, more synth presets, a preset browser with tags, favorites and search,
  user effect presets, bank import / export, FX chains, track templates, A/B compare with morphing, randomize.

## Phase 6 — Workflow
- Chord track and chord pads, clip effects, action macros, spectral editing.

## Later
- **SuperCollider**: send tracks to SuperDirt over OSC (desktop), one-click SuperCollider input with latency
  compensation, scsynth as an instrument (desktop), scsynth in the browser if a WebAssembly build is mature.
