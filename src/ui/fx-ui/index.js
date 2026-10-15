// Custom effect-card UIs (canvases, step editors, curve editors), keyed by effect type.
import analysis from './analysis.js';
import rhythm from './rhythm.js';
import dynamics from './dynamics.js';
import space from './space.js';
import character from './character.js';

export const FX_UI = { ...analysis, ...rhythm, ...dynamics, ...space, ...character };
