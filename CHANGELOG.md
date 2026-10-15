# Changelog

All notable changes to daW³. Versions follow [semantic versioning](https://semver.org); the web app, Pocket and
the desktop apps share one version.

## [Unreleased]

### Added
- **Metering**: the Loudness panel meters the master or any track / bus and adds PLR, PSR, DR, a short-term
  histogram, pass / adjust against 14 streaming / broadcast / club targets, pause, and master bit / DC / clip meters.
  Mixer meters switch (globally or per strip) between digital peak, RMS, VU, BBC / EBU / DIN / Nordic PPM and
  K-20 / 14 / 12, with optional LUFS under every strip. Exports show an analysis report (PLR, PSR, DR, clips, DC,
  loudness over time, spectrum), savable as .txt / .json. EQ Three and Parametric EQ cards get a draggable response
  curve over a live spectrum.
- **Rhythm effects**, locked sample-accurately to the song grid (seeks, loops, tempo maps, exports): **Trance Gate**
  (1–32 drawable steps, attack / release / shape, swing, stereo offset or separate right pattern, 31 patterns),
  **Volume Shaper** (drawable LFO-tool curve over 1/8 note to 4 bars, pumps / gates / swells, optional filter sweep),
  **Beat Repeat** (grid stutter with chance, decay, pitch-down per repeat and a hold-to-stutter button) and
  **Time Shaper** (tape stop / start, synced reverse, half speed — every N bars or on a trigger button).
- **Native plugin manager** (desktop, Plugins › Native): search, sort by vendor / format, favorites, hide, a
  blocklist (never scanned or loaded), per-plugin scan log, and every plugin that failed as a greyed card with the
  reason (crashed, timed out, quarantined by macOS with the fix, Intel-only, the loader's own error) and Retry.
  New and updated plugins are picked up by a quick cached rescan at start-up and when the dialog opens.
- **Intel-only VST3 / CLAP plugins on Apple silicon** run in a second, Rosetta-translated plugin host; Intel-only
  Audio Units and app-extension (AUv3) Audio Units load out of process instead of failing.
- **Wavetable Synth**: 2 morphing, band-limited (mipmapped) wavetable oscillators in an AudioWorklet with 8 warp modes,
  16-voice unison, sub + noise, LP/BP/HP/notch/comb filter, 3 envelopes, 4 LFOs and a mod matrix; 56 generated
  factory tables, WAV / Serum import and resynthesis of samples (stored compactly in the project), a 2D / 3D table
  editor with frame drawing and harmonic sliders, and 63 presets.
- **Modulation** for every track: 8 automatable, MIDI-learnable macros, LFO / MSEG, envelope, step, random and
  envelope-follower modulators, a mod matrix and drag-to-modulate onto any knob (rings show range and live value);
  works on instruments, effects and mixer params, live and in exports.
- **Prebake** (as in strudel.cc Settings → prebake): Strudel helper libraries evaluated before your code — add one by
  URL (cached for offline use), paste or upload it; enable, reorder, reload; see the functions it defines and any
  failing statement (line, message). It runs once per change in every code path (Code tab, Song, split import,
  render, Setlist, Pocket), its functions show in autocomplete and the building blocks, and a project keeps a
  reference to the prebakes its code uses. Code calling undefined functions offers the saved prebake that defines
  them. Split import maps what the helpers produce (filter envelopes, delay sends, filters, gain, orbit mute / solo).
- **Analyzer devices** (Analysis category, zero-latency pass-through): Oscilloscope (cycle-locked trigger, pitch
  readout), Vectorscope (Lissajous / polar / scatter, correlation and balance), Spectrum Analyzer (FFT up to 32k,
  slope, averaging, peak hold, max, compare trace from another track), Spectrogram (log / linear / mel, colour-blind
  safe maps, 3D waterfall) and Tuner (needle + strobe, A4 415–466 Hz) — each with presets and a pop-out window.
  A Scopes panel in the Mixer shows them for the master or any track without an insert; Pocket shows them compact.
- **Presets**: 10–17 tagged factory presets for every effect, about 110 new instrument sounds (synth, FM, organ,
  Strudel), and a preset browser with search, categories / tags, favorites, recently used and audition on select.
  User presets, FX chains and track templates can be saved, dragged onto tracks and shared as .daw3preset / .daw3bank
  files. Every device has A/B compare, eight snapshots with morphing, and randomize (subtle, wild or within preset
  tags; right-click a knob to lock it). Pocket gets the same search and favorites for sounds and effect presets.
- **Chord track + chord pads**: a chord lane in Arrange (add / edit / drag / resize chord symbols, detect them from
  your MIDI), chord pads in the project key with inversions, voicings and voice leading (drag a chord or a
  progression onto the chord lane, a MIDI clip or the piano roll), and MIDI tracks / clips that follow the chord
  track non-destructively. **Clip effects** (per-clip effect chains, rendered and latency-compensated with the mix),
  a **spectral editor** for audio clips (attenuate, remove, heal, isolate — undoable, original kept) and **action
  macros** (record or compose command sequences, give them a shortcut, run them from the palette, export as JSON).
- **Dynamics & EQ effects**: Multiband Compressor (3 / 4 Linkwitz-Riley bands, upward + downward with an OTT-style
  depth), Transient Shaper, De-esser, Expander / Gate (hysteresis, hold, look-ahead, filtered or external key),
  Dynamic EQ, Linear-Phase EQ and Match EQ (capture a reference track, file or clip) — AudioWorklet / FIR DSP that
  renders offline too, latency compensated, with transfer-curve, gain-reduction and response-curve cards and presets.
- **Space, voice & character effects** (AudioWorklet DSP, rendered identically offline): Algorithmic Reverb (room /
  hall / plate / chamber / spring, freeze), Shimmer Reverb, Tape, Multitap (tap editor) and Granular Delay; Pitch
  Shifter / Harmonizer (scale-aware voices, formant preservation, latency-compensated), Vocoder (built-in carrier or
  sidechain track), Formant Shifter; Frequency Shifter, Ring Modulator, Resonator, Envelope Filter, Distortion+,
  Mid/Side tool and Haas Widener (correlation meter) — 10–16 presets each.
- **SETI Scope**: a fullscreen visualizer styled after the classic radio-telescope screensaver — a rotating 3D
  power × frequency × time plot (WebGL, canvas fallback) with panels of real analysis of the song (strongest spectral
  spike + note, pitch drift, a Gaussian fitted to the loudness, beat / BPM, rhythmic triplets, detected key). Opens
  from the main / View menu, the command palette (Shift+V), the transport, the mixer's master strip and Pocket's
  menu; master or any track / bus as the source; CRT and Retro 640×480 modes; optional idle screensaver.

### Fixed
- **Faust plugins load without the internet**: the Faust compiler now ships with the app (web, Pocket and desktop)
  instead of being downloaded from cdn.jsdelivr.net, so every catalog Faust instrument and effect loads offline, on
  networks that block the CDN, and in exports. Load failures name the actual cause; the organ's drawbar settings
  from generated songs now apply.

## [1.0.0] — 2026-10-14

The first release: one codebase for the web app, the Pocket phone layout and the desktop apps for macOS,
Windows and Linux.

### Everywhere
- **Write:** arrangement timeline (markers, loop, ripple, comping), Scenes clip launcher, Step Rack, Piano Roll,
  Mixer and the Plugboard routing graph; tempo map with meter changes and audio warping.
- **Sound:** polyphonic synths (analog, FM, organ), samplers and multisampled instruments, sampled drum machines,
  Strudel's sound engine (superdough), SoundFont / Faust / WAM plugins.
- **Generate:** a song wizard and generative songwriting in 59 genres that follows music theory — arranging,
  extending, part-by-part regeneration and an assistant that suggests the next step.
- **Code:** every song is readable Strudel code; editing the code edits the song, and pasted Strudel code is
  imported as one track per instrument with its effects.
- **Setlist** (an endless, evolving DJ set) and **Decks** (two decks with key / BPM / phrase analysis, loops, hot
  cues and harmonic suggestions; cut loops onto pads, the sampler or the timeline).
- **Record:** audio and MIDI recording with takes, automation recording (touch / latch / write) on every control.
- **Mix & export:** plugin delay compensation, freeze / bounce, sidechain, meters, dithered 16/24/32-bit WAV,
  stems, MP3, MIDI, DAWproject, MusicXML lead sheets, mix bundles for engineers; crash recovery and version history.
- **Control:** MIDI learn on any control, Mackie Control / HUI, Launchpad / APC / Push grids, MIDI clock and MTC,
  Ableton Link, a command palette and rebindable shortcuts.
- **Together:** live peer-to-peer collaboration.

### Pocket (phones and small touch screens)
- The same app with a touch layout, chosen automatically on small screens and at `/pocket/` (Menu ▸ layout
  switches): Home, Play pads, Notes, Tracks, Song timeline, Mix, Code and Setlist pages; hum or whistle to notes,
  automation lanes, export, tempo / meter changes, MIDI devices and version history.

### Desktop apps (macOS, Windows, Linux)
- Electron shell around the unchanged web app (`app://` protocol, works offline), native menus, open / save
  dialogs, drag & drop of audio files and folders, `.daW3` file association (Finder, Windows installer, Linux
  `.desktop` + `application/x-daw3` MIME type).
- **Native audio engine** (miniaudio in a separate process): CoreAudio on macOS, WASAPI on Windows, ALSA /
  PulseAudio / JACK on Linux; device, channel, sample-rate and buffer choice, loopback latency measurement,
  sample-rate changes without a reload.
- **Plugin hosting** in a crash-isolated host process: CLAP and VST3 on all three systems (standard plugin
  folders), Audio Units on macOS; state saved in the project, parameters automatable and MIDI-learnable,
  presets, sidechain inputs, multi-out instruments, faster-than-realtime export with sample-accurate automation.
- **Ableton Link** built in (the `daw3-link` helper).
- Installers: macOS `.dmg` / `.zip` (Apple Silicon + Intel, ad-hoc signed), Windows NSIS installer + portable
  `.zip` (x64 + arm64, unsigned), Linux AppImage, `.deb` and `.tar.gz` (x64).
- The version and build commit are shown in About, the main menu and Pocket's menu.

### Fixed
- Desktop app: blank window when the app name ("daW³") reached the User-Agent header (headers must be Latin-1).
- macOS: the Intel build's Electron Framework is now ad-hoc signed too (strict `codesign --verify` on both builds).

### Known limitations
- Plugin editor windows open on macOS only; on Windows and Linux plugins are played and automated through daW³'s
  own parameter controls.
- The macOS apps are not notarized and the Windows installer is not code-signed (see the README for first-launch
  steps). Windows arm64 builds are cross-compiled and not smoke-tested in CI.
