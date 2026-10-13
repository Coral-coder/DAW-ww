// The song-as-code tests again, with the REAL Strudel engine (vendor/strudel) evaluating the code —
// what the app does in a browser. (song-code.test.js alone runs the built-in fallback engine.)
import { loadStrudel, codeEngine } from '../src/code/strudel.js';

if (!(await loadStrudel()) || codeEngine() !== 'strudel') throw new Error('vendored Strudel engine failed to load');
await import('./song-code.test.js');
