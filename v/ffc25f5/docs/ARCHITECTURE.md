# daW³ — Architecture & Module Contracts

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
        codeSound?: 'strudel'|'daw3' (code tracks: sound engine, default 'strudel'),
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
Bus     { id, name, volume, pan, mute, fx: Effect[], automation: AutomationLane[] }
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
  (numeric param of an insert effect), `'mute'` (step lane, ≥ 0.5 = muted), `'fxen:<fxId>'` (effect on / bypass,
  step lane), `'cable:<cableId>'` (plugboard cable gain 0..2). Nested param keys: `'inst:pads.<padKey>.<param>'`
  (drum pads), `'inst:values.<address>'` / `'fx:<fxId>:values.<address>'` (Faust controls). enum / bool params are
  lanes of numbers (option index / 0|1 — `laneDef`, `encodeParam`, `decodeParam`; the engine decodes them).
* Owners (`automationOwner(project, id)`): tracks, **buses** (`bus.automation`: volume / pan / mute / fx / fxen) and
  the master (`project.master.automation`: volume / fx / fxen). Track/bus/master fx automation, bus mixer lanes and
  mute lanes all play live and in offline renders. A muted track with an active mute lane keeps playing in song
  mode (`isTrackPlayable`) so the lane can un-mute it; a track silenced by another track's solo stays silent.
* **One lane per target**: drawn, generated (src/gen rides) and recorded automation are the same data.
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

## Automation recording (`src/core/automation-record.js` pure, `src/ui/automation-recorder.js`)

* Arm with the header **A●** button (Shift+A); arming in pattern mode switches to SONG mode. While armed and
  playing (also when started with Record / R), any change to an automatable setting from any UI is written into
  that target's lane at the audible playhead (`engine.getAudiblePosition()` = position − output latency).
* Detection is UI-agnostic: after every transaction `snapshotTargets(project)` (flat `owner|target → value`) is
  diffed with the previous one (`diffTargets`). Ignored: undo / redo / load, the recorder's own commit, lane
  edits, new tracks / effects / instrument swaps, and bulk changes (> 16 targets in one transaction: presets,
  auto-mix). Disabled lanes are never recorded into (a toast says to re-enable them).
* Modes (`ui.autoMode`): **touch** — writes while the control is held (`controlEvents` touchstart/touchend from
  knob / fader / mixer fader; wheel / typed / click changes count as a 0.7 s touch), the lane resumes on release;
  **latch** — writes from the first touch, holds the last value until stop; **write** — latch + grabbing a tagged
  control writes immediately. Switched targets (mute, on/bypass, enum, bool) always latch.
* `AutomationTake` collects segments per target (thinned to ≥ 1/32 beat, new segment on a loop wrap). On stop
  `mergeTake` replaces only the written spans (punch-in / punch-out points keep drawn points around them),
  simplifies with Ramer–Douglas–Peucker (≈ 0.8 % of the range) and the whole pass is ONE undo step
  ("Record automation"); lanes are created when missing.
* Engine: `setAutomationOverride(ownerId, target, on)` makes playback ignore a lane while it is being written
  (the live store value is heard); `getAutomatedValue(ownerId, target)` is the lane value at the audible
  position (null when not automated) — the UI uses it to animate tagged controls (`markAuto`) at ~20 fps.

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
* `song.js`: `generateSong({genre, key?, scale?, bpm?, seed, withHarmony?, length?, targetMinutes?}) -> partial project
  {bpm, swing, key, genre, tracks, patterns, clips, scenes, markers}` using model factories (`withHarmony` adds
  `harmony` [{startBeat, durBeats, roman, root, type, bass, name}] + `harmonyLength` for analysis/tests).
* Production layer used by `generateSong` (all pure, deterministic):
  - `arrange.js`: `sectionKind/sectionType`, `planSections(genre)` (orchestration: sparse first verse, held-back arp in early
    choruses, ≤ 5 melodic layers, fx only on transitions), `planSectionHarmony` (verse / chorus / pre-chorus tension
    (IV–V, bVI–bVII…) / bridge progressions), automation point builders (`filterSweepPoints`, `AutomationBuilder`).
  - `groove.js`: `GROOVES` / `grooveFor(genre)` feel templates, `applyGroove(notes, {role, genre, bpm, rng, length, strum})`
    (swing baked in as a time warp of the 8th/16th grid — songs set `swing: 0`; late-only micro-timing per role / drum pad so
    notes keep their step and chord; ghost snares; hat accents; strums), `shapeDynamics` (section energy, phrase accents,
    crescendo into the next section).
  - `melody.js` `makeMotif` / `varyMotif` / `writeMelody`: a 1-bar motif developed by sequence (re-anchored on each chord),
    variation (displacement, tail, fragment, ornament) and question / answer cadences with rests; the chorus hook is its own
    motif (higher, longer notes, repetition) and returns with each chorus.
  - `sound.js`: `instrumentForRole(role, genre)` — sampled drum machine (`drumInstrumentForGenre`, synth kit fallback) and GM
    SoundFonts for acoustic genres (`{type:'soundfont', params:{library, instrument}, fallbackPreset}`), else synth presets.
  - `mix.js`: `mixTrack` (loudness-normalised levels `LEVEL_FIX` × role balance `ROLE_TRIM_DB`, pan, EQ8 high-pass, compression,
    saturation / tape, ducker keyed by the drum track or pump, widener, sends), `createSongBuses` (Reverb / tempo-synced Delay),
    `createSongMaster` (glue compressor → limiter).
  - `rides.js`: `addRides` — sparse automation lanes a producer would ride: per-section volume rides, pre-chorus pad swells,
    lead delay throws on phrase endings, pad width, breakdown filter dips, acid cutoff / resonance.
  `generateSong` returns `buses` + `master` too (the UI uses them) and, with `withHarmony`, `patternHarmony {patId: {harmony,
  length, key?}}` — the exact chords each pattern was written over (sections use different progressions; `key` is set on
  patterns after a last-chorus key change, which pop / gospel / rock / country songs sometimes make — `sections[i].modulation`).
* Song length / form (`form.js`, pure, no imports): every genre has a realistic standard length (`genre.minutes`, e.g. trance
  7.5, house / techno 6.5, dnb 5, dubstep 4.5, pop 3.5, trap 3, lo-fi 3, jazz 5, ambient 6.5) and its `structure` is its
  template (`STRUCTURES` in genres.js: DJ forms with drums-only intros / long breakdowns / two drops / DJ outros, verse–pre–
  chorus–bridge–double-chorus songs, jazz head–solos–trading–head…) fitted to it by `fitStructure(structure, targetBars)`
  (repeats / removes idiomatic blocks — EDM breakdown→build→drop, verse→pre→chorus, extra solo choruses — and doubles / halves
  sections). `generateSong({length: 'short'|'standard'|'extended'|'club', targetMinutes})` → `resolveStructure` (short ≈ 60 %,
  extended ≈ 140 %, club = DJ edit with ≥ 32-bar intro / outro for dance genres); `planSongLength(genre, opts)` previews it.
  Long sections evolve: `planSections` marks a held-back layer that enters halfway (`section.enter`, pattern "(enters)").
* `extend.js`: grow an existing song (generated or hand-made). `planExtension(project, {bars|minutes|toMinutes, mode, …})`
  (preview: items + summary "Adds Breakdown 3 (16) → Build 3 (8) → Drop 3 (32) = +56 bars / +1:37"), `extendSong` (material:
  varied copies of the template section's patterns — drum variants with fills / build rolls / crashes, lead hook variations
  fitted to the section chords, octave lifts, an arp entering; same tracks / mix; automation lanes with points in the template
  continue; the master fade moves to the new end) and `applyExtension(project, ext)` (mutates; inserting shifts later clips —
  split at the insert point —, markers, automation, sections, loop). Modes: `continue` (EDM breakdown→build→drop, songs
  bridge→double chorus then verse rounds, jazz more solos, loops A/B variations; before the outro when there is one),
  `repeat-last`, `extend-outro` (peels layers away), `insert-section` (at a marker / beat, `kind` or `templateMarkerId`).
  `removeSection(project, {markerId | start, end})` cuts a section and closes the gap. Sections come from the markers
  (`songSections`), 8-bar parts without markers. UI: Create ▸ Extend song…, Arrange ▸ More ▸ Extend / Insert, marker menu
  (Insert section here… / Extend this section by… / Shorten / remove section) → `actions.showExtendDialog` (one undo step).
* `assistant.js`: `getRecommendations(project, context) -> [{id, level:'tip'|'warn'|'idea', title, text, action?: {label, kind, payload}}]`
  (context = { selectedTrackId, selectedPatternId, view }). Actions are applied by the UI via `applyAssistantAction`.

## Code engine (`src/code/*.js`) — the real Strudel, behind a small facade

Code is evaluated by the **real Strudel engine** (strudel.cc, AGPL-3.0-or-later), vendored as prebuilt ESM in
`vendor/strudel/` (`strudel-core.mjs`: @strudel/core + mini + tonal + transpiler + draw, Node-importable;
`strudel-audio.mjs`: superdough + @strudel/webaudio + soundfonts, browser only; a shared chunk; exact versions and
every bundled license in `vendor/strudel/VERSION` + `licenses/`). `scripts/vendor-strudel.sh` rebuilds it with
esbuild (build time only; it applies three small, checked superdough patches — see the script).

* `src/code/strudel.js` is the facade everything imports (`evaluate`, `queryEvents`, `dslNames`, `splitTopLevel`, …).
  In a browser the first `evaluate()` lazy-loads the vendored engine (`loadStrudel()`); until it is ready — or if it
  can't load — the built-in reimplementation (`evaluateBuiltin`, `pattern.js`, `mini.js`) stands in (results carry
  `engine: 'strudel'|'builtin'`, `pending: true` while loading). `codeEngineVersion()` changes when the engine
  changes — caches of evaluate() results include it (scheduler `CodeCache`, Code view). In Node nothing loads unless
  `await loadStrudel()` is called; `useBuiltinEngine(true)` forces the fallback.
* `src/code/strudel-real.js` evaluates like Strudel's REPL: Strudel's transpiler (labels → `.p()`, located
  mini-notation for double-quoted/backtick strings, `slider()` → `sliderWithID()`), every exported function in
  scope (as `Function` parameters — no globals are written), `all/each/hush/setcps/setcpm/samples/aliasBank`.
  Deliberate differences, so a track evaluates synchronously: top-level `await` is dropped (sample maps load in the
  background), labelled patterns stay separate `entries` (per-block highlighting / song view) with `all()` applied to
  each, names from Strudel packages we don't ship (midi, osc, hydra, csound, Tone.js-era helpers) degrade to
  pass-throughs with a warning, strudel.cc page helpers (`backgroundImage`, visualisations drawing on a full-page
  canvas: `pianoroll`, `scope`, …) are no-ops — the Code view draws its own. `slider()` widgets: `res.widgets`
  ([{id, from, to, value, min, max, step}]); `setSliderValue(id, v)` changes the sound live (the pattern reads it at
  query time); the editor shows a range input at the end of the line and writes the value into the code on release.
* Compatibility corpus: `tests/fixtures/strudel-tunes/` (the REPL's example tunes, every `@example` of the function
  reference, every MiniRepl tune of the workshop/learn pages — AGPL like Strudel; rebuilt by
  `scripts/collect-strudel-tunes.mjs`); `node tests/strudel-compat.mjs` prints the pass rate,
  `tests/strudel-compat.test.js` requires 100%.

* `evaluate(source) -> { patterns: Pattern[], entries: [{name, pattern, muted, block}], labels: [{name, muted, start, end}], cps, error, warnings, widgets?, engine }`
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
  string literal's offset) — used for Strudel-style live highlighting. Real-Strudel events also carry `duration`
  (cycles, Strudel's `hap.duration`: `clip`/`legato` applied).
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
  `detectPluginKind`, `validateManifest` for `daW3.json`/`plugin.json` `{name, kind, entry, type?}`),
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

## Code tracks: sound engines (`src/audio/strudel-instrument.js`, `code-instrument.js`)

`track.codeSound` picks how a code track sounds (Code view toolbar ▸ "Sound"); either way the sound enters the
track's channel strip, so mixer, inserts, sends, automation and the plugboard apply.
* `'strudel'` (default) — `StrudelInstrument`: superdough, Strudel's own engine, exactly as strudel.cc (synths, ZZFX,
  General MIDI soundfonts, samples, effects, orbits). strudel.cc's prebake runs once (`loadStrudelAudio()`: synths,
  ZZFX, soundfonts, dough-samples maps: tidal-drum-machines, piano, Dirt-Samples, EmuSP12, VCSL, mridangam, the
  drum-machine aliases); `samples('github:…')` in code registers more. Each instrument owns a superdough audio
  controller whose output feeds the strip (so orbits — superdough's delay/reverb buses — are per track) and selects
  its context + controller right before each `superdough()` call. AudioWorklets are added per context (never waited
  on for more than 6 s). Scheduler code events carry `cycle`, `cps`, `hapDur` for it. If the vendored engine can't
  load, it plays through a `CodeInstrument`.
* `'daw3'` — `CodeInstrument`: daW³'s own synths, drum kits, presets and the sample library.
* Offline (WAV export, stems): superdough renders into the `OfflineAudioContext` (`render.js`): the render claims
  superdough (`claimSuperdough`, realtime Strudel sounds pause), waits for the instruments (`whenReady`) and, while the
  context is suspended between chunks, for every triggered sound to set up its nodes incl. sample loading
  (`flushCode`). If superdough can't render, the render is redone with `codeSound: 'daw3'` and `onNotice` reports it
  (the export shows a one-time toast).

## Licensing

daW³ is AGPL-3.0-or-later (`LICENSE`), because it ships Strudel (AGPL-3.0-or-later; © Strudel contributors,
https://codeberg.org/uzu/strudel). Third-party licenses of the vendored bundles: `vendor/strudel/licenses/` and
`vendor/strudel/VERSION`. AGPL §13: the app offers its source to every user — main menu ▸ "About / credits & source
code" and the Help dialog link to `SOURCE_URL` (`src/ui/actions.js`); keep that link pointing at the deployed code.

