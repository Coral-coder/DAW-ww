# daW³ for iOS

A small native app around **daW³ Pocket** (the phone layout in `src/mobile/`). It runs the same web app,
bundled offline, in a `WKWebView`, and adds what Safari can't do:

| | Safari / home-screen PWA | iOS app |
|---|---|---|
| MIDI keyboards & controllers | ✗ (no Web MIDI on iOS) | ✓ CoreMIDI, through a `navigator.requestMIDIAccess` polyfill |
| Keeps playing when locked / in background | ✗ | ✓ `UIBackgroundModes: audio`, `.playback` session |
| Plays with the silent switch on | Safari 16.4+ only | ✓ |
| Open `.daW3` / MIDI / audio from Files, AirDrop, Mail ("Open in daW³") | ✗ | ✓ |
| Import from Files / Save to Files / share sheet | partly | ✓ native pickers + share sheet |
| Other apps' MIDI into daW³ (AUM, sequencers) | ✗ | ✓ virtual MIDI destination "daW³" |
| Audio interfaces (USB / Lightning) | system route | system route + preferred sample-rate / buffer via the bridge |
| AUv3 instruments / effects | ✗ | discovery today, hosting later (see below) |

No Capacitor / Cordova: the native side is ~1,000 lines of Swift (a scheme handler, a message handler, CoreMIDI,
the audio session, document pickers). A framework would add a dependency, a CLI and a generated project for little
gain, and Capacitor's plugin model doesn't help with the parts that matter here (MIDI, audio session, AUv3).

## Layout

```
ios/
  project.yml                 XcodeGen spec (the .xcodeproj is generated, not committed)
  scripts/bundle-web.sh       build phase: copies index.html, src/, styles/, vendor/, icons/, manifest into daW3.app/web
  daW3/App/                   AppDelegate + SceneDelegate ("Open in daW³"), WebViewController (WKWebView setup)
  daW3/Bridge/                SchemeHandler (daw3://localhost), NativeBridge (JS <-> native), MIDIManager (CoreMIDI + UMP),
                              AudioSessionManager, AUv3Catalog
  daW3/Web/daw3-native.js     JS half of the bridge, injected at document start (window.daw3Native + Web MIDI polyfill)
  daW3/Info.plist             .daW3 document type (UTI com.coralcoder.daw3.project), background audio, microphone text
  daW3Tests/                  XCTests hosted in the app (boot, bridge, CoreMIDI virtual endpoints <-> Web MIDI shim)
```

How it works:

- **Offline web app, real origin.** The page loads from `daw3://localhost/index.html` served by a `WKURLSchemeHandler`
  out of the bundle, so ES modules, `fetch()`, AudioWorklet modules, `localStorage` and IndexedDB (autosaves, recent
  songs) all work with no server. Online features (sample packs from CDNs) still use the network when available.
  The service worker is not used (not supported on custom schemes, and not needed).
- **Pocket layout.** iPhone opens `index.html?mobile=1`; iPad defaults to Pocket but the menu can switch to the desktop layout.
- **Audio session.** `.playback` without `.mixWithOthers` (other apps' audio stops, the silent switch is ignored, playback
  continues when locked). The bridge wraps `getUserMedia`: opening the mic switches to `.playAndRecord`
  (`.defaultToSpeaker`, Bluetooth A2DP) and back to `.playback` when the last mic track stops. Interruptions (calls,
  Siri) resume the AudioContext when they end.
- **Bridge.** `window.daw3Native` matches the Mac app's preload where they overlap
  (`isNative`, `platform` = `'ios'`, `openFiles`, `saveFile`, `readFile`, `pathForFile`, `onCommand`, `ready`) and adds
  `share`, `info`, `midi`, `audio`, `auv3`. JS → native is `webkit.messageHandlers.daw3.postMessage({ v: 1, cmd, args })`
  answered through `WKScriptMessageHandlerWithReply` (a Promise); native → JS is batched events via
  `window.__daw3NativeReceive([...])`. Bytes go to native as base64; files go to JS as `daw3://localhost/__files/…`
  URLs the bridge fetches (no base64 for big audio). The schema is documented at the top of `daw3-native.js` and
  checked by `tests/ios-bridge.test.js` against `NativeBridge.swift`.
- **MIDI.** `navigator.requestMIDIAccess()` returns a Web-MIDI-shaped `MIDIAccess` (`inputs` / `outputs` Maps,
  `onmidimessage`, `addEventListener('midimessage')`, `send(data, timestamp)`, `onstatechange` on hot-plug, `sysex`
  gate). Natively every CoreMIDI source is connected through a MIDI-1.0-protocol input port; Universal MIDI Packets are
  converted to MIDI 1.0 bytes (including multi-packet sysex) and back. The existing "MIDI keyboard input" code works
  unchanged (Pocket ▸ Menu ▸ *MIDI keyboard input*).
- **Files.** Pocket ▸ Menu ▸ *Import from Files…* (audio, MIDI, `.daW3`), Save/Share buttons use the share sheet and
  "Save to Files" (export picker), and `.daW3` files open in daW³ from Files / AirDrop / Mail; MIDI and audio files show
  daW³ under "Open in…" too.

## Install it on your iPhone (no App Store)

You need a Mac with Xcode 15 or newer, and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).

```sh
git clone -b ios https://github.com/Coral-coder/DAW-ww.git daw3 && cd daw3/ios
xcodegen generate
open daW3.xcodeproj
```

Then in Xcode:

1. **Sign in**: Xcode ▸ Settings ▸ Accounts ▸ **+** ▸ Apple ID. A free Apple ID works.
2. Select the **daW3** target ▸ *Signing & Capabilities* ▸ tick *Automatically manage signing* ▸ pick your **Team**
   ("Your Name (Personal Team)").
3. Change the **Bundle Identifier** to something unique to you, e.g. `com.yourname.daw3` (a free account can't use
   `com.coralcoder.daw3`). Do the same for the `daW3Tests` target if Xcode complains.
4. Plug in the iPhone (or pair it over Wi-Fi), unlock it, tap **Trust**. On iOS 16+, enable
   *Settings ▸ Privacy & Security ▸ Developer Mode* (restart required), then pick the phone as the run destination.
5. Press **Run** (⌘R). The first time, iOS blocks the app: *Settings ▸ General ▸ VPN & Device Management* ▸ your
   Apple ID ▸ **Trust**. Run again.

| Account | How long the app runs | Devices | Notes |
|---|---|---|---|
| Free Apple ID (Personal Team) | **7 days**, then re-run from Xcode | your own, up to 3 apps | no TestFlight / ad hoc |
| Paid Apple Developer Program | 1 year | up to 100 registered iPhones (ad hoc) | or TestFlight internal testing (up to 100 testers, no App Review); nothing is published publicly |

With a paid account, to give the app to a few people without the App Store: Product ▸ **Archive** ▸ *Distribute App* ▸
**Release Testing / Ad Hoc** (register their device UDIDs first in the developer portal), or **TestFlight Internal Only**.
Never choose "App Store Connect ▸ App Store" if you don't want it public — internal TestFlight builds are not listed anywhere.

Debugging the web side: on the Mac, Safari ▸ Settings ▸ Advanced ▸ *Show features for web developers*, then
Safari ▸ Develop ▸ *your iPhone* ▸ daW³ (the web view is inspectable).

Editing the web app: change files under `src/`, `styles/`, … and press Run — the build phase re-copies them into the app.

### CI builds

`.github/workflows/ios.yml` (push to `ios`, or *Run workflow*) generates the project, builds and runs the XCTests on an
iOS Simulator, and uploads an artifact **daW3-ios** with:

- `daW3-simulator.zip` — the simulator app (`xcrun simctl install booted daW3.app`),
- `daW3-unsigned.ipa` and `daW3-unsigned.xcarchive.zip` — an **unsigned** device build. iPhones only run signed apps:
  re-sign it locally with your own identity, e.g. with [`zsign`](https://github.com/zhlynn/zsign) or
  `codesign` + a provisioning profile, or open the archive in Xcode's Organizer. Building from source in Xcode (above)
  is simpler and is the recommended path.

## AUv3 hosting — design

**Today:** `daw3Native.auv3.list({ kind })` lists installed Audio Units (instruments `aumu`, effects `aufx`,
MIDI-controlled effects `aumf`, MIDI processors `aumi`, generators `augn`) via `AVAudioUnitComponentManager` —
name, manufacturer, four-char codes, version, MIDI in/out, tags, whether it is a v3 extension.

**The constraint.** daW³'s audio graph is Web Audio running inside WebKit's out-of-process audio (GPU/WebContent
process). The app process cannot insert nodes into it, tap its output, or feed samples into it at audio rate: there is
no API to put an `AUAudioUnit` inside an `AudioContext`, and a bridge round-trip (postMessage / scheme-handler fetch)
is milliseconds of jitter, never sample-accurate. So an AU's audio cannot simply be "mixed into the WebView's output".

**Options:**

1. **Parallel native engine (recommended for live play).** The app runs an `AVAudioEngine` next to WebKit's audio;
   hosted AUs (`AVAudioUnit.instantiate(with:options: .loadOutOfProcess)`) render into its main mixer and go straight
   to the hardware, which mixes both apps-within-the-app. The JS sequencer keeps scheduling: for tracks whose
   instrument is an AU it sends timestamped note events over the bridge (`{ id, bytes, when }`), and native schedules
   them with the AU's `scheduleMIDIEventBlock` at the matching `AVAudioTime` (host-time anchored: JS sends
   `AudioContext.getOutputTimestamp()` pairs so native can map context time → host time, re-synced every bar).
   Mixer volume / pan / mute for those tracks are mirrored to native nodes. Costs: two output latencies to align
   (measure `outputLatency` on both sides and delay the earlier one), and Web Audio effects/sends cannot process AU
   audio (the AU track gets native effects or none). The plugin UI is the AU's `requestViewController`, presented as a
   native sheet over the WebView.
2. **Offline render ("freeze / bounce").** Native renders an AU track with `AVAudioEngine` manual rendering
   (`enableManualRenderingMode(.offline, …)`) from the MIDI the JS side sends, writes a WAV and hands it back as a
   `daw3://…/__files/` URL — it becomes an ordinary audio clip in daW³ with all Web Audio effects. Sample-accurate, works
   for export; not for live playing. Pairs well with option 1 (play live natively, freeze to commit).
3. **Native audio engine for everything.** Move the whole DSP graph native (JS keeps UI + sequencing). Cleanest
   sync and lowest latency, but rewrites daW³'s instruments/effects — out of scope.
4. **Inter-app audio / AUM-style.** Expose daW³ itself as an AUv3 or rely on the "daW³" virtual MIDI destination so
   AUM / other hosts play AUs from daW³'s MIDI. Zero hosting code — works today for sequencing external AUs.

Plan: (4) works now; then (1) for instrument AUs with (2) as "freeze"; effects AUs on Web Audio tracks would need (2) or (3).
