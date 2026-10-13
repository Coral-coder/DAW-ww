// daWWW bootstrap.
import { createApp } from './ui/app.js';

window.addEventListener('error', (e) => console.error('[heroic]', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[heroic] unhandled', e.reason));

createApp(document.getElementById('app')).catch((e) => {
  console.error(e);
  document.getElementById('app').textContent = 'Failed to start daWWW: ' + e.message;
});
