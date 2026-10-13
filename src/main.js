// daWWW bootstrap.
import { createApp } from './ui/app.js';

// Carry UI settings saved under the app's earlier name over to the current "dawww-" keys.
const SETTING_KEYS = ['ui', 'arrange', 'rack', 'piano', 'mixer', 'user-presets', 'countin', 'code-viz-window', 'code-viz-h',
  'code-ref-open', 'code-autoapply', 'browser-open', 'assistant-tab'];
try {
  for (const key of Object.keys(localStorage)) {
    const m = /^([a-z]+)-(.+)$/.exec(key);
    if (!m || m[1] === 'dawww' || !SETTING_KEYS.includes(m[2])) continue;
    if (localStorage.getItem('dawww-' + m[2]) === null) localStorage.setItem('dawww-' + m[2], localStorage.getItem(key));
    localStorage.removeItem(key);
  }
} catch { /* storage unavailable */ }

window.addEventListener('error', (e) => console.error('[dawww]', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[dawww] unhandled', e.reason));

createApp(document.getElementById('app')).catch((e) => {
  console.error(e);
  document.getElementById('app').textContent = 'Failed to start daWWW: ' + e.message;
});
