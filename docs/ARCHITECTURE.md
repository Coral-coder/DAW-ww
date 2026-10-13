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
        activePatternId, role?, automation: AutomationLane[] }
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
ParamDef { key, label, type:'number'|'enum'|'bool', min, max, step, default, unit?,
           curve?: 'lin'|'log'|'exp', options?: [{value,label}] (enum), section: string,
           advanced?: boolean  // hidden behind "Advanced" disclosure in the UI }
```

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

## Generators (`src/gen/*.js`) — pure, take `rng` (from `createRng(seed)`) for reproducibility

* `genres.js`: `GENRES {id: GenreDef}`, ≥40 genres. GenreDef includes name, family, bpm range, default
  bpm, swing, timeSig, preferred scales/keys, drum style ids, bass style, chord style/progressions,
  melody style, instrument presets per role (names from `src/audio/presets.js`), drum kit id,
  structure (sections w/ bars), FX suggestions, tips[].
* `drums.js`: `generateDrumPattern({genre|style, bars, density, variation, fill, rng}) -> Note[]` (GM pitches).
* `harmony.js`: `generateProgression({key, scale, genre, bars, chordsPerBar, rng}) -> [{roman, chord, startBeat, durBeats, notes(midi voicing)}]`,
  `progressionToNotes(...)`.
* `bass.js`, `melody.js`, `arp.js`: produce `Note[]` from a progression with styles.
* `song.js`: `generateSong({genre, key?, scale?, bpm?, seed}) -> partial project
  {bpm, swing, key, genre, tracks, patterns, clips, scenes, markers}` using model factories.
* `assistant.js`: `getRecommendations(project, context) -> [{id, level:'tip'|'warn'|'idea', title, text, action?: {label, kind, payload}}]`
  (context = { selectedTrackId, selectedPatternId, view }). Actions are applied by the UI via `applyAssistantAction`.

## Code engine (`src/code/*.js`) — pure, Strudel-compatible subset

* `evaluate(source) -> { patterns: Pattern[], cps: number|null, error: string|null }` — supports
  `$:` multiple patterns, `setcps/setcpm`, `stack/cat/seq/...`, method chains.
* `queryEvents(evaluated, beginCycle, endCycle) -> [{ begin, end, value }]` — onsets only, in cycles.
  `value` keys: `s, n, note (midi number or name), freq, gain, velocity, pan, cutoff/lpf, resonance,
  hcutoff/hpf, room, delay, delaytime, delayfeedback, crush, shape, attack, decay, sustain, release,
  legato, bank, speed, orbit, ...` — `note` is normalized to MIDI number when possible.
* `convert.js`: `codeToPatterns(source, {cycles, beatsPerCycle}) -> [{name, kind:'drums'|'melodic', notes, sound}]`
  and `patternsToCode(project) -> string` (export project as Strudel code).

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
