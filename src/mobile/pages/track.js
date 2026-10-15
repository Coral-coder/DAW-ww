// Pocket ▸ Track: sound browser, the main sound controls as big tiles, mixer (volume / pan / sends), effects, patterns.
import { h, icon } from '../../ui/dom.js';
import { INSTRUMENT_DEFS } from '../../audio/defs.js';
import { resolveInstrumentDef } from '../../audio/presets.js';
import { EFFECT_DEFS, EFFECT_CATEGORIES, resolveEffectParams } from '../../audio/effect-defs.js';
import { mountAnalyzer, SCOPE_VIEWS } from '../../ui/scopes/index.js';
import { presetSheet, fxPresetSheet } from '../preset-sheets.js';
import { effectPresetEntries } from '../../audio/effect-presets.js';
import { patternsForTrack, createEffect, DRUM_PADS } from '../../core/model.js';
import { openPadSheet } from '../pad-sheet.js';
import { editedPads } from '../pad-logic.js';
import { pageShell, soundName, iconBtn, soundBrowser, isDrums, emptyState } from './common.js';
import { ctlTile, instTarget, fxTarget, mixTarget } from '../controls.js';
import { actionSheet, onLongPress, haptic, bigButton, promptSheet } from '../touch.js';
import { dragReorder, reorder } from '../reorder.js';
import { openAutomationSheet, pickAutomationTarget } from '../auto-lane.js';
import { laneLabel } from '../../ui/automation-targets.js';
import { macroTargets, usesMacros } from '../macros.js';

const TILE_TYPES = new Set(['number', 'enum', 'bool']);
const MAIN_COUNT = 8;

export function createTrackPage(app, nav) {
  const { store, ui, actions, engine } = app;
  const back = iconBtn('chevronRight', () => nav.back(), 'Back', 'back');
  const { el, head, body, titleEl } = pageShell('Track');
  head.prepend(back);
  titleEl.addEventListener('click', async () => { const t = track(); if (!t) return; const n = await promptSheet('Track name', t.name); if (n) actions.updateTrack(t.id, (tt) => { tt.name = n; }, 'Rename track'); });
  let trackId = null, visible = false, structKey = '', showAll = false;
  const open = new Set(); // expanded effect ids
  let tiles = [];
  const track = () => store.get().tracks.find((t) => t.id === trackId);

  const tileGrid = (targets) => {
    const g = h('div.pk-tiles');
    for (const tg of targets) { const t = ctlTile(app, tg); tiles.push(t); g.appendChild(t); }
    return g;
  };

  function structureOf(t) {
    if (!t) return 'none';
    const p = store.get();
    return [t.id, t.type, t.instrument?.type, t.instrument?.preset, t.instrument?.params?.kit, (t.fx || []).map((f) => `${f.id}:${f.type}:${f.enabled !== false}`).join(','), p.buses.map((b) => b.id).join(','),
      patternsForTrack(p, t.id).map((x) => x.id).join(','), t.activePatternId, showAll, [...open].join(','), t.arm,
      JSON.stringify(t.instrument?.params?.pads || {}), (t.automation || []).map((l) => `${l.id}:${l.target}:${l.points?.length}:${l.enabled}:${!!l.overridden}`).join(','),
      usesMacros(t) ? (t.mod.macros || []).map((m) => m.name).join(',') : ''].join('|');
  }

  function render() {
    const t = track();
    tiles = [];
    body.replaceChildren();
    if (!t) { titleEl.textContent = 'Track'; body.appendChild(emptyState('Track not found', 'It may have been deleted.', bigButton('All tracks', () => nav.go({ page: 'tracks' }), { ic: 'layers' }))); return; }
    titleEl.textContent = t.name;
    el.style.setProperty('--tc', t.color);
    const p = store.get();

    if (t.type === 'instrument') {
      // sound
      const soundBtn = h('button.pk-sound', { type: 'button' }, h('div.pk-label', isDrums(t) ? 'Drum kit' : 'Sound'), h('div.pk-sound-name', soundName(t)), icon('chevronRight', 20));
      soundBtn.addEventListener('click', () => soundBrowser(app, t.id));
      const prev = bigButton('Preview', () => engine.previewNote(t.id, isDrums(t) ? 36 : 60, 0.85, 1), { ic: 'play' });
      body.appendChild(h('div.pk-card', soundBtn, h('div.pk-row', prev, bigButton('Edit notes', () => nav.go({ page: 'notes' }), { ic: 'piano' }), bigButton('Play', () => nav.go({ page: 'play' }), { ic: 'music' }))));
      // instrument controls
      const r = resolveInstrumentDef(t.instrument);
      const defs = (INSTRUMENT_DEFS[r.type]?.params || []).filter((d) => TILE_TYPES.has(d.type) && d.key !== 'kit' && d.key !== 's');
      const main = defs.filter((d) => !d.advanced);
      const shown = showAll ? defs : main.slice(0, MAIN_COUNT);
      const more = bigButton(showAll ? 'Fewer controls' : `All controls (${defs.length})`, () => { showAll = !showAll; render(); }, { ic: 'sliders', cls: 'ghost' });
      body.appendChild(h('div.pk-card', h('div.pk-label', 'Sound controls — drag sideways or tap'), tileGrid(shown.map((d) => instTarget(app, t.id, d))), defs.length > MAIN_COUNT ? more : null));
      // macro knobs (mapped on the desktop layout's device panel)
      if (usesMacros(t)) body.appendChild(h('div.pk-card', h('div.pk-label', 'Macros'), tileGrid(macroTargets(app, t.id))));
      if (isDrums(t)) {
        const edited = editedPads(t);
        const pads = h('div.pk-padgrid', ...DRUM_PADS.slice(0, 12).map((pad) => {
          const b = h(`button.pk-padbtn${edited.has(pad.key) ? '.edited' : ''}`, { type: 'button' }, pad.name);
          b.addEventListener('click', () => { haptic(5); engine.previewNote(t.id, pad.pitch, 0.9, 0.5); openPadSheet(app, t.id, pad); });
          return b;
        }));
        body.appendChild(h('div.pk-card', h('div.pk-label', 'Drum pads — tap for tune, decay, level…'), pads));
      }
    } else if (t.type === 'audio') {
      const arm = bigButton(t.arm ? 'Armed for recording' : 'Arm for recording', () => actions.updateTrack(t.id, (tt) => { tt.arm = !tt.arm; }, 'Arm'), { ic: 'record', cls: t.arm ? 'rec on' : 'rec' });
      body.appendChild(h('div.pk-card', h('p.pk-p', 'Audio track: records your microphone. Arm it, then press ● in the transport ▸ Record audio.'), arm));
    } else {
      body.appendChild(h('div.pk-card', h('p.pk-p', 'Code track: Strudel live code.'), bigButton('Edit code', () => nav.go({ page: 'code', id: t.id }), { ic: 'code', cls: 'primary' })));
    }

    // mixer
    const mix = [mixTarget(app, t.id, 'volume'), mixTarget(app, t.id, 'pan'), ...p.buses.map((b) => mixTarget(app, t.id, `send:${b.id}`))];
    body.appendChild(h('div.pk-card', h('div.pk-label', 'Mix'), tileGrid(mix.map((m) => ({ ...m, color: t.color })))));

    // effects
    const fxWrap = h('div.pk-fxlist');
    (t.fx || []).forEach((f, i) => fxWrap.appendChild(fxCard(t, f, i)));
    dragReorder(fxWrap, { onMove: (from, to) => actions.updateTrack(t.id, (tt) => { tt.fx = reorder(tt.fx, from, to); }, 'Reorder effects') });
    const addFx = bigButton('Add effect', () => actionSheet('Add effect', EFFECT_CATEGORIES.map((c) => {
      const list = Object.entries(EFFECT_DEFS).filter(([, d]) => d.category === c && !d.plugin);
      return list.length ? { label: c, submenu: list.map(([type, d]) => ({ label: d.name, onClick: () => { const fx = createEffect(type, {}); open.add(fx.id); actions.updateTrack(t.id, (tt) => { tt.fx.push(fx); }, `Add ${d.name}`); } })) } : null;
    }).filter(Boolean).concat(['-', { label: 'From preset or FX chain…', icon: 'search', onClick: () => presetSheet(app, { kind: 'effect-add', trackId: t.id, onAdded: (fx) => { if (fx) { open.add(fx.id); render(); } } }) }])), { ic: 'plus', cls: 'ghost' });
    body.appendChild(h('div.pk-card', h('div.pk-label', (t.fx || []).length > 1 ? 'Effects (drag ≡ to reorder)' : 'Effects'), fxWrap, addFx));

    // automation lanes of this track
    const lanes = (t.automation || []);
    const laneRows = lanes.map((l) => {
      const b = h('button.pk-row-btn', { type: 'button' }, h('span.pk-row-name', laneLabel(p, t.id, l.target)), h('span.pk-row-sub', `${l.points?.length || 0} points${l.overridden ? ' · overridden by hand' : l.enabled === false ? ' · off' : ''}`), icon('chevronRight', 18));
      b.addEventListener('click', () => openAutomationSheet(app, t.id, l.target));
      onLongPress(b, () => actionSheet(laneLabel(p, t.id, l.target), [
        { label: 'Edit lane', icon: 'pencil', onClick: () => openAutomationSheet(app, t.id, l.target) },
        l.overridden ? { label: 'Re-enable automation', icon: 'undo', onClick: () => store.transact('Re-enable automation', (pp) => { const ll = pp.tracks.find((x) => x.id === t.id)?.automation?.find((x) => x.id === l.id); if (ll) delete ll.overridden; }) } : null,
        { label: l.enabled === false ? 'Turn lane on' : 'Turn lane off', icon: 'power', onClick: () => store.transact('Toggle automation lane', (pp) => { const ll = pp.tracks.find((x) => x.id === t.id)?.automation?.find((x) => x.id === l.id); if (ll) ll.enabled = ll.enabled === false; }) },
        { label: 'Delete lane', icon: 'trash', onClick: () => store.transact('Delete automation lane', (pp) => { const tt = pp.tracks.find((x) => x.id === t.id); if (tt) tt.automation = tt.automation.filter((x) => x.id !== l.id); }) },
      ].filter(Boolean)));
      return b;
    });
    const addAuto = bigButton('Automate a control…', () => pickAutomationTarget(app, { ownerId: t.id, onPick: (o, tg) => openAutomationSheet(app, o, tg) }), { ic: 'wave', cls: 'ghost' });
    body.appendChild(h('div.pk-card', h('div.pk-label', 'Automation (draw how controls move over the song)'), ...laneRows, addAuto));

    // patterns
    if (t.type === 'instrument') {
      const pats = patternsForTrack(p, t.id);
      const patRow = h('div.pk-chips.scroll', ...pats.map((pt) => {
        const b = h(`button.pk-chip${pt.id === t.activePatternId ? '.on' : ''}`, { type: 'button' }, `${pt.name} · ${pt.notes.length}`);
        b.addEventListener('click', () => { haptic(5); actions.selectPattern(pt.id); });
        onLongPress(b, () => actionSheet(pt.name, [
          { label: 'Edit notes', icon: 'piano', onClick: () => { actions.selectPattern(pt.id); nav.go({ page: 'notes' }); } },
          { label: 'Duplicate', icon: 'copy', onClick: () => actions.duplicatePattern(pt.id) },
          { label: 'Rename…', icon: 'pencil', onClick: async () => { const n = await promptSheet('Pattern name', pt.name); if (n) store.transact('Rename pattern', (pp) => { if (pp.patterns[pt.id]) pp.patterns[pt.id].name = n; }); } },
          { label: 'Delete pattern', icon: 'trash', onClick: () => actions.deletePattern(pt.id) },
        ]));
        return b;
      }));
      const gen = bigButton('Generate', () => actionSheet('Generate into this pattern', isDrums(t)
        ? [{ label: 'Drum beat', icon: 'dice', onClick: () => actions.generatePart('drums', { trackId: t.id }) }]
        : ['lead', 'bass', 'chords', 'arp', 'pad'].map((role) => ({ label: role[0].toUpperCase() + role.slice(1), icon: 'dice', onClick: () => actions.generatePart(role, { trackId: t.id }) }))), { ic: 'dice' });
      body.appendChild(h('div.pk-card', h('div.pk-label', 'Patterns (long-press for more)'), patRow,
        h('div.pk-row', bigButton('New', () => actions.newPattern(t.id), { ic: 'plus' }), gen, bigButton('Hum', () => app.openHum?.({ trackId: t.id }), { ic: 'music' }))));
    }
    body.appendChild(h('div.pk-row', bigButton('Track actions', () => actionSheet(t.name, actions.trackMenuItems(t.id).filter((it) => it === '-' || it.header || !/Export track/.test(it.label || ''))), { ic: 'menu', cls: 'ghost' })));
  }

  function fxCard(t, f, i) {
    const def = EFFECT_DEFS[f.type];
    const isOpen = open.has(f.id);
    const onBtn = h(`button.pk-fx-on${f.enabled !== false ? '.on' : ''}`, { type: 'button', 'aria-label': 'On / off' }, icon('power', 18));
    onBtn.addEventListener('click', (e) => { e.stopPropagation(); haptic(6); actions.updateTrack(t.id, (tt) => { const x = tt.fx.find((y) => y.id === f.id); if (x) x.enabled = x.enabled === false; }, `${def?.name || f.type} on/off`); });
    const headBtn = h('button.pk-fx-head', { type: 'button' }, h('span.pk-fx-name', def?.name || f.type), h('span.pk-fx-cat', def?.category || ''), icon(isOpen ? 'chevronDown' : 'chevronRight', 18));
    headBtn.addEventListener('click', () => { haptic(5); if (open.has(f.id)) open.delete(f.id); else open.add(f.id); render(); });
    onLongPress(headBtn, () => actionSheet(def?.name || f.type, [
      { label: 'Presets…', icon: 'search', disabled: !effectPresetEntries(f.type).length, onClick: () => fxPresetSheet(app, t.id, f.id) },
      { label: 'Move up', disabled: i === 0, onClick: () => actions.updateTrack(t.id, (tt) => { const k = tt.fx.findIndex((x) => x.id === f.id); if (k > 0) [tt.fx[k - 1], tt.fx[k]] = [tt.fx[k], tt.fx[k - 1]]; }, 'Reorder effects') },
      { label: 'Move down', disabled: i === t.fx.length - 1, onClick: () => actions.updateTrack(t.id, (tt) => { const k = tt.fx.findIndex((x) => x.id === f.id); if (k >= 0 && k < tt.fx.length - 1) [tt.fx[k + 1], tt.fx[k]] = [tt.fx[k], tt.fx[k + 1]]; }, 'Reorder effects') },
      { label: 'Remove effect', icon: 'trash', onClick: () => actions.updateTrack(t.id, (tt) => { tt.fx = tt.fx.filter((x) => x.id !== f.id); }, `Remove ${def?.name || f.type}`) },
    ]));
    const grip = h('span.pk-grip', { 'aria-label': 'Drag to reorder', 'data-noswipe': '' }, '≡');
    const card = h(`div.pk-fx${f.enabled === false ? '.off' : ''}`, h('div.pk-fx-top', grip, headBtn, onBtn));
    if (isOpen && def?.category === 'Analysis' && SCOPE_VIEWS[f.type]) {
      // analyzer display (same drawing code as the desktop card, compact); stops itself when the card is rebuilt
      const v = mountAnalyzer(f.type, {
        compact: true,
        getProbe: () => engine.getFxProbe?.(f.id) ?? null,
        getParams: () => resolveEffectParams(track()?.fx?.find((x) => x.id === f.id) || f),
      });
      card.appendChild(h(`div.pk-an${f.type === 'spectrogram' || f.type === 'tuner' ? '.an-tall' : ''}`, { 'data-noswipe': '' }, v.el));
    }
    if (isOpen && def) {
      const defs = def.params.filter((d) => TILE_TYPES.has(d.type));
      const main = defs.filter((d) => !d.advanced);
      card.appendChild(tileGrid((showAll ? defs : main).map((d) => fxTarget(app, t.id, f.id, d))));
      if (effectPresetEntries(f.type).length) card.appendChild(bigButton('Presets', () => fxPresetSheet(app, t.id, f.id), { ic: 'search', cls: 'ghost' }));
    }
    return card;
  }

  app.subscribe(() => {
    if (!visible) return;
    const k = structureOf(track());
    if (k !== structKey) { structKey = k; render(); } else for (const tl of tiles) tl.update();
  });
  return {
    el,
    show(route) {
      visible = true;
      if (route?.id && route.id !== trackId) { trackId = route.id; showAll = false; open.clear(); }
      if (trackId && ui.get('selectedTrackId') !== trackId) actions.selectTrack(trackId);
      structKey = structureOf(track());
      render();
      body.scrollTop = 0;
    },
    hide() { visible = false; },
  };
}
