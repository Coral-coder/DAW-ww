// Desktop app (Electron: macOS, Windows, Linux) integration — a no-op in the browser. The desktop shell's preload exposes
// window.daw3Native = { platform, openFiles, saveFile, readFile, revealInFinder, onCommand }; native
// menu items and Finder events (open-file, dock drops) arrive here as commands.
import { isTyping } from './keyboard.js';
import { filesFromDataTransfer } from '../io/track-library.js';

export const nativeBridge = () => (typeof window !== 'undefined' && window.daw3Native) || null;

/** Turn {name, data} payloads from the main process into File objects (keeping the path for Reveal in Finder). */
export function payloadToFiles(list) {
  return (list || []).filter((f) => f && f.data).map((f) => Object.assign(new File([f.data], f.name || 'file', { type: '' }), { nativePath: f.path || null }));
}

export function installNative(app) {
  const nat = nativeBridge();
  if (!nat?.onCommand) return false;
  document.documentElement.dataset.native = nat.platform || 'desktop';
  const { actions } = app;
  const importMusic = async (files) => {
    app.showView('decks');
    for (let i = 0; i < 50 && !app.importMusic; i++) await new Promise((r) => setTimeout(r, 50));
    if (app.importMusic) await app.importMusic(files);
    else await actions.importSamples(files);
  };
  const handlers = {
    'open-project': ([f]) => f && actions.openProject(payloadToFiles([f])[0]),
    'open-dialog': () => actions.openProject(),
    'save-project': () => actions.saveProject(),
    'new-project': () => actions.newProject?.(),
    'import-music': (files) => (files?.length ? importMusic(payloadToFiles(files)) : nat.openFiles({ kind: 'audio', multiple: true, title: 'Import music' }).then((r) => r?.length && importMusic(payloadToFiles(r)))),
    'import-samples': () => actions.importSamples(),
    'import-midi': () => actions.importMidiFile?.(),
    'export-wav': () => actions.exportWav(),
    'export-stems': () => actions.exportWav({ stems: true }),
    'export-midi': () => actions.exportMidiFile(),
    undo: () => (isTyping({ target: document.activeElement }) ? document.execCommand('undo') : actions.undo()),
    redo: () => (isTyping({ target: document.activeElement }) ? document.execCommand('redo') : actions.redo()),
    'toggle-play': () => actions.togglePlay(),
    'show-view': (id) => app.showView(id),
    'toggle-browser': () => app.ui.set({ browserOpen: !app.ui.get('browserOpen') }),
    'toggle-assistant': () => app.ui.set({ assistantOpen: !app.ui.get('assistantOpen') }),
    help: () => actions.showHelp(),
    about: () => actions.showAbout(),
    'audio-prefs': () => import('./audio-prefs.js').then((m) => m.openAudioPrefs(app)),
  };
  nat.onCommand((cmd, payload) => {
    const fn = handlers[cmd];
    if (!fn) { console.warn('[native] unknown command', cmd); return; }
    Promise.resolve().then(() => fn(payload)).catch((e) => app.toast(`${cmd} failed: ${e.message}`, { level: 'error' }));
  });
  // Files / folders dropped anywhere no view handles them: .daW3 opens, audio goes to the Decks library.
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (e.defaultPrevented || !hasFiles(e)) return;
    e.preventDefault();
    const all = [...(e.dataTransfer.files || [])];
    const project = all.find((f) => /\.daw3$/i.test(f.name));
    const audioP = filesFromDataTransfer(e.dataTransfer); // reads entries synchronously before awaiting
    if (project) { actions.openProject(project); return; }
    audioP.then((files) => {
      for (const f of files) f.nativePath = nat.pathForFile?.(f) || null;
      if (files.length) importMusic(files); else app.toast('Drop audio files, folders or a .daW3 project', { level: 'warn' });
    });
  });
  if (nat.plugins) installPluginBridge(app, nat);
  nat.ready?.(); // flush files queued by Finder before the page was ready
  return true;
}

/**
 * Native plugins + device rate (Mac app): plugin-window edits / MIDI learn by touch (plugin-device.js hooks);
 * a device sample-rate change (Audio Settings, or another window) rebuilds the Web Audio context at the new
 * rate without a reload — native plugins keep their state: it is saved into the project first and the
 * re-created instances load it at the new rate.
 */
function installPluginBridge(app, nat) {
  import('./plugin-device.js').then((m) => m.installNativeHooks(app)).catch((e) => console.warn('[native] hooks', e));
  const engine = app.engine;
  engine.onBeforeRebuild?.(async () => {
    const { livePlugins } = await import('../plugins/native.js');
    const { nativeTargetOf } = await import('./plugin-device.js');
    const saved = [];
    for (const pl of livePlugins()) {
      if (pl.offline || pl.inst == null) continue;
      const t = nativeTargetOf(app, pl);
      const state = t ? await pl.getState().catch(() => null) : null;
      if (state) saved.push({ t, state });
    }
    if (!saved.length) return;
    app.store.transact('Plugin states', (p) => {
      for (const { t, state } of saved) {
        const owner = t.owner === 'master' ? p.master : p.tracks.find((x) => x.id === t.owner) || p.buses.find((x) => x.id === t.owner);
        if (!owner) continue;
        const fxId = t.prefix.startsWith('fx:') ? t.prefix.slice(3, t.prefix.indexOf(':', 3)) : null;
        const def = fxId ? owner.fx?.find((f) => f.id === fxId) : owner.instrument;
        if (def) def.params = { ...(def.params || {}), state };
      }
    }, { undo: false });
  });
  nat.audio?.onEvent?.((ev) => {
    if (ev?.event !== 'audio-config' || !ev.rateChanged || !engine.ctx || !ev.config?.enabled) return;
    if (engine.ctx.sampleRate === ev.config.sampleRate) return;
    engine.setSampleRate(ev.config.sampleRate).then((sr) => app.toast(`Audio engine at ${(sr / 1000).toFixed(1)} kHz`, { level: 'success' }),
      (e) => app.toast(`Could not switch the sample rate: ${e?.message || e}`, { level: 'error' }));
  });
}
