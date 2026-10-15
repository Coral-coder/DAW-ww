// Workflow features wired into the app shell: chord track + chord pads commands, the clip inspector (clip effects,
// chord follow), the spectral editor and action macros. Installed once from app.js after the keyboard / commands.
import { hasClipFx } from '../audio/clip-fx.js';
import { CHORD_FOLLOW_MODES, followModeFor } from '../core/chord-track.js';
import { setChordFollow, detectChordsFromMidi } from './chord-actions.js';
import { openClipInspector } from './clip-inspector.js';
import { installMacros } from './macros-ui.js';
import { toast } from './components.js';

export function installWorkflow(app) {
  const { ui, store } = app;
  const get = () => store.get();
  const selectedClip = (pred = () => true) => {
    const ids = ui.get('selectedClipIds') || [];
    return get().clips.find((c) => ids.includes(c.id) && pred(c)) || null;
  };
  const pads = () => import('./chord-pads.js').then((m) => m.toggleChordPads(app));
  const spectral = (clipId) => import('./spectral-editor.js').then((m) => m.openSpectralEditor(app, clipId));
  const inspector = (clipId) => openClipInspector(app, clipId);

  app.openClipInspector = inspector;
  app.openSpectralEditor = spectral;

  // ---- Arrange clip menu + clip label badges (src/ui/views/arrange.js)
  app.clipMenuExtras = (clip, ids = [clip.id]) => {
    const p = get();
    const t = p.tracks.find((x) => x.id === clip.trackId);
    const melodic = t?.type === 'instrument' && t.instrument?.type !== 'drums' && clip.type !== 'audio';
    const items = [
      { label: `Clip inspector / clip effects…${hasClipFx(clip) ? `  (${clip.fx.filter((f) => f.enabled !== false).length})` : ''}`, icon: 'sliders', onClick: () => inspector(clip.id) },
    ];
    if (clip.type === 'audio') items.push({ label: 'Spectral editor…', icon: 'wave', onClick: () => spectral(clip.id) });
    if (melodic) {
      const cur = clip.chordFollow || '';
      items.push({ label: 'Follow chord track', icon: 'music', submenu: [
        { label: `${cur ? '' : '● '}Same as track (${CHORD_FOLLOW_MODES.find((m) => m.value === followModeFor(t, null))?.label || 'Off'})`, onClick: () => setChordFollow(app, { clipIds: ids, mode: null }) },
        ...CHORD_FOLLOW_MODES.map((m) => ({ label: `${cur === m.value ? '● ' : ''}${m.label}`, onClick: () => setChordFollow(app, { clipIds: ids, mode: m.value }) })),
      ] });
    }
    return items;
  };
  app.clipBadges = (clip, track) => {
    let s = '';
    if (hasClipFx(clip)) s += '  ·FX';
    if (clip.type !== 'audio' && followModeFor(track, clip) !== 'off' && get().chordTrack?.chords?.length) s += '  ·chords';
    return s;
  };

  // ---- commands (command palette; rebindable)
  const reg = app.commands;
  if (reg) {
    reg.registerAll([
      { id: 'chords.pads', label: 'Chord pads (show / hide)', category: 'Chords', keys: [], run: () => pads() },
      { id: 'chords.lane', label: 'Chord track lane (show / hide)', category: 'Chords', keys: [], run: () => { if (ui.get('view') !== 'arrange') ui.set({ view: 'arrange' }); setTimeout(() => app.chordLane?.toggle(), 30); } },
      { id: 'chords.detect', label: 'Detect chord track from MIDI clips', category: 'Chords', keys: [], run: () => { if (detectChordsFromMidi(app)) app.chordLane?.toggle(true); } },
      ...CHORD_FOLLOW_MODES.map((m) => ({ id: `chords.follow.${m.value}`, label: `Selected track follows chord track: ${m.label}`, category: 'Chords', keys: [], run: () => {
        const id = ui.get('selectedTrackId');
        const t = get().tracks.find((x) => x.id === id);
        if (!t || t.type !== 'instrument' || t.instrument?.type === 'drums') { toast('Select a synth / keys track first'); return; }
        setChordFollow(app, { trackId: id, mode: m.value });
        toast(`${t.name}: chord follow ${m.label}`);
      } })),
      { id: 'clip.inspector', label: 'Clip inspector / clip effects (selected clip)', category: 'Clips', keys: [], run: () => { const c = selectedClip(); if (c) inspector(c.id); else toast('Select a clip in the arrangement first'); } },
      { id: 'clip.spectral', label: 'Spectral editor (selected audio clip)', category: 'Clips', keys: [], run: () => { const c = selectedClip((x) => x.type === 'audio'); if (c) spectral(c.id); else toast('Select an audio clip in the arrangement first'); } },
    ]);
  }
  // action macros last: they wrap every registered command for recording
  installMacros(app);
  return app;
}
