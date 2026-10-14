# UI contract (for view/panel authors)

Read `docs/ARCHITECTURE.md` first. UI code is plain ES modules + DOM + canvas, no framework.

## The `app` object (passed to every view/panel factory)

```
app.store        Store (src/core/store.js) — store.get(), store.transact(label, fn, {coalesce, undo})
app.ui           UIState (src/ui/state.js) — ui.get(key), ui.set({...}); keys: view, selectedTrackId,
                 selectedPatternId, selectedClipIds[], browserOpen, assistantOpen, deviceOpen, deviceHeight,
                 deviceTarget ({kind:'bus'|'master', id}|null), deviceFocus (fxId to reveal in the device panel),
                 recording, followPlayhead, keyboardOctave, snap, theme
app.engine       AudioEngine — play/pause/stop/setPosition/getPosition()/isPlaying, noteOn/noteOff(trackId,pitch,vel),
                 getMeter(id|'master') -> {l,r}, getAnalyser(), decodeSample(id), auditionSample(id),
                 on('position'|'state'|'code-error'|'code-ok'|'samples', fn), ctx (null until first user gesture)
app.actions      see src/ui/actions.js (read it!) — selectTrack, selectPattern, addTrack(kind, opts), deleteTrack,
                 duplicateTrack, updateTrack(id, fn, label, opts), trackMenuItems(id), addTrackMenuItems(),
                 newPattern, duplicatePattern, deletePattern, ensurePattern, setPatternNotes,
                 liveNoteOn/liveNoteOff(pitch, vel), generatePart(role, {trackId}), generateSong, importSamples,
                 placeSample(sampleId, {trackId, start}), sampleToSampler(sampleId, trackId), importStrudel(file),
                 renderCodeToTracks(trackId), exportCode(trackIds), applyAssistantAction(action), setPosition, ensureAudio …
app.subscribe(fn) rAF-batched callback fn({project:boolean, ui:{changedKeys…}, labels:[]}) — called after any
                 store or ui change. Return value = unsubscribe.
app.toast(msg, {level:'info'|'success'|'warn'|'error'})
app.setStatus(text)  status-bar message
app.showView(id)
app.emitLiveNote  (set by piano view if it wants to highlight keys) — optional hook
app.automation   automation recorder (src/ui/automation-recorder.js): recording, armed, toggleArm(), setMode(m),
                 recordingKeys(), liveSegments(owner, target), isWriting(owner, target), revealLane(owner, target),
                 on('update'|'tick'|'state', fn). UI keys: autoArm, autoMode ('touch'|'latch'|'write')
```

## View / panel factory signature

```js
export function createXView(app) { return { el, show?(), hide?() } }
```
* `el` fills its container (views are `position:absolute; inset:0; display:flex; flex-direction:column`).
  Put a `.view-toolbar` at the top, then the content area with `flex:1; min-height:0`.
* Subscribe with `app.subscribe` and update only if visible (`show/hide` toggled) — but keep state consistent
  when shown again (re-render on `show()`).
* Animations (playheads, meters) use your own `requestAnimationFrame` loop that stops while hidden.
* Edits: always via `store.transact(label, fn)`; use `{coalesce:true}` while dragging and a final transact on release
  (or coalesce throughout — coalescing merges into one undo step).
* Canvas drawing: use `fitCanvas(canvas)` from `src/ui/dom.js` for HiDPI; redraw on resize (ResizeObserver).
* Automation: tag every control that edits an automatable setting with `markAuto(el, ownerId, target)`
  (ownerId = track id | bus id | 'master'; `paramPanel({auto:{owner, prefix}})` tags its controls). Tagged controls
  follow their lanes during song playback (via `el.autoSet(v)` or `el.setValue(v)`), get a dot marker and the
  right-click "Show / Add / Clear automation lane" menu. Custom drag controls should call `touchStart(el)` /
  `touchEnd(el)` so TOUCH-mode recording knows when the user lets go. Target metadata: `src/ui/automation-targets.js`.
* Hardware control (`src/control/*`, `app.control`): every `markAuto`-tagged control is automatically MIDI-learnable
  (right-click → "MIDI learn…", header MIDI button = learn mode) and drivable from Mackie/HUI surfaces — nothing to do
  in your view. Global keyboard shortcuts are commands in `src/control/commands.js` (rebindable in Preferences →
  Shortcuts, listed in the Ctrl/Cmd+K palette); add new global actions there, not as hard-coded keys.
* Reuse components from `src/ui/components.js` (knob, fader, toggle, select, numberField, button, iconButton,
  paramPanel, meter, modal, toast, contextMenu, promptText, confirmDialog, tabs, fileInput) and `h`, `icon`,
  `startDrag`, `fitCanvas`, `cssVar` from `src/ui/dom.js`.
* Styling: put your CSS in your own file under `styles/` (listed below) using CSS variables from
  `styles/main.css` (`--bg`, `--bg-2..4`, `--panel`, `--line`, `--text`, `--text-2/3`, `--accent`, `--accent-2`,
  `--accent-3`, `--good`, `--warn`, `--bad`, `--grid-bar/beat/step`, `--white-key`, `--black-key`, `--mono`).
  Must look good in dark and light themes. Prefix classes with your view name to avoid collisions.
* Keyboard: global shortcuts live in `src/ui/keyboard.js` (Space, 1–7, letters…). For view-specific shortcuts
  (Delete, Ctrl+A/C/V/D, arrows) add a `keydown` listener on window that checks your view is visible and that
  `isTyping(e)` (exported from keyboard.js) is false; call `e.preventDefault()` + `e.stopImmediatePropagation()`
  only for keys you handle.
* Discoverability ("easy to understand with nested features"): show the simple controls by default, put power
  features in context menus, "More ▾" dropdowns, collapsible `<details>` sections, and tooltips (`title`) on
  every control. Empty states must explain what to do next with a button that does it.

## Files

| Area | JS | CSS |
|------|----|-----|
| Arrangement timeline | `src/ui/views/arrange.js` (`createArrangeView`) | `styles/arrange.css` |
| Scenes / clip launcher | `src/ui/views/session.js` (`createSessionView`) | `styles/session.css` |
| Step rack (channel rack) | `src/ui/views/rack.js` (`createRackView`) | `styles/rack.css` |
| Piano roll | `src/ui/views/piano.js` (`createPianoView`) | `styles/piano.css` |
| Mixer | `src/ui/views/mixer.js` (`createMixerView`) | `styles/mixer.css` |
| Code | `src/ui/views/code.js` (`createCodeView`) | `styles/code.css` |
| Browser (left) | `src/ui/panels/browser.js` (`createBrowserPanel`) | `styles/panels.css` |
| Assistant (right) | `src/ui/panels/assistant.js` (`createAssistantPanel`) | `styles/panels.css` (assistant section) |
| Guided session (assistant "Guide" tab) | `src/ui/wizard.js` (`createWizard`; pure logic in `src/ui/wizard-core.js`) | `styles/wizard.css` |
| Device panel (bottom) | `src/ui/panels/device.js` (`createDevicePanel`) | `styles/device.css` |
| Plugboard (patch bay + project routing) | `src/ui/views/patch.js` (`createPatchView`) | `styles/patch.css` |
| Hardware control (MIDI devices, learn, surfaces, sync, palette, shortcuts) | `src/control/index.js` (`installControl`; Node-safe logic in `src/control/{midi,mapping,devices,router,surface-protocol,surface,grid,clock,link-client,shortcuts,targets}.js`; Link bridge `tools/link-bridge/`) | `styles/control.css` |
| Setlist (endless DJ set, view 8) | `src/ui/views/setlist.js` (`createSetlistView`; logic `src/live/setlist-engine.js` pure + `src/live/setlist-runner.js`, `app.setlist`) | `styles/setlist.css` |

`index.html` links every CSS file above. Run the app with `npm start` (http://localhost:5173, add `?nowelcome`
to skip the welcome dialog). Chromium for automated checks: Playwright is pre-configured
(`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`); install `playwright-core` in a scratch dir under /tmp/claude-0/,
never in the repo. `window.daw3` exposes the app object for automation.

## daW³ Pocket (phone layout, `src/mobile/`)

Phones / small touch screens (width ≤ 820, or a coarse pointer with width ≤ 1024) start the Pocket shell instead of
the desktop layout; `?mobile=1` / `?mobile=0` force it, Menu ▸ "Pocket layout" / Pocket menu ▸ "Desktop layout"
switch and remember the choice (`localStorage['daw3-layout']`). Both layouts share `createCore()` (store, engine,
actions, generators) — projects are the same `.daW3` files.

| Area | JS |
|------|----|
| Shell: transport, swipeable pages + tab bar, hash routes (`#/notes`, `#/track/<id>`) | `src/mobile/shell.js`, pure logic `router.js`, `mode.js` |
| Touch kit: bottom sheets (pull down to close), action sheets, long-press, hold-repeat, haptics | `src/mobile/touch.js` |
| Control popup (big slider with vertical-distance fine mode, − / + with hold-repeat, presets, reset, typed entry, automate / lock), drag tiles, vertical faders | `src/mobile/controls.js`, pure logic `param-logic.js` |
| Pages: Create, Tracks, Track, Notes (touch piano roll + drum step grid), Play (keys / chords / piano / pads), Mix, Setlist | `src/mobile/pages/*.js`, roll geometry `roll-core.js` |
| Hum / whistle to notes: mic capture (AudioWorklet, ScriptProcessor fallback), live pitch, review, "Use" | `src/mobile/hum.js`, `capture-worklet.js`, pure DSP `pitch.js` (YIN, segmentation, quantize, scale snap) |
| Take analysis off the main thread: module Worker (`hum-worker.js`) with progress; sliced main-thread fallback | `src/mobile/hum-analysis.js` (message protocol `analyze` → `progress`* → `result` / `error`) |
| Song page (`#/arrange`): touch timeline — pinch zoom, tap = select, drag selected clip = move (snap bar / beat / off), drag edges = trim / loop longer, long-press = clip / lane menus, tap empty = add a clip of the track's pattern, markers (tap to add, drag, menu: rename / loop / extend / remove section), loop bar, ruler scrub, follow playhead, Song / Loop, extend song | `src/mobile/pages/arrange.js`, pure math `arrange-core.js` |
| Touch automation lanes: freehand draw (RDP-thinned), tap to add, drag points, long-press to delete, ramps / LFOs / clear, lane on/off + "re-enable" for overridden lanes; docked under the Song timeline, as a sheet from "Automate this" (control popup) and on the Track page | `src/mobile/auto-lane.js`, pure `auto-core.js` |
| Code page (`#/code`, `#/code/<trackId>`): highlighted Strudel code of the song / code tracks, Edit mode (16 px textarea), snippet bar (insert at cursor), Apply = the desktop's apply path | `src/mobile/pages/code.js`, `code-core.js`, shared `src/code/song-apply.js` |
| Drum pad sheet (tap a pad name on the step grid / Track page): tune, decay, tone, level, pan, variation, mute — automatable `inst:pads.<pad>.<key>` | `src/mobile/pad-sheet.js`, `pad-logic.js` |
| Song / Notes multi-select: Select mode (tap = add / remove, drag empty = lasso), long-press + drag = lasso, count chip + action bar (Song: duplicate / move to track / delete / select all in track · section · loop; Notes: transpose ▲▼ (scale steps with the lock), quantize, velocity, duplicate, delete); cross-track clip drags (pattern clips → same-kind instrument tracks, audio → audio; valid lanes lit; patterns re-homed / copied like the desktop) | `pages/arrange.js`, `pages/notes.js`, pure `arrange-core.js` (canDrop, dropLanes, moveClips, fixOwnership, clipsInBox…), `roll-core.js` (notesInBox, moveNotes, transposeNotes, quantizeNotes, setVelocity…) |
| Mix extras: strips in track order (drag ≡ sideways = reorder tracks; landing inside a folder joins it), folder tabs (tap = collapse), group badges (linked faders / mute / solo via `applyLinkedEdit`), VCA strips, ❄ frozen marks, LUFS chip (short-term / integrated; tap = loudness sheet) | `pages/mix.js`, pure `mix-core.js` |
| Pro features as sheets: freeze / bounce / flatten + "Recording takes" in every track menu (`app.freezeMenuItems`), takes per section (song markers) + flatten comp, tempo & meter change lists (Song ▸ More, Menu, long-press ♩), pro export (loudness presets, stems, report), version history (recovery snapshots), MIDI devices (Web MIDI; inputs play the selected track) | `src/mobile/pro.js`, pure `pro-core.js` |
| Drag-reorder (tracks, effects — drag the ≡ grip), first-launch tips (3 cards, `localStorage['daw3-pocket-onboarded']`), undo / redo in the transport (long-press undo = history) | `src/mobile/reorder.js`, `onboarding.js`, `shell.js` |

Styles: `styles/mobile.css` (loaded by the shell only; classes prefixed `pk-`). Tests: `tests/mobile-*.test.js`.
