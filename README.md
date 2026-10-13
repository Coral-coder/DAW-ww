# ⚡ HEROIC DAW

A feature-rich digital audio workstation that runs entirely in your browser — no install, no plugins, no dependencies.
It takes ideas from Ableton, Bitwig, FL Studio, Reason, Logic, GarageBand and Strudel: multi-track sequencing, polyphonic synths,
drum machines, sampling, generative composition based on music theory, an assistant that makes suggestions as you work,
and a Strudel-compatible live-coding engine.

## Quick start

```bash
npm start          # serves the app at http://localhost:5173 (Node 18+, no npm install needed)
npm test           # runs the unit tests (node:test)
```

Any static file server works — it's plain ES modules.

## What's inside

| Area | Highlights |
|------|-----------|
| **Arrangement** | Timeline with pattern & audio clips, markers, loop region, split/duplicate/trim, drag-and-drop samples |
| **Scenes** | Clip-launcher grid: launch pattern combinations live, capture scenes, scenes → arrangement |
| **Step Rack** | FL-style channel rack: 16-pad drum rows, accents, ghosts, ratchets, euclidean fills, 1/32 rolls |
| **Piano Roll** | Scale highlighting, fold-to-scale, chord stamps, chord suggestions, quantize/humanize/strum, velocity lane |
| **Mixer** | Channel strips, inserts, sends to Reverb/Delay buses, master chain with limiter, meters & spectrum |
| **Instruments** | Analog (3-osc, unison, dual LFO, mono/glide), 4-op FM, drawbar organ, sampler with slicing, 20 drum kits, 70+ presets |
| **Effects** | EQ, filter, compressor, limiter, distortion, bitcrusher, delay, reverb, chorus, flanger, phaser, tremolo, autopan, widener, pump (sidechain-style), tape, utility |
| **Generators** | 45+ genres: full songs, drums, chord progressions, basslines, melodies, arps — all music-theory driven and seedable |
| **Assistant** | Live recommendations: next chords, out-of-key notes, mix issues, arrangement ideas, genre tips — one-click fixes |
| **Code** | Strudel-compatible mini-notation & pattern functions; import `.strudel` files, play alongside tracks, render to editable patterns, export any project as Strudel code |
| **Files** | Save/load `.heroic.json` projects (samples embedded), browser autosave, WAV mixdown & stems, MIDI import/export |

## Keyboard

`Space` play/pause · `Enter` stop · `1–6` views · `P` pattern/song · `L` loop · `M` metronome · `R` record ·
`` ` `` computer-keyboard piano (Z…M / Q…P, `-`/`=` octave) · `Ctrl+Z / Ctrl+Shift+Z` undo/redo · `Ctrl+S` save · `Ctrl+O` open · `Ctrl+E` export WAV · `?` help.

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/UI.md`](docs/UI.md). In short:

```
src/core    data model + undo store          src/audio   Web Audio engine, instruments, effects, offline render
src/theory  scales, chords, harmony analysis  src/gen     genre-aware generators + assistant
src/code    Strudel-style pattern engine      src/io      project files, MIDI, WAV, autosave
src/ui      views, panels, components
```
