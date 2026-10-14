// Mac app (Electron) integration — a no-op in the browser. The desktop shell's preload exposes
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
  nat.ready?.(); // flush files queued by Finder before the page was ready
  return true;
}
