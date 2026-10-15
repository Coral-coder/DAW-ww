# Changelog

All notable changes to daW³. Versions follow [semantic versioning](https://semver.org); the web app, Pocket and
the desktop apps share one version.

## [Unreleased]

### Added
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
