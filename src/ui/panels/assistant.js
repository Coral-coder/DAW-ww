// Assistant panel (right): live recommendations, music-theory helper, generators and genre guide.
// Friendly and educational — every suggestion explains *why*.
import { h, icon } from '../dom.js';
import { iconButton, button, tabs, select, toggle, toast } from '../components.js';
import { beatsPerBar, createNote } from '../../core/model.js';
import { createRng } from '../../core/util.js';
import * as theory from '../../theory/index.js';
import * as genres from '../../gen/genres.js';
import * as audio from '../../audio/index.js';

const LS_TAB = 'heroic-assistant-tab';
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
const cap = (s) => String(s || '').replace(/(^|[-\s])\w/g, (m) => m.toUpperCase()).replace(/-/g, ' ');
const LEVEL = { tip: { icon: 'bulb', label: 'Tip' }, warn: { icon: 'help', label: 'Heads-up' }, idea: { icon: 'sparkles', label: 'Idea' } };
const FUNC_INFO = {
  tonic: { label: 'Tonic', cls: 'fn-t', why: 'Home: stable, restful — phrases like to start and end here.' },
  subdominant: { label: 'Subdominant', cls: 'fn-s', why: 'Moves away from home — creates gentle motion and "lift".' },
  dominant: { label: 'Dominant', cls: 'fn-d', why: 'Tension that wants to resolve back to the tonic.' },
  'secondary-dominant': { label: 'Secondary dominant', cls: 'fn-x', why: 'A borrowed V that points at another chord.' },
  chromatic: { label: 'Colour', cls: 'fn-x', why: 'Outside the key — colour and surprise.' },
};
const ROLE_INFO = {
  drums: { icon: 'drum', why: 'The groove: kick & snare set the pulse, hats set the energy.' },
  bass: { icon: 'music', why: 'Locks with the kick and defines each chord\'s root.' },
  chords: { icon: 'piano', why: 'Harmony: sets the mood (major = bright, minor = dark).' },
  pad: { icon: 'layers', why: 'Sustained background that glues the mix together.' },
  lead: { icon: 'sparkles', why: 'The hook people remember — built from chord tones on strong beats.' },
  arp: { icon: 'wave', why: 'Broken chords in a rhythm — adds motion without clutter.' },
};

let genMod = null;
function loadGen() {
  if (!genMod) genMod = import('../../gen/index.js').catch((e) => { console.warn('[assistant] gen/index.js unavailable', e); return {}; });
  return genMod;
}

/** Group a pattern's notes into chords (onset clusters, else per bar). -> [{chord, start, end, notes}] */
export function chordsInPattern(pat, bpb) {
  if (!pat?.notes?.length || !theory.detectChord) return [];
  const notes = [...pat.notes].sort((a, b) => a.start - b.start);
  const clusters = [];
  for (const n of notes) {
    const c = clusters[clusters.length - 1];
    if (c && Math.abs(n.start - c.start) < 0.13) c.notes.push(n); else clusters.push({ start: n.start, notes: [n] });
  }
  let segs = clusters.filter((c) => new Set(c.notes.map((n) => n.pitch % 12)).size >= 3);
  if (!segs.length) {
    // melodic material: one chord guess per bar
    const bars = Math.max(1, Math.ceil(pat.length / bpb));
    segs = [];
    for (let b = 0; b < bars; b++) {
      const ns = notes.filter((n) => n.start >= b * bpb && n.start < (b + 1) * bpb);
      if (new Set(ns.map((n) => n.pitch % 12)).size >= 3) segs.push({ start: b * bpb, notes: ns });
    }
  }
  const out = [];
  for (const s of segs) {
    const chord = theory.detectChord(s.notes.map((n) => n.pitch));
    if (!chord) continue;
    const end = Math.max(...s.notes.map((n) => n.start + n.dur));
    const last = out[out.length - 1];
    if (last && last.chord.root === chord.root && last.chord.type === chord.type) { last.end = Math.max(last.end, end); continue; }
    out.push({ chord, start: s.start, end, notes: s.notes.map((n) => n.pitch) });
  }
  return out;
}

export function createAssistantPanel(app) {
  const { store, ui, engine, actions } = app;
  const get = () => store.get();
  const GENRES = genres.GENRES || {};
  const PRESETS = audio.PRESETS || {};
  const DRUM_KITS = audio.DRUM_KITS || {};
  let gen = {};
  let activeTab = lsGet(LS_TAB, 'ideas');
  const dismissed = new Set();
  let recs = [];
  let recsKey = '';
  let recError = null;
  let sevenths = false;
  let keyGuesses = null;
  // generate-tab options
  const genOpts = { target: 'new', bars: 0, seed: '', lockSeed: false, amount: 0.35 };

  const selectedTrack = () => get().tracks.find((t) => t.id === ui.get('selectedTrackId')) || null;
  const selectedPattern = () => {
    const p = get();
    const pid = ui.get('selectedPatternId');
    if (pid && p.patterns[pid]) return p.patterns[pid];
    const t = selectedTrack();
    return t && p.patterns[t.activePatternId] ? p.patterns[t.activePatternId] : null;
  };
  const keyLabel = (root, scale) => (theory.keyName ? theory.keyName(root, scale) : `${theory.pitchClassName(root)} ${scale}`);

  // ---------------------------------------------------------------- shell
  const refreshBtn = iconButton('dice', () => { recsKey = ''; computeRecs(true); rerender(true); toast('Assistant refreshed', { timeout: 1200 }); }, 'Refresh suggestions');
  refreshBtn.firstChild.replaceWith(icon('loop', 15));
  const header = h('div.panel-header', icon('bulb', 14), h('span.title', 'Assistant'), h('div.spacer'), refreshBtn, iconButton('x', () => ui.set({ assistantOpen: false }), 'Hide assistant (A)'));
  const tabItems = [
    { id: 'ideas', label: 'Ideas', icon: 'sparkles', render: renderIdeas },
    { id: 'theory', label: 'Theory', icon: 'music', render: renderTheory },
    { id: 'generate', label: 'Generate', icon: 'wand', render: renderGenerate },
    { id: 'genre', label: 'Genre', icon: 'layers', render: renderGenre },
  ];
  const tabsEl = tabs(tabItems, activeTab, (id) => { activeTab = id; lsSet(LS_TAB, id); });
  tabsEl.classList.add('as-tabs');
  const el = h('div.as-panel', header, tabsEl);
  const bodyOf = () => tabsEl.querySelector('.tab-body');

  function rerender(force = false) {
    const body = bodyOf();
    const st = body?.scrollTop || 0;
    // don't yank content from under an active control (slider/number field)
    if (!force && body && body.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    tabsEl.show(activeTab);
    if (body) body.scrollTop = st;
  }

  // ---------------------------------------------------------------- helpers
  function chordTargetTrack() {
    const p = get();
    const t = selectedTrack();
    if (t && t.type === 'instrument' && t.instrument?.type !== 'drums' && !['bass', 'drums'].includes(t.role)) return t;
    return p.tracks.find((x) => x.type === 'instrument' && x.instrument?.type !== 'drums' && (x.role === 'chords' || x.role === 'pad'))
      || p.tracks.find((x) => x.type === 'instrument' && x.instrument?.type !== 'drums') || null;
  }
  function voicingFor(chord, prev) {
    if (prev?.length && theory.voiceLead) { const v = theory.voiceLead(prev, chord.notes || theory.chordPitchClasses(chord.root, chord.type), [52, 76]); if (v?.length) return v; }
    let r = 60 + chord.root; if (r > 66) r -= 12;
    return theory.chordNotes(r, chord.type, {});
  }
  async function audition(chord, prev) {
    const t = chordTargetTrack();
    if (!t) { toast('Add an instrument track (e.g. Keys) to hear chords', { level: 'warn' }); return; }
    try { await actions.ensureAudio(); } catch { return; }
    const notes = voicingFor(chord, prev);
    for (const n of notes) engine.noteOn(t.id, n, 0.7);
    setTimeout(() => { for (const n of notes) engine.noteOff(t.id, n); }, 900);
    app.setStatus?.(`${chord.name || theory.chordName(chord)} on ${t.name}: ${notes.map((n) => theory.noteName(n)).join(' ')}`);
  }
  function insertChord(chord, { at = null, prev = null } = {}) {
    let t = chordTargetTrack();
    if (!t || ['bass', 'lead', 'arp', 'fx'].includes(t.role)) {
      t = actions.addTrack(PRESETS['electric-piano'] ? 'electric-piano' : 'synth', { role: 'chords', name: 'Chords' });
      if (!t) return;
      toast(`Created a "${t.name}" track for your chords`, { timeout: 2000 });
    }
    const p = get();
    const bpb = beatsPerBar(p);
    let pat = selectedPattern();
    if (!pat || pat.trackId !== t.id) pat = actions.ensurePattern(t.id);
    if (!pat) return;
    let start = at;
    if (start == null) {
      const pos = engine.getPatternPosition?.(t.id) ?? (engine.getPosition?.() || 0);
      start = Math.floor((((pos % pat.length) + pat.length) % pat.length) / bpb) * bpb;
    }
    const dur = bpb;
    const notes = voicingFor(chord, prev);
    store.transact(`Insert ${chord.name || 'chord'}`, (pp) => {
      const pt = pp.patterns[pat.id];
      if (!pt) return;
      if (start + dur > pt.length) pt.length = Math.ceil((start + dur) / bpb) * bpb;
      pt.notes = pt.notes.filter((n) => !(n.start >= start - 1e-6 && n.start < start + dur - 1e-6));
      for (const pitch of notes) pt.notes.push(createNote(pitch, start, dur * 0.98, 0.72));
    });
    toast(`${chord.name || theory.chordName(chord)} written to "${t.name}" at bar ${Math.floor(start / bpb) + 1}`, { level: 'success', timeout: 2200 });
  }
  function setKey(root, scale, why) {
    store.transact('Set key', (p) => { p.key = { root: ((root % 12) + 12) % 12, scale }; });
    app.setStatus?.(`Key: ${keyLabel(root, scale)}${why ? ' — ' + why : ''}`);
  }
  const section = (title, ...children) => h('div.as-section', h('div.as-section-title', title), ...children);
  const explain = (text) => h('p.as-explain', text);

  // ---------------------------------------------------------------- IDEAS
  function computeRecs(force) {
    const p = get();
    const ctx = { selectedTrackId: ui.get('selectedTrackId'), selectedPatternId: ui.get('selectedPatternId'), view: ui.get('view') };
    if (!gen.getRecommendations) { recs = []; return false; }
    let next;
    try { next = gen.getRecommendations(p, ctx) || []; recError = null; } catch (e) { console.error('[assistant]', e); recError = e.message; next = []; }
    const key = JSON.stringify(next.map((r) => [r.id, r.title, r.text, r.level]));
    if (!force && key === recsKey) return false;
    recsKey = key;
    recs = next;
    return true;
  }
  function renderIdeas() {
    const wrap = h('div.as-ideas');
    const t = selectedTrack();
    const g = GENRES[get().genre];
    wrap.appendChild(h('div.as-context', icon('pointer', 12), h('span', t ? `Focused on ${t.name}` : 'Looking at the whole project'), g ? h('span.chip', g.name) : null, h('span.chip', keyLabel(get().key.root, get().key.scale))));
    if (!gen.getRecommendations) {
      wrap.appendChild(h('div.as-empty', icon('bulb', 22), h('p', 'The assistant is warming up…')));
      return wrap;
    }
    if (recError) wrap.appendChild(h('div.as-card.level-warn', h('div.as-card-body', h('b', 'Assistant hiccup'), h('p', recError))));
    const visible = recs.filter((r) => !dismissed.has(r.id));
    if (!visible.length && !recError) {
      wrap.appendChild(h('div.as-empty', icon('sparkles', 24), h('b', 'Nothing to flag right now'), h('p', 'Keep creating — suggestions update as you work. Try the Theory tab for chord ideas, or Generate for new parts.')));
    }
    const order = { warn: 0, idea: 1, tip: 2 };
    for (const r of visible.slice().sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3))) {
      const lv = LEVEL[r.level] || LEVEL.tip;
      const dismiss = iconButton('x', () => { dismissed.add(r.id); rerender(true); }, 'Dismiss this suggestion');
      dismiss.classList.add('as-dismiss');
      const actionBtn = r.action ? button(r.action.label || 'Apply', () => {
        try { actions.applyAssistantAction(r.action); app.setStatus?.(`Assistant: ${r.title}`); } catch (e) { toast('Could not apply: ' + e.message, { level: 'error' }); }
        dismissed.add(r.id);
        setTimeout(() => { computeRecs(true); rerender(true); }, 50);
      }, { icon: 'wand', primary: r.level === 'idea', cls: 'small', title: r.action.label }) : null;
      wrap.appendChild(h(`div.as-card.level-${r.level || 'tip'}`,
        h('div.as-card-icon', { title: lv.label }, icon(lv.icon, 15)),
        h('div.as-card-body', h('div.as-card-title', h('b', r.title || ''), dismiss), r.text ? h('p', r.text) : null, actionBtn ? h('div.as-card-actions', actionBtn) : null)));
    }
    if (dismissed.size) {
      const restore = h('button.as-link', { type: 'button' }, `Show ${dismissed.size} dismissed`);
      restore.addEventListener('click', () => { dismissed.clear(); rerender(true); });
      wrap.appendChild(h('div.as-foot', restore));
    }
    return wrap;
  }

  // ---------------------------------------------------------------- THEORY
  function circleOfFifths(root, scale) {
    const NS = 'http://www.w3.org/2000/svg';
    const S = 236, C = S / 2, R1 = 112, R2 = 80, R3 = 50;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${S} ${S}`);
    svg.setAttribute('class', 'as-cof');
    const minor = theory.isMinorScale ? theory.isMinorScale(scale) : /minor/.test(scale);
    const COF = theory.CIRCLE_OF_FIFTHS || [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];
    const majorRoot = minor ? (root + 3) % 12 : root; // relative major position on the circle
    const idx = COF.indexOf(majorRoot);
    const pt = (r, a) => [C + r * Math.cos(a), C + r * Math.sin(a)];
    const arc = (ri, ro, a0, a1) => {
      const [x0, y0] = pt(ro, a0), [x1, y1] = pt(ro, a1), [x2, y2] = pt(ri, a1), [x3, y3] = pt(ri, a0);
      return `M${x0} ${y0} A${ro} ${ro} 0 0 1 ${x1} ${y1} L${x2} ${y2} A${ri} ${ri} 0 0 0 ${x3} ${y3}Z`;
    };
    const mk = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };
    for (let i = 0; i < 12; i++) {
      const a0 = ((i - 0.5) / 12) * Math.PI * 2 - Math.PI / 2, a1 = ((i + 0.5) / 12) * Math.PI * 2 - Math.PI / 2, am = (i / 12) * Math.PI * 2 - Math.PI / 2;
      const dist = Math.min(Math.abs(i - idx), 12 - Math.abs(i - idx));
      const maj = COF[i], min = (maj + 9) % 12;
      for (const [ring, pc, sc] of [['outer', maj, 'major'], ['inner', min, 'minor']]) {
        const isCur = (ring === 'outer' && !minor && pc === root) || (ring === 'inner' && minor && pc === root);
        const cls = `as-cof-seg ${ring}${isCur ? ' current' : dist <= 1 ? ' near' : ''}`;
        const path = mk('path', { d: ring === 'outer' ? arc(R2, R1, a0, a1) : arc(R3, R2, a0, a1), class: cls });
        const name = theory.pitchClassName(pc, theory.keyPrefersFlats ? theory.keyPrefersFlats(pc, sc) : false);
        const title = mk('title', {}, `${name} ${sc}${isCur ? ' (current key)' : dist === 1 ? ' — closely related: shares 6 of 7 notes' : dist === 0 ? ' — relative key: same notes' : ''}. Click to switch.`);
        path.appendChild(title);
        path.addEventListener('click', () => setKey(pc, sc, dist <= 1 ? 'a close neighbour on the circle, so the change sounds smooth.' : 'a distant key — expect a dramatic colour change.'));
        svg.appendChild(path);
        const [tx, ty] = pt(ring === 'outer' ? (R1 + R2) / 2 : (R2 + R3) / 2, am);
        svg.appendChild(mk('text', { x: tx, y: ty + 4, class: `as-cof-label ${ring}${isCur ? ' current' : ''}` }, ring === 'outer' ? name : name.toLowerCase() + 'm'));
      }
    }
    const sig = theory.keySignature ? theory.keySignature(root, scale) : 0;
    svg.appendChild(mk('text', { x: C, y: C - 4, class: 'as-cof-center' }, keyLabel(root, scale).split(' ')[0]));
    svg.appendChild(mk('text', { x: C, y: C + 12, class: 'as-cof-sub' }, sig === 0 ? 'no ♯/♭' : sig > 0 ? `${sig} ♯` : `${-sig} ♭`));
    return svg;
  }

  function renderTheory() {
    const p = get();
    const { root, scale } = p.key;
    const wrap = h('div.as-theory');
    const sc = theory.SCALES?.[scale] || theory.getScale?.(scale);
    // --- key
    const rootSel = select({ options: Array.from({ length: 12 }, (_, i) => ({ value: i, label: theory.pitchClassName(i, 'common') })), value: root, title: 'Key root', onChange: (v) => setKey(Number(v), scale) });
    const scaleSel = select({ options: Object.entries(theory.SCALES || {}).map(([id, s]) => ({ value: id, label: s.name })), value: scale, title: 'Scale / mode', onChange: (v) => setKey(root, v) });
    const pcs = theory.scalePitchClasses ? theory.scalePitchClasses(root, scale) : [];
    const flats = theory.keyPrefersFlats ? theory.keyPrefersFlats(root, scale) : false;
    const noteChips = h('div.as-notes', pcs.map((pc, i) => h(`span.as-note${i === 0 ? '.root' : ''}`, { title: `Scale degree ${i + 1}` }, h('small', String(i + 1)), theory.pitchClassName(pc, flats || 'common'))));
    wrap.appendChild(section('Key & scale',
      h('div.as-keyrow', h('div.as-keyname', keyLabel(root, scale)), h('div.spacer'), rootSel, scaleSel),
      sc?.mood ? explain(`Mood: ${sc.mood}. Notes from this scale will always sound "right" together — the piano roll highlights them.`) : null,
      noteChips));
    // --- circle of fifths
    const rel = theory.relativeKey?.(root, scale);
    const par = theory.parallelKey?.(root, scale);
    const nb = theory.circleNeighbors?.(root, scale);
    const keyBtn = (label, k, why) => k ? button(`${label}: ${keyLabel(k.root, k.scale)}`, () => setKey(k.root, k.scale, why), { cls: 'small', title: why }) : null;
    wrap.appendChild(section('Circle of fifths',
      h('div.as-cof-wrap', circleOfFifths(root, scale)),
      explain('Neighbouring keys differ by just one note, so moving to them (or borrowing their chords) sounds smooth. The inner ring shows each major key\'s relative minor — same notes, different home.'),
      h('div.as-keybtns',
        keyBtn('Relative', rel, 'Same notes, different home note — the mood flips between bright and dark without any new notes.'),
        keyBtn('Parallel', par, 'Same root, opposite mode — great for borrowing chords (modal interchange).'),
        nb ? keyBtn('Dominant', nb.dominant, 'One step clockwise: adds a sharp. Modulating up a fifth feels energetic.') : null,
        nb ? keyBtn('Subdominant', nb.subdominant, 'One step counter-clockwise: adds a flat. Feels warmer, more relaxed.') : null)));
    // --- diatonic chords
    const chords = theory.diatonicChords ? theory.diatonicChords(root, scale, { sevenths }) : [];
    const sevToggle = toggle({ label: '7ths', value: sevenths, title: 'Show four-note seventh chords (jazzier, richer)', onChange: (v) => { sevenths = v; rerender(true); } });
    const chordGrid = h('div.as-chords', chords.map((c) => {
      const fn = theory.chordFunction ? theory.chordFunction(c, root, scale) : 'tonic';
      const fi = FUNC_INFO[fn] || FUNC_INFO.chromatic;
      const chip = h(`button.as-chord.${fi.cls}`, { type: 'button', title: `${c.name} (${c.roman}) — ${fi.label}. ${fi.why}\nClick: listen · Shift+click: write it at the playhead into the selected pattern` }, h('b', c.roman), h('span', c.name));
      chip.addEventListener('click', (e) => { if (e.shiftKey) insertChord(c); else audition(c); });
      return chip;
    }));
    wrap.appendChild(section('Chords in this key',
      h('div.as-row', explain('Click to hear, Shift+click to write into the selected pattern at the playhead.'), sevToggle),
      chordGrid,
      h('div.as-legend', h('span.fn-t', 'Tonic = home'), h('span.fn-s', 'Subdominant = away'), h('span.fn-d', 'Dominant = tension'))));
    // --- what next?
    wrap.appendChild(renderWhatNext(root, scale));
    // --- detect key
    const detectBtn = button('Detect key from notes', () => {
      const pp = get();
      const notes = [];
      for (const pat of Object.values(pp.patterns)) {
        const t = pp.tracks.find((x) => x.id === pat.trackId);
        if (!t || t.instrument?.type === 'drums') continue;
        notes.push(...pat.notes);
      }
      if (!notes.length) { toast('No melodic notes yet — write some chords or a melody first', { level: 'warn' }); return; }
      keyGuesses = (theory.detectKey(notes) || []).slice(0, 3);
      rerender(true);
    }, { icon: 'search', cls: 'small', title: 'Analyse every melodic note in the project (Krumhansl–Schmuckler key finding)' });
    const guesses = keyGuesses ? h('div.as-guesses', keyGuesses.map((k, i) => {
      const pct = Math.round(Math.max(0, Math.min(1, k.score)) * 100);
      const isCur = k.root === root && k.scale === scale;
      return h('div.as-guess', h('b', k.name || keyLabel(k.root, k.scale)), h('div.as-meter', h('div', { style: { width: pct + '%' } })), h('span.muted', `${pct}%`),
        isCur ? h('span.chip', 'current') : button(i === 0 ? 'Use' : 'Use', () => { setKey(k.root, k.scale, 'detected from your notes'); keyGuesses = null; rerender(true); }, { cls: 'small', primary: i === 0 }));
    })) : null;
    wrap.appendChild(section('Key detection', explain('Compares how often (and how long) each pitch class appears with the profile of every major and minor key. The best match is usually your key.'), detectBtn, guesses));
    return wrap;
  }

  function renderWhatNext(root, scale) {
    const p = get();
    const pat = selectedPattern();
    const t = pat && p.tracks.find((x) => x.id === pat.trackId);
    const bpb = beatsPerBar(p);
    if (!pat || t?.instrument?.type === 'drums') {
      return section('What next?', explain('Select a chord or keys pattern and I\'ll suggest the next chord — with the reason it works.'));
    }
    const found = chordsInPattern(pat, bpb);
    const romans = found.map((f) => (theory.chordToRoman ? theory.chordToRoman(f.chord, root) : f.chord.name));
    let sugg = [];
    try { sugg = theory.suggestNextChords ? theory.suggestNextChords(romans, root, scale, p.genre, { limit: 6 }) : []; } catch (e) { console.warn(e); }
    const lastNotes = found.length ? found[found.length - 1].notes : null;
    const lastEnd = found.length ? Math.ceil(found[found.length - 1].end / bpb - 1e-6) * bpb : 0;
    const prog = h('div.as-prog', found.length ? found.map((f, i) => {
      const c = h('button.as-chord.small', { type: 'button', title: `Bar ${Math.floor(f.start / bpb) + 1}: ${f.chord.name}. Click to hear.` }, h('b', romans[i]), h('span', f.chord.name));
      c.addEventListener('click', () => audition(f.chord, null));
      return c;
    }) : h('span.muted', 'No chords detected yet in this pattern (needs 3+ notes at once).'));
    let analysis = null;
    if (romans.length >= 2 && theory.analyzeProgression) {
      try {
        const a = theory.analyzeProgression(romans, root, scale);
        if (a?.notes?.length) analysis = h('ul.as-analysis', a.notes.slice(0, 3).map((n) => h('li', n)));
      } catch { /* ignore */ }
    }
    const list = h('div.as-sugg', sugg.map((s) => {
      const name = s.chord?.name || (s.chord ? theory.chordName(s.chord) : s.roman);
      const add = button('', () => insertChord(s.chord, { at: lastEnd, prev: lastNotes }), { icon: 'plus', cls: 'small', title: `Append ${name} after the last chord (bar ${Math.floor(lastEnd / bpb) + 1})` });
      const play = button('', () => audition(s.chord, lastNotes), { icon: 'play', cls: 'small', title: `Hear ${name} (voice-led from the previous chord)` });
      const fn = theory.chordFunction ? theory.chordFunction(s.chord, root, scale) : null;
      return h('div.as-sugg-item', h(`span.as-roman.${(FUNC_INFO[fn] || FUNC_INFO.chromatic).cls}`, s.roman), h('div.as-sugg-text', h('b', name), h('p', s.reason || '')), h('div.as-sugg-btns', play, add));
    }));
    return section(`What next? · ${pat.name}`, prog, analysis,
      sugg.length ? explain(found.length ? 'Ranked by how strongly each chord follows your last one:' : 'Good ways to start a progression:') : null, list);
  }

  // ---------------------------------------------------------------- GENERATE
  function renderGenerate() {
    const wrap = h('div.as-generate');
    const p = get();
    const g = GENRES[p.genre];
    wrap.appendChild(h('button.as-hero', { type: 'button', title: 'Pick a genre, key and tempo — get a full multi-track arrangement', onclick: () => actions.showSongWizard() },
      icon('wand', 22), h('div', h('b', 'Full song wizard'), h('span', 'Genre → key → tempo → a complete arrangement to remix'))));
    const t = selectedTrack();
    const canTarget = t && t.type === 'instrument';
    const seedNow = () => (genOpts.seed !== '' ? Number(genOpts.seed) : undefined);
    const doGen = (role) => {
      const opts = { genre: p.genre || undefined };
      if (genOpts.bars) opts.bars = genOpts.bars;
      const sd = seedNow();
      if (sd !== undefined && !Number.isNaN(sd)) opts.seed = sd;
      if (genOpts.target === 'selected' && canTarget) {
        const isDrums = t.instrument?.type === 'drums';
        if ((role === 'drums') !== isDrums) { toast(isDrums ? 'The selected track is a drum track — generate drums into it, or switch target to "New track"' : 'The selected track is not a drum track', { level: 'warn' }); return; }
        opts.trackId = t.id;
      }
      actions.generatePart(role, opts);
      if (!genOpts.lockSeed) genOpts.seed = '';
    };
    const parts = h('div.as-parts', ['drums', 'bass', 'chords', 'pad', 'lead', 'arp'].map((role) => {
      const b = h('button.as-part', { type: 'button', title: `${cap(role)}: ${ROLE_INFO[role].why}` }, icon(ROLE_INFO[role].icon, 18), h('b', cap(role)), h('small', ROLE_INFO[role].why.split(':')[0].split('—')[0].slice(0, 42)));
      b.addEventListener('click', () => doGen(role));
      return b;
    }));
    wrap.appendChild(section(`Add a part${g ? ` · ${g.name}` : ''}`, parts,
      explain(`Parts follow the project key (${keyLabel(p.key.root, p.key.scale)})${g ? ` and ${g.name} conventions` : ''}, and share one chord progression so they fit together.`)));
    // options
    const targetSel = select({ options: [{ value: 'new', label: 'New track' }, { value: 'selected', label: canTarget ? `Selected: ${t.name}` : 'Selected track (none)' }], value: genOpts.target, onChange: (v) => { genOpts.target = v; } });
    const barsSel = select({ options: [{ value: 0, label: 'Auto' }, { value: 1, label: '1 bar' }, { value: 2, label: '2 bars' }, { value: 4, label: '4 bars' }, { value: 8, label: '8 bars' }], value: genOpts.bars, onChange: (v) => { genOpts.bars = Number(v); } });
    const seedIn = h('input.as-seed', { type: 'text', placeholder: 'random', value: genOpts.seed, title: 'Seed: the same seed reproduces the same result' });
    seedIn.addEventListener('input', () => { genOpts.seed = seedIn.value.replace(/[^\d]/g, ''); });
    seedIn.addEventListener('keydown', (e) => e.stopPropagation());
    const dice = iconButton('dice', () => { genOpts.seed = String((Math.random() * 1e6) | 0); seedIn.value = genOpts.seed; }, 'Roll a random seed');
    const lock = toggle({ label: 'Lock', value: genOpts.lockSeed, title: 'Keep the seed between generations (reproducible results)', onChange: (v) => { genOpts.lockSeed = v; } });
    const opts = h('details.as-options', h('summary', icon('sliders', 12), 'Options'),
      h('div.as-optgrid', h('label', 'Into', targetSel), h('label', 'Length', barsSel), h('label', 'Seed', h('div.row', seedIn, dice, lock))));
    wrap.appendChild(opts);
    // variation
    const pat = selectedPattern();
    const amount = h('input', { type: 'range', min: 0.1, max: 0.9, step: 0.05, value: genOpts.amount, title: 'How much to change' });
    const amountLbl = h('span.muted', `${Math.round(genOpts.amount * 100)}%`);
    amount.addEventListener('input', () => { genOpts.amount = Number(amount.value); amountLbl.textContent = `${Math.round(genOpts.amount * 100)}%`; });
    const varBtn = button('Variation of selected pattern', () => makeVariation(), { icon: 'copy', title: 'Duplicate the selected pattern and mutate it a little (keeps it in key)', cls: 'small' });
    varBtn.disabled = !pat;
    wrap.appendChild(section('Variations',
      explain(pat ? `"${pat.name}" → a new pattern with small changes: notes moved along the scale, rhythm nudges, velocity variation. Great for B-sections and fills.` : 'Select a pattern to create a variation of it.'),
      h('div.as-row', varBtn, h('div.spacer'), amount, amountLbl)));
    wrap.appendChild(section('Harmony',
      explain('All generated parts share one chord progression. Want different chords? Roll a new one, then regenerate parts.'),
      button('New chord progression', () => { actions.newProgression?.(); toast('Next generated parts will use a fresh progression', { timeout: 2200 }); }, { icon: 'dice', cls: 'small' })));
    return wrap;
  }

  function makeVariation() {
    const src = selectedPattern();
    if (!src) return;
    const p = get();
    const t = p.tracks.find((x) => x.id === src.trackId);
    const isDrums = t?.instrument?.type === 'drums';
    const np = actions.duplicatePattern(src.id);
    if (!np) return;
    const rng = createRng((Math.random() * 2 ** 31) | 0);
    const amt = genOpts.amount;
    const { root, scale } = p.key;
    const L = np.length;
    const notes = [];
    for (const n of np.notes) {
      const r = rng();
      const m = { ...n };
      if (isDrums) {
        const onDownbeat = Math.abs(n.start % 1) < 1e-6 && (n.pitch === 36 || n.pitch === 38);
        if (!onDownbeat && r < amt * 0.25) continue; // thin out
        if (!onDownbeat && r > 1 - amt * 0.2) m.start = Math.max(0, Math.min(L - 0.25, Math.round((n.start + (rng() < 0.5 ? -0.25 : 0.25)) * 4) / 4));
      } else {
        if (r < amt * 0.12) continue;
        if (r < amt * 0.5) {
          const steps = rng.pick([-2, -1, 1, 2]);
          m.pitch = theory.stepInScale ? theory.stepInScale(n.pitch, steps, root, scale) : n.pitch + steps;
        } else if (r < amt * 0.65) {
          m.start = Math.max(0, Math.min(L - m.dur, Math.round((n.start + (rng() < 0.5 ? -0.25 : 0.25)) * 4) / 4));
        }
      }
      m.vel = Math.max(0.2, Math.min(1, (n.vel ?? 0.8) * (0.85 + rng() * 0.3)));
      notes.push(m);
    }
    // a few new notes
    const extra = Math.round(np.notes.length * amt * 0.2);
    for (let i = 0; i < extra && np.notes.length; i++) {
      const base = rng.pick(np.notes);
      const start = Math.floor(rng() * L * 4) / 4;
      if (isDrums) notes.push({ pitch: rng.pick([42, 42, 38, 46]), start, dur: 0.25, vel: 0.35 + rng() * 0.3 });
      else notes.push({ pitch: theory.snapToScale ? theory.snapToScale(base.pitch + rng.pick([-3, 2, 4, 7]), root, scale) : base.pitch, start, dur: Math.min(base.dur, L - start), vel: 0.6 });
    }
    actions.setPatternNotes(np.id, notes, 'Pattern variation');
    toast(`Created "${np.name}" — a ${Math.round(amt * 100)}% variation. Undo with Ctrl+Z.`, { level: 'success' });
  }

  // ---------------------------------------------------------------- GENRE
  function renderGenre() {
    const p = get();
    const id = p.genre;
    const g = GENRES[id];
    const wrap = h('div.as-genre');
    const fams = {};
    for (const [gid, gg] of Object.entries(GENRES)) (fams[gg.family || 'other'] ||= []).push({ value: gid, label: gg.name, group: cap(gg.family || 'other') });
    const opts = [{ value: '', label: '— choose a genre —' }, ...Object.keys(fams).sort().flatMap((f) => fams[f])];
    const sel = select({ options: opts, value: id || '', title: 'Project genre (guides the assistant and generators)', onChange: (v) => { if (v) actions.setGenre(v); } });
    wrap.appendChild(h('div.as-keyrow', h('div.as-keyname', g ? g.name : 'No genre yet'), h('div.spacer'), sel));
    if (!g) {
      wrap.appendChild(explain('Pick a genre and I\'ll explain its tempo, rhythm, harmony and typical sounds — and tailor every suggestion to it.'));
      const popular = ['house', 'techno', 'trap', 'lofi-hip-hop', 'pop', 'drum-and-bass', 'synthwave', 'ambient'].filter((x) => GENRES[x]);
      wrap.appendChild(h('div.as-chipgrid', popular.map((x) => h('button.as-genre-chip', { type: 'button', onclick: () => actions.setGenre(x) }, GENRES[x].name))));
      return wrap;
    }
    let described = null;
    try { described = gen.describeGenre ? gen.describeGenre(id) : null; } catch { described = null; }
    if (typeof described === 'string' && described.trim()) wrap.appendChild(h('div.as-describe', described.split(/\n+/).filter((l) => l.trim() && !(g.tips || []).includes(l.trim())).slice(0, 6).map((l) => h('p', l))));
    else if (described && typeof described === 'object' && (described.summary || described.text)) wrap.appendChild(explain(described.summary || described.text));
    const inRange = p.bpm >= (g.bpm?.[0] ?? 0) && p.bpm <= (g.bpm?.[1] ?? 999);
    wrap.appendChild(h('div.as-facts',
      h('div', h('span', 'Tempo'), h('b', `${g.bpm?.[0]}–${g.bpm?.[1]}`), h('small', inRange ? `you: ${p.bpm} ✓` : `you: ${p.bpm} — outside`)),
      h('div', h('span', 'Swing'), h('b', g.swing ? `${Math.round(g.swing * 100)}%` : 'straight'), h('small', `you: ${Math.round((p.swing || 0) * 100)}%`)),
      h('div', h('span', 'Scales'), h('b', (g.scales || []).slice(0, 2).map((s) => cap(s)).join(', ') || '–'), h('small', (g.scales || []).includes(p.key.scale) ? 'yours fits ✓' : `you: ${cap(p.key.scale)}`)),
      h('div', h('span', 'Kit'), h('b', DRUM_KITS[g.drumKit]?.name || g.drumKit || '–'))));
    if (!inRange || (g.swing && !p.swing)) {
      wrap.appendChild(h('div.as-row', explain('Your tempo/feel differs from the genre\'s usual range.'), button('Apply defaults', () => actions.applyGenreDefaults(id), { cls: 'small', icon: 'wand', title: 'Set BPM, swing, time signature and scale to the genre defaults' })));
    }
    // structure
    const struct = genres.STRUCTURES?.[g.structure] || (Array.isArray(g.structure) ? g.structure : null);
    if (struct?.length) {
      const total = struct.reduce((s, x) => s + x.bars, 0);
      wrap.appendChild(section(`Typical structure · ${total} bars`,
        h('div.as-structure', struct.map((s) => {
          const seg = h('div.as-struct-seg', { style: { flex: String(s.bars) }, title: `${s.name}: ${s.bars} bars, energy ${Math.round(s.energy * 100)}%\nPlaying: ${s.roles.join(', ')}` }, h('span', s.name), h('small', String(s.bars)));
          seg.style.setProperty('--energy', String(0.25 + s.energy * 0.75));
          return seg;
        })),
        explain('Height = energy. Sections are built in multiples of 4/8 bars; arrange your clips the same way and the song will "breathe".')));
    }
    // instruments
    if (g.presets) {
      const have = new Set(p.tracks.map((t) => t.role));
      const rows = Object.entries(g.presets).map(([role, pid]) => {
        const isKit = role === 'drums';
        const name = isKit ? (DRUM_KITS[pid]?.name || pid) : (PRESETS[pid]?.name || pid);
        const exists = have.has(role);
        const add = button('', () => actions.addTrack(pid, isKit ? {} : { role }), { icon: 'plus', cls: 'small', title: `Add a ${name} track` });
        const addGen = button('', () => {
          const t = actions.addTrack(pid, isKit ? {} : { role });
          if (t && role !== 'fx') actions.generatePart(role, { trackId: t.id, genre: id });
        }, { icon: 'dice', cls: 'small', title: `Add ${name} and generate a ${role} part in ${g.name} style` });
        return h(`div.as-inst${exists ? '.have' : ''}`, icon(ROLE_INFO[role]?.icon || 'music', 13), h('div.as-inst-text', h('b', cap(role)), h('span', name)), exists ? h('span.chip', { title: 'You already have a track with this role' }, '✓') : null, add, role !== 'fx' ? addGen : null);
      });
      wrap.appendChild(section('Typical instruments', h('div.as-insts', rows), explain('Click + to add the sound, or the dice to add it with a generated part.')));
    }
    if (g.progressions?.length && theory.PROGRESSIONS) {
      wrap.appendChild(section('Signature progressions', h('div.as-chipgrid', g.progressions.map((pid) => {
        const pr = theory.PROGRESSIONS[pid];
        if (!pr) return null;
        const names = pr.romans.map((r) => theory.romanToChord(r, p.key.root, p.key.scale)?.name || r).join(' – ');
        return h('span.chip', { title: `${pr.description}\nIn your key: ${names}` }, pr.name);
      }))));
    }
    if (g.tips?.length) wrap.appendChild(section('Tips', h('ul.as-tips', g.tips.map((x) => h('li', x)))));
    if (g.fx?.length) wrap.appendChild(section('Production', h('ul.as-tips', g.fx.map((x) => h('li', x)))));
    wrap.appendChild(h('div.as-row', button(`Generate a ${g.name} song`, () => actions.generateSong({ genre: id }), { icon: 'wand', primary: true, title: 'Replace the project with a generated song in this genre' })));
    return wrap;
  }

  // ---------------------------------------------------------------- updates
  let sigTheory = '';
  const theorySig = () => {
    const p = get();
    const pat = selectedPattern();
    const t = selectedTrack();
    return [activeTab, p.key.root, p.key.scale, p.genre, p.bpm, p.swing, pat?.id, pat?.notes.length, pat ? pat.notes.reduce((s, n) => s + n.pitch * 7 + n.start * 13, 0) : 0, t?.id, t?.type, t?.name,
      p.tracks.map((x) => x.role).join(','), Object.keys(p.patterns).length, ui.get('selectedPatternId')].join('|');
  };
  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const recsChanged = computeRecs(false);
      if (activeTab === 'ideas') { if (recsChanged) rerender(); }
      else {
        const s = theorySig();
        if (s !== sigTheory) { sigTheory = s; rerender(); }
      }
      updateBadge();
    }, 500);
  }
  function updateBadge() {
    const n = recs.filter((r) => !dismissed.has(r.id)).length;
    const tab = tabsEl.querySelector('.tab[data-id="ideas"]');
    if (!tab) return;
    let b = tab.querySelector('.as-badge');
    if (!b) { b = h('span.as-badge'); tab.appendChild(b); }
    b.textContent = n ? String(n) : '';
    b.classList.toggle('hidden', !n);
    b.classList.toggle('warn', recs.some((r) => r.level === 'warn' && !dismissed.has(r.id)));
  }
  app.subscribe((r) => {
    if (r.project || 'selectedTrackId' in r.ui || 'selectedPatternId' in r.ui || 'view' in r.ui) schedule();
  });
  tabsEl.querySelectorAll('.tab').forEach((tb) => tb.addEventListener('click', () => { sigTheory = theorySig(); if (tb.dataset.id === 'ideas') { computeRecs(true); rerender(true); } updateBadge(); }));

  loadGen().then((m) => {
    gen = m || {};
    computeRecs(true);
    rerender(true);
    updateBadge();
  });

  return { el, refresh: () => { computeRecs(true); rerender(true); }, show: (id) => { activeTab = id; lsSet(LS_TAB, id); rerender(true); } };
}
