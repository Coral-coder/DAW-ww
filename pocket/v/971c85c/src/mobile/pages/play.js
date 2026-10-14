// Pocket ▸ Play: a big multi-touch instrument — scale-locked keys (default), a piano, chord buttons, or drum pads —
// with velocity from where you touch a key (higher = softer, lower = harder). Record ● writes what you play into the
// selected pattern while the loop runs.
import { h, icon } from '../../ui/dom.js';
import { DRUM_PADS } from '../../core/model.js';
import { scalePitchClasses, pitchClassName } from '../../theory/index.js';
import { stepPitch } from '../roll-core.js';
import { pageShell, iconBtn, pickTrack, isDrums, emptyState, addTrackSheet } from './common.js';
import { haptic, bigButton, chips } from '../touch.js';

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const LS = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const SS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } };

/** Velocity from the touch position inside a key: 0.35 at the top edge … 1 at the bottom. */
export const velocityAt = (frac) => Math.max(0.3, Math.min(1, 0.35 + 0.65 * frac));

export function createPlayPage(app) {
  const { store, ui, actions } = app;
  const get = () => store.get();
  const trackBtn = h('button.pk-select.small', { type: 'button' });
  const recBtn = iconBtn('record', () => actions.toggleRecord(), 'Rec', 'labeled rec');
  const humBtn = iconBtn('music', () => app.openHum?.({ trackId: ui.get('selectedTrackId') }), 'Hum', 'labeled accent');
  const { el, body, titleEl } = pageShell('Play', humBtn, recBtn);
  titleEl.replaceWith(trackBtn);
  trackBtn.addEventListener('click', () => pickTrack(app, { title: 'Play which track?', onPick: () => render() }));

  let layout = LS('daw3-pocket-keys', 'scale');
  let octave = LS('daw3-pocket-oct', 4);
  const layoutChips = chips([{ value: 'scale', label: 'Scale' }, { value: 'chords', label: 'Chords' }, { value: 'piano', label: 'Piano' }], layout, (v) => { layout = v; SS('daw3-pocket-keys', v); render(); }, { cls: 'small' });
  const octEl = h('span.pk-oct');
  const octDown = iconBtn('minus', () => { octave = Math.max(1, octave - 1); SS('daw3-pocket-oct', octave); render(); }, 'Octave down');
  const octUp = iconBtn('plus', () => { octave = Math.min(7, octave + 1); SS('daw3-pocket-oct', octave); render(); }, 'Octave up');
  const tools = h('div.pk-play-tools', layoutChips, h('div.pk-oct-box', octDown, octEl, octUp));
  const statusEl = h('div.pk-play-status');
  const keysEl = h('div.pk-keys', { 'data-noswipe': '' });
  body.classList.add('pk-play-body');
  body.append(tools, statusEl, keysEl);

  let visible = false;
  const track = () => get().tracks.find((t) => t.id === ui.get('selectedTrackId'));
  const pcs = () => scalePitchClasses(get().key.root, get().key.scale);

  function keyEl(label, pitches, { root = false, black = false, sub = '' } = {}) {
    const k = h(`div.pk-key${root ? '.root' : ''}${black ? '.black' : ''}`, { dataset: { pitches: pitches.join(',') } }, h('span.pk-key-name', label), sub ? h('span.pk-key-sub', sub) : null);
    return k;
  }

  function render() {
    const t = track();
    trackBtn.replaceChildren(h('span.pk-tc-dot', { style: { background: t?.color || 'var(--text-3)' } }), h('span', t ? t.name : 'Choose a track'), icon('chevronDown', 16));
    octEl.textContent = `Oct ${octave}`;
    const k = get().key;
    if (!t || t.type !== 'instrument') {
      tools.hidden = true;
      keysEl.replaceChildren(emptyState('Pick an instrument track', 'Play it with your fingers here.', bigButton('Choose a track', () => pickTrack(app, { onPick: () => render() }), { ic: 'layers', cls: 'primary' }), bigButton('Add a track', () => addTrackSheet(app, () => render()), { ic: 'plus' })));
      return;
    }
    tools.hidden = false;
    const drums = isDrums(t);
    layoutChips.hidden = drums;
    octEl.parentElement.hidden = drums;
    keysEl.className = `pk-keys ${drums ? 'pads' : layout}`;
    if (drums) {
      keysEl.replaceChildren(...DRUM_PADS.slice(0, 16).map((p) => keyEl(p.name, [p.pitch], { root: p.pitch === 36 || p.pitch === 38 })));
      return;
    }
    const base = (octave + 1) * 12;
    if (layout === 'piano') {
      const rows = [1, 0].map((o) => {
        const lo = base + o * 12;
        const whites = [0, 2, 4, 5, 7, 9, 11].map((s) => keyEl(NAMES[s] + (s === 0 ? Math.floor((lo + s) / 12) - 1 : ''), [lo + s], { root: (lo + s) % 12 === k.root }));
        const blacks = [1, 3, 6, 8, 10].map((s) => { const b = keyEl('', [lo + s], { black: true, root: (lo + s) % 12 === k.root }); b.style.setProperty('--pos', String([1, 3, 6, 8, 10].indexOf(s) < 2 ? [1, 3].indexOf(s) + 1 : [6, 8, 10].indexOf(s) + 4)); return b; });
        return h('div.pk-piano-row', ...whites, ...blacks);
      });
      keysEl.replaceChildren(...rows);
      return;
    }
    // scale keys: 2 rows (upper octave on top), each the scale's degrees + the octave root
    const scale = pcs();
    const rootPitch = base + k.root;
    const deg = scale.length;
    const rows = [1, 0].map((o) => {
      const keys = [];
      for (let i = 0; i <= deg; i++) {
        const p = stepPitch(rootPitch, o * deg + i, scale);
        if (layout === 'chords') {
          const chord = [p, stepPitch(p, 2, scale), stepPitch(p, 4, scale)];
          const third = (chord[1] - chord[0] + 12) % 12, fifth = (chord[2] - chord[0] + 12) % 12;
          const q = third === 3 ? (fifth === 6 ? '°' : 'm') : fifth === 8 ? '+' : '';
          keys.push(keyEl(`${NAMES[p % 12]}${q}`, chord, { root: i % deg === 0, sub: ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][i % deg] || '' }));
        } else keys.push(keyEl(NAMES[p % 12], [p], { root: p % 12 === k.root, sub: `${Math.floor(p / 12) - 1}` }));
      }
      return h('div.pk-key-row', ...keys);
    });
    keysEl.replaceChildren(...rows);
    statusEl.textContent = `${pitchClassName(k.root)} ${k.scale} — only notes in the key. Touch higher on a key to play softer.`;
  }

  // multi-touch playing with slide (glissando) between keys
  const held = new Map(); // pointerId -> {el, pitches}
  const keyAt = (x, y) => document.elementFromPoint(x, y)?.closest?.('.pk-key');
  const on = (id, kEl, e) => {
    const pitches = kEl.dataset.pitches.split(',').map(Number);
    const r = kEl.getBoundingClientRect();
    const vel = velocityAt((e.clientY - r.top) / Math.max(1, r.height));
    for (const p of pitches) actions.liveNoteOn(p, vel);
    kEl.classList.add('down');
    held.set(id, { el: kEl, pitches });
    haptic(4);
  };
  const off = (id) => {
    const hd = held.get(id);
    if (!hd) return;
    held.delete(id);
    for (const p of hd.pitches) if (![...held.values()].some((o) => o.pitches.includes(p))) actions.liveNoteOff(p);
    if (![...held.values()].some((o) => o.el === hd.el)) hd.el.classList.remove('down');
  };
  keysEl.addEventListener('pointerdown', (e) => {
    const kEl = e.target.closest('.pk-key');
    if (!kEl) return;
    e.preventDefault();
    e.target.releasePointerCapture?.(e.pointerId);
    on(e.pointerId, kEl, e);
  });
  keysEl.addEventListener('pointermove', (e) => {
    const hd = held.get(e.pointerId);
    if (!hd) return;
    const kEl = keyAt(e.clientX, e.clientY);
    if (kEl && kEl !== hd.el) { off(e.pointerId); on(e.pointerId, kEl, e); }
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) keysEl.addEventListener(t, (e) => { if (t === 'pointerleave' && e.pointerType !== 'mouse') return; off(e.pointerId); });
  keysEl.addEventListener('contextmenu', (e) => e.preventDefault());

  const syncRec = () => {
    const rec = !!ui.get('recording');
    recBtn.classList.toggle('on', rec);
    if (rec) {
      const t = track();
      const pat = t && get().patterns[t.activePatternId];
      statusEl.textContent = `● Recording into ${pat?.name || 'the pattern'} — play along with the loop.`;
    }
  };
  app.subscribe((r) => {
    if (!visible) return;
    if (held.size === 0 && ('selectedTrackId' in r.ui || (r.project && !r.labels.every((l) => l === 'Record note' || l === 'Volume')))) render();
    syncRec();
  });
  return {
    el,
    show() { visible = true; render(); syncRec(); },
    hide() { visible = false; for (const id of [...held.keys()]) off(id); },
  };
}
