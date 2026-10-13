// HEROIC DAW generators — pure, deterministic with `rng` from createRng(seed). Re-exports every generator module.
export * from './genres.js';
export * from './drums.js';
export * from './harmony.js';
export * from './bass.js';
export * from './melody.js';
export * from './arp.js';
export * from './analyze.js';
export * from './song.js';
export * from './assistant.js';
export { generateBassline as generateBass } from './bass.js';
