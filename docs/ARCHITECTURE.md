# daWWW — Architecture & Module Contracts

Zero-dependency, browser-native DAW. Plain ES modules (no bundler, no npm runtime deps),
served statically. Pure-logic modules (theory, generators, code engine, io) must also run
under Node 22 (`node --test`) — they must not touch `window`, `document` or `AudioContext`
at import time.

```
index.html
src/
  main.js            app bootstrap (UI)
  core/              util.js, model.js (data model), store.js (undo/redo store)
  theory/            music theory: notes, scales, chords, progressions, analysis
  gen/               generators: genres, drums, bass, chords, melody, arps, full songs, assistant
  code/              Strudel-style live-coding engine: mini-notation, Pattern, DSL eval, convert
  audio/             Web Audio engine: instruments, drum synth, sampler, effects, scheduler, render
  io/                project save/load, MIDI import/export, WAV encode, autosave
  ui/                views & components
tests/               node:test unit tests (*.test.js)
```

## Time & units

* **Beat** = quarter note. All musical positions/durations in the project are in beats (float).
* A **step** = 1/4 beat (16th note). Step sequencers show 16 steps per 4/4 bar.
* A **cycle** (code engine) = 1 bar = `beatsPerBar(project)` beats (4 in 4/4).
* Pitches are MIDI note numbers (60 = C4 = middle C). Pitch classes 0..11 (0 = C).
* Velocity `vel` 0..1. Track `volume` is linear gain 0..1.5 (0.8 default). `pan` -1..1.
* Swing 0..1: delays every odd 16th by `swing * (1/4 beat) * 0.5` (0.5 swing ≈ triplet feel… 1 = hard shuffle).

## Data model (`src/core/model.js`) — plain JSON

```
Project {
  format, version, name, bpm, timeSig:[num,den], swing, key:{root:0..11, scale:'minor'}, genre,
  mode: 'pattern' | 'song',
  loop:{enabled,start,end}, metronome,
  tracks: Track[], patterns: {id: Pattern}, clips: Clip[], scenes: Scene[],
  buses: Bus[], master:{volume, fx: Effect[], automation: AutomationLane[]}, samples:{id: Sample}, markers:[{id,beat,name}]
}
Track { id, name, type:'instrument'|'audio'|'code', color, volume, pan, mute, solo, arm,
        fx: Effect[], sends:{busId: 0..1}, instrument: Instrument|null, code?: string,
        activePatternId, role?, automation: AutomationLane[], patch?: Patch }
Patch   { enabled, nodes: PatchNode[], cables: Cable[] }            (plugboard — see below)
PatchNode { id, kind:'fx', fxId, x, y } | { id, kind:'split'|'mix', x, y }
Cable   { id, from:{node:'in'|nodeId, port:0}, to:{node:'out'|nodeId, port:0|1}, gain: 0..2 }
AutomationLane { id, target, points:[{beat, value}] (sorted by beat), enabled }
Instrument { type: 'synth'|'fm'|'organ'|'drums'|'sampler', preset: string|null, params:{} }
Pattern { id, trackId, name, length(beats), notes: Note[], color }
Note    { id, pitch, start(beats, relative to pattern), dur(beats), vel }
Clip    { id, trackId, type:'pattern'|'audio', patternId, sampleId, start, length, offset, gain, name }
Scene   { id, name, slots:{ trackId: patternId } }
Bus     { id, name, volume, pan, mute, fx: Effect[] }
Effect  { id, type, enabled, params:{} }
Sample  { id, name, mime, data: base64 (original file bytes), duration }
```

* **Drum tracks** are instrument tracks with `instrument.type === 'drums'`. Their notes use
  General-MIDI drum pitches from `DRUM_PADS` (36 kick, 38 snare, 42 closed hat, …).
* **Pattern mode**: every non-muted track loops its `activePatternId` pattern independently
  (pattern length may differ per track → polymeter). Scenes set `activePatternId` for many tracks.
* **Song mode**: clips on the arrangement play. A pattern clip loops its pattern across
  `clip.length`, starting `clip.offset` beats into it. Audio clips play `sampleId` from `offset`.
* **Code tracks** play whenever not muted, in both modes; their code is evaluated by `src/code`.
* Missing instrument/effect params always fall back to the defs' defaults.

## Plugboard (`src/core/patch.js` — pure helpers, `src/ui/views/patch.js` — view 7)

* `track.patch` is optional. When it is absent or `patch.enabled` is false the track's insert
  section is the serial chain in `track.fx` order (unchanged behaviour, bit-identical renders).
* When enabled, the insert section is the patch graph: `'in'` = the track's own signal
  (instrument / clips / code), `'out'` = the channel strip after the patch (pan → volume → mute →
  master + post-fader sends, exactly as before). `fx` nodes reference `track.fx` entries by id, so
  effect params, the device panel and automation (`fx:<fxId>:<key>`) work unchanged. Several
  cables into one input sum; one output feeding several cables splits; `split`/`mix` nodes are
  unity-gain junctions. Each cable is a GainNode (`gain` 0..2). Effects not on the board and
  devices whose input or output isn't patched are silent. Port 1 of a `ducker` node is its key input.
* Cycles are illegal (Web Audio forbids delay-free loops): `validateCable` rejects loop-closing,
  duplicate, self and wrong-port cables; `sanitizePatch` (used by the engine) drops anything invalid
  that slipped into a saved file, in order. `topoOrder` / `patchFxOrder` give signal-flow order
  (used by the device panel and mixer to list the fx of a patched channel).
* `serialToPatch(track)` builds in → fx1 → … → out; `patchToSerial(track)` gives a best-effort serial
  order; `setPatchEnabled(track, on)` switches (re-uses a stored patch when it still matches the fx
  list). `reconcilePatch(track)` keeps an enabled patch consistent with `track.fx` (the app shell runs
  it after every change: effects added elsewhere are inserted before OUT, removed ones are bridged).
  `applyTemplate(track, id, makeFx, {drumTrackId})` inserts the `PATCH_TEMPLATES` routings at the end
  of the chain; `autoLayout(patch)` lays devices out left-to-right by signal depth.
* Engine (`ChannelStrip.setFx(list, patch)`): rebuilds the wiring only when the structure key changes
  (fx ids/types + node ids/kinds/fxIds + cable ids/endpoints + enabled); effect params still go through
  `effect.update`, cable gains are ramped in place. Offline render builds the same graph via MixGraph.

## Sidechain (ducker effect)

* `ducker` (Dynamics): params `sourceTrackId` (ParamDef type `'track'`, `''` = none — rendered as a
  track picker), `amount` 0..1, `threshold` dB, `attack`, `release` s. Implementation (native nodes):
  key → mono → |x| (WaveShaper) → low-pass detector → threshold curve (6 dB knee) → fast (attack) and
  slow (release) low-passes → max(fast, slow) = (f+s+|f−s|)/2 → clamp 0..1 → × −amount → added to a
  VCA GainNode (gain = 1 − amount·env). `fx.keyInput` is the key input.
* Key tap: every track strip has a `post` node (after the inserts / patch, before pan / fader / mute).
  `MixGraph._syncKeys` connects the source track's `post` to the ducker's `keyInput` — the key is
  post-effects, **pre-fader** (turning the kick's fader down doesn't change the ducking; a muted track
  plays no events, so it doesn't duck anything). Duckers on buses / master can be keyed too.
* `resolveKeyLinks(project)` drops self-keying, missing source tracks (deleted → no ducking, no error)
  and any track↔track key loop. Stems (`renderOffline({stems:true})`) keep the key sources of each stem
  playing silently (fader 0, no sends) so a stem keeps its ducking (`keySourcesFor`).

## Automation (`src/core/automation.js` — pure helpers)

* Lane `target`: `'volume'` (0..1.5), `'pan'` (-1..1), `'send:<busId>'` (0..1), `'inst:<paramKey>'`
  (numeric instrument param of the track's *resolved* instrument type), `'fx:<fxId>:<paramKey>'`
  (numeric param of an insert effect). `project.master.automation` accepts `volume` / `pan`.
* Points are sorted by beat; values interpolate linearly between points and are held before the
  first / after the last point. Two points on the same beat make a vertical jump. Lanes without
  points, disabled lanes and lanes whose target no longer exists are ignored.
* Automation plays in **song mode only** (timeline positions); pattern mode ignores lanes.
  While it plays the automated value overrides the static one; the static value is restored on
  stop / pause / switching to pattern mode / removing the lane.
* Helpers: `parseTarget`, `valueAt(points, beat)`, `segmentsInWindow(points, b0, b1)`,
  `controlOverrides(track, beat)`, `toNorm/fromNorm(paramDef, v)` (log/exp curves), `rampPoints`,
  `lfoPoints`, `replaceRange`.
* Engine: mixer targets are AudioParam ramps (`ChannelStrip.automate`) scheduled per scheduler
  window (`Scheduler` `onWindow` hook; `jump:'seek'` cancels what was scheduled ahead, `'wrap'`
  continues across loop wraps). Instrument params are applied at each window start and effect
  params at the audible position on every tick (`MixGraph.applyControl`, cheap: only on change).
  Offline render schedules all mixer ramps up front and, when inst/fx lanes exist, renders in
  1/16-note steps (suspend → apply params → schedule that step's events).

## Audio recording (`src/audio/recorder.js`, browser-only)

`AudioRecorder(engine)`: `openInput()` (getUserMedia without echo-cancel/NS/AGC), `getLevel()`,
`start()` → latency-compensated ctx time of the first sample, `stop()` → `{blob, mime, ctxStart}`.
`actions.toggleRecord()` records audio when audio tracks are armed (switches to song mode, turns the
loop off for the take, optional 1-bar count-in via `actions.setCountIn`); when the transport stops the
take is decoded, encoded to WAV (`encodeWav`) and stored as a project sample + an audio clip on every
armed audio track. Without armed audio tracks Record keeps recording keyboard/MIDI notes into patterns.

## Store (`src/core/store.js`)

`store.get()` → project. All edits go through `store.transact(label, project => { mutate })`
(records undo; `{coalesce:true}` for knob drags; `{undo:false}` for non-undoable).
`store.on('change', (project, label) => …)`, `store.on('load', project => …)`, `undo()`, `redo()`, `load(json)`.

UI-only state (selection, zoom, current view) lives in `src/ui/state.js`, never in the project.

## Parameter metadata (drives auto-generated UI)

Both instrument and effect modules export definitions so UI never hard-codes params:

```
ParamDef { key, label, type:'number'|'enum'|'bool'|'track', min, max, step, default, unit?,
           curve?: 'lin'|'log'|'exp', options?: [{value,label}] (enum), section: string,
           advanced?: boolean  // hidden behind "Advanced" disclosure in the UI }
```
`'track'` params hold a track id (`''` = none); `paramPanel` renders them with `trackSelect`
(options from `setTrackOptionsProvider`, installed by the app shell). Only `'number'` params are automatable.

## Theory (`src/theory/index.js`) — pure

Exports (at least):
`NOTE_NAMES, noteName(midi) -> 'C4', pitchClassName(pc, preferFlats?), parseNote('C#4'|'eb3'|'c') -> midi,
SCALES {id:{name, intervals}}, scaleNotes(root, scaleId, octave?) -> midi[], scalePitchClasses(root, scaleId),
inScale(midi, root, scaleId), snapToScale(midi, root, scaleId),
CHORD_TYPES {id:{name, symbol, intervals}}, chordNotes(rootMidi, typeId, {inversion, voicing:'close'|'open'|'drop2'|'spread'}),
diatonicChord(root, scaleId, degree(0-based), {sevenths, extensions}) -> {root(midi pc), type, roman, notes(pcs)},
romanToChord(roman, keyRoot, scaleId), chordName(chord), detectChord(midiNotes[]) -> {root,type,name}|null,
detectKey(notes[]) -> [{root, scale, score}], voiceLead(prevNotes[], nextPcs[], range) -> midi[],
suggestNextChords(progressionRomans[], keyRoot, scaleId, genre?) -> [{roman, chord, reason, score}],
PROGRESSIONS (named library, tagged by genre/mood), CIRCLE_OF_FIFTHS helpers, relativeKey, parallelKey,
analyzeProgression(romans) -> notes for assistant (cadences, borrowed chords)`.

`voicing.js` — chord-scales and voicings (every chord writer goes through these):
`chordScale(chord, keyRoot, scale, {blues}) -> {tones, tensions, avoid, pool}` (key notes that contradict an altered
chord tone are dropped; avoid = a half step above a chord tone), `fitToChord(midi, cs, {allow, dir, range})`,
`chordVoicingPcs(chord, max, {rootless})` (drops 5th → 11 → root → 13 → 9; 3rd/7th always kept),
`voiceChord(chord, {prev, range, maxVoices})` / `voiceLead(prev, pcs, range)` (voice-led search under low-interval
limits: no m2 below C4, no M2 below G3, no 3rds below F3, no m9 between voices), `cleanVoicing(notes)`.

## Generators (`src/gen/*.js`) — pure, take `rng` (from `createRng(seed)`) for reproducibility

* `genres.js`: `GENRES {id: GenreDef}`, ≥40 genres. GenreDef includes name, family, bpm range, default
  bpm, swing, timeSig, preferred scales/keys, drum style ids, bass style, chord style/progressions,
  melody style, instrument presets per role (names from `src/audio/presets.js`), drum kit id,
  structure (sections w/ bars), FX suggestions, tips[].
* `drums.js`: `generateDrumPattern({genre|style, bars, density, variation, fill, rng}) -> Note[]` (GM pitches).
* `harmony.js`: `generateProgression({key, scale, genre, bars, chordsPerBar, rng}) -> [{roman, chord, startBeat, durBeats, notes(midi voicing)}]`,
  `progressionToNotes(...)`.
* `bass.js`, `melody.js`, `arp.js`: produce `Note[]` from a progression with styles. Upper parts are judged against the
  chord-scale of the chord sounding under each note (`fit.js` `fitNotesToHarmony`), not just the project scale;
  basses keep strong beats / chord starts on chord tones and approach notes never grind against the current chord.
  `colorChord(chord, flavor, rng, {key})` takes extensions from the key (no maj7 on a dorian IV, no m9 on iii).
  Quality is enforced by `tests/harmony-quality.test.js` (all genres × seeds; rules in `tests/lib/harmony-check.js`).
* `song.js`: `generateSong({genre, key?, scale?, bpm?, seed, withHarmony?}) -> partial project
  {bpm, swing, key, genre, tracks, patterns, clips, scenes, markers}` using model factories (`withHarmony` adds
  `harmony` [{startBeat, durBeats, roman, root, type, bass, name}] + `harmonyLength` for analysis/tests).
* `assistant.js`: `getRecommendations(project, context) -> [{id, level:'tip'|'warn'|'idea', title, text, action?: {label, kind, payload}}]`
  (context = { selectedTrackId, selectedPatternId, view }). Actions are applied by the UI via `applyAssistantAction`.

## Code engine (`src/code/*.js`) — pure, Strudel-compatible subset

* `evaluate(source) -> { patterns: Pattern[], entries: [{name, pattern, muted, block}], labels: [{name, muted, start, end}], cps, error }`
  — supports `$:` / `name:` labelled patterns (`_name:` muted; a label's block ends at the next label or the
  next top-level statement such as `const x = …`), `setcps/setcpm`, `stack/cat/seq/arrange/...`, method chains.
  `samples(url | map, base)` calls the injectable loader (`setSampleLoader(fn)`; in a browser it defaults to
  `src/audio/library/strudel-sounds.js` `registerSamples`, lazily imported) once per pack.
* `queryEvents(evaluated, beginCycle, endCycle, {active?}) -> [{ begin, end, value, pattern, name, block, locations }]`
  — onsets in cycles (`active: true`: events overlapping the window instead). `value` keys: `s, n, note (midi number
  or name), freq, gain, velocity, pan, cutoff/lpf, resonance, hcutoff/hpf, room, delay, delaytime, delayfeedback,
  crush, shape, attack, decay, sustain, release, legato, bank, speed, orbit, ...` — `note` is normalized to MIDI.
  `locations: [{start, end}]` are absolute source offsets of the mini-notation tokens that produced the event
  (mini.js tags every atom; Pattern ops merge `hap.context.locations` like Strudel; the transform passes each
  string literal's offset) — used for Strudel-style live highlighting.
* `convert.js`: `codeToPatterns(source, {cycles, beatsPerCycle}) -> [{name, kind:'drums'|'melodic', notes, sound}]`
  and `patternsToCode(project) -> string` (compact export of the active patterns).
* `song-code.js` ("Song as code", shown pinned as "Song (live)" in the Code view, regenerated ~250 ms after any
  project change): `songToCode(project) -> {code, mode, blocks, labels}` — `setcpm(bpm/beatsPerBar)` header, swing
  as `all(x => x.swingBy(…))`, one `// ── Track ──` section per track: pattern mode → `label: <active pattern>`,
  song mode → one `const label_pattern = …` per pattern + `label: arrange([bars, const|silence], …)`; drums as
  per-voice mini-notation (`s("bd*4, [~ sd]*2, hh*8")`, `perc:<pitch>` for pads without a name, `stack(...)`
  with `.velocity("…")` when velocities vary), melodic as `note("<[c3,e3,g3]@2 …>")` (one alternation step per bar
  group, `@` durations, chords, non-overlapping layers); `.s(preset)` / `.bank(kit)`, `.gain(volume/0.8)`,
  `.pan((pan+1)/2)`, lpf/hpf/room/delay/shape/crush from the first enabled matching insert; muted or solo-silenced
  tracks get `_label:`; code tracks are embedded verbatim (their setcpm/all lines commented out). Onsets are
  snapped to 16ths (humanised/strummed) or a 1/24-beat grid, velocities to 0.05.
  `applySongCode(project, code, {presets, kits, keepComplexAsCode}) -> report` mutates the project (call inside one
  `store.transact`): only blocks whose code changed are applied — notes + length of the active pattern (song mode:
  the edited `const` patterns; arrangement edits are reported, not applied), gain/pan/effects, `.s()`/`.bank()`
  instrument changes, tempo/swing; removed blocks or `_label:` mute (tracks are never deleted); new labels create
  tracks; random/signal/non-repeating blocks are returned in `report.complex` (or kept as code tracks).
## Audio (`src/audio/*.js`) — browser only (may import theory)

* `INSTRUMENT_DEFS {type: {name, params: ParamDef[]}}`, `EFFECT_DEFS {type: {name, params}}`,
  `PRESETS` (`presets.js`: `{id: {name, category, role[], genres[], instrument}}`), `DRUM_KITS` (`{id: {name, pads}}`).
* `AudioEngine` (`engine.js`):
  - `new AudioEngine(store)`; `await engine.init()` (creates AudioContext on user gesture; idempotent)
  - `play()`, `stop()`, `pause()`, `setPosition(beat)`, `getPosition()` (beats, live), `isPlaying`
  - follows `store` changes automatically (builds/diffs channel strips, instruments, fx)
  - `noteOn(trackId, pitch, vel)`, `noteOff(trackId, pitch)` — live play / audition
  - `playCodeEvent` handled internally for code tracks
  - `getMeter(id|'master') -> {l, r}` peak 0..1+, `getAnalyser()` (master AnalyserNode)
  - `async decodeSample(sampleId)` / sample cache; `auditionSample(sampleId)`
  - `async renderOffline({startBeat, endBeat, stems?:boolean}) -> AudioBuffer | {trackId: AudioBuffer}`
  - events: `engine.on('position', beat)`, `engine.on('state', {playing})`, `engine.on('error', e)`
* Scheduling: lookahead scheduler (25 ms timer, ~120 ms horizon). Same event-collection code is
  reused for offline rendering via `OfflineAudioContext`.

## IO (`src/io/*.js`)

* `project-file.js`: `serializeProject(project) -> string`, `parseProjectFile(text) -> project` (validates, normalizes),
  `downloadProject(project)`, `readFileAsProject(file)`.
* `midi.js`: `exportMidi(project, {mode}) -> Uint8Array`, `importMidi(arrayBuffer) -> {bpm, tracks:[{name, notes, isDrums}]}`.
* `wav.js`: `encodeWav(audioBuffer, {bitDepth:16|24|32}) -> ArrayBuffer`.
* `autosave.js`: IndexedDB autosave + list/restore of local projects.
* `samples.js`: `fileToSample(file) -> Sample` (base64), `sampleToArrayBuffer(sample)`.

## Plugins (`src/plugins/*`, browser runtime lazy-loaded)

Web-native stand-ins for VSTs, as instrument types `soundfont` / `faust` / `wam` (INSTRUMENT_DEFS,
`plugin: true`) and effect types `faust` / `wam` (EFFECT_DEFS category 'Plugins'). Everything needed
to reload lives in `params`: soundfont `{library, instrument, url?}`, faust `{name, code, url?,
values:{address: value}}`, wam `{name, url, state}`.
* Pure (Node-tested in `tests/plugins.test.js`): `github.js` (`resolveGitHubUrl` → jsDelivr,
  `detectPluginKind`, `validateManifest` for `daWWW.json`/`plugin.json` `{name, kind, entry, type?}`),
  `soundfont-parse.js` (midi-js file parser, note names), `gm.js` (128 GM names, libraries),
  `catalog.js` (+ `faust-library.js` sources), `status.js` (load-status registry keyed by `pluginKey(def)`).
* Runtime: `soundfont.js` (bank cache, repitch, ADSR), `faust.js` (@grame/faustwasm from jsDelivr,
  factory cache per source), `wam.js` (WAM 2.0 host, experimental), `fetch-cache.js` (Cache Storage,
  raw.githubusercontent fallback). `src/audio/plugin-instrument.js` is the sync facade used by
  `instruments.js` (`Instrument.ready` / `.error`), plus `awaitPluginsReady` / `flushPlugins` used by
  `render.js` (offline renders wait for plugins and for worklet note delivery), `preloadInstrument(def)`,
  `isSoundfontReady(def)`. `src/audio/plugin-fx.js` builds plugin effects (pass-through until loaded).
* UI: `src/ui/plugins-dialog.js` (Catalog / GitHub link / Faust editor), `src/ui/plugin-device.js`
  (device-panel status + retry, Faust knobs, WAM GUI), `styles/plugins.css`.
