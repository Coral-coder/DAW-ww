// Pocket inside the iOS app (ios/): wires window.daw3Native (injected by the app, see ios/daW3/Web/daw3-native.js)
// into Pocket — documents opened from Files / AirDrop ("Open in daW³"), Files-app import, MIDI keyboards.
// A no-op in the browser.

export const nativeBridge = () => (typeof window !== 'undefined' && window.daw3Native) || null;

const PROJECT_RE = /\.(daw3|json)$/i;
const MIDI_RE = /\.(mid|midi|smf)$/i;
const AUDIO_RE = /\.(wav|wave|aif|aiff|aifc|caf|mp3|m4a|aac|mp4|ogg|oga|opus|flac|webm)$/i;

/** Split files by what daW³ does with them: { projects, midi, audio, other } (by file name). Pure. */
export function routeFiles(files) {
  const out = { projects: [], midi: [], audio: [], other: [] };
  for (const f of files || []) {
    const n = String(f?.name || '');
    if (PROJECT_RE.test(n)) out.projects.push(f);
    else if (MIDI_RE.test(n)) out.midi.push(f);
    else if (AUDIO_RE.test(n) || /^audio\//.test(f?.type || '')) out.audio.push(f);
    else out.other.push(f);
  }
  return out;
}

/** Native { name, path, data } payloads -> File objects. */
export function payloadToFiles(list) {
  return (list || []).filter((f) => f && f.data).map((f) => Object.assign(new File([f.data], f.name || 'file', { type: '' }), { nativePath: f.path || null }));
}

/** Open / import whatever arrived: the first project wins; MIDI files become tracks; audio goes to the sample library. */
export async function openNativeFiles(app, files, { go } = {}) {
  const { projects, midi, audio, other } = routeFiles(files);
  const { actions } = app;
  if (projects.length) { await actions.openProject(projects[0]); go?.({ page: 'tracks' }); return; }
  for (const f of midi) await actions.importMidiFile(f);
  if (audio.length) await actions.importSamples(audio);
  if (midi.length || audio.length) go?.({ page: 'tracks' });
  if (other.length) app.toast(`Can't open ${other.map((f) => f.name).join(', ')} — use audio, MIDI or .daW3 files`, { level: 'warn' });
}

/** Install the command handlers (no-op without the native bridge). Returns true when installed. */
export function installPocketNative(app, { go } = {}) {
  const nat = nativeBridge();
  if (!nat?.onCommand) return false;
  document.documentElement.dataset.native = nat.platform || 'native';
  const open = (list) => openNativeFiles(app, payloadToFiles(list), { go });
  const handlers = {
    'open-project': open,
    'open-files': open,
    'import-music': open,
    'import-midi': open,
    'toggle-play': () => app.actions.togglePlay(),
    'save-project': () => app.actions.saveProject(),
  };
  nat.onCommand((cmd, payload) => {
    const fn = handlers[cmd];
    if (!fn) { console.warn('[native] unknown command', cmd); return; }
    Promise.resolve().then(() => fn(payload)).catch((e) => app.toast(`${cmd} failed: ${e.message}`, { level: 'error' }));
  });
  nat.ready?.();
  return true;
}

/** Extra Pocket menu items: Files-app import (iOS app) and MIDI keyboards (wherever Web MIDI or the bridge exists). */
export function nativeMenuItems(app, { go } = {}) {
  const nat = nativeBridge();
  const items = [];
  if (nat?.openFiles) {
    items.push({
      label: 'Import from Files…', icon: 'folder',
      onClick: () => nat.openFiles({ kind: 'any', multiple: true, title: 'Import into daW³' })
        .then((list) => list?.length && openNativeFiles(app, payloadToFiles(list), { go }))
        .catch((e) => app.toast('Import failed: ' + e.message, { level: 'error' })),
    });
  }
  if (typeof navigator !== 'undefined' && navigator.requestMIDIAccess && app.actions.enableMidiInput) {
    items.push({ label: 'MIDI keyboard input', icon: 'piano', onClick: () => app.actions.enableMidiInput() });
  }
  return items;
}
