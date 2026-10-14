// Guided session ("Make a track"): a step-by-step walkthrough in the assistant panel that teaches while doing.
// Every step explains why it matters, offers big one-click actions (through the existing actions / store.transact,
// so everything is undoable) and a "do it yourself" path that switches view and spotlights the relevant UI.
// Pure logic (detection, suggestions, arranger) lives in ./wizard-core.js.
import { h, icon } from './dom.js';
import { button, select, toast, confirmDialog } from './components.js';
import { beatsPerBar, createNote } from '../core/model.js';
import { createRng } from '../core/util.js';
import * as theory from '../theory/index.js';
import { GENRES } from '../gen/genres.js';
import * as gen from '../gen/index.js';
import { extraInstrument, percPart } from '../gen/orchestra.js';
import { PRESETS, DRUM_KITS } from '../audio/index.js';
import {
  WIZARD_STEPS, STEP_IDS, MOODS, detectProgress, nextOpenStep, moodScale, suggestProgressions, describeProgression,
  loopBarsFor, planArrangement, applyArrangement, addSidechain, wizardRole, findRoleTrack,
} from './wizard-core.js';

const LS = 'daw3-wizard';
const load = () => { try { return JSON.parse(localStorage.getItem(LS) || 'null') || {}; } catch { return {}; } };
const DEFAULT_STATE = { started: false, step: 0, genre: null, mood: null, progressionId: null, melodySeeds: [], melodyPick: null, confirmed: {} };
const POPULAR = ['house', 'techno', 'trap', 'lofi-hip-hop', 'pop', 'drum-and-bass', 'synthwave', 'trance', 'dubstep', 'ambient', 'deep-house', 'boom-bap'];
const SCALE_CHOICES = ['minor', 'major', 'dorian', 'phrygian', 'mixolydian', 'lydian', 'harmonic-minor', 'minor-pentatonic', 'major-pentatonic', 'blues'];
const LAYERS = [
  { role: 'pad', label: 'Pad', icon: 'layers', why: 'Long, soft chords that fill the space behind everything.' },
  { role: 'arp', label: 'Arpeggio', icon: 'wave', why: 'The chord notes one at a time, in rhythm — motion without clutter.' },
  { role: 'counter', label: 'Counter-melody', icon: 'music', why: 'A second line that answers your hook in its gaps.' },
  { role: 'perc', label: 'Percussion', icon: 'drum', why: 'Shakers, congas or rims that add groove on top of the kit.' },
];
const MOOD_AN = { dark: 'a dark', uplifting: 'an uplifting', chill: 'a chill', energetic: 'an energetic' };
const SECTION_ABBR = { Intro: 'In', Verse: 'Vs', Build: '↗', Break: 'Brk', Outro: 'Out' };
const rand = () => (Math.random() * 2 ** 31) | 0;
const cap = (s) => String(s || '').replace(/(^|[-\s])\w/g, (m) => m.toUpperCase()).replace(/-/g, ' ');

function feelForBpm(bpm) {
  if (bpm < 80) return 'slow and spacious — room for long notes and big reverbs';
  if (bpm < 100) return 'a laid-back head-nod tempo';
  if (bpm < 116) return 'a mid-tempo groove — easy to dance or walk to';
  if (bpm < 136) return 'dance-floor pace: the pulse of club music';
  if (bpm < 160) return 'high energy (often felt half-time, so it can sound slower than it is)';
  return 'double-time energy — drums race while chords move slowly';
}

/** How to program the genre's basic beat on a 16-step grid (teaching text). */
function beatRecipe(g) {
  const id = g?.id || '';
  const fam = g?.family || '';
  if (['house', 'techno', 'trance', 'hard'].includes(fam) || ['disco', 'nu-disco', 'kpop', 'eurobeat', 'industrial'].includes(id)) {
    return 'Four-on-the-floor: kick on steps 1, 5, 9 and 13. Clap on 5 and 13. Closed hat on 3, 7, 11 and 15 (the off-beats).';
  }
  if (['trap', 'drill', 'phonk'].includes(id) || fam === 'bass') {
    return 'Half-time: kick on step 1 (and maybe 11), snare or clap only on 9 — the beat feels half as fast as the BPM. Fast hats on every step add the energy.';
  }
  if (fam === 'dnb' || fam === 'breaks') return 'Two-step break: kick on steps 1 and 11, snare on 5 and 13, hats on every other step.';
  if (id === 'reggae' || id === 'dub') return 'One-drop: kick and snare together on step 9 only, hats on the off-beats (3, 7, 11, 15).';
  if (id === 'reggaeton' || id === 'dancehall') return 'Dembow: kick on 1, 5, 9, 13 and snare on 4, 7, 12 and 15.';
  if (['hiphop', 'soul', 'chill'].includes(fam)) return 'Boom-bap: kick on steps 1 and 11 (try 8 too), snare on 5 and 13, hats on every odd step.';
  return 'Rock/pop backbeat: kick on steps 1 and 9, snare on 5 and 13, hats on every odd step (8th notes).';
}

export function createWizard(app) {
  const { store, ui, engine, actions } = app;
  const get = () => store.get();
  let state = { ...DEFAULT_STATE, ...load() };
  state.confirmed = state.confirmed || {};
  const save = () => {
    if (ui.get('booted')) state.pid = get().createdAt || null;
    try { localStorage.setItem(LS, JSON.stringify(state)); } catch { /* storage blocked */ }
  };
  /** Another project is open than the one the saved progress belongs to: start its guide from its first open step. */
  function syncProject() {
    if (!ui.get('booted')) return;
    const pid = get().createdAt || null;
    if (state.pid === undefined || state.pid === pid) { if (state.pid === undefined) save(); return; }
    Object.assign(state, { melodySeeds: [], melodyPick: null, progressionId: null, confirmed: {}, mood: null, genre: get().genre || null });
    state.step = get().tracks.length || get().genre ? nextOpenStep(detectProgress(get()), {}) : 0;
    save();
  }
  const setState = (patch) => { Object.assign(state, patch); save(); render(); };
  let filter = '';
  let flash = null; // {step, text} success line after an action
  let busy = false;

  const el = h('div.wz', { role: 'region', 'aria-label': 'Guided session: make a track' });

  // ------------------------------------------------------------------------------ helpers
  const genreId = () => get().genre || state.genre || null;
  const genre = () => GENRES[genreId()] || null;
  const keyLabel = (root, scale) => (theory.keyName ? theory.keyName(root, scale) : `${theory.pitchClassName(root)} ${scale}`);
  const bpb = () => beatsPerBar(get());
  const detect = () => detectProgress(get());
  const isDone = (id, d = detect()) => !!(d[id] || state.confirmed[id]);
  const suggestions = () => {
    const p = get();
    return suggestProgressions(genreId() || 'pop', p.key.root, p.key.scale, { mood: state.mood, limit: 4 });
  };
  const plannedProgId = () => {
    const s = suggestions();
    return (state.progressionId && s.some((x) => x.id === state.progressionId) ? state.progressionId : null)
      || (state.progressionId && theory.PROGRESSIONS[state.progressionId] ? state.progressionId : null) || s[0]?.id || 'aeolian-loop';
  };
  /** Bars of the loop the parts share: the chord pattern's length if there is one, else the planned progression's. */
  const loopBars = () => {
    const p = get();
    const d = detect();
    const ct = d.ids.chords && p.tracks.find((t) => t.id === d.ids.chords);
    const pat = ct && p.patterns[ct.activePatternId];
    if (pat?.notes?.length) return Math.max(1, Math.round(pat.length / bpb()));
    return loopBarsFor(describeProgression(plannedProgId(), p.key.root, p.key.scale).bars);
  };
  const say = (text) => { flash = { step: state.step, text }; };

  /** The project, plus (if it has no chords yet) a hidden chord track playing the planned progression, so bass and
   * melody generated before step 5 already follow the chords the wizard will suggest. */
  function harmonicProject(bars) {
    const p = get();
    if (detect().chords) return p;
    const prog = gen.generateProgression({ key: p.key.root, root: p.key.root, scale: p.key.scale, genre: genreId() || 'pop', bars, beatsPerBar: bpb(), progression: plannedProgId(), rng: createRng(7) });
    const notes = prog.flatMap((c) => c.notes.map((pitch) => ({ id: 'wz', pitch, start: c.startBeat, dur: c.durBeats * 0.98, vel: 0.7 })));
    const t = { id: '__wz_chords', name: 'plan', type: 'instrument', role: 'chords', instrument: { type: 'synth', preset: null, params: {} }, activePatternId: '__wz_pat' };
    return { ...p, tracks: [...p.tracks, t], patterns: { ...p.patterns, __wz_pat: { id: '__wz_pat', trackId: t.id, length: bars * bpb(), notes } } };
  }

  function partNotes(role, { seed = rand(), bars = loopBars() } = {}) {
    const base = harmonicProject(bars);
    const g = genre() || GENRES.pop;
    const rng = createRng(seed);
    const opts = { genre: g.id, key: base.key.root, root: base.key.root, scale: base.key.scale, bars, beatsPerBar: bpb(), rng, project: base };
    if (role === 'counter') {
      const lead = findRoleTrack(base, 'lead');
      const melody = lead ? base.patterns[lead.activePatternId]?.notes || [] : [];
      const found = gen.progressionFromProject(base);
      const progression = found?.progression?.length ? found.progression : gen.generateProgression({ ...opts, progression: plannedProgId() });
      return gen.generateRoleNotes('counter', { ...opts, progression, melody, energy: 0.6 });
    }
    if (role === 'perc') {
      const drums = findRoleTrack(base, 'drums');
      const dpat = drums && base.patterns[drums.activePatternId];
      const main = [];
      if (dpat) for (let off = 0; off < bars * bpb(); off += dpat.length || bars * bpb()) for (const n of dpat.notes) main.push({ ...n, start: n.start + off });
      try {
        const notes = percPart(g, { bars, kind: 'main', energy: 0.8, name: 'Main', roles: [] }, { bpb: bpb(), main });
        if (notes?.length) return notes;
      } catch (e) { console.warn('[wizard] perc', e); }
      const PERC = new Set([37, 54, 56, 63, 70, 75]);
      return gen.generatePartNotes('drums', opts).filter((n) => PERC.has(n.pitch) || n.pitch === 42).map((n) => ({ ...n, pitch: n.pitch === 42 ? 70 : n.pitch }));
    }
    return gen.generatePartNotes(role, opts);
  }

  function presetFor(role) {
    const g = genre() || GENRES.pop;
    if (role === 'counter' || role === 'perc') {
      try {
        const inst = extraInstrument(role, g, { soundfonts: false, plugins: false });
        if (inst?.preset && (PRESETS[inst.preset] || DRUM_KITS[inst.preset])) return inst.preset;
      } catch { /* fallback below */ }
      return role === 'perc' ? 'latin' : 'flute';
    }
    const id = g.presets?.[role] || { bass: 'saw-bass', chords: 'electric-piano', pad: 'warm-pad', lead: 'saw-lead', arp: 'arp-pluck' }[role];
    return PRESETS[id] || DRUM_KITS[id] ? id : 'synth';
  }
  const ROLE_NAME = { bass: 'Bass', chords: 'Chords', pad: 'Pad', lead: 'Lead', arp: 'Arp', counter: 'Counter melody', perc: 'Percussion', drums: 'Drums' };

  /** The track for a role: the existing one (even if empty) or a new one with the genre's sound. */
  function ensurePartTrack(role) {
    const p = get();
    const t = findRoleTrack(p, role, { anyTrack: true });
    if (t) return t;
    const preset = presetFor(role);
    return actions.addTrack(preset, { role, name: ROLE_NAME[role] || cap(role) });
  }

  /** Write notes into a role's track (creating it); one undo step for the notes. */
  function writePart(role, notes, { bars = loopBars(), label } = {}) {
    const t = ensurePartTrack(role);
    if (!t) return null;
    const pat = actions.ensurePattern(t.id);
    if (!pat) return null;
    const len = bars * bpb();
    store.transact(label || `Guide: ${ROLE_NAME[role] || role}`, (pp) => {
      const pt = pp.patterns[pat.id];
      if (!pt) return;
      pt.length = len;
      pt.notes = notes.filter((n) => n.start >= 0 && n.start < len - 1e-6).map((n) => createNote(n.pitch, n.start, Math.max(0.02, Math.min(n.dur, len - n.start)), n.vel ?? 0.8));
    });
    actions.selectTrack(t.id);
    return t;
  }

  const trackNotes = (t) => { const p = get(); return t ? p.patterns[t.activePatternId]?.notes?.length || 0 : 0; };

  async function confirmReplace(role, what) {
    const t = findRoleTrack(get(), role);
    if (!t || !trackNotes(t)) return true;
    return confirmDialog(`Replace your ${what}?`, `"${t.name}" already has notes. Replace them with a new ${what}? (You can undo with Ctrl+Z.)`);
  }

  async function playLoop() {
    if (get().mode === 'song' && !get().clips.length) actions.setMode('pattern');
    try { await actions.play(); } catch { /* audio blocked: toast shown by ensureAudio */ }
    render();
  }
  async function togglePlay() { try { await actions.togglePlay(); } catch { /* */ } setTimeout(render, 30); }

  // ------------------------------------------------------------------------------ audition (scale / chords)
  async function voice() {
    await actions.ensureAudio();
    const ctx = engine.ctx;
    const p = get();
    const t = ['chords', 'pad', 'lead', 'arp', 'other'].map((r) => p.tracks.find((x) => x.type === 'instrument' && wizardRole(x) === r && !x.mute)).find(Boolean);
    const inst = t && engine.graph?.getInstrument?.(t.id);
    if (inst?.trigger) return { ctx, play: (time, pitch, vel, dur) => { try { inst.trigger(time, pitch, vel, dur); } catch { /* */ } } };
    const out = engine.graph?.master?.input || ctx.destination;
    return {
      ctx,
      play: (time, pitch, vel, dur) => {
        const o = ctx.createOscillator();
        const f = ctx.createBiquadFilter();
        const g = ctx.createGain();
        o.type = 'triangle';
        o.frequency.value = 440 * 2 ** ((pitch - 69) / 12);
        f.type = 'lowpass'; f.frequency.value = 2400;
        g.gain.setValueAtTime(0, time);
        g.gain.linearRampToValueAtTime(0.16 * vel, time + 0.012);
        g.gain.setTargetAtTime(0.1 * vel, time + 0.05, 0.2);
        g.gain.setTargetAtTime(0, time + dur * 0.9, 0.06);
        o.connect(f); f.connect(g); g.connect(out);
        o.start(time); o.stop(time + dur + 0.5);
      },
    };
  }
  async function playScale() {
    const p = get();
    const { ctx, play } = await voice();
    const pcs = theory.scalePitchClasses(p.key.root, p.key.scale);
    const base = 60 + p.key.root - (p.key.root > 6 ? 12 : 0);
    const iv = pcs.map((pc) => ((pc - p.key.root + 12) % 12)).sort((a, b) => a - b);
    const seq = [...iv.map((x) => base + x), base + 12, ...iv.slice().reverse().map((x) => base + x)];
    const t0 = ctx.currentTime + 0.05;
    seq.forEach((m, i) => play(t0 + i * 0.2, m, i === 0 || i === iv.length ? 0.85 : 0.7, 0.22));
  }
  async function playNote(m) { const { ctx, play } = await voice(); play(ctx.currentTime + 0.02, m, 0.8, 0.5); }
  async function playProgression(id) {
    const p = get();
    const { ctx, play } = await voice();
    const chords = theory.progressionChords(id, p.key.root, p.key.scale);
    let t = ctx.currentTime + 0.05;
    let prev = [];
    const unit = Math.min(1.6, (60 / p.bpm) * bpb() * 0.6);
    for (const c of chords) {
      const notes = theory.voiceChord ? theory.voiceChord(c.chord, { prev, range: [52, 76], maxVoices: 4 }) : [];
      const dur = Math.max(0.35, unit * c.bars);
      for (const n of notes) play(t, n, 0.6, dur * 0.95);
      play(t, 36 + ((c.chord.root - 36) % 12 + 12) % 12 + (c.chord.root % 12 < 4 ? 12 : 0), 0.7, dur * 0.95);
      prev = notes;
      t += dur;
    }
  }

  // ------------------------------------------------------------------------------ spotlight
  let spot = null;
  function closeSpotlight() {
    if (!spot) return;
    cancelAnimationFrame(spot.raf);
    window.removeEventListener('keydown', spot.onKey, true);
    spot.root.remove();
    const ret = spot.returnFocus;
    spot = null;
    try { ret?.focus?.(); } catch { /* */ }
  }
  /** Find an element (selector, element or function), waiting for lazily mounted views. */
  function waitFor(target, timeout = 2500) {
    const find = () => {
      const e = typeof target === 'function' ? target() : typeof target === 'string' ? document.querySelector(target) : target;
      return e && e.isConnected && e.getBoundingClientRect().width > 0 ? e : null;
    };
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = () => {
        const e = find();
        if (e || performance.now() - t0 > timeout) resolve(e);
        else requestAnimationFrame(tick);
      };
      tick();
    });
  }
  /** Dim the screen except `target`, with a callout bubble pointing at it. Esc / click anywhere dismisses. */
  async function spotlight(target, { title, text, steps } = {}) {
    closeSpotlight();
    const elx = await waitFor(target);
    if (!elx) { toast(text || title || 'Have a look around!', { timeout: 5000 }); return; }
    try { elx.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* */ }
    const blockers = [0, 1, 2, 3].map(() => h('div.wz-spot-block'));
    const ring = h('div.wz-spot-ring');
    const gotIt = button('Got it', () => closeSpotlight(), { primary: true, cls: 'small' });
    const bubble = h('div.wz-spot-bubble', { role: 'dialog', 'aria-label': title || 'Tip' },
      h('div.wz-spot-arrow'),
      title ? h('b', title) : null,
      text ? h('p', text) : null,
      steps?.length ? h('ol', steps.map((s) => h('li', s))) : null,
      h('div.wz-spot-foot', h('span.muted', 'Esc or click to close'), gotIt));
    const root = h('div.wz-spot', ...blockers, ring, bubble);
    document.body.appendChild(root);
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSpotlight(); } };
    window.addEventListener('keydown', onKey, true);
    for (const b of blockers) b.addEventListener('pointerdown', (e) => { e.preventDefault(); closeSpotlight(); });
    // clicking inside the highlighted area works normally and closes the callout
    const passThrough = (e) => { if (spot && !bubble.contains(e.target)) closeSpotlight(); };
    elx.addEventListener('pointerdown', passThrough, { once: true, capture: true });
    spot = { root, onKey, raf: 0, returnFocus: document.activeElement };
    const pad = 6;
    const place = () => {
      if (!spot || spot.root !== root) return;
      if (!elx.isConnected) { closeSpotlight(); return; }
      const r = elx.getBoundingClientRect();
      const W = window.innerWidth, H = window.innerHeight;
      const x0 = Math.max(0, r.left - pad), y0 = Math.max(0, r.top - pad), x1 = Math.min(W, r.right + pad), y1 = Math.min(H, r.bottom + pad);
      const set = (b, l, t, w, hh) => Object.assign(b.style, { left: `${l}px`, top: `${t}px`, width: `${Math.max(0, w)}px`, height: `${Math.max(0, hh)}px` });
      set(blockers[0], 0, 0, W, y0);
      set(blockers[1], 0, y1, W, H - y1);
      set(blockers[2], 0, y0, x0, y1 - y0);
      set(blockers[3], x1, y0, W - x1, y1 - y0);
      set(ring, x0, y0, x1 - x0, y1 - y0);
      const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
      let top, arrowSide;
      if (H - y1 >= bh + 16) { top = y1 + 12; arrowSide = 'top'; }
      else if (y0 >= bh + 16) { top = y0 - bh - 12; arrowSide = 'bottom'; }
      else { top = Math.max(8, Math.min(H - bh - 8, y0 + 12)); arrowSide = 'none'; }
      const cx = (x0 + x1) / 2;
      const left = Math.max(8, Math.min(W - bw - 8, cx - bw / 2));
      Object.assign(bubble.style, { left: `${left}px`, top: `${top}px` });
      bubble.dataset.arrow = arrowSide;
      bubble.style.setProperty('--arrow-x', `${Math.max(14, Math.min(bw - 14, cx - left))}px`);
      spot.raf = requestAnimationFrame(place);
    };
    place();
    setTimeout(() => { if (spot?.root === root) gotIt.focus(); }, 30);
  }
  const inView = (view, sel) => () => document.querySelector(`.view[data-view="${view}"] ${sel}`);
  const headerField = (label) => () => [...document.querySelectorAll('.app-header .hfield')].find((f) => f.querySelector('.hlabel')?.textContent.trim() === label);
  function showView(id) { if (ui.get('view') !== id) ui.set({ view: id }); }

  // ------------------------------------------------------------------------------ step actions
  async function applyVibe(gid, mood = state.mood) {
    const g = GENRES[gid];
    if (!g) return;
    const p = get();
    const { scale } = moodScale(gid, mood);
    if (p.key.scale !== scale && detect().hasMelodicNotes) {
      const ok = await confirmDialog('Change the scale?', `This switches the project to ${theory.SCALES[scale]?.name || scale}. Notes you already wrote won't move, so some may sound out of key. Continue?`);
      if (!ok) { state.genre = gid; state.mood = mood; save(); actions.setGenre(gid); render(); return; }
    }
    actions.applyGenreDefaults(gid);
    if (get().key.scale !== scale) store.transact('Guide: mood scale', (pp) => { pp.key.scale = scale; });
    state.genre = gid; state.mood = mood; state.progressionId = null; save();
    say(`${g.name} at ${get().bpm} BPM in ${keyLabel(get().key.root, get().key.scale)}.`);
    render();
  }

  async function setKey(root, scale) {
    const p = get();
    if ((p.key.root !== root || p.key.scale !== scale) && detect().hasMelodicNotes) {
      const ok = await confirmDialog('Change key?', 'Notes you already wrote won\'t be transposed, so they may clash with the new key. Continue?');
      if (!ok) { render(); return; }
    }
    store.transact('Guide: key', (pp) => { pp.key = { root: ((root % 12) + 12) % 12, scale }; });
    state.progressionId = null; save();
    render();
  }

  async function generateBeat() {
    if (!(await confirmReplace('drums', 'beat'))) return;
    const d = findRoleTrack(get(), 'drums', { anyTrack: true });
    const t = actions.generatePart('drums', { trackId: d?.id, bars: 2, genre: genreId() || undefined });
    if (t) { say(`New ${genre()?.name || ''} beat on "${t.name}". Listen to how kick and snare talk to each other.`); playLoop(); }
    render();
  }
  async function diyBeat() {
    let t = findRoleTrack(get(), 'drums', { anyTrack: true });
    if (!t) t = actions.addTrack('drums', { kit: genre()?.drumKit });
    if (t) actions.selectTrack(t.id);
    showView('rack');
    const kick = () => [...document.querySelectorAll('.view[data-view="rack"] .rack-row')].find((r) => /kick/i.test(r.querySelector('.rack-head')?.textContent || ''))
      || document.querySelector('.view[data-view="rack"] .rack-row');
    spotlight(kick, { title: 'Program your beat here', text: beatRecipe(genre()), steps: ['Click a step to turn it on, click again to turn it off.', 'Press Space to hear the loop while you edit.', 'Right-click a step for an accent or a ghost note.'] });
  }

  async function generateRole(role, what, { seed } = {}) {
    if (!(await confirmReplace(role, what))) return null;
    let notes;
    try { notes = partNotes(role, { seed }); } catch (e) { console.error(e); toast('Could not generate: ' + e.message, { level: 'error' }); return null; }
    const t = writePart(role, notes, { label: `Guide: generate ${what}` });
    if (t) playLoop();
    return t;
  }
  function diyPiano(role, { title, text, steps }) {
    const t = ensurePartTrack(role);
    if (!t) return;
    const pat = actions.ensurePattern(t.id);
    const len = loopBars() * bpb();
    if (pat && !pat.notes.length && pat.length < len) store.transact('Guide: pattern length', (pp) => { if (pp.patterns[pat.id]) pp.patterns[pat.id].length = len; });
    actions.selectTrack(t.id);
    showView('piano');
    spotlight(inView('piano', '.piano-gridwrap'), { title, text, steps });
  }

  async function useProgression(id) {
    const p = get();
    const d = detect();
    const ct = d.ids.chords && p.tracks.find((t) => t.id === d.ids.chords);
    if (ct && trackNotes(ct) && !(await confirmDialog('Replace your chords?', `"${ct.name}" already has chords. Replace them with ${theory.PROGRESSIONS[id]?.name || 'this progression'}? (Ctrl+Z undoes it.)`))) return;
    const info = describeProgression(id, p.key.root, p.key.scale);
    const bars = loopBarsFor(info.bars);
    const g = genre() || GENRES.pop;
    const rng = createRng(rand());
    const prog = gen.generateProgression({ key: p.key.root, root: p.key.root, scale: p.key.scale, genre: g.id, bars, beatsPerBar: bpb(), progression: id, rng });
    const notes = gen.progressionToNotes(prog, { style: g.chordStyle || 'whole', rng, beatsPerBar: bpb(), length: bars * bpb() });
    const hadBass = !!detect().bass || !!detect().melody;
    state.progressionId = id; save();
    writePart('chords', notes, { bars, label: `Guide: chords ${info.name}` });
    say(`${info.chords.map((c) => c.name).join(' – ')} written to your chords track.${hadBass ? ' Your bass/hook were made before — refresh them below so they follow these chords.' : ''}`);
    playLoop();
    render();
  }

  function refitParts() {
    const d = detect();
    const bars = loopBars();
    for (const role of ['bass', 'lead']) {
      if (!d[role === 'bass' ? 'bass' : 'melody']) continue;
      try { writePart(role, partNotes(role, { bars, seed: role === 'lead' && state.melodyPick != null ? state.melodyPick : rand() }), { bars, label: `Guide: refit ${role} to chords` }); } catch (e) { console.warn(e); }
    }
    say('Bass and hook now follow your chords.');
    render();
  }

  function rollMelodies() {
    state.melodySeeds = Array.from({ length: 4 }, () => rand());
    state.melodyPick = null;
    save();
    render();
  }
  async function tryMelody(seed) {
    if (state.melodyPick == null && !(await confirmReplace('lead', 'hook'))) return;
    let notes;
    try { notes = partNotes('lead', { seed }); } catch (e) { console.error(e); toast('Could not generate: ' + e.message, { level: 'error' }); return; }
    writePart('lead', notes, { label: 'Guide: try hook' });
    state.melodyPick = seed; save();
    playLoop();
    render();
  }

  async function addLayer(role) {
    const what = LAYERS.find((l) => l.role === role)?.label.toLowerCase() || role;
    if (!(await confirmReplace(role, what))) return;
    let notes;
    try { notes = partNotes(role); } catch (e) { console.error(e); toast('Could not generate: ' + e.message, { level: 'error' }); return; }
    if (!notes.length) { toast(`No ${what} part fits here — try another layer.`, { level: 'warn' }); return; }
    const t = writePart(role, notes, { label: `Guide: add ${what}` });
    if (t) { say(`Added "${t.name}". Mute and unmute it while the loop plays to hear what it adds.`); playLoop(); }
    render();
  }

  async function arrangeSong() {
    const p = get();
    const plan = planArrangement(p);
    if (!plan.clips.length) { toast('Make some parts first — the arranger uses your patterns.', { level: 'warn' }); return; }
    if (p.clips.some((c) => c.type !== 'audio') && !(await confirmDialog('Replace the arrangement?', 'Your timeline already has clips. Replace them with a new arrangement of your parts? (Ctrl+Z undoes it.)'))) return;
    engine.stop?.();
    store.transact('Guide: arrange song', (pp) => applyArrangement(pp, plan));
    showView('arrange');
    setTimeout(() => app.views?.arrange?.zoomToFit?.(), 120);
    const min = (plan.totalBeats / get().bpm);
    say(`Arranged ${plan.sections.length} sections · ${Math.floor(min)}:${String(Math.round((min % 1) * 60)).padStart(2, '0')} min. Press play to hear it from the top.`);
    render();
  }
  async function playFromStart() {
    const p = get();
    if (p.clips.length && p.mode !== 'song') actions.setMode('song');
    if (engine.isPlaying) engine.stop();
    actions.setPosition(0);
    try { await actions.play(); } catch { /* */ }
    setTimeout(render, 30);
  }

  async function mixer() {
    showView('mixer');
    const t0 = performance.now();
    while (!app.views?.mixer && performance.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 40));
    return app.views?.mixer || null;
  }
  async function balanceMix() {
    if (!get().tracks.length) { toast('Add some parts first.', { level: 'warn' }); return; }
    const mx = await mixer();
    if (mx?.assist?.full) mx.assist.full();
    state.confirmed.mix = true; save();
    say('Levels set by role, pans spread, reverb and delay sends added.');
    render();
    spotlight(inView('mixer', '.mx-scroll'), { title: 'Your balanced mix', text: 'Drums and bass sit loudest and centred; chords, pads and arps are tucked in and spread left/right. Small sends to the Reverb and Delay buses give everything one shared space.', steps: ['Drag a fader to taste — trust your ears.', 'Solo (S) a track to check it, then un-solo.', 'Ctrl+Z undoes the whole auto-mix in one step.'] });
  }
  function sidechain() {
    let n = 0;
    store.transact('Guide: sidechain pump', (pp) => { n = addSidechain(pp); });
    if (n) { say(`Sidechain ducking added to ${n} track${n === 1 ? '' : 's'}: they dip every time the kick hits.`); playLoop(); }
    else toast('Nothing to duck — needs a drum track plus bass/chords/pads (or they already pump).', { level: 'warn' });
    render();
  }

  // ------------------------------------------------------------------------------ view pieces
  const lead = (text) => h('p.wz-lead', text);
  const tip = (text, label = 'Tip') => h('div.wz-tip', icon('bulb', 14), h('div', h('b', label), h('span', ' ' + text)));
  const bigBtn = (ic, title, sub, onClick, { primary = false, attrs = {} } = {}) => {
    const b = h(`button.wz-big${primary ? '.primary' : ''}`, { type: 'button', ...attrs }, h('span.wz-big-icon', icon(ic, 18)), h('span.wz-big-text', h('b', title), sub ? h('small', sub) : null));
    b.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      b.classList.add('busy');
      try { await onClick(); } catch (e) { console.error('[wizard]', e); toast('Something went wrong: ' + e.message, { level: 'error' }); } finally { busy = false; b.classList.remove('busy'); }
    });
    return b;
  };
  const diy = (text, onClick) => {
    const b = h('button.wz-diy', { type: 'button', title: 'Switch to the right view and show me where' }, icon('pointer', 13), h('span', h('b', 'Do it yourself: '), text));
    b.addEventListener('click', onClick);
    return b;
  };
  const doneLine = (text) => h('div.wz-done', h('span.wz-check', '✓'), h('span', text));
  const playRow = () => {
    const playing = !!engine.isPlaying;
    const b = button(playing ? 'Stop' : 'Play loop', () => (playing ? togglePlay() : playLoop()), { icon: playing ? 'stop' : 'play', cls: 'small', title: 'Space also plays / pauses' });
    return h('div.wz-row', b, h('span.muted', 'Space = play / pause'));
  };
  const flashLine = () => (flash && flash.step === state.step ? h('div.wz-flash', { role: 'status' }, icon('sparkles', 13), h('span', flash.text)) : null);

  function miniKeyboard(root, scale) {
    const pcs = new Set(theory.scalePitchClasses(root, scale));
    const flats = theory.keyPrefersFlats?.(root, scale);
    const base = 48;
    const whites = [];
    const blacks = [];
    const WHITE = [0, 2, 4, 5, 7, 9, 11];
    let wi = 0;
    for (let m = base; m < base + 24; m++) {
      const pc = m % 12;
      const inScale = pcs.has(pc);
      const isRoot = pc === root;
      const label = theory.pitchClassName(pc, flats || 'common');
      const deg = inScale ? [...theory.scalePitchClasses(root, scale)].indexOf(pc) + 1 : 0;
      const k = h(`button.wz-key${WHITE.includes(pc) ? '.white' : '.black'}${inScale ? '.in' : ''}${isRoot ? '.root' : ''}`,
        { type: 'button', title: `${label}${inScale ? ` — scale degree ${deg}${isRoot ? ' (root / home)' : ''}` : ' — not in the scale'}`, 'aria-label': `${label}${inScale ? ' in scale' : ''}` },
        WHITE.includes(pc) && inScale ? h('span', isRoot ? label : String(deg)) : null);
      k.addEventListener('click', () => playNote(m));
      if (WHITE.includes(pc)) { k.style.left = `calc(${wi} * 100% / 14)`; whites.push(k); wi++; }
      else { k.style.left = `calc(${wi} * 100% / 14 - 100% / 28 * 0.62)`; blacks.push(k); }
    }
    return h('div.wz-kbd', ...whites, ...blacks);
  }

  function melodyPreview(notes, len) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 200 34');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'wz-mel');
    if (!notes.length) return svg;
    const lo = Math.min(...notes.map((n) => n.pitch)) - 1, hi = Math.max(...notes.map((n) => n.pitch)) + 1;
    for (let b = 1; b < len / bpb(); b++) {
      const l = document.createElementNS(NS, 'line');
      Object.entries({ x1: (b * bpb() / len) * 200, x2: (b * bpb() / len) * 200, y1: 0, y2: 34, class: 'wz-mel-bar' }).forEach(([k, v]) => l.setAttribute(k, v));
      svg.appendChild(l);
    }
    for (const n of notes) {
      const r = document.createElementNS(NS, 'rect');
      const y = 32 - ((n.pitch - lo) / Math.max(1, hi - lo)) * 30;
      Object.entries({ x: (n.start / len) * 200, y: y - 1.5, width: Math.max(1.5, (n.dur / len) * 200 - 0.6), height: 3, rx: 1 }).forEach(([k, v]) => r.setAttribute(k, v));
      svg.appendChild(r);
    }
    return svg;
  }

  function planPreview(plan) {
    const p = get();
    const total = plan.totalBeats || 1;
    const head = h('div.wz-plan-row.head', h('span.wz-plan-name'), h('div.wz-plan-cells', plan.sections.map((s) => h(`div.wz-plan-sec.k-${s.kind}`, { style: { flex: String(s.bars) }, title: `${s.name}: ${s.bars} bars` }, s.bars >= 12 ? s.name : SECTION_ABBR[s.name] || s.name.slice(0, 2)))));
    const tracks = p.tracks.filter((t) => plan.sections.some((s) => s.trackIds.includes(t.id)));
    const rows = tracks.map((t) => h('div.wz-plan-row', h('span.wz-plan-name', { title: t.name }, t.name),
      h('div.wz-plan-cells', plan.sections.map((s) => h(`div.wz-plan-cell${s.trackIds.includes(t.id) ? '.on' : ''}`, { style: { flex: String(s.bars), '--c': t.color || 'var(--accent)' } })))));
    return h('div.wz-plan', { title: `${Math.round(total / bpb())} bars` }, head, ...rows);
  }

  function genreGrid() {
    const g0 = genreId();
    const order = [...POPULAR.filter((x) => GENRES[x]), ...Object.keys(GENRES).filter((x) => !POPULAR.includes(x)).sort((a, b) => GENRES[a].name.localeCompare(GENRES[b].name))];
    const grid = h('div.wz-genres', { role: 'listbox', 'aria-label': 'Genres' });
    const fill = () => {
      const f = filter.trim().toLowerCase();
      const ids = order.filter((id) => !f || `${GENRES[id].name} ${GENRES[id].family} ${id}`.toLowerCase().includes(f));
      grid.replaceChildren(...ids.map((id) => {
        const g = GENRES[id];
        const c = h(`button.wz-genre${id === g0 ? '.selected' : ''}`, { type: 'button', role: 'option', 'aria-selected': String(id === g0), title: g.tips?.[0] || g.name },
          h('b', g.name), h('small', `${g.defaultBpm} BPM · ${cap(g.family)}`));
        c.addEventListener('click', () => applyVibe(id));
        return c;
      }));
      if (!ids.length) grid.appendChild(h('div.muted.wz-none', 'No genre matches — try "house", "hip" or "jazz".'));
    };
    fill();
    const search = h('input.wz-search', { type: 'search', placeholder: `Search ${Object.keys(GENRES).length} genres…`, value: filter, 'aria-label': 'Search genres' });
    search.addEventListener('input', () => { filter = search.value; fill(); });
    search.addEventListener('keydown', (e) => e.stopPropagation());
    return h('div', search, grid);
  }

  // ------------------------------------------------------------------------------ steps
  const STEP_RENDER = {
    vibe() {
      const g = genre();
      const p = get();
      const moods = h('div.wz-moods', { role: 'radiogroup', 'aria-label': 'Mood' }, Object.entries(MOODS).map(([id, m]) => {
        const b = h(`button.wz-mood.m-${id}${state.mood === id ? '.on' : ''}`, { type: 'button', role: 'radio', 'aria-checked': String(state.mood === id), title: m.blurb }, h('b', m.label), h('small', m.blurb));
        b.addEventListener('click', () => { if (g) applyVibe(g.id, id); else setState({ mood: id }); });
        return b;
      }));
      let info = null;
      if (g) {
        const ms = moodScale(g.id, state.mood);
        info = h('div.wz-card',
          h('div.wz-card-title', h('b', g.name), h('span.chip', `${p.bpm} BPM`), h('span.chip', keyLabel(p.key.root, p.key.scale))),
          h('p', `Tempo ${g.bpm[0]}–${g.bpm[1]} BPM is ${feelForBpm(g.defaultBpm)}.`),
          g.swing ? h('p', `Swing ${Math.round(g.swing * 100)}%: every second 16th note is pushed a little late — that's what makes it groove instead of march.`) : h('p', 'Straight timing (no swing): tight and machine-precise.'),
          state.mood ? h('p', ms.why) : null);
      }
      return [
        lead('Every track starts with a feeling. Pick a mood, then a genre — I\'ll set the tempo, groove and scale to match.'),
        h('div.wz-label', '1 · Mood'), moods,
        h('div.wz-label', '2 · Genre'), genreGrid(),
        info,
        g?.tips?.[0] ? tip(g.tips[0], `${g.name} tip:`) : tip('Tempo (BPM) sets the energy more than anything else. Most dance music sits at 120–130 BPM; hip-hop around 85–95.'),
        diy('set tempo, swing and key in the header', () => spotlight(headerField('BPM'), { title: 'Tempo lives here', text: 'Drag up/down or type a BPM. Swing and Key are right next to it.' })),
      ];
    },
    key() {
      const p = get();
      const { root, scale } = p.key;
      const sc = theory.SCALES[scale];
      const scales = SCALE_CHOICES.includes(scale) ? SCALE_CHOICES : [scale, ...SCALE_CHOICES];
      const rootSel = select({ options: Array.from({ length: 12 }, (_, i) => ({ value: i, label: theory.pitchClassName(i, 'common') })), value: root, title: 'Root (home note)', onChange: (v) => setKey(Number(v), scale) });
      const scaleSel = select({ options: scales.map((id) => ({ value: id, label: theory.SCALES[id]?.name || id })), value: scale, title: 'Scale', onChange: (v) => setKey(root, v) });
      const minor = theory.isMinorScale(scale);
      const rel = theory.relativeKey?.(root, scale);
      return [
        lead('The key is home: the root note everything wants to return to. The scale is your palette — the notes that always sound right together.'),
        h('div.wz-keyname', keyLabel(root, scale)),
        miniKeyboard(root, scale),
        h('div.wz-row', rootSel, scaleSel),
        sc?.mood ? h('p.wz-text', h('b', `${sc.name}: `), `${sc.mood}.`) : null,
        h('div.wz-row', button('Hear the scale', () => playScale(), { icon: 'play', cls: 'small', title: 'Play the scale up and down' }), h('span.muted', 'Click any key to hear it')),
        tip(minor ? `Minor scales have a flat 3rd (three semitones above the root) — that one note is what makes them sound dark.${rel ? ` ${keyLabel(rel.root, rel.scale)} uses the very same notes, just with a different home.` : ''}`
          : `Major scales have a major 3rd (four semitones above the root) — that's the bright sound.${rel ? ` ${keyLabel(rel.root, rel.scale)} uses the same notes but feels darker.` : ''}`, 'Theory tip:'),
        diy('change the key in the header', () => spotlight(headerField('Key'), { title: 'Key & scale', text: 'Pick a root and a scale here any time. The piano roll highlights the notes of the scale.' })),
      ];
    },
    beat() {
      const d = detect();
      const t = d.ids.drums && get().tracks.find((x) => x.id === d.ids.drums);
      const g = genre();
      return [
        lead('The beat is the floor everyone stands on. The kick is the pulse, the snare or clap is the backbeat, and the hi-hats set the energy.'),
        t ? doneLine(`You have a beat: "${t.name}".`) : null,
        h('div.wz-actions',
          bigBtn('dice', t ? 'Generate a new beat' : 'Generate a beat', `${g ? g.name : 'Genre'}-style drums, 2 bars`, generateBeat, { primary: !t }),
          bigBtn('grid', 'Build it in the Step Rack', 'Program kick, snare and hats yourself', diyBeat)),
        flashLine(),
        t ? playRow() : null,
        h('div.wz-card', h('b', 'Recipe for this genre'), h('p', beatRecipe(g))),
        tip(g?.swing ? `Groove: ${g.name} swings ${Math.round(g.swing * 100)}% — the off-beat 16ths land a little late. Try the Swing field in the header and hear the beat loosen up.`
          : 'Groove: drums sound human when not every hit is equally loud. Quieter "ghost" notes between the main hits add bounce.', 'Producer tip:'),
      ];
    },
    bass() {
      const d = detect();
      const t = d.ids.bass && get().tracks.find((x) => x.id === d.ids.bass);
      const p = get();
      const planned = describeProgression(plannedProgId(), p.key.root, p.key.scale);
      return [
        lead('The bass glues rhythm to harmony: it plays the root of each chord, and it locks with the kick drum so they hit as one.'),
        t ? doneLine(`Bassline on "${t.name}".`) : null,
        h('div.wz-actions',
          bigBtn('dice', t ? 'Generate a new bassline' : 'Generate a bassline', d.beat ? 'Follows the chords and locks to your kick' : 'Follows the chords', async () => {
            const tt = await generateRole('bass', 'bassline');
            if (tt) say(d.chords ? 'The bass follows your chord roots and lands with the kick.' : `The bass follows ${planned.chords.map((c) => c.name).join(' – ')} for now — you'll pick the chords in the next step.`);
            render();
          }, { primary: !t }),
          bigBtn('piano', 'Draw it in the Piano Roll', 'Write your own bass notes', async () => diyPiano('bass', {
            title: 'Draw your bassline',
            text: `Click to add notes. Start with the root of each chord on beat 1 of every bar: ${planned.chords.map((c) => c.name.replace(/(maj|m|dim|aug|sus|\d).*$/, '')).join(', ')}. Highlighted rows are in the scale.`,
            steps: ['Click = add a note, drag the edge to make it longer.', 'Add short notes where your kick hits — they\'ll punch together.', 'Keep it low: around C1–C3.'],
          }))),
        flashLine(),
        t ? playRow() : null,
        tip('Leave space: if bass and kick play long notes at the same time they fight for the low end. Short bass notes between kicks (or sidechain in the Mix step) keep it clean.', 'Producer tip:'),
      ];
    },
    chords() {
      const d = detect();
      const p = get();
      const sugg = suggestions();
      const cur = state.progressionId;
      const list = h('div.wz-progs', sugg.map((s) => {
        const on = cur === s.id && d.chords;
        const card = h(`div.wz-prog${on ? '.on' : ''}`,
          h('div.wz-prog-head', h('b', s.name.replace(/\s*\(.*\)$/, '')), on ? h('span.wz-check', '✓') : null),
          h('div.wz-prog-chords', s.chords.map((c) => h(`span.wz-chord.fn-${c.fn}`, { title: `${c.name} (${c.roman}) — ${c.fnLabel}` }, h('small', c.roman), h('b', c.name)))),
          h('p.wz-prog-why', s.why),
          h('div.wz-row', button('Listen', () => playProgression(s.id), { icon: 'play', cls: 'small', title: `Hear ${s.name} in ${keyLabel(p.key.root, p.key.scale)}` }),
            button(on ? 'Write again' : 'Use these chords', () => useProgression(s.id), { icon: 'plus', cls: 'small', primary: !on, title: 'Write this progression into a Chords track (asks before replacing)' }),
            h('span.muted.wz-flow', s.flow)));
        return card;
      }));
      const refit = (d.bass || d.melody) && d.chords && flash?.step === state.step
        ? bigBtn('loop', 'Refresh bass & hook', 'Regenerate them to follow these chords', async () => {
          if (!(await confirmDialog('Refresh bass & hook?', 'This regenerates your bassline (and hook, if you have one) so they follow the new chords. Ctrl+Z undoes it.'))) return;
          refitParts();
        }) : null;
      return [
        lead(`Chords set the emotion. Here are progressions that suit ${genre()?.name || 'your genre'}${state.mood ? ` and ${MOOD_AN[state.mood]} mood` : ''}, already in ${keyLabel(p.key.root, p.key.scale)}. Listen, then pick one.`),
        d.chords && !cur ? doneLine('You already have chords — pick one below to replace them, or move on.') : null,
        flashLine(),
        refit,
        list,
        d.chords ? playRow() : null,
        h('div.wz-legend', h('span.fn-tonic', 'home (tonic)'), h('span.fn-subdominant', 'away'), h('span.fn-dominant', 'tension')),
        tip('Roman numerals name chords by their position in the key: i is home, iv/VI move away, V/VII create tension that wants to come home. Capital = major, lower case = minor.', 'Theory tip:'),
        diy('draw chords in the Piano Roll', () => {
          const s = sugg[0];
          diyPiano('chords', { title: 'Stack your chords', text: s ? `Try ${s.chords.map((c) => c.name).join(' – ')}, one chord per bar.` : 'One chord per bar.', steps: ['A chord = 3 notes stacked: root, 3rd and 5th (skip one scale row between each).', 'Make each chord a whole bar long.', 'Shift+click a chord in the Theory tab to write it for you.'] });
        }),
      ];
    },
    melody() {
      const d = detect();
      const p = get();
      const len = loopBars() * bpb();
      if (!state.melodySeeds?.length) state.melodySeeds = Array.from({ length: 4 }, () => rand());
      const cards = state.melodySeeds.map((seed, i) => {
        let notes = [];
        try { notes = partNotes('lead', { seed, bars: len / bpb() }); } catch { notes = []; }
        const on = state.melodyPick === seed && d.melody;
        const b = h(`button.wz-idea${on ? '.on' : ''}`, { type: 'button', title: `Try idea ${'ABCD'[i]} (writes it into your Lead track and plays the loop)`, 'aria-pressed': String(on) },
          h('span.wz-idea-name', 'ABCD'[i]), melodyPreview(notes, len), on ? h('span.wz-check', '✓') : h('span.wz-idea-play', icon('play', 12)));
        b.addEventListener('click', () => tryMelody(seed));
        return b;
      });
      return [
        lead('The hook is the part people hum on the way home. Here are four ideas built from your chords — click one to hear it in the loop, keep the one you love.'),
        d.melody && state.melodyPick == null ? doneLine('You already have a lead line. Try an idea below to replace it (asks first).') : null,
        h('div.wz-ideas', cards),
        h('div.wz-row', button('Four new ideas', () => rollMelodies(), { icon: 'dice', cls: 'small', title: 'Roll four new melodies' }), d.melody ? playRow() : null),
        flashLine(),
        tip('Motif + repetition: a short idea (3–5 notes) played twice, then changed a little the third time, is what makes a hook stick. Land long notes on chord tones; pass through the others quickly.', 'Songwriting tip:'),
        diy('write the hook in the Piano Roll', () => diyPiano('lead', { title: 'Write your hook', text: `Stay in ${keyLabel(p.key.root, p.key.scale)} (highlighted rows) and around C4–C6.`, steps: ['Write a 3–5 note idea in bar 1.', 'Copy it to bar 2 (Ctrl+C / Ctrl+V).', 'Change only the ending in bars 3–4.'] })),
      ];
    },
    layers() {
      const p = get();
      const rows = LAYERS.map((l) => {
        const t = findRoleTrack(p, l.role);
        return bigBtn(l.icon, `${t ? '✓ ' : ''}${l.label}`, t ? `On "${t.name}" — click for a new one` : l.why, () => addLayer(l.role), { attrs: { 'aria-label': `${t ? 'Regenerate' : 'Add'} ${l.label}` } });
      });
      return [
        lead('Layers add depth and movement. Add one, listen, and only keep it if the track feels bigger — not just busier.'),
        h('div.wz-actions.grid', rows),
        flashLine(),
        p.tracks.length ? playRow() : null,
        tip('Give every part its own space: low (bass), middle (chords), high (lead, arp, hats). Long sounds (pads) pair well with short ones (plucks, arps).', 'Producer tip:'),
      ];
    },
    arrange() {
      const p = get();
      const plan = planArrangement(p);
      const d = detect();
      return [
        lead('So far you\'ve built one loop. A song takes listeners on a ride: start small, build tension, drop everything in, take it away, then bring it back bigger.'),
        plan.clips.length ? planPreview(plan) : h('p.muted', 'Make some parts first — the arranger uses your patterns.'),
        h('div.wz-actions',
          bigBtn('timeline', d.arrange ? 'Re-arrange my song' : 'Arrange my song', 'Intro → verse → build → chorus → break → chorus → outro', arrangeSong, { primary: !d.arrange }),
          d.arrange ? bigBtn('play', 'Play from the start', 'Song mode, from bar 1', playFromStart) : null,
          d.arrange ? bigBtn('plus', 'Make it longer…', 'Add sections with the Extend tool', () => actions.showExtendDialog()) : null),
        flashLine(),
        tip('The builds use a low-pass filter sweep (automation): the sound starts muffled and opens up, so the chorus hits harder. Removing the drums for the break makes their return feel huge.', 'Arrangement tip:'),
        diy('arrange clips on the timeline', () => { showView('arrange'); spotlight(inView('arrange', '.arr-body'), { title: 'The arrangement timeline', text: 'Each row is a track; each block a clip of a pattern.', steps: ['Double-click a lane to add a clip.', 'Drag clips to move them; Alt-drag copies.', 'Drag a clip\'s right edge to make it loop longer.'] }); }),
      ];
    },
    mix() {
      const d = detect();
      return [
        lead('Mixing makes every part audible: levels so nothing gets buried, panning for width, and a shared space (reverb) so it sounds like one band in one room.'),
        state.confirmed.mix ? doneLine('Mix balanced. Fine-tune by ear in the Mixer.') : null,
        h('div.wz-actions',
          bigBtn('sliders', 'Balance my mix', 'Gain staging, panning and sends by role', balanceMix, { primary: !state.confirmed.mix }),
          d.beat ? bigBtn('wave', 'Add sidechain pump', 'Bass and chords duck under the kick', sidechain) : null),
        flashLine(),
        h('ul.wz-tips',
          h('li', h('b', 'Gain staging: '), 'start with drums and bass, then bring the rest up until it sits — leave headroom on the master meter.'),
          h('li', h('b', 'Sidechain: '), 'ducking the bass when the kick hits gives the classic pump and stops them clashing.'),
          h('li', h('b', 'Reverb on a send: '), 'one shared reverb bus glues parts together; keep the bass dry.'),
          h('li', h('b', 'Pan: '), 'kick, snare, bass and lead in the centre; chords, pads and percussion to the sides.')),
        diy('use the Mixer', async () => { await mixer(); spotlight(() => [...document.querySelectorAll('.view[data-view="mixer"] .view-toolbar .btn')].find((b) => /auto-mix/i.test(b.textContent)) || document.querySelector('.view[data-view="mixer"] .mx-scroll'), { title: 'The Mixer', text: 'Faders set level, the knob above sets pan, sends feed the Reverb and Delay buses. Auto-mix assist has one-click helpers.' }); }),
      ];
    },
    finish() {
      const p = get();
      const end = p.clips.reduce((m, c) => Math.max(m, c.start + c.length), 0);
      const min = end / p.bpm;
      return [
        h('div.wz-celebrate', h('div.wz-celebrate-mark', '♪'), h('b', 'You made a track!'),
          h('span', `${GENRES[p.genre]?.name || 'Your song'} · ${keyLabel(p.key.root, p.key.scale)} · ${p.bpm} BPM · ${p.tracks.length} tracks${end ? ` · ${Math.floor(min)}:${String(Math.round((min % 1) * 60)).padStart(2, '0')}` : ''}`)),
        h('div.wz-actions.grid',
          bigBtn('play', 'Play from the start', 'Hear the whole song', playFromStart, { primary: true }),
          bigBtn('download', 'Export WAV', 'A mixdown to share anywhere', () => actions.exportWav()),
          bigBtn('save', 'Save .daW3', 'The project file, samples included', () => actions.saveProject()),
          bigBtn('code', 'View as Strudel code', 'Your song as live-code patterns', () => { showView('code'); })),
        tip('Live coders can paste the code into strudel.cc — or keep jamming on it right here in the Code view.', 'Did you know?'),
        h('div.wz-row.center', button('Start a new guided track', async () => {
          if (!(await actions.newProject())) return;
          state = { ...DEFAULT_STATE, started: true, confirmed: {} }; save(); render();
        }, { icon: 'plus', cls: 'small' })),
      ];
    },
  };

  // ------------------------------------------------------------------------------ shell
  function intro() {
    const d = detect();
    const resume = state.step > 0;
    return h('div.wz-intro',
      h('div.wz-hero', h('div.wz-hero-mark', icon('wand', 22)), h('b', 'Make a track, step by step'),
        h('p', 'Ten short steps from an empty project to a finished, mixed song — with the music theory and production tricks explained as you go. Every step can be generated for you or done by hand.')),
      h('ol.wz-outline', WIZARD_STEPS.map((s, k) => h(`li${isDone(s.id, d) ? '.done' : ''}`, isDone(s.id, d) ? h('span.wz-check', '✓') : h('span.wz-num', String(k + 1)), s.title))),
      h('div.wz-row.center',
        button(resume ? `Resume · step ${state.step + 1}` : 'Start the guide', () => start(), { primary: true, icon: 'play' }),
        resume ? button('Start over', () => { state = { ...DEFAULT_STATE, confirmed: {} }; start(0); }, { cls: 'small' }) : null));
  }

  function goto(i) {
    closeSpotlight();
    state.step = Math.max(0, Math.min(STEP_IDS.length - 1, i));
    flash = null;
    save();
    render();
    el.querySelector('.wz-steptitle')?.focus({ preventScroll: true });
    el.closest('.tab-body')?.scrollTo?.({ top: 0 });
  }

  function render() {
    if (!state.started) { el.replaceChildren(intro()); return el; }
    const d = detect();
    const i = state.step;
    const step = WIZARD_STEPS[i];
    let body;
    try { body = STEP_RENDER[step.id](); } catch (e) { console.error('[wizard]', e); body = [h('div.wz-card', h('b', 'This step hit a snag'), h('p', e.message))]; }
    const doneCount = STEP_IDS.filter((id) => isDone(id, d)).length;
    const bar = h('div.wz-progress', { role: 'list', 'aria-label': `${doneCount} of ${STEP_IDS.length} steps done` }, WIZARD_STEPS.map((s, k) => {
      const done = isDone(s.id, d);
      const b = h(`button.wz-seg${done ? '.done' : ''}${k === i ? '.current' : ''}`, { type: 'button', role: 'listitem', title: `${k + 1}. ${s.title}${done ? ' ✓' : ''}`, 'aria-label': `Step ${k + 1}: ${s.title}${done ? ', done' : ''}${k === i ? ', current' : ''}` });
      b.addEventListener('click', () => goto(k));
      return b;
    }));
    const done = isDone(step.id, d);
    const next = button(i === STEP_IDS.length - 1 ? 'Done' : 'Next', () => {
      if (step.id === 'key' || (step.id === 'vibe' && d.vibe) || step.id === 'finish') state.confirmed[step.id] = true;
      if (i === STEP_IDS.length - 1) { state.started = false; save(); render(); toast('Guide closed — reopen it any time from the Guide tab or the main menu.', { timeout: 3500 }); return; }
      goto(i + 1);
    }, { primary: done || step.id === 'key' || step.id === 'finish', title: i === STEP_IDS.length - 1 ? 'Finish the guide' : 'Next step' });
    const back = button('Back', () => goto(i - 1), { cls: 'small', title: 'Previous step' });
    back.disabled = i === 0;
    const skip = h('button.as-link.wz-skip', { type: 'button', title: 'Skip this step' }, 'Skip');
    skip.addEventListener('click', () => goto(i + 1));
    const close = h('button.as-link.wz-close', { type: 'button', title: 'Leave the guide (your place is remembered)' }, 'Exit');
    close.addEventListener('click', () => { closeSpotlight(); state.started = false; save(); render(); });
    el.replaceChildren(
      h('div.wz-top', h('span.wz-count', `Step ${i + 1} of ${STEP_IDS.length}`), h('div.spacer'), close),
      bar,
      h('h3.wz-steptitle', { tabindex: '-1' }, step.title, done ? h('span.wz-check', { title: 'Done' }, '✓') : null),
      h('div.wz-body', ...body.filter(Boolean)),
      h('div.wz-nav', back, h('div.spacer'), i < STEP_IDS.length - 1 ? skip : null, next));
    return el;
  }

  function start(step) {
    state.started = true;
    if (step != null) state.step = step;
    else if (!state.step) state.step = nextOpenStep(detect(), state.confirmed);
    save();
    render();
  }

  // live ✓ updates while the guide is on screen (cheap signature check; never steals focus from the search box)
  let sig = '';
  let timer = null;
  app.subscribe((r) => {
    if (!el.isConnected) return;
    if (!r.project && !('view' in r.ui)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const p = get();
      const d = detect();
      const s = JSON.stringify([STEP_IDS.map((id) => d[id]), p.genre, p.key, p.bpm, p.tracks.length, p.clips.length, Object.keys(p.patterns).length, !!engine.isPlaying]);
      if (s === sig) return;
      sig = s;
      if (el.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName)) return;
      render();
    }, 250);
  });
  engine.on?.('state', () => { if (el.isConnected) setTimeout(() => { if (!(el.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement?.tagName))) render(); }, 0); });
  // a different project (new / opened / restored): the saved progress belongs to another one
  store.on?.('load', () => { syncProject(); if (el.isConnected) render(); });
  ui.on?.('change', (c) => { if ('booted' in c) { syncProject(); if (el.isConnected) render(); } });

  render();
  return { el, render, start, spotlight, closeSpotlight, get state() { return state; }, goto };
}
