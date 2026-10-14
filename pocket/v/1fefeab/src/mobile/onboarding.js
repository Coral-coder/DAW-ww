// First-launch hint overlay for Pocket: three short cards, dismissible, remembered in localStorage.
import { h, icon } from '../ui/dom.js';
import { haptic } from './touch.js';

export const ONBOARD_KEY = 'daw3-pocket-onboarded';
export const ONBOARD_CARDS = [
  { icon: 'layers', title: 'Swipe between pages', text: 'Swipe left / right (or use the tabs at the bottom) to move between Create, Tracks, Song, Notes, Play, Mix and Setlist.' },
  { icon: 'sliders', title: 'Tap a control for big buttons', text: 'Tap any knob or tile: a big slider with − / + buttons and presets pops up. Drag tiles sideways for quick moves; long-press for more.' },
  { icon: 'music', title: 'Hum to write notes', text: 'Press ● and choose “Hum / whistle to notes” — sing or whistle a melody and it becomes notes in your song’s key.' },
];

/** Should the overlay show? (storage may throw in private mode — then don't nag.) */
export function shouldOnboard(storage) {
  try { return !storage?.getItem(ONBOARD_KEY); } catch { return false; }
}
export function markOnboarded(storage) {
  try { storage?.setItem(ONBOARD_KEY, '1'); } catch { /* */ }
}

/** Show the overlay (forced = from the menu, ignores the remembered flag). Returns the element or null. */
export function showOnboarding({ force = false, storage = globalThis.localStorage } = {}) {
  if (!force && !shouldOnboard(storage)) return null;
  let i = 0;
  const card = h('div.pk-ob-card');
  const dots = h('div.pk-ob-dots');
  const next = h('button.pk-btn.primary', { type: 'button' });
  const skip = h('button.pk-btn.ghost', { type: 'button' }, 'Skip');
  const el = h('div.pk-ob', { role: 'dialog', 'aria-label': 'Welcome to daW³ Pocket' }, h('div.pk-ob-panel', card, dots, h('div.pk-row', skip, next)));
  const close = () => { markOnboarded(storage); el.classList.add('closing'); setTimeout(() => el.remove(), 200); };
  const render = () => {
    const c = ONBOARD_CARDS[i];
    card.replaceChildren(h('div.pk-ob-icon', icon(c.icon, 34)), h('h3', c.title), h('p', c.text));
    dots.replaceChildren(...ONBOARD_CARDS.map((_, k) => h(`span${k === i ? '.on' : ''}`)));
    next.textContent = i < ONBOARD_CARDS.length - 1 ? 'Next' : 'Let’s make music';
  };
  next.addEventListener('click', () => { haptic(6); if (i < ONBOARD_CARDS.length - 1) { i++; render(); } else close(); });
  skip.addEventListener('click', () => close());
  // swipe the card sideways to page through
  let x0 = null;
  card.addEventListener('pointerdown', (e) => { x0 = e.clientX; });
  card.addEventListener('pointerup', (e) => {
    if (x0 == null) return;
    const dx = e.clientX - x0;
    x0 = null;
    if (dx < -40 && i < ONBOARD_CARDS.length - 1) { i++; render(); } else if (dx > 40 && i > 0) { i--; render(); }
  });
  render();
  document.body.appendChild(el);
  return el;
}
