// Effect families added after 1.0. Each module exports a function (ParamDef helpers) => { type: def },
// merged into EFFECT_DEFS by effect-defs.js once its own helpers exist (no import cycle).
import analysis from './analysis.js';
import rhythm from './rhythm.js';
import dynamics from './dynamics.js';
import space from './space.js';
import character from './character.js';

export const FX_DEF_FAMILIES = [analysis, rhythm, dynamics, space, character];
