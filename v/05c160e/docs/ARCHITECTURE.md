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
  collab/            real-time collaboration (CRDT, WebRTC, presence) + versions — docs/COLLAB.md
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
  mode: 'pattern' | 'song', tempoMap?, meterMap?, grooves?   (see "Tempo map, meters & audio warping")
  loop:{enabled,start,end}, metronome,
  mode: 'pattern' | 'song',
  loop:{enabled,start,end}, punch?:{enabled,start,end}, metronome,
  tracks: Track[], patterns: {id: Pattern}, clips: Clip[], scenes: Scene[],
  buses: Bus[], master:{volume, fx: Effect[], automation: AutomationLane[]}, samples:{id: Sample}, markers:[{id,beat,name}]
}
Track { id, name, type:'instrument'|'audio'|'code', color, volume, pan, mute, solo, arm,
        fx: Effect[], sends:{busId: 0..1}, instrument: Instrument|null, code?: string,
        codeSound?: 'strudel'|'daw3' (code tracks: sound engine, default 'strudel'),
        activePatternId, role?, automation: AutomationLane[], patch?: Patch,
        recInput?: {source, channels:[n]|[n,n+1]}, monitor?: 'off'|'auto'|'on',
        takeLanes?: [{id, takes: Take[]}], comp?: [{takeId, start, end}], compXfade?: ms }   (see "Recording")
Take    { id, name, sampleId | patternId, start, length, offset, gain?, srcLength?, pass? }
Patch   { enabled, nodes: PatchNode[], cables: Cable[] }            (plugboard — see below)
PatchNode { id, kind:'fx', fxId, x, y } | { id, kind:'split'|'mix', x, y }
Cable   { id, from:{node:'in'|nodeId, port:0}, to:{node:'out'|nodeId, port:0|1}, gain: 0..2 }
AutomationLane { id, target, points:[{beat, value}] (sorted by beat), enabled }
Instrument { type: 'synth'|'fm'|'organ'|'drums'|'sampler', preset: string|null, params:{} }
Pattern { id, trackId, name, length(beats), notes: Note[], color }
Note    { id, pitch, start(beats, relative to pattern), dur(beats), vel }
Clip    { id, trackId, type:'pattern'|'audio', patternId, sampleId, start, length, offset, gain, name, warp? }   (warp: see "Tempo map")
Clip    { id, trackId, type:'pattern'|'audio', patternId, sampleId, start, length, offset, gain, name,
          fadeIn?, fadeOut? (beats), fadeInShape?, fadeOutShape? ('lin'|'exp'|'log'|'s'|'eqp'), gainEnv?: [{beat, gain}],
          xfade?: false (no auto crossfade), reversed? }                       (audio-clip editing — see "Recording")
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

## Recording, takes + comping, clip editing (`src/record/*`, UI: `src/ui/views/arrange-rec.js`, `src/ui/record-panel.js`)

Pure (Node-tested in `tests/recording.test.js`): `takes.js` (take lanes / comp model, swipe math, comp → virtual clips
with crossfades, `computePasses`), `clips.js` (fades / gain envelope / auto crossfades, `trackClips`, split / slip /
ripple / zero crossings / normalize / reverse math, `mixClipsToPcm` = playback-exact PCM render), `timing.js` (latency
compensation, punch / pre-roll plan, monitoring rule, prefs), `midi.js` (pass recorder, MIDI takes, capture buffer, step
input). Browser: `inputs.js` (input sources + InputManager), `capture-processor.js` (AudioWorklet), `session.js`
(`createRecorder(app)` → `app.rec`).

* **Playback of comps / fades** — `scheduler.collectEvents` plays `trackClips(project, track)`: the track's clips (where
  an audio clip starts inside another and runs past its end, both get an equal-power crossfade over the overlap, unless
  `xfade === false`) + `compClips()` of its take lanes. Comp segments that touch crossfade over `compXfade` ms (default
  10, equal power) centred on the boundary, using the takes' handles (audio before / after the segment; `srcLength`). The
  mixer (`_clipEnvelope`) schedules `envelopePoints()` (curved fades sampled in 24 linear ramps, gain envelope, 4 ms
  de-click) for clips with curved fades / a gain envelope; other clips keep the old envelope (bit-identical renders).
  Flatten comp / consolidate render with `mixClipsToPcm`, the same math. `songLengthBeats` / `defaultEndBeat` count comps.
  Everything that renders or exports goes through `trackClips` too — mixdown / stem exports, the mixing-engineer stems
  (`stemRenderPlan` counts comp-only tracks), MIDI export (`collectTrackNotes` writes the comp of MIDI takes) and
  DAWproject (comp as clips + takes as muted lanes, see Interchange): comps never need flattening first.
* **Inputs** — an input source is `{id, label, kind:'browser'|'native', channels}`: getUserMedia device ids ('default'),
  or `window.daw3Native.audio.listInputs()` / `openInput(ctx, id) -> {node, channels, latency, close}` (ids
  `native:…`, multi-channel interfaces). `InputManager` opens the sources armed audio tracks (and tracks monitoring 'on')
  need — one stream + one capture tap per source — and routes each track's channels (`track.recInput.channels`, mono or a
  stereo pair) to its monitor gain → the track strip input (inserts + PDC), or straight to the output in low-latency
  mode. Monitoring `off | auto | on` (`monitorActive`: auto = while armed when stopped / recording inside the punch,
  not during playback). Per-track peak + latched clip meters (`level(id)`, click the header meter to clear).
  Rebinds on engine `'context'` (sample-rate change).
* **Capture** — the `daw3-capture` AudioWorklet stamps every block with its context frame (sample-accurate; Chromium
  hands a node's first `process()` a stale `currentFrame`, so a chunk starting there takes its frame from the next
  quantum); where AudioWorklet is missing or stalls (2.5 s), a ScriptProcessor tap. A ScriptProcessor's input is *not*
  at a fixed distance from `playbackTime` (Chromium: 2·N + 128…256 frames, varying per block, quanta can be skipped), so
  the tap carries a pilot channel — a looping frame-index ramp started at a known frame — and stamps every contiguous
  128-frame run from it (`pilotFrame`): both taps are frame-exact, dropouts become gaps in place
  (`tools/browser-check/record-check.mjs`).
* **Alignment / latency** — captured frame F is heard-time beat `anchor.beat + (F/sr − roundTrip − anchor.time)·bpm/60`
  (anchor = the scheduler's first anchor, heard time). **Tempo / meter maps**: the anchor carries the scheduler's
  `TempoMap` and the cycle range, and `timing.js` (`beatAtTime` / `timeAtBeat` / `songBeat`) integrates the *unwrapped*
  timeline through the map (each loop pass = `span(loop.start, loop.end)` s); `planAudioTakes` places the passes
  (take length = `beatAt(startSec + dur) − startBeat`, offset = sample seconds / `spbAt(take.start)` — the unwarped-clip
  convention of `warp/player.js`), `countInPlan` / `recordPlan({map})` count real bars of the meter map (a 7/8 count-in
  bar = 7 eighths, 2+2+3 accents, at its own tempo; bars before beat 0 use the first meter), `compClips` /
  `mixClipsToPcm({map})` / `envelopePoints(…, map)` / audition / reverse / normalize go through `takes.srcSecAt`, capture
  MIDI times free playing via the map. A constant map (no `tempoMap`, no meter changes) keeps the original linear
  arithmetic bit-for-bit. `roundTrip` = the measured loopback
  latency of the device (Recording settings ▸ Measure: pings out, onset detection in, `detectPing`) or the browser
  estimate (base + output + track latency), + a manual offset (ms) — stored per device in localStorage
  `daw3-rec-latency`. The ping goes through the same capture path, so a calibrated device is exact either way.
* **Session flow** (`rec.start({audio, midi})`, Record / R): song mode; `recordPlan` → transport starts at
  `recIn − pre-roll` (`engine.play({from, at})` starts exactly after the count-in clicks), records from `recIn` (playhead
  or punch-in), auto-stops after punch-out + post-roll (not while cycling). Stop commits everything as ONE undo step
  ("Record"): per armed audio track one WAV sample (24-bit, the whole pass + 1 bar handles); `computePasses` splits it
  into one take per loop pass (cycle) and/or the punch range. A single linear pass over empty space becomes a plain clip;
  otherwise `addRecordedTakes`: overlapping clips become "Original" takes, each pass a take in the first free lane, the
  comp points at the newest pass for its range. MIDI (song mode): `MidiPassRecorder` tags notes with their loop pass;
  prefs `midiMode` overdub (into the clips under the notes, the rest into a new clip) | replace (clears the recorded range
  first) | takes (one pattern take per pass, comped like audio) | merge (all passes in one take); `inputQuantize` (also
  for pattern-mode recording; 0 = off). Pattern-mode MIDI recording is unchanged.
* **Capture MIDI** (Shift+R): `CaptureBuffer` keeps the last 2 minutes of live notes (song positions when the transport
  ran, else timing at the current tempo); the last phrase becomes a clip (song) / new pattern. **Step input**: with the
  transport stopped each note / chord goes in at the step cursor of the selected pattern (Rest / Back).
* **Arrange UI** — header: input button (device / channels / monitoring), `T<n>` take-lanes toggle, input meter.
  Take rows under the track: drag across a take = swipe that range into the comp; click = that take for the comp
  section under the pointer; double-click = promote; Alt-click = audition; menu: delete, crossfade length, flatten.
  The comp plays (and is drawn) in the track lane with ✕ crossfade marks. Selected audio clips: fade handles (top
  corners, curve shapes in the menu), clip-gain line (drag), Shift-click = gain-envelope point (drag, Alt-click deletes);
  Alt-drag in the waveform = slip; S = split at playhead; Shift+Del = ripple delete; toolbar Ripple toggle (delete closes
  gaps, resizing moves later clips); clip menu: Normalize, Reverse (new reversed audio), Consolidate, split at loop /
  punch, zero-crossing snap (Rec menu). Punch range: Shift-drag in the loop lane (red), right-click for options.
  Rec ▾ menu + Recording settings dialog (count-in 0–4 bars, pre / post-roll, punch, inputs, latency, MIDI modes).
* `src/audio/recorder.js` (MediaRecorder) is the old single-input recorder, kept for compatibility; nothing uses it.

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
* Anti-monotony (no "3 notes, 231 231 231"): `planSectionHarmony` gives drone / vamp genres section-level movement
  (`DRONE_PLANS`: psytrance i pedal → bII phrygian tension, bVI–bVII lifts in builds / peaks, bIII relative shift + IV
  mixture in breaks; techno / minimal / tech-house i ↔ bVII / iv / bVI; ambient 2-bar drifts; any one-chord loop in a
  non-song form gets the techno plan) and two-chord vamp songs a lifting chorus / contrasting bridge (`LIFTS`); every song
  has ≥ 2 chord roots. `progressionToNotes(…, {motion})` re-voices returning chords along inversion paths (top-line
  melody) with phrase-end rhythm answers / breaths; `padPart` voice-leads 4-voice pads, ties common tones and walks
  held chords through `voicingStates`; `arpFigures` (arp.js) plays figures (1-5-8-10, 1-3-5-8-5-3, 2-octave up/down,
  pedal, psy…) over a chord-tone ladder with gate patterns, changing figure / octave / density every 4–8 bars; basses
  answer (psy KBBB riffs with octave / b7 / 5 / 6 cells and 8th-bar fills, `TAIL_STYLES` riff answers, root/drone
  two-feel). `monotony.js`: `partStats` (distinct pitches per 16 / 8 bars, longest ≤ 3-token cell repetition in bars,
  bigram entropy), `isMonotonous`, `varyPart` (the guard `generateSong` runs on every part) and `monotonyReport(project)`;
  enforced by `tests/monotony.test.js`.
* Orchestration depth (`orchestra.js`) and plugins (`plugins.js`), both called by `generateSong` (`orchestra: false` /
  `plugins: false` turn them off; `soundfonts: false` also disables plugins):
  - `planExtras(genre, sections)` adds extra layers per section (`section.extra`, kept out of `section.roles`) by genre
    priority (`GENRE_EXTRAS` / family defaults): `perc` (1–2 voices, ≤ 8 hits/bar, conga + clave / 3-over-4 rim / tambourine /
    taiko ostinato; top-end voices only within the per-bar budget left by the main kit — `topEndBudget` 16 dnb / 20 others —
    never a second 16th stream), `top` (dnb / jungle / breaks only: off-step ghost snares, HPF 400 Hz, −12 dB), `sub`
    (bass roots in E1–D#2, mid-bass HPF 95 Hz), `counter` (counter-melody, call & response), `strings`, `brass` (answer stabs),
    `guitar`, `color` (banjo / sitar / steel drums / marimba / glockenspiel…), `texture`, `vox` (hook double / choir),
    `bells`, `organ`, `impact` (downbeat hits; snare roll into drops only where the kit sits out). Density: `maxLayers(section)`
    melodic layers (3 intro/outro … 8 biggest chorus). Enforced by `tests/drum-layers.test.js` (+ the harmony / monotony guards).
  - `addTurnarounds(progs, sections)`: the last 2 beats before a new section become V7/x, a borrowed iv or bVII (song genres).
  - `plugins.js`: Faust catalog instruments per genre/role (`GENRE_FAUST`, `EXTRA_FAUST`: supersaw, VA poly, warm pad, KS pluck,
    modal bell, PM flute / clarinet, tonewheel organ) as `{type:'faust', params:{code, values (by control label), gain},
    fallbackPreset}`; mixed as their fallback preset (`mixInstrument`), `FAUST_GAIN` calibrated to it. `applyPluginEffects`:
    Zita / Freeverb on the reverb bus, tape echo on the delay bus, Moog ladder on analog / acid basses, phaser, parallel Faust
    compression on band drums — each with `params.fallback = {type, params}`: `createEffect` (effects.js) mutes the plugin's
    pass-through while it loads and swaps in the built-in effect if it fails (a send bus never returns dry signal).
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

## Pro engine (PDC, freeze, export quality, streaming, recovery, health) — APIs for other features

**Plugin delay compensation** (`src/audio/latency.js` pure, `mixer.js`, `scheduler.js`, `render.js`)
* Every insert effect exposes `fx.latency` (s, constant whether bypassed — the bypass path is delayed to match) and
  `fx.refreshLatency()`; instruments expose `instrument.latency`. Sources: Chromium-measured table
  (`effectLatencyFrames(def, sr)`: compressor / limiter 6 ms pre-delay, gate 4 ms, tape 12 ms + 2x oversampling,
  distortion / saturator oversampling, mastering), plugin-reported (WAM `getCompensationDelay()`), or a manual
  `latency` (samples) on any effect / instrument def (Faust, odd plugins).
* `computePdc({sampleRate, enabled, tracks:[{id, latency, sends}], buses, master})` → per-route compensation. The
  `MixGraph` puts `DelayLink`s on each track→master link and each send link (`ChannelStrip.setCompensation`) so
  every route meets at the master input; `graph.latency` = whole-mix delay, `graph.latencyReport()`,
  `graph.updatePdc()` (also called when a plugin reports its latency).
* Inside a strip (`alignInserts` in latency.js, `ChannelStrip.alignment()`): the insert section — plugboard graph or the
  serial chain — is aligned too: parallel branches are delayed to the slowest before they meet (every cable is a
  `DelayLink`), and a keyed effect's key (in-board port-1 cable or an external sidechain from another strip's `post`)
  meets the audio it keys: the earlier one waits (an external key later than the ducked audio lengthens that strip).
  `MixGraph.updatePdc` iterates the key arrivals (they depend on the plan) to a fixed point; key links are `DelayLink`s.
  Strip latency = aligned in→out latency. `project.pdc === false` turns this off too (old behaviour).
* Tempo-synced LFOs: each effect's `env.getBeatAt(t)` returns the beat at `t + heard` (`heard` = total latency − when the
  effect's input arrives after dispatch), so LFO phases line up with the beat at the speakers, not at the insert.
* Realtime: the scheduler pre-rolls every event by `graph.latency` (`getPreroll`); anchors / `beatAt` /
  `getPosition` / `engine.beatAtTime(t)` stay in *heard* time, so recording alignment (item 2) needs no change.
  Fader automation is timed per strip (`faderOffsets`); the metronome joins after the master section.
  Offline: the render is padded (`PDC_PAD` = 1 s) and the head trimmed → sample-identical to a latency-free graph.
* `project.pdc === false` turns compensation off (old behaviour). `engine.getLatency()`, `engine.on('latency')`.

**Freeze / bounce** (`src/core/freeze.js` pure, `src/audio/freeze.js`)
* `track.frozen = {sampleId, mode:'preFx'|'postFx'|'postFader', renderMode:'song'|'pattern', start, length, loop?,
  gain, bpm, at}`; the original track stays intact. `frozenMode(project, track)` says whether the freeze is in effect
  (sample present, same transport mode, same tempo — else the track plays live again; `frozenStaleReason`).
* While frozen the mixer instantiates no instrument / code source and (postFx/postFader) no inserts; the scheduler
  emits the render as an audio clip (song) or a seamless loop (pattern). postFader bypasses volume / pan.
* `engine.freezeTrack(id, {mode})`, `engine.unfreezeTrack(id)`, `engine.bounceTrack(id, {mode='postFader',
  muteSource=true})` → new audio track id, `engine.flattenTrack(id, {mode='postFx'})`, `engine.renderTrack(id, opts)`
  → `{buffer, info}`. Renders are 24-bit TPDF-dithered WAV samples (`sample.frozen` flag), peak-normalised with the
  level restored by `frozen.gain` / clip gain.
* Edits are blocked by a store guard (`createFreezeGuard`, `Store.addGuard`): a transaction changing a frozen
  track's sound (notes, clips, instrument, inserts, code, fader for postFader) is rolled back for that track and
  `store.on('blocked', {message})` fires (UI: toast with `FROZEN_HINT`). `store.transact(label, fn, {guard:false})`
  skips guards (whole-project restores).
* UI: track menu ▸ Freeze / Freeze… / Bounce / Flatten (`app.freezeMenuItems`), mixer ❄ button, arrange ❄ badge.

**Export quality** (`src/io/wav.js`, re-exported by `src/audio/wav.js`; `src/audio/dsp/truepeak.js`)
* `encodeWav(buffers, {bitDepth: 16|24|32, dither: 'none'|'tpdf', noiseShaping: 'none'|'first'|'shaped', seed,
  sampleRate})` — buffers = AudioBuffer | Float32Array[] | {channels, sampleRate}. 32 = bit-exact float (overs kept);
  integer formats clamp after dither (never wrap). `decodeWav`, `wavInfo`, `readWavFrames` (range decode).
* `truePeak(channels)`, `truePeakDb`, `limitTruePeak(channels, sr, {ceilingDb=-1, lookahead, release})` — offline
  look-ahead true-peak limiter (no latency). `renderOffline(..., {truePeakCeiling: -1})` applies it to the master;
  `applyTruePeakLimit(audioBuffer, opts)`. The render path is float32 end to end. (Export UI: item 4.)

**Long-audio streaming** (`src/audio/stream/*`)
* Samples ≥ `STREAM_MIN_SECONDS` (30 s) are not decoded into AudioBuffers for clip playback: `SampleStreamer`
  caches PCM chunks (32768 frames) in IndexedDB `daw3-pcm` via a module Worker (`stream-worker.js`; WAV parsed in
  the worker, other formats decoded once with decodeAudioData and handed over), and each clip play is an
  AudioWorkletNode `daw3-stream` (`stream-processor.js`) fed chunk by chunk over a MessagePort (3 chunks ahead,
  linear resampling when rates differ, silence + underrun count when late). Short samples, offline renders and
  browsers without AudioWorklet / module workers / IndexedDB use buffers. `engine.decodeSample(id)` returns a light
  `{duration, streamed: true, peaks}` object for streamed samples (`{full: true}` forces a buffer);
  `engine.getSamplePeaks(id)` gives the waveform overview.

**Crash-safe autosave / recovery / history** (`src/io/recovery.js`, UI in `src/ui/engine-ui.js`)
* `createRecovery({backend})`: incremental snapshots to IndexedDB `daw3-recovery` (project JSON without samples;
  each sample stored once by content key) every 10 s when changed, on tab hide and on pagehide; sessions carry a
  heartbeat and are marked clean on pagehide. On boot `findUnclean()` → "Recover unsaved session (time)" dialog.
  `listSnapshots(projectId)` (last 20 per project), `loadSnapshot(id)`; main menu ▸ Version history… restores as
  one undoable step (`restoreProject`). The older whole-project autosave (`autosave.js`) is unchanged.

**Engine health** (`src/audio/monitor.js`, `engine.js`)
* `engine.getMetrics()` → `{load, peakLoad, xruns, late, lateEvents, lateMs, latencyMs, pdcMs, sampleRate, state}`
  (load from `AudioContext.renderCapacity` where available; xruns from `playoutStats` or audio-clock drift;
  scheduler lateness / skipped windows). Status bar: DSP / dropouts / latency + PDC, sample-rate select, Panic.
* `engine.panic()` (all notes off + 0.6 s master mute to kill tails; Shift+Esc), `engine.setSampleRate(rate|null)`
  (rebuilds the context, resumes playback; `SAMPLE_RATES`; preference in localStorage `daw3-sample-rate`; emits
  `'samplerate'` and `'context'` — anything holding nodes of the old context, e.g. the recorder, must rebind).

## Pro mixer, metering & export (`src/core/mixer-model.js`, `src/audio/{mixer,meters,export}.js`, `src/io/export-plan.js`)

**Data** (all optional; absent = old behaviour, bit-identical renders): `project.mixer = { soloMode: 'sip'|'afl'|'pfl',
groups[], vcas[], folders[], snapshots[] }`; track extras `folderId, trim (dB), phase, width (0..2), soloSafe, notes,
sendModes:{busId:'pre'|'post'}, output (busId), padOutputs:{padKey: busId}`; bus extras `folderId` (folder summing bus),
`source:{trackId,pad}` (drum multi-out channel). `mixerOf(project)` reads with defaults, `ensureMixer` creates.
* **Groups** `{id,name,color,members,mode:'relative'|'absolute',enabled,link:{volume,pan,mute,solo,arm,select}}`:
  `applyLinkedEdit(p, id, key, value, {bypass})` — relative volume = same dB delta for every member (members at −∞ stay),
  relative pan = same offset, switches absolute; transitive across groups (`linkedIds`). Mixer: Ctrl/Cmd while editing
  = this channel only. `linkChannels` = absolute "stereo link" group. `groupSelection` for linked selection.
* **VCA** `{id,name,volume (linear),mute,members:[track|bus id],automation:[lane 'volume']}`: no audio passes through;
  member gain = fader × Π VCA gains (dB sum). VCAs are automation owners (`automationOwner`, recorder snapshot); the engine
  turns `vcaCombinedLane` (product of every VCA lane over the member) into ramps on the strip's `vcaGain` node, so VCA
  automation multiplies with the member's own fader automation. Arrange shows one row per VCA (above the bus / master
  rows, `ownerInfo` kind `'vca'`, violet): "A" opens its level lane (`'volume'`, linear 0..`VCA_MAX`, square-law lane
  scale so 0 dB sits mid-lane) — draw / edit / ramps / LFO shapes like any lane, touch / latch / write recording from the
  mixer's VCA fader; while a VCA is being written `setAutomationOverride(vcaId, 'volume')` makes its members follow the
  live fader.
* **Solo** (`soloState`, `isAudible` — used by `scheduler.isTrackAudible`): SIP mutes non-soloed tracks except
  `soloSafe`; AFL / PFL never touch the main mix or exports — soloed channels feed `graph.cue` (post-VCA / pre-fader) and
  the monitor output switches to the cue bus (realtime only). `toggleSolo(p, id, {exclusive})`.
* **Folders** `{id,name,collapsed,busId}`: `createFolder` (members kept contiguous), `setFolderSum` (a bus + every
  member's `output`), `trackRows`/`collapsedHidden`/`folderHeadOf` for Arrange (collapsed members are zero-height rows,
  their clips draw on the folder's first row) and Mixer (folder tabs). Snapshots: `captureMixerState`/`saveSnapshot`/
  `recallMixerState(p, state, {faders,pans,switches,sends,fx})`; `resetMixer`.
* **Strip graph** (`ChannelStrip`): input → `inStage` (trim × polarity) → inserts → post (key tap) → [lazy M/S width] →
  `preFader` (pre-fader sends through a mute-following gain, PFL) → pan → volume → `vcaGain` (AFL) → mute → `direct` →
  output (`setOutput`: master or a bus; PDC treats a bus-routed main out like a send). Meters tap after the mute through a
  DelayNode with the strip's PDC compensation (PDC-aware); `getMeter` → `{l, r, rmsL, rmsR}`.
* **Sidechain**: `compressor`, `gate`, `ducker` take `params.sourceTrackId` = any track **or bus** (`KEYED_FX`). The
  compressor switches to a keyed gain computer (peak follower → static curve → VCA, same look-ahead / latency); the gate's
  detector listens to the key. `resolveKeyLinks` checks loops over the whole routing graph (sends, outputs, multi-outs
  and other keys). Drum multi-out: `DrumInstrument.setPadOutputs({pad: node})` (mixer-tools "Multi-out").
* **Metering** (`src/audio/dsp/loudness.js`, pure): `kWeighting(sr)`, `measureLoudness(channels, sr)` → integrated /
  momentary / short-term max / LRA / true peak (BS.1770-4 gating, EBU 3342 LRA), streaming `LoudnessMeter`,
  `correlation`, `normalizeLoudness(channels, sr, {mode:'peak'|'lufs', target, ceiling})` (true-peak limited, refined to
  ±0.05 LU), `LOUDNESS_PRESETS`. Realtime: `engine.getMasterAnalysis()` (`meters.js`: AudioWorklet
  `loudness-worklet.js`, analyser fallback; vector scope, pre / post master spectrum) → Mixer ▸ Loudness panel.
* **Export** (File ▸ Export ▸ Export audio…, Ctrl+E, `ui/export-dialog.js`): `io/export-plan.js` (pure: `resolveRange`
  song / loop / selection / custom bars, `formatFileName` tokens, `detectTail`, `stemTargets` all / selected / buses /
  groups, `stemProject` pre / post fader, with / without master), `io/wav-meta.js` (LIST/INFO + iXML: title, artist,
  ISRC…), `audio/export.js` `runExport` (renders at 44.1–96 kHz, tail detection, normalisation, WAV 16/24/32f + dither /
  noise shaping, lossy formats, consistent stem start / length, report). Several files download as one ZIP with
  `export-report.txt`.
* **Lossy export** — **MP3** in every browser: `io/mp3.js` `encodeMp3` drives the vendored LAME port
  (`vendor/lamejs/lame.mjs`, LGPL-3.0, imported lazily inside the module Worker `audio/encode-worker.js`; main-thread
  fallback), CBR 128–320 kbps or average-bitrate VBR (the ABR loop ported from LAME), joint stereo at 32 / 44.1 / 48 kHz
  (other render rates are rendered at 44.1 / 48 kHz: `encodeRate`), a Xing / Info + LAME tag frame (frame count, seek
  TOC, encoder delay / padding → gapless decoders return exactly the source length) and an ID3v2.3 tag (title, artist,
  album, ISRC, year, BPM, comment, cover APIC). **AAC** (`.m4a`) and **Opus** (`.ogg`) through WebCodecs `AudioEncoder`
  when `formatSupport()` finds an encoder (Chromium on Linux has Opus, no AAC): `io/mp4.js` `muxM4a` (ftyp / moov with
  an edit list hiding the encoder priming, mp4a + esds, stts / stsc / stsz / stco, iTunes `ilst` metadata incl. covr,
  ISRC and iTunSMPB) and `io/ogg.js` `muxOggOpus` (OpusHead pre-skip, OpusTags with METADATA_BLOCK_PICTURE, 48 kHz
  granules trimming the padding). The dialog lists every format; ones the browser can't write are disabled with the
  reason as tooltip. Normalisation / the true-peak limiter run before encoding; the encoded file is decoded back
  (`decodeAudioData`) and the report adds its measured LUFS / true peak / duration ("Encoded file").

## Tempo map, meters & audio warping (`src/time/*`, `src/audio/warp/*`)

* **Data** (all optional — a project without them plays exactly as before):
  `project.bpm` = tempo at beat 0 (authoritative: BPM field, setcpm, Link / MIDI-clock-in write it);
  `project.tempoMap = [{beat, bpm, curve:'jump'|'linear'}]` (point 0 mirrors `bpm`; `curve` shapes the segment *after* the
  point: hold, or a linear ramp in beats to the next point); `project.timeSig` = meter of bar 0;
  `project.meterMap = [{bar (0-based), num, den, groups?}]` (changes only). Legacy `tempoAutomation` / `timeSigAutomation`
  (older DAWproject imports) migrate in `normalizeProject`.
* **`src/time/tempo-map.js` is the only beat↔seconds code**: `TempoMap` (`secAt`, `beatAt`, `bpmAt`, `span`, `breaks`,
  `barAt`, `barStart`, `position` / `formatBBT`, `clicks` (one per meter unit; level 2 downbeat / 1 accent group, e.g.
  7/8 = 2+2+3), `gridLines`), `tempoMapFor(project, mode)` (cached by content; **pattern mode = constant `project.bpm`**,
  tempo changes are an arrangement feature; meters apply in both), `songTempoMap`, `spanOf(spbOrMap, b0, b1)`.
  Ramps integrate exactly: `sec = 60/k·ln(bpm(b)/bpm0)`, `beat = b0 + bpm0·(e^{k·s/60} − 1)/k`.
  Editing: `tempo-edit.js` (`setTempoPoint`, `moveTempoPoint`, `addTempoRamp`, `setMeter`, `TapTempo` / `tapTempoToMap`,
  `tempoFromSelection` = "set tempo from selection length"); interchange: `convert.js`.
* **Who follows it**: the scheduler (window ends, event times `t0 + secAt(ev.beat) − secAt(b0)`, anchors carry the map so
  `beatAt(t)` / the playhead are exact through ramps; `annotateTimes` adds `durSec` so notes / code events last their
  real length), offline render (same math, chunking in seconds), mixer automation ramps (`spanOf`), the metronome (accent per
  meter), engine `'tempo'` events + `getCurrentTempo()` (tempo-synced effects follow the tempo at the playhead), MIDI clock out
  (`tickTime(k)` through the map — tick spacing glides on ramps), MTC (`map.secAt`), Link (sends the tempo at the playhead
  while a map plays), setlist (phrase bars via `barAt`, safety lead at the fastest tempo), DAWproject (Tempo /
  TimeSignature automation round-trip incl. ramps), MIDI export (Set Tempo per change, ramps stepped every 16th), stems
  "Tempo map.txt", LCD (`formatBBT`, time through the map), Arrange ruler / grid / bar snap. Constant maps keep the old
  arithmetic bit-for-bit.
* **Code tracks** are beat-locked: one cycle = one bar of the *first* meter, so they follow tempo changes (events land on
  the same beats; the map turns beats into seconds); the `cps` handed to superdough is the tempo at the event. `setcpm`
  sets `project.bpm` (the starting tempo).
* **Freeze**: `track.frozen.tempo` = `tempoSignature(project)`; editing the tempo / meter map makes song-mode freezes play
  live until refrozen (like a bpm change).
* **Audio warping** — `clip.warp = { mode: 'off'|'repitch'|'beats'|'tones'|'complex', markers: [{beat, sec}], bpm,
  transpose, formants, quality }`; markers map *content beats* (the unit of `clip.offset`) to sample seconds, linear between
  markers, extrapolated outside. Warped clips follow the tempo map; `off` plays at the sample's own speed (old behaviour).
  `sample.analysis = {bpm, confidence, downbeat, transients}` (`warp/analyze.js`, onset / tempo code ported from the Mac
  branch). Imports (`actions.placeSample`) auto-warp: markers on each detected bar, `beats` for percussive loops, `tones`
  otherwise, `off` for files > 60 s.
  - `markers.js` (pure): `secAtBeat` / `beatAtSec`, `clipCurve(clip, map, b0, b1)` → piecewise-linear output-time →
    sample-time curve (breakpoints at markers, tempo breaks and every 1/16 beat inside ramps), `curveRates`, `autoWarp`,
    marker editing, `sourceTimeFn` (waveform drawing).
  - `core.js` (pure, streaming `WarpRenderer`): repitch (resample along the curve), beats (slice at transients, each slice
    starts exactly on its curve time at its own speed, faded before the next source slice / cross-faded when cut), tones
    (WSOLA, ~50 ms grains, 2× overlap, ±12 ms search), complex (WSOLA ~90 ms grains, 4× overlap); transpose = grains read
    resampled; `formants` = per-grain LPC envelope removed → residual resampled → envelope re-applied.
  - `player.js` (browser): off / repitch use AudioBufferSourceNodes (repitch: piecewise-constant `playbackRate`, exact at
    every breakpoint); pitch-preserving modes stream through the `daw3-warp` **AudioWorklet** (`worklet.js`, sample PCM
    posted once per context) and fall back to a main-thread render of the same `WarpRenderer` (LRU cache) when the worklet
    is unavailable / still loading (addModule gives up after 8 s). Offline renders / export always use the precomputed path.
  - **Live tempo edits**: when the tempo map changes while playing (`engine._retimeOnTempoEdit`; maps are cached by
    content, so a new map object = an edit) every warped voice spanning the scheduler's next window boundary
    (`scheduler.boundary()`: where the scheduler itself switches maps) is re-curved from there
    (`WarpPlayer.retime` → `markers.spliceCurve`): worklet voices get `{type:'curve'}` and `WarpRenderer.setCurve` carries
    on seamlessly (grain / slice state kept), repitch re-schedules `playbackRate`, cached-fallback voices restart from
    the boundary; the clip gain envelope is re-laid under the new map.
  - **Streamed (long) samples** warp too: the voice gets a stream-worker port (`SampleStreamer.openPort`) instead of the
    PCM, and a sliding `SourceWindow` (`warp/window.js`, chunk-aligned, 12 chunks + mono mix) follows
    `WarpRenderer.neededRange()`; the renderer reads through `base` (bit-identical to the in-memory render). No full
    decode; a late chunk renders silence for that block (underrun) and the clip stays in time.
* **Quantize / groove** (`src/time/groove.js`): `quantizeWarp(clip, transients, {grid, strength, swing, groove})` puts warp
  markers on the transients pulled toward the timeline grid (two hits in one slot: only the closer moves);
  `extractGroove` / `grooveFromNotes` / `grooveFromAudio` → `GrooveTemplate {grid, length, offsets, velocities}` (stored in
  `project.grooves`); `applyGrooveToNotes`, `quantizeNotes`.
* **UI**: Arrange **Tempo** lane (`src/ui/tempo-lane.js`: double-click adds a point, drag moves, right-click: ramp / jump,
  set BPM, delete, tempo / meter change at a bar, tempo from loop length, clear; Tap = tap tempo to map), meter labels on
  the ruler, meter-aware bar snap; clip **Warp editor** (`src/ui/warp-editor.js`, double-click an audio clip or clip menu ▸
  Warp: mode, transpose, formants, quality, clip BPM, detect tempo, set project tempo from clip, auto-warp, markers, audio
  quantize, extract groove).

## IO (`src/io/*.js`)

* `project-file.js`: `serializeProject(project) -> string`, `parseProjectFile(text) -> project` (validates, normalizes),
  `downloadProject(project)`, `readFileAsProject(file)`.
* `midi.js`: `exportMidi(project, {mode}) -> Uint8Array`, `importMidi(arrayBuffer) -> {bpm, tracks:[{name, notes, isDrums}]}`.
* `wav.js`: `encodeWav(buffers, {bitDepth:16|24|32, dither, noiseShaping}) -> ArrayBuffer`, `decodeWav` (see Pro engine).
* `mp3.js` / `mp4.js` / `ogg.js`: MP3 (LAME) encoding + frame / Xing / ID3 parsing, the .m4a muxer and the Ogg Opus muxer
  (see "Lossy export"); each has a reader used by the tests and the report.
* `recovery.js`: crash-safe incremental snapshots, recovery and version history (see Pro engine).
* `autosave.js`: IndexedDB autosave + list/restore of local projects.
* `samples.js`: `fileToSample(file) -> Sample` (base64), `sampleToArrayBuffer(sample)`.
* `interchange/*`: other-DAW formats — see "Interchange" below.

## Interchange (`src/io/interchange/*` — pure except `ui.js`)

Menu: File → Import / Export → *DAWproject…*, *For mixing engineer (stems + MIDI ZIP)…*, *MusicXML…*
(`actions.interchange(fn)` lazy-loads `ui.js`; Open… also accepts `.dawproject`).

* `zip.js`: `writeZip(entries) / readZip(bytes) / zipText` — store + deflate (method 8), CRC-checked, UTF-8 names,
  no ZIP64. Deflate via `CompressionStream('deflate-raw')` when available, else `node:zlib`; a `{deflateRaw,
  inflateRaw}` codec can be injected (tests use node:zlib). `xml.js`: `el()/toXml()` writer + small `parseXml()`
  (no DOMParser needed — works in Node). `media.js`: WAV header info, mime/extension, safe names.
* `dawproject.js` — [DAWproject 1.0](https://github.com/bitwig/dawproject) (Bitwig, Studio One, Cubase…):
  `exportDawproject(project, {renders, sampleInfo}) -> {bytes, report}`, `importDawproject(bytes) -> {project, report}`.
  * Tracks → `<Track><Channel>` (Volume linear 0..2, Pan normalized 0..1 ↔ −1..1, Mute, Solo), buses → `role="effect"`
    channels with post-fader `<Send>`s, master → `role="master"`. A track's main output into a bus (`track.output`) is the
    channel `destination`. **Folders** → group tracks (`contentType="tracks"`, members nested inside); a folder's summing
    bus is its `role="submix"` channel (members' destination). Import: a top-level group track becomes a folder, its
    group channel the folder's summing bus (nested groups join the outer folder). **VCAs, mixer link groups, solo mode
    and folder flags** have no DAWproject 1.0 element: they go to `daw3/mixer.json` in the archive (members by Track
    id), daW³ restores them, other DAWs see the folders and the member faders (`report.unmapped` says so).
  * Instruments / code tracks → `<BuiltinDevice deviceRole="instrument" deviceID="daw3.instrument.<type>">` named after
    the preset, every number/enum/bool param as a `*Parameter` (automation targets) + a JSON State file
    (`plugins/*.json`, `format: 'daw3-device'`) that restores the device exactly in daW³ (referenced samples are
    exported with it). Compressor / Limiter / Gate / EQ (eq3, eq8) → the spec's generic `<Compressor>` /
    `<Limiter>` / `<NoiseGate>` / `<Equalizer>` (ratio ↔ percent `1−1/r`); other effects → `BuiltinDevice audioFX`.
  * **Take lanes** (Recording): the comp is written as the track lane's active clips (segments with their crossfades,
    `comment="daw3:comp:<takeId>:<start>:<end>"`), every take lane as a nested `<Lanes>` of disabled (= muted) clips
    (`comment="daw3:take:{id, pass, srcLength, gain}"`). Other DAWs play the comp and keep the takes as muted lanes;
    daW³'s import rebuilds `takeLanes` / `comp` (comp clips whose takes are gone stay ordinary clips; a foreign nested
    lane of only disabled clips becomes a take lane). No need to flatten comps before exporting.
  * Pattern clips → `<Clip playStart=offset loopStart=0 loopEnd=patternLength><Notes>` with the notes **unrolled**
    over the played range: loop-aware and loop-ignoring importers both play the right notes; the importer keeps
    `[loopStart, loopEnd)` as the pattern and dedupes identical clips into one shared pattern. Velocity = `vel`
    (× clip gain). Audio clips → `<Clip contentTimeUnit="beats" fade*><Warps>` (beats → seconds at natural speed)
    `<Audio><File path="audio/…">`; offsets / fades round-trip (`clip.fadeIn` / `clip.fadeOut` in beats, played by
    `MixGraph._playAudioClip`). Code tracks export their rendered notes as one clip (State restores the code).
  * Automation → `<Points><Target parameter=…>` in the owner's arrangement lane: volume, pan, mute, sends,
    instrument / effect params, effect on/off. Step lanes (mute, on/off, enums) are written as switch points
    (`stepPoints`, daW³ thresholds linear lanes); `hold` points import as vertical steps. Unmappable lanes
    (plugboard cables, disabled lanes) are omitted and listed in `report.unmapped`.
  * Tempo / meter → `<Transport>`; optional `project.tempoAutomation [{beat,bpm}]` / `project.timeSigAutomation
    [{beat,num,den}]` ↔ `<TempoAutomation>` / `<TimeSignatureAutomation>` (kept on import, but daW³ plays the first
    value — reported). Markers ↔ `<Markers>`.
  * *Render instrument tracks to audio alongside MIDI*: `renders[trackId]` (post-insert, pre-fader, pre-master
    renders from `stems.js` + `renderOffline`) become extra audio tracks `"<name> (audio)"` carrying the original
    fader / pan / sends + their automation, tagged `comment="daw3:rendered-from:<id>"` — skipped when daW³ re-imports
    its own file (the instrument is restored), kept otherwise.
  * Import of foreign devices: instruments → nearest daW³ preset by device / track name and note range; effects by
    name (reverb, delay, EQ, compressor…) with default settings; anything else stays a placeholder in
    `track.foreignDevices` (written back as an unloaded device of the same kind on export). Everything approximate
    or dropped (MIDI CC / expression automation, clip-launcher scenes, disabled clips, time-stretch, pre-fader sends,
    group processing) goes into `report` (`summarizeReport` → toast, details dialog).
* `stems.js` — "Export for mixing engineer": `stemVariant(project, trackId, {tap})` (`post-fader` = fader, pan,
  automation, sends; `post-insert` = unity, centre, no sends; both bypass the master), `renderStems(project, {render})`
  (one offline render per unmuted track with content, same `startBeat 0 … endBeat + tail` → identical lengths),
  `buildMixBundle()` → `Name/README.txt` (BPM, meter, key, sample rate, bit depth, tap), `Stems/NN Track.wav`
  (`encodeWav` at the chosen bit depth), `MIDI/Name.mid` (`exportMidi`), `Tempo map.txt`.
* `musicxml.js` — MusicXML 4.0 partwise lead sheet: the melody track (role lead/vocal, else most monophonic & highest)
  as a top-line skyline, quantized to 24 divisions per quarter (16ths, 32nds, triplets exact), split at barlines with
  ties, notatable values via `splitDuration`; key signature from `project.key`; chord symbols (`<harmony>`, MusicXML
  `kind` + `text`) from the project's harmony = the chords / pad track detected per beat (`harmonyChords`, bass from
  the bass track); tempo, rehearsal marks for markers, velocities as `dynamics`. Import (`.musicxml`, `.xml`,
  compressed `.mxl`): pitched notes (chords, ties, backup / forward, pickups) → one track + pattern per part;
  chord symbols → an optional chords track. Percussion (unpitched) and timewise scores are not supported.
* **AAF / OMF are out of scope.** Both are binary post-production containers (AAF = Microsoft Structured Storage
  with an object model of several hundred classes; OMF 2 a legacy Avid binary) built for audio/video editorial
  hand-off to Pro Tools / Media Composer: seconds-based timelines with audio and fades only — no notes, no musical
  time, no instruments or devices. A faithful writer needs a compound-document (CFB) implementation plus the AAF
  object model (or the AAF SDK, a native library), and what it can carry is a strict subset of the stems bundle and
  DAWproject (audio regions + volume/pan). For post-production delivery use the stems bundle (sample-accurate,
  identical lengths from 0:00) or DAWproject; Pro Tools users import the stems + MIDI.

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

## Instrument tracks on Strudel sounds (`src/audio/strudel-voice.js`, `strudel-patches.js`)

Instrument type `'strudel'` plays a superdough *patch* (`params` = Strudel controls: `s`, `n`, `gain`, ADSR, `lpf`,
`resonance`, `lpenv` + filter ADSR, `hpf`, supersaw `unison/detune/spread`, `fm/fmh` + FM envelope, `penv`, `vib`,
`vowel`, `shape`, `crush`, `pan`, `room/size`, `delay/delaysync/delayfeedback`) from notes and the live keyboard.
* `StrudelVoice` wraps a `StrudelInstrument` (same routing / offline path as code tracks — `MixGraph.strudelInstruments()`
  lists it, so renders claim superdough and flush sample loads). `ready` resolves once superdough AND the patch's
  sound (muted probe note) loaded; otherwise the track plays `fallbackPreset` (def field, else the patch's) with a
  built-in engine.
* Live edits: notes play at superdough's unity gain; patch gain + pan and a follow-the-knob low/high-pass live in a
  post stage (AudioParams), so knob moves reach sounding notes; a new `s` loads in the background.
* No AudioWorklets on a context (some headless browsers): supersaw -> 3 detuned saws, pulse -> square, shape/crush dropped.
* Curated patches: `STRUDEL_PATCHES` (ids `sd-*`, category 'Strudel' in `PRESETS`; gains loudness-matched to their
  fallback preset on a role phrase, so mix.js `levelFix` uses `role|strudel:<id>` or else the fallback's entry).
  `strudelValue(params)` = what superdough gets; `strudelPatchCode(params)` = the same as Strudel code
  (`.s("supersaw").adsr(…).lpf(…)…`, used by song-code / the live coder; envelope groups are sent whole or not at all).
* Generated songs (`src/gen/strudel-sounds.js`): every melodic role maps preset / GM instrument -> patch (genre
  overrides in `GENRE_STRUDEL`, dance-music hooks never a soft EP), the old def's preset as `fallbackPreset`; guitars,
  brass, saxes, fiddles, orchestral solos keep their multisamples; drums keep sampled machines. `opts.strudel: false`
  (or `soundfonts: false`) keeps the built-in instruments.

## Testing AudioWorklets (headless Chromium, `tools/browser-check/`)

**Why `addModule()` hung in automation**: not the sandbox, the audio sink or the headless mode — plain
`chrome --headless` without DevTools runs worklets fine (realtime and offline). Playwright attaches every page with
`Target.setAutoAttach({waitForDebuggerOnStart: true, filter: [iframe, worker, service_worker]})`; Chromium (140) still
parks every new AudioWorklet thread (target type `worklet`) waiting for a debugger although the filter excludes it, and
nobody attaches or resumes it — so `addModule()` never settles (always on an `AudioContext`, often on an
`OfflineAudioContext`; `data:` URLs sometimes slip through). Flags (`--no-sandbox`, `--disable-features=AudioServiceOut
OfProcess`, `--alsa-output-device=null`, fake media, headless shell vs new headless vs Xvfb) change nothing.

**Recipe**: open a second CDP session on the page *before* it creates audio contexts, auto-attach worklet targets
(waiting) and detach them immediately — detaching releases the wait:

```js
const cdp = await page.context().newCDPSession(page);
cdp.on('Target.attachedToTarget', (e) => cdp.send('Target.detachFromTarget', { sessionId: e.sessionId }).catch(() => {}));
await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'worklet' }] });
```

`tools/browser-check/browser.mjs` does this (`launch()` / `enableWorklets(page)`, plus autoplay / fake-media flags and
`serveRepo()` = `scripts/serve.js` on a free port, killed by PID). playwright-core comes from `$PLAYWRIGHT_CORE`, the
repo / cwd `node_modules` or `/tmp/claude-0/pw`; Chromium from `$CHROME` or `/opt/pw-browsers/chromium-*`. Checks (each
exits non-zero on failure):

| script | verifies |
|---|---|
| `worklet-smoke.mjs` | blob + every daW³ worklet module loads (realtime + offline) and processors produce audio |
| `loudness-check.mjs` | `daw3-loudness` worklet vs `measureLoudness` (Node DSP): integrated LUFS ±0.2 LU, true peak ±0.2 dB |
| `warp-check.mjs` | warped drum loop on the grid at 90 / 120 / 150 BPM (< 3 ms); live tempo edit retimes a playing clip |
| `record-check.mjs` | capture worklet and ScriptProcessor fallback stamp an impulse at its exact frame, chunks contiguous |
| `stream-check.mjs` | 10-minute WAV streams, seeks, stays in sync; warped (beats / tones) streamed clips, no full decode |
| `superdough-check.mjs` | supersaw through superdough's worklet realtime and offline; level vs the worklet-free stand-in |
| `faust-check.mjs` | Faust instrument (realtime) and instrument → effect (offline); `FAUSTWASM_DIR=<unpacked npm pack>` serves jsDelivr locally, else skipped when the CDN is unreachable |

`harness.js` (served, imported by the page code): `makeEngine(project)`, `wavSample`, `captureOutput(ctx, node)`
(sample-accurate worklet recorder), `onsets`, `drumLoop`.

## Licensing

daW³ is AGPL-3.0-or-later (`LICENSE`), because it ships Strudel (AGPL-3.0-or-later; © Strudel contributors,
https://codeberg.org/uzu/strudel). Third-party licenses of the vendored bundles: `vendor/strudel/licenses/` and
`vendor/strudel/VERSION`. AGPL §13: the app offers its source to every user — main menu ▸ "About / credits & source
code" and the Help dialog link to `SOURCE_URL` (`src/ui/actions.js`); keep that link pointing at the deployed code.
MP3 export uses lamejs 1.2.1 (pure-JS LAME 3.99, LGPL-3.0 — combinable with AGPL-3.0; it stays a separate, replaceable
library loaded at runtime): `vendor/lamejs/` holds it with `LICENSE` (LGPL-3.0 + GPL-3.0 texts), `README.txt` and
`daw3-modifications.diff` (ES-module export, ABR loop port, encoder delay / padding getter).

