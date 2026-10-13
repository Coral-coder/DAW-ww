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

`index.html` links every CSS file above. Run the app with `npm start` (http://localhost:5173, add `?nowelcome`
to skip the welcome dialog). Chromium for automated checks: Playwright is pre-configured
(`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`); install `playwright-core` in a scratch dir under /tmp/claude-0/,
never in the repo. `window.daw3` exposes the app object for automation.
