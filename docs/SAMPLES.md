# Sample library (real drum machines & Strudel sounds)

`src/audio/library/*` streams the same sample collections [Strudel](https://strudel.cc) uses, straight
from their GitHub repositories, at runtime. **daW³ does not bundle or redistribute any of these
files**: users' browsers fetch them from the original repositories (exactly like strudel.cc), and every
sampled sound falls back to a synthesized one when the network is unavailable.

## Sources, URL layouts and licenses

| Collection | Used for | Map / URL layout | License |
|---|---|---|---|
| [ritchse/tidal-drum-machines](https://github.com/ritchse/tidal-drum-machines) | 35 sampled drum machines (`drums` + `params.machine`, `drumsampler`, `.bank(...)` in code) | `https://raw.githubusercontent.com/ritchse/tidal-drum-machines/main/machines/<Machine>/<machine lowercase>-<key>/<file>.wav`. Strudel's map: `felixroos/dough-samples/main/tidal-drum-machines.json` (key `<Machine>_<key>`, e.g. `RolandTR909_bd`). The catalog we use is embedded in `drum-machines-data.js` (generated from that map). | **No license file** in the repo. These are recordings of vintage hardware collected for TidalCycles/SuperDirt and are used by strudel.cc the same way. We only reference them at runtime. If a license-clean default is required, use `VCSLAcoustic` (below). |
| [tidalcycles/Dirt-Samples](https://github.com/tidalcycles/Dirt-Samples) | bare Strudel names in code tracks: `bd sd hh cp casio jazz metal east crow insect wind jvbass …` (= `samples('github:tidalcycles/dirt-samples')`) | map `https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/strudel.json` (`_base` + `name: [files]`) | No single license (collected from many contributors for TidalCycles tutorials); runtime reference only. |
| [sgossner/VCSL](https://github.com/sgossner/VCSL) (Versilian Community Sample Library) | `VCSLAcoustic` drum kit (real velocity layers + round robins), VCSL names in code (`marimba`, `kalimba`, `vibraphone`, `harp`, `steinway`…) | map `https://raw.githubusercontent.com/felixroos/dough-samples/main/vcsl.json`; files under `https://raw.githubusercontent.com/sgossner/VCSL/master/…` | **CC0** (public domain) — freely redistributable. |
| Salamander Grand Piano V3 (Alexander Holm) via [felixroos/dough-samples](https://github.com/felixroos/dough-samples) | `s("piano")` (note-keyed map embedded in `strudel-sounds.js`) | `https://raw.githubusercontent.com/felixroos/dough-samples/main/piano/<Note>v8.mp3` | **CC-BY 3.0** — credit: *Salamander Grand Piano by Alexander Holm*. |

Credits: TidalCycles / Strudel (Alex McLean, Felix Roos and contributors) for the collections and the
`strudel.json` format; ritchse (geikha) for tidal-drum-machines; Versilian Studios / Sam Gossner for VCSL;
Alexander Holm for the Salamander piano.

## Strudel conventions we follow

* `samples('github:owner/repo[/branch]')` → `https://raw.githubusercontent.com/owner/repo/<branch, default main>/strudel.json`
  (the `github:tidalcycles/dirt-samples` shortcut maps to the repo's `master` branch).
* strudel.json: `{ "_base": "...", "name": ["file", ...] | "file" | { "C4": "file", ... } }`; per-entry `_base` allowed.
* `.bank("RolandTR909")` + `s("bd")` → sound `RolandTR909_bd`; bank names are case-insensitive and Strudel's
  alias map (`tidal-drum-machines-alias.json`: `TR909`, `TR808`, `LM1`, `SP12`, `MPC60`, …) is embedded.
* Sample index: `bd:3` or `.n(3)` → `round(n) mod count`. Note-keyed maps pick the closest key and repitch;
  array maps repitch relative to MIDI 36 when a `note` is given. `speed` (negative = reverse), `begin/end`,
  `loop`, `cut` (previous sound in the group fades over 10 ms), `clip`/`release`, `loopAt` (`unit:'c'`).

## Resolution order in code tracks

1. Synth waveforms (`sine`, `sawtooth`, `supersaw`, noise…) — always synthesized.
2. Project samples by name (user imports).
3. Library samples: bank / `Machine_key` names → registered maps (piano, `registerSamples`) → Dirt-Samples names
   → VCSL names → DAW drum names Dirt lacks (`oh`, `rim`, `kick`…) on the default machine (TR-909).
   A machine missing a sound uses the pad fallback rules (e.g. `.bank("RolandTR606").s("cp")` still claps).
4. Anything not loaded yet / unreachable → the previous synthesized behaviour (drum kits, presets).

## Drum machines (`drum-machines.js`)

`DRUM_MACHINES` (35 + VCSL), `resolvePadSamples(machine)` maps the 16 GM pads (`DRUM_PADS`) onto each machine:
the machine's own sound first, then same-machine substitutes (missing mid tom → low tom +3 st, open hat →
closed hat ringing, ride ↔ crash), then companion machines (TR-808 → LinnDrum → TR-707 → TR-909), then weak
substitutes (tambourine ↔ shaker, clave → rim +5 st). `preferredKitForGenre(genreId, family)` /
`drumInstrumentForGenre(genreId, {kit})` give generated songs a machine.

Instruments: a regular `drums` instrument with `params.machine` (recommended: every drum view keeps working,
`params.kit` is the synthesized fallback) or the `drumsampler` type. Per pad: tune, decay, tone, level, pan,
mute, project-sample override and `variant` (which of the machine's sounds). Global: pitch, decay, tone,
`roundRobin`, `humanize`. Closed hat chokes open hat; velocity → gain + low-pass for single-layer samples,
real velocity layers for VCSL.

## Loading & caching (`sample-library.js`)

* Mirrors: `raw.githubusercontent.com` first, `cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/…` second
  (`library.setMirrorOrder()` swaps them). jsDelivr refuses GitHub repos > 50 MB (tidal-drum-machines,
  Dirt-Samples), so raw is the reliable primary; a mirror that keeps failing for a repo is tried last.
* Raw bytes: memory + Cache Storage (`daw3-samples-v1`) → reloads are instant and work offline.
  Decoded `AudioBuffer`s are cached per sample rate. 6 concurrent fetches, 20 s timeout, failures
  remembered for 30 s. Events: `library.on('progress' | 'decoded' | 'error', fn)`.
* Offline render: sampled drum instruments expose `ready` (awaited like plugin instruments) and code tracks
  are prepared by `prepareCodeSamples()` before scheduling; anything that fails renders with the synth fallback.
* Realtime: code samples are prefetched when code evaluates; drum instruments load on creation. Hits that
  arrive before a sample is decoded play the synthesized voice.
