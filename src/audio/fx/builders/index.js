// Builder families matching src/audio/fx/defs. Each module exports a function (helpers) => { type: builder },
// merged into BUILDERS by effects.js.
import analysis from './analysis.js';
import rhythm from './rhythm.js';
import dynamics from './dynamics.js';
import space from './space.js';
import character from './character.js';

export const FX_BUILDER_FAMILIES = [analysis, rhythm, dynamics, space, character];
