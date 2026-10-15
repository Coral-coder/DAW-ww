// Clip inspector (modal): clip effects chain (take FX — src/audio/clip-fx.js), chord-track following for MIDI clips
// and the spectral editor for audio clips. Opened from the Arrange clip menu and the command palette.
import { h, icon } from './dom.js';
import { modal, button, iconButton, toggle, select, paramPanel, toast } from './components.js';
import { createEffect } from '../core/model.js';
import { EFFECT_DEFS } from '../audio/effect-defs.js';
import { CHORD_FOLLOW_MODES, followModeFor } from '../core/chord-track.js';
import { setChordFollow } from './chord-actions.js';

const findClip = (p, id) => p.clips.find((c) => c.id === id);

export async function openClipInspector(app, clipId) {
  const { store } = app;
  const get = () => store.get();
  const clip0 = findClip(get(), clipId);
  if (!clip0) { toast('Select a clip first'); return null; }
  const editClip = (label, fn, opts) => store.transact(label, (p) => { const c = findClip(p, clipId); if (c) fn(c, p); }, opts);
  const open = new Set();

  const info = h('div.ci-info');
  const follow = h('div.ci-follow');
  const fxList = h('div.ci-fx-list');
  const addBtn = button('Add clip effect', async (e) => {
    const { showEffectMenu } = await import('./panels/device.js');
    showEffectMenu(e, (type, params) => {
      const fx = createEffect(type, params);
      open.add(fx.id);
      editClip(`Add clip effect: ${EFFECT_DEFS[type]?.name || type}`, (c) => { (c.fx ||= []).push(fx); });
      renderFx();
    });
  }, { icon: 'plus', cls: 'small', title: 'Add an effect that processes only this clip (before the track inserts and fader)' });
  const audioTools = h('div.ci-audio');
  const body = h('div.clip-inspector',
    info,
    follow,
    h('div.ci-section', h('div.ci-section-head', icon('sliders', 14), h('span', 'Clip effects'), h('span.spacer'), addBtn),
      h('p.ci-hint', 'Processed only while this clip plays, before the track’s inserts and fader. Clip effects are rendered with the mix and stay in sync with plugin delay compensation.'),
      fxList),
    audioTools);

  function renderInfo() {
    const p = get();
    const c = findClip(p, clipId);
    if (!c) return;
    const t = p.tracks.find((x) => x.id === c.trackId);
    const bpb = p.timeSig ? p.timeSig[0] * (4 / p.timeSig[1]) : 4;
    const name = c.name || (c.type === 'audio' ? p.samples?.[c.sampleId]?.name : p.patterns?.[c.patternId]?.name) || 'Clip';
    info.replaceChildren(
      h('div.ci-name', name),
      h('div.ci-meta', `${t?.name || ''} · ${c.type === 'audio' ? 'audio' : 'MIDI'} · bar ${+(c.start / bpb + 1).toFixed(2)} · ${+(c.length / bpb).toFixed(2)} bars${c.type === 'audio' ? ` · gain ${(20 * Math.log10(c.gain ?? 1)).toFixed(1)} dB` : ''}`));
    // chord follow (MIDI clips on melodic tracks)
    const melodic = t?.type === 'instrument' && t.instrument?.type !== 'drums' && c.type !== 'audio';
    follow.classList.toggle('hidden', !melodic);
    if (melodic) {
      const trackMode = followModeFor(t, null);
      const opts = [{ value: '', label: `Same as track (${CHORD_FOLLOW_MODES.find((m) => m.value === trackMode)?.label || 'Off'})` }, ...CHORD_FOLLOW_MODES.map((m) => ({ value: m.value, label: m.label }))];
      follow.replaceChildren(h('label', icon('music', 14), h('span', 'Follow chord track')),
        select({ options: opts, value: c.chordFollow || '', title: 'Conform this clip’s notes to the chord track while it plays (the notes themselves are not changed)', onChange: (v) => setChordFollow(app, { clipIds: [clipId], mode: v || null }) }),
        h('span.ci-hint', CHORD_FOLLOW_MODES.find((m) => m.value === (c.chordFollow || trackMode))?.description || ''));
    }
    audioTools.replaceChildren(...(c.type === 'audio' ? [
      h('div.ci-section-head', icon('wave', 14), h('span', 'Audio')),
      button('Spectral editor…', async () => { const m = await import('./spectral-editor.js'); m.openSpectralEditor(app, clipId); }, { icon: 'wave', cls: 'small', title: 'Spectrogram: select a time × frequency region and attenuate, remove, heal or isolate it (on a copy of the audio — undoable)' }),
      c.spectralSource ? button('Restore original audio', () => editClip('Restore original audio', (cc) => { cc.sampleId = cc.spectralSource; delete cc.spectralSource; }), { cls: 'small', title: 'Undo every spectral edit of this clip (the original sample is kept in the project)' }) : null,
    ] : []));
  }

  function renderFx() {
    const c = findClip(get(), clipId);
    if (!c) return;
    const list = c.fx || [];
    if (!list.length) { fxList.replaceChildren(h('div.ci-empty', 'No clip effects')); return; }
    fxList.replaceChildren(...list.map((fx, i) => {
      const def = EFFECT_DEFS[fx.type];
      const card = h('div.ci-fx' + (fx.enabled === false ? '.off' : ''));
      const expanded = open.has(fx.id);
      const headRow = h('div.ci-fx-head',
        toggle({ label: '', value: fx.enabled !== false, title: 'On / bypass', cls: 'ci-power', onChange: (v) => { editClip('Clip effect on/off', (cc) => { const f = cc.fx.find((x) => x.id === fx.id); if (f) f.enabled = v; }); renderFx(); } }),
        h('button.ci-fx-name', { type: 'button', title: 'Show / hide parameters', onclick: () => { if (open.has(fx.id)) open.delete(fx.id); else open.add(fx.id); renderFx(); } }, icon(expanded ? 'chevronDown' : 'chevronRight', 12), h('span', def?.name || fx.type)),
        h('span.spacer'),
        iconButton('chevronDown', () => move(i, -1), 'Move up', `ci-up${i === 0 ? ' invisible' : ''}`),
        iconButton('chevronDown', () => move(i, 1), 'Move down', i === list.length - 1 ? 'invisible' : ''),
        iconButton('trash', () => { editClip('Remove clip effect', (cc) => { cc.fx = cc.fx.filter((x) => x.id !== fx.id); if (!cc.fx.length) delete cc.fx; }); renderFx(); }, 'Remove'));
      card.append(headRow);
      if (expanded && def) {
        card.append(paramPanel({
          defs: def.params.filter((d) => d.type !== 'track'), values: fx.params || {},
          onChange: (k, v) => editClip(`Clip ${def.name}: ${k}`, (cc) => { const f = cc.fx.find((x) => x.id === fx.id); if (f) f.params = { ...(f.params || {}), [k]: v }; }, { coalesce: true }),
        }));
      }
      return card;
    }));
  }
  function move(i, d) {
    editClip('Reorder clip effects', (c) => { const j = i + d; if (j < 0 || j >= c.fx.length) return; const [f] = c.fx.splice(i, 1); c.fx.splice(j, 0, f); });
    renderFx();
  }

  renderInfo();
  renderFx();
  const unsub = app.subscribe?.((r) => {
    if (!r.project) return;
    if (!findClip(get(), clipId)) { m.close(); return; }
    const lbl = r.labels || [];
    if (lbl.some((l) => /^(undo|redo|load|Chord follow|Restore original|Spectral)/.test(l))) { renderInfo(); renderFx(); }
  });
  const m = modal({ title: 'Clip inspector', body, width: 560, cls: 'clip-inspector-modal', onClose: () => unsub?.() });
  return m;
}
