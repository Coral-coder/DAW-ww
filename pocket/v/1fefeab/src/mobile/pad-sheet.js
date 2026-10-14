// Pocket drum pad sheet: tap a pad name on the step grid -> tune / decay / tone / level / pan / variation / mute
// as big drag tiles (tap a tile for the control popup, which can also open its automation lane).
import { h } from '../ui/dom.js';
import { ctlTile, valueTarget } from './controls.js';
import { openSheet, bigButton, haptic } from './touch.js';
import { padDefs, readPad, writePad, padAutoTarget } from './pad-logic.js';

export function openPadSheet(app, trackId, pad) {
  const { store, engine } = app;
  const track = () => store.get().tracks.find((t) => t.id === trackId);
  const t0 = track();
  if (!t0) return null;
  const defs = padDefs(t0);
  const preview = () => engine.previewNote(trackId, pad.pitch, 0.9, 0.5).catch?.(() => {});
  let previewTimer = 0;
  const tiles = defs.map((def) => ctlTile(app, valueTarget(def, () => readPad(track(), pad.key, def), (v, { final } = {}) => {
    store.transact(`${pad.name}: ${def.label}`, (p) => { const t = p.tracks.find((x) => x.id === trackId); if (t) writePad(t, pad.key, def.key, v); }, { coalesce: true });
    // audition the change (debounced while dragging)
    clearTimeout(previewTimer);
    if (def.key !== 'mute') previewTimer = setTimeout(preview, final ? 0 : 140);
  }, { label: def.key === 'gain' ? 'Level' : def.label, color: t0.color, auto: { owner: trackId, target: padAutoTarget(pad.key, def.key) } })));
  const reset = bigButton('Reset pad', () => {
    store.transact(`${pad.name}: reset`, (p) => { const t = p.tracks.find((x) => x.id === trackId); if (t?.instrument?.params?.pads?.[pad.key]) delete t.instrument.params.pads[pad.key]; });
    for (const tl of tiles) tl.update();
    haptic(8);
  }, { ic: 'undo', cls: 'ghost' });
  const play = bigButton('Play pad', () => preview(), { ic: 'play', cls: 'primary' });
  const unsub = app.subscribe(() => { for (const tl of tiles) tl.update(); });
  return openSheet({
    title: `${pad.name} pad`,
    body: [h('div.pk-tiles', ...tiles), h('p.pk-hint', 'Drag a tile sideways · tap it for big buttons and “Automate this”'), h('div.pk-row', play, reset)],
    cls: 'pk-pad-sheet',
    onClose: unsub,
  });
}
