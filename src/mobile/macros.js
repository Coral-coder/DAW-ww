// Pocket: a track's macro knobs as touch tiles (core/modulation.js). Modulators and the matrix are edited on the
// desktop layout; Pocket plays / automates the macros.
import { MACRO_COUNT, createModState } from '../core/modulation.js';

export const MACRO_TILE_DEF = { key: 'macro', label: 'Macro', type: 'number', min: 0, max: 1, step: 0.001, default: 0, unit: '%' };

/** Control targets (controls.js ctlTile format) for the 8 macros of a track. */
export function macroTargets(app, trackId) {
  const track = () => app.store.get().tracks.find((t) => t.id === trackId);
  return Array.from({ length: MACRO_COUNT }, (_, i) => {
    const name = track()?.mod?.macros?.[i]?.name || `Macro ${i + 1}`;
    const def = { ...MACRO_TILE_DEF, label: name };
    return {
      def, label: name, auto: { owner: trackId, target: `macro:${i}` },
      get: () => track()?.mod?.macros?.[i]?.value ?? 0,
      set: (v) => app.store.transact(`Macro ${i + 1}`, (p) => {
        const t = p.tracks.find((x) => x.id === trackId);
        if (!t) return;
        t.mod ||= createModState();
        if (t.mod.macros?.[i]) t.mod.macros[i].value = Math.max(0, Math.min(1, v));
      }, { coalesce: true }),
    };
  });
}

/** Does the track use its macros (mapped to something)? */
export const usesMacros = (t) => !!t?.mod?.routes?.some((r) => String(r.src).startsWith('macro:'));
