// daW³ bootstrap.
import { createApp } from './ui/app.js';
import { installPWA } from './pwa.js';
import { detectPocket, readEnv } from './mobile/mode.js';

// Carry UI settings saved under the app's earlier name over to the current "daw3-" keys.
const SETTING_KEYS = ['ui', 'arrange', 'rack', 'piano', 'mixer', 'user-presets', 'countin', 'code-viz-window', 'code-viz-h',
  'code-ref-open', 'code-autoapply', 'browser-open', 'assistant-tab'];
try {
  for (const key of Object.keys(localStorage)) {
    const m = /^([a-z0-9]+)-(.+)$/.exec(key);
    if (!m || m[1] === 'daw3' || !SETTING_KEYS.includes(m[2])) continue;
    if (localStorage.getItem('daw3-' + m[2]) === null) localStorage.setItem('daw3-' + m[2], localStorage.getItem(key));
    localStorage.removeItem(key);
  }
} catch { /* storage unavailable */ }

window.addEventListener('error', (e) => console.error('[daw3]', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[daw3] unhandled', e.reason));

installPWA();

// Phones / small touch screens get the Pocket layout (src/mobile); ?mobile=1|0 or Menu ▸ layout overrides.
const pocket = detectPocket(readEnv(window));
const start = pocket
  ? import('./mobile/shell.js').then((m) => m.createPocketApp(document.getElementById('app')))
  : createApp(document.getElementById('app'));
start.catch((e) => {
  console.error(e);
  document.getElementById('app').textContent = 'Failed to start daW³: ' + e.message;
});
