// Step rack (channel rack / step sequencer): the fastest way to make beats.
// Rows = instrument tracks (drum tracks expand into one row per pad). Steps edit
// each track's ACTIVE pattern. See docs/UI.md for the view contract.
import { h, icon, startDrag } from '../dom.js';
import { select, numberField, iconButton, button, toggle, knob, contextMenu, promptText } from '../components.js';
import { DRUM_PADS, patternsForTrack, beatsPerBar } from '../../core/model.js';
import { uid, clamp, createRng } from '../../core/util.js';
import * as T from '../../theory/index.js';

let gen = null;
import('../../gen/index.js').then((m) => { gen = m; }).catch(() => {});

const EPS = 1e-6;
const SETTINGS_KEY = 'daw3-rack';
const CORE_PADS = [36, 38, 39, 42, 46]; // always shown (kick, snare, clap, hats)
const VOL_DEF = { key: 'volume', label: 'Volume', min: 0, max: 1.5, default: 0.8, step: 0.01 };
const EUCLID_PRESETS = [
  [3, 8, 0, 'Tresillo'], [5, 8, 0, 'Cinquillo'], [3, 16, 0, ''], [5, 16, 0, 'Bossa'], [7, 16, 0, ''],
  [9, 16, 0, ''], [11, 16, 0, ''], [4, 16, 2, 'Offbeats'], [7, 12, 0, 'West African bell'], [2, 5, 0, 'Khafif-e-ramal'],
];
const FOUR_FLOOR = /house|techno|trance|disco|edm|dance|electro|garage|hardstyle|eurodance|big-room|progressive/i;

let rowClipboard = null; // [{start, dur, vel, dp}] dp = pitch offset relative to the source row

function loadSettings() {
  const d = { showAll: false, res: 0.25, collapsed: [] };
  try { Object.assign(d, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { /* ignore */ }
  return d;
}

/** Bjorklund / Euclidean rhythm: k pulses spread over n steps, rotated by r. */
export function euclidRhythm(k, n, r = 0) {
  k = clamp(Math.round(k), 0, n);
  if (gen && typeof gen.euclidean === 'function') {
    try {
      const out = gen.euclidean(k, n, r);
      if (Array.isArray(out) && out.length === n) return out.map(Boolean);
    } catch { /* fall back */ }
  }
  const pattern = [];
  for (let i = 0; i < n; i++) pattern.push(Math.floor(((i + 1) * k) / n) - Math.floor((i * k) / n) === 1);
  // rotate so the first pulse is on step 0, then apply user rotation
  const first = pattern.indexOf(true);
  const base = first > 0 ? [...pattern.slice(first), ...pattern.slice(0, first)] : pattern;
  const rr = ((r % n) + n) % n;
  return rr ? [...base.slice(n - rr), ...base.slice(0, n - rr)] : base;
}

export function createRackView(app) {
  const { store, ui, actions, engine } = app;
  const S = loadSettings();
  const save = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S)); } catch { /* ignore */ } };
  const collapsed = new Set(S.collapsed || []);
  const melPitch = new Map(); // trackId -> row pitch (UI only)

  let visible = false;
  let rows = []; // row models
  let signature = '';
  let focusKey = null;
  let raf = 0;
  const playCols = new Map(); // row index -> playing step index

  // ---------------------------------------------------------------- DOM
  const toolbar = h('div.view-toolbar.rack-toolbar');
  const banner = h('div.rack-banner.hidden');
  const ruler = h('div.rack-ruler');
  const list = h('div.rack-list');
  const scroll = h('div.rack-scroll', ruler, list);
  const empty = h('div.rack-empty.hidden');
  const el = h('div.rack-view', toolbar, banner, scroll, empty);

  const proj = () => store.get();
  const res = () => S.res;
  const keyInfo = () => proj().key || { root: 0, scale: 'minor' };
  const defaultMelPitch = () => 48 + keyInfo().root; // key root, octave 3
  const rowKey = (r) => `${r.track.id}:${r.kind === 'mel' ? 'mel' : r.pitch}`;
  const padName = (m) => DRUM_PADS.find((d) => d.pitch === m)?.name || T.noteName(m);
  const stepsFor = (pat) => Math.max(1, Math.round((pat ? pat.length : beatsPerBar(proj())) / res()));

  // ---------------------------------------------------------------- toolbar
  const patSel = h('select.rack-pat-sel', { title: 'Active pattern of the selected track' });
  patSel.addEventListener('change', () => actions.selectPattern(patSel.value));
  const trackLabel = h('span.rack-track-label');
  const newPatBtn = iconButton('plus', () => { const t = selTrack(); if (t) actions.newPattern(t.id); }, 'New pattern for the selected track');
  const dupPatBtn = iconButton('copy', () => { const t = selTrack(); if (t?.activePatternId) actions.duplicatePattern(t.activePatternId); }, 'Duplicate the selected track\'s pattern (variation)');
  const stepsSel = select({
    title: 'Pattern length in 16th steps — applies to every track\'s active pattern',
    options: [8, 16, 32, 48, 64].map((n) => ({ value: n, label: `${n} steps` })),
    value: 16,
    onChange: (n) => setAllLengths(Number(n)),
  });
  const swingField = numberField({
    value: 0, min: 0, max: 100, step: 1, width: 48, title: 'Swing: delays every off-beat 16th (drag or type, 0–100%)',
    format: (v) => `${Math.round(v)}%`,
    onChange: (v) => store.transact('Swing', (p) => { p.swing = clamp(v / 100, 0, 1); }, { coalesce: true }),
  });
  const resBtn = toggle({ label: '1/32', value: S.res < 0.25, title: '1/32 resolution: twice as many steps per beat (hi-hat rolls, trap)', onChange: (v) => { S.res = v ? 0.125 : 0.25; save(); render(true); } });
  const allPadsBtn = toggle({ label: 'All pads', value: S.showAll, title: 'Show all 16 drum pads (otherwise only pads used in the pattern)', onChange: (v) => { S.showAll = v; save(); render(true); } });
  const fillBtn = button('Fill', (e) => contextMenu(anchorEv(e), fillMenuItems()), { icon: 'grid', cls: 'small', title: 'Fill the focused row every 2 / 4 / 8 steps' });
  const addBtn = button('Add track', (e) => contextMenu(anchorEv(e), actions.addTrackMenuItems()), { icon: 'plus', cls: 'small', title: 'Add a drum machine, synth, sampler…' });
  const genBtn = button('Generate beat', () => generateBeat(), { icon: 'dice', cls: 'small', primary: true, title: 'Generate a drum pattern for the current genre (into the selected / first drum track)' });

  toolbar.append(
    h('div.rack-group', trackLabel, patSel, newPatBtn, dupPatBtn),
    h('div.sep'),
    h('div.rack-group', stepsSel, h('label.rack-mini', { title: 'Swing' }, h('span', 'Swing'), swingField), resBtn, allPadsBtn),
    h('div.sep'),
    h('div.rack-group', fillBtn),
    h('div.spacer'),
    h('div.rack-group', addBtn, genBtn),
  );

  function anchorEv(e) {
    const r = (e.currentTarget || e.target).getBoundingClientRect();
    return { clientX: r.left, clientY: r.bottom + 2, preventDefault() {} };
  }
  function selTrack() {
    const p = proj();
    const t = p.tracks.find((x) => x.id === ui.get('selectedTrackId'));
    return t && t.type === 'instrument' ? t : null;
  }
  function generateBeat() {
    const p = proj();
    const sel = selTrack();
    const drum = sel?.instrument?.type === 'drums' ? sel : p.tracks.find((t) => t.instrument?.type === 'drums');
    actions.generatePart('drums', drum ? { trackId: drum.id } : {});
  }
  function setAllLengths(steps) {
    const len = steps * 0.25;
    store.transact(`Pattern length ${steps} steps`, (p) => {
      for (const t of p.tracks) {
        if (t.type !== 'instrument') continue;
        const pat = p.patterns[t.activePatternId];
        if (pat) pat.length = len;
      }
    });
  }

  // ---------------------------------------------------------------- model
  function buildRows() {
    const p = proj();
    const out = [];
    for (const t of p.tracks) {
      if (t.type !== 'instrument') continue;
      const pat = p.patterns[t.activePatternId] || null;
      const steps = stepsFor(pat);
      if (t.instrument?.type === 'drums') {
        out.push({ kind: 'head', track: t, pat, steps });
        if (collapsed.has(t.id)) continue;
        const used = new Set((pat?.notes || []).map((n) => n.pitch));
        const pads = DRUM_PADS.filter((d) => S.showAll || used.has(d.pitch) || CORE_PADS.includes(d.pitch)).map((d) => d.pitch);
        for (const m of [...used].sort((a, b) => a - b)) if (!DRUM_PADS.some((d) => d.pitch === m)) pads.push(m);
        for (const m of pads) out.push({ kind: 'pad', track: t, pat, steps, pitch: m, name: padName(m) });
      } else {
        if (!melPitch.has(t.id)) melPitch.set(t.id, guessMelPitch(pat));
        out.push({ kind: 'mel', track: t, pat, steps, pitch: melPitch.get(t.id), name: t.name });
      }
    }
    return out;
  }
  function guessMelPitch(pat) {
    const notes = pat?.notes || [];
    if (!notes.length) return defaultMelPitch();
    // key root in the octave closest to the median pitch of the pattern
    const ps = notes.map((n) => n.pitch).sort((a, b) => a - b);
    const med = ps[Math.floor(ps.length / 2)];
    const root = keyInfo().root;
    let best = defaultMelPitch(), bd = Infinity;
    for (let m = root; m <= 127; m += 12) { const d = Math.abs(m - med); if (d < bd) { bd = d; best = m; } }
    return best;
  }
  const sigOf = (rs) => JSON.stringify([res(), rs.map((r) => [r.kind, r.track.id, r.pat?.id, r.pitch, r.steps, r.track.name, r.track.color])]);

  function stepNotes(row, pat, i) {
    if (!pat) return [];
    const r = res();
    const lo = i * r - EPS, hi = (i + 1) * r - EPS;
    return pat.notes.filter((n) => n.start >= lo && n.start < hi && (row.kind === 'mel' || n.pitch === row.pitch));
  }
  function rowNotes(row, pat) {
    if (!pat) return [];
    return row.kind === 'mel' ? pat.notes : pat.notes.filter((n) => n.pitch === row.pitch);
  }

  // ---------------------------------------------------------------- editing
  function patIdFor(row) {
    const p = proj();
    const t = p.tracks.find((x) => x.id === row.track.id);
    if (t && p.patterns[t.activePatternId]) return t.activePatternId;
    return actions.ensurePattern(row.track.id)?.id || null;
  }
  function editRow(row, label, fn, drag, extra = {}) {
    const pid = patIdFor(row);
    if (!pid) return;
    let opts = { ...extra };
    if (drag) { if (drag.recorded) opts = { undo: false }; drag.recorded = true; }
    store.transact(label, (p) => { const pat = p.patterns[pid]; if (pat) fn(pat, p); }, opts);
  }
  const mk = (pitch, start, dur, vel = 0.8) => ({ id: uid('n'), pitch, start: +start.toFixed(5), dur: +dur.toFixed(5), vel: +clamp(vel, 0.02, 1).toFixed(4) });
  const inStep = (n, i) => n.start >= i * res() - EPS && n.start < (i + 1) * res() - EPS;
  const matches = (row, n) => row.kind === 'mel' || n.pitch === row.pitch;

  function setStep(row, i, on, drag, vel = 0.8) {
    editRow(row, on ? 'Add step' : 'Clear step', (pat) => {
      pat.notes = pat.notes.filter((n) => !(matches(row, n) && inStep(n, i)));
      if (on) pat.notes.push(mk(row.pitch, i * res(), res(), vel));
    }, drag);
  }
  function cycleAccent(row, i) {
    const pat = proj().patterns[row.pat?.id];
    const ns = pat ? stepNotes(row, pat, i) : [];
    if (!ns.length) { setStep(row, i, true, null, 1); audition(row, 1); return; }
    const v = Math.max(...ns.map((n) => n.vel ?? 0.8));
    const next = v >= 0.95 ? 0.45 : v <= 0.5 ? 0.8 : 1;
    editRow(row, 'Step accent', (pt) => { for (const n of pt.notes) if (matches(row, n) && inStep(n, i)) n.vel = next; });
    app.setStatus?.(`Step ${i + 1}: ${next === 1 ? 'accent' : next < 0.5 ? 'ghost' : 'normal'} (vel ${Math.round(next * 127)})`);
  }
  function setRatchet(row, i, count) {
    const pat = proj().patterns[row.pat?.id];
    const ns = pat ? stepNotes(row, pat, i) : [];
    const n0 = count ?? (ns.length >= 4 ? 1 : Math.max(2, ns.length + 1));
    const vel = ns.length ? Math.max(...ns.map((n) => n.vel ?? 0.8)) : 0.8;
    const pitch = ns[0]?.pitch ?? row.pitch;
    const r = res();
    editRow(row, 'Ratchet', (pt) => {
      pt.notes = pt.notes.filter((n) => !(matches(row, n) && inStep(n, i)));
      for (let k = 0; k < n0; k++) pt.notes.push(mk(pitch, i * r + (k * r) / n0, r / n0, vel * (k ? 0.85 : 1)));
    });
    app.setStatus?.(n0 > 1 ? `Step ${i + 1}: ratchet ×${n0}` : `Step ${i + 1}: single hit`);
  }
  function nudgeStep(row, i, { dVel = 0, dPitch = 0, scaleStep = 0 }) {
    const k = keyInfo();
    let shown = null;
    editRow(row, dVel ? 'Step velocity' : 'Step pitch', (pt) => {
      for (const n of pt.notes) {
        if (!(matches(row, n) && inStep(n, i))) continue;
        if (dVel) n.vel = +clamp((n.vel ?? 0.8) + dVel, 0.05, 1).toFixed(3);
        if (dPitch) n.pitch = clamp(n.pitch + dPitch, 0, 127);
        if (scaleStep) n.pitch = clamp(T.stepInScale ? T.stepInScale(n.pitch, scaleStep, k.root, k.scale) : n.pitch + scaleStep, 0, 127);
        shown = n;
      }
    }, null, { coalesce: true });
    if (shown) {
      if (dVel) app.setStatus?.(`Step ${i + 1}: velocity ${Math.round(shown.vel * 127)}`);
      else { app.setStatus?.(`Step ${i + 1}: ${T.noteName(shown.pitch)}`); audition({ ...row, pitch: shown.pitch }, shown.vel); }
    }
  }
  function setRowNotes(row, label, makeNotes) {
    editRow(row, label, (pat) => {
      const keep = pat.notes.filter((n) => !matches(row, n));
      pat.notes = keep.concat(makeNotes(pat));
    });
  }
  function fillEvery(row, every, offset = 0) {
    setRowNotes(row, `Fill every ${every}`, (pat) => {
      const steps = Math.round(pat.length / res());
      const out = [];
      for (let i = offset; i < steps; i += every) out.push(mk(row.pitch, i * res(), res(), i % (every * 2) === offset ? 0.85 : 0.75));
      return out;
    });
  }
  function euclidFill(row, k, n, rot) {
    setRowNotes(row, `Euclid ${k}/${n}`, (pat) => {
      const steps = Math.round(pat.length / res());
      const bits = euclidRhythm(k, n, rot);
      const out = [];
      for (let i = 0; i < steps; i++) if (bits[i % n]) out.push(mk(row.pitch, i * res(), res(), i % n === 0 ? 0.95 : 0.78));
      return out;
    });
  }
  function randomizeRow(row, prob) {
    const rng = createRng((Math.random() * 2 ** 31) | 0);
    const k = keyInfo();
    setRowNotes(row, 'Randomize row', (pat) => {
      const steps = Math.round(pat.length / res());
      const out = [];
      for (let i = 0; i < steps; i++) {
        if (rng() >= prob) continue;
        let pitch = row.pitch;
        if (row.kind === 'mel' && rng() < 0.4) pitch = T.stepInScale ? T.stepInScale(row.pitch, rng.int(-2, 4), k.root, k.scale) : row.pitch;
        out.push(mk(pitch, i * res(), res(), 0.55 + rng() * 0.45));
      }
      return out;
    });
  }
  function shiftRow(row, dir) {
    editRow(row, dir < 0 ? 'Shift left' : 'Shift right', (pat) => {
      const L = pat.length;
      for (const n of pat.notes) if (matches(row, n)) n.start = +((((n.start + dir * res()) % L) + L) % L).toFixed(5);
    });
  }
  function velShape(row, kind) {
    const rng = createRng((Math.random() * 2 ** 31) | 0);
    editRow(row, 'Row velocity', (pat) => {
      const ns = rowNotes(row, pat).sort((a, b) => a.start - b.start);
      ns.forEach((n, idx) => {
        const f = ns.length > 1 ? idx / (ns.length - 1) : 1;
        if (kind === 'up') n.vel = 0.35 + 0.65 * f;
        else if (kind === 'down') n.vel = 1 - 0.65 * f;
        else if (kind === 'beats') n.vel = Math.abs(n.start - Math.round(n.start)) < EPS ? 1 : 0.6;
        else n.vel = 0.5 + rng() * 0.5;
        n.vel = +n.vel.toFixed(3);
      });
    });
  }
  function copyRow(row) {
    const pat = proj().patterns[row.pat?.id];
    rowClipboard = rowNotes(row, pat).map((n) => ({ start: n.start, dur: n.dur, vel: n.vel, dp: n.pitch - row.pitch }));
    app.setStatus?.(`Copied ${rowClipboard.length} step(s)`);
  }
  function pasteRow(row) {
    if (!rowClipboard) return;
    setRowNotes(row, 'Paste row', (pat) => rowClipboard.filter((n) => n.start < pat.length).map((n) => mk(row.kind === 'mel' ? clamp(row.pitch + n.dp, 0, 127) : row.pitch, n.start, n.dur, n.vel)));
  }
  function generatePad(row) {
    const p = proj();
    const genre = p.genre || 'house';
    const pat = proj().patterns[patIdFor(row)];
    if (!pat) return;
    const bars = Math.max(1, Math.round(pat.length / beatsPerBar(p)));
    const rng = createRng((Math.random() * 2 ** 31) | 0);
    let notes = null;
    if (gen?.generateDrumPattern) {
      try {
        const all = gen.generateDrumPattern({ genre, bars, rng, density: 0.5 + rng() * 0.4, variation: rng(), beatsPerBar: beatsPerBar(p) });
        if (Array.isArray(all)) notes = all.filter((n) => n.pitch === row.pitch);
        if (notes && !notes.length && rng() < 0.7) notes = null; // genre doesn't use this pad: invent something
      } catch { notes = null; }
    }
    if (!notes) notes = rulePad(row.pitch, pat.length, genre, rng);
    setRowNotes(row, `Generate ${padName(row.pitch)}`, (pt) => notes.filter((n) => n.start < pt.length).map((n) => mk(row.pitch, n.start, n.dur || 0.25, n.vel ?? 0.8)));
  }
  function rulePad(pitch, length, genre, rng) {
    const steps = Math.round(length / 0.25);
    const out = [];
    const add = (i, v = 0.8) => out.push({ start: i * 0.25, dur: 0.25, vel: v });
    const ff = FOUR_FLOOR.test(genre);
    for (let i = 0; i < steps; i++) {
      const s = i % 16;
      switch (pitch) {
        case 36: if (ff ? s % 4 === 0 : (s === 0 || s === 10 || (s === 7 && rng() < 0.5) || (s === 8 && rng() < 0.3))) add(i, s === 0 ? 1 : 0.85); break;
        case 38: case 39: if (s === 4 || s === 12) add(i, 0.9); else if (rng() < 0.06) add(i, 0.4); break;
        case 42: if (s % 2 === 0 || rng() < 0.25) add(i, s % 4 === 0 ? 0.85 : s % 2 ? 0.45 : 0.65); break;
        case 46: if (ff ? s % 4 === 2 : (s === 14 && rng() < 0.7)) add(i, 0.7); break;
        default: break;
      }
    }
    if (![36, 38, 39, 42, 46].includes(pitch)) {
      const bits = euclidRhythm(rng.int(2, 5), 16, rng.int(0, 7));
      for (let i = 0; i < steps; i++) if (bits[i % 16]) add(i, 0.6 + rng() * 0.3);
    }
    return out;
  }

  async function audition(row, vel = 0.9) {
    try { await actions.ensureAudio(); } catch { return; }
    try {
      engine.noteOn(row.track.id, row.pitch, vel);
      setTimeout(() => { try { engine.noteOff(row.track.id, row.pitch); } catch { /* ignore */ } }, row.kind === 'mel' ? 260 : 120);
    } catch { /* ignore */ }
  }
  function openInPiano(row) {
    const pid = patIdFor(row);
    if (pid) actions.selectPattern(pid);
    ui.set({ view: 'piano' });
  }

  // ---------------------------------------------------------------- menus
  function rowMenuItems(row) {
    const t = row.track;
    const items = [{ header: row.kind === 'pad' ? `${t.name} · ${row.name}` : t.name }];
    if (row.kind === 'pad') items.push({ label: `Generate ${row.name}`, icon: 'dice', onClick: () => generatePad(row) });
    else {
      items.push({ label: 'Generate', icon: 'dice', submenu: ['bass', 'chords', 'lead', 'arp', 'pad'].map((r) => ({ label: r[0].toUpperCase() + r.slice(1), onClick: () => actions.generatePart(r, { trackId: t.id }) })) });
    }
    items.push(
      { label: 'Fill every', icon: 'grid', submenu: [
        { label: '2 steps (8ths)', onClick: () => fillEvery(row, 2) },
        { label: '4 steps (beats)', onClick: () => fillEvery(row, 4) },
        { label: '4 steps, off-beat', onClick: () => fillEvery(row, 4, 2) },
        { label: '8 steps', onClick: () => fillEvery(row, 8) },
        { label: '8 steps, from step 5', onClick: () => fillEvery(row, 8, 4) },
        { label: 'Every step', onClick: () => fillEvery(row, 1) },
      ] },
      { label: 'Euclidean', icon: 'sparkles', submenu: [
        ...EUCLID_PRESETS.map(([k, n, r, name]) => ({ label: `${k} of ${n}${r ? ` ↻${r}` : ''}${name ? ` — ${name}` : ''}`, onClick: () => euclidFill(row, k, n, r) })),
        '-',
        { label: 'Custom…', onClick: async () => {
          const v = await promptText('Euclidean rhythm: pulses, steps, rotation', '5, 16, 0', { placeholder: 'e.g. 5, 16, 2' });
          if (!v) return;
          const [k, n, r] = v.split(/[\s,/]+/).map((x) => parseInt(x, 10));
          if (!(n > 0 && n <= 64 && k >= 0)) { app.toast('Use: pulses, steps, rotation — e.g. 5, 16, 2', { level: 'warn' }); return; }
          euclidFill(row, k, n, r || 0);
        } },
      ] },
      { label: 'Randomize', icon: 'dice', submenu: [0.15, 0.3, 0.5, 0.75].map((pr) => ({ label: `${Math.round(pr * 100)}% density`, onClick: () => randomizeRow(row, pr) })) },
      { label: 'Velocity', icon: 'sliders', submenu: [
        { label: 'Ramp up', onClick: () => velShape(row, 'up') },
        { label: 'Ramp down', onClick: () => velShape(row, 'down') },
        { label: 'Accent beats', onClick: () => velShape(row, 'beats') },
        { label: 'Randomize', onClick: () => velShape(row, 'random') },
      ] },
      { label: 'Shift left', icon: 'chevronRight', onClick: () => shiftRow(row, -1) },
      { label: 'Shift right', icon: 'chevronRight', onClick: () => shiftRow(row, 1) },
      '-',
      { label: 'Copy row', icon: 'copy', onClick: () => copyRow(row) },
      { label: 'Paste row', disabled: !rowClipboard, onClick: () => pasteRow(row) },
      { label: 'Clear row', icon: 'trash', onClick: () => setRowNotes(row, 'Clear row', () => []) },
      '-',
      { label: 'Open in piano roll', icon: 'piano', onClick: () => openInPiano(row) },
      { label: 'Track', icon: 'menu', submenu: actions.trackMenuItems(t.id) },
    );
    return items;
  }
  function headMenuItems(row) {
    const t = row.track;
    return [
      { header: t.name },
      { label: 'Generate beat', icon: 'dice', onClick: () => actions.generatePart('drums', { trackId: t.id }) },
      { label: S.showAll ? 'Show used pads only' : 'Show all 16 pads', icon: 'grid', onClick: () => { S.showAll = !S.showAll; allPadsBtn.setValue(S.showAll); save(); render(true); } },
      { label: collapsed.has(t.id) ? 'Expand pads' : 'Collapse pads', icon: 'chevronDown', onClick: () => toggleCollapse(t.id) },
      { label: 'Shift pattern left', onClick: () => editRow(row, 'Shift left', (pat) => { const L = pat.length; for (const n of pat.notes) n.start = +((((n.start - res()) % L) + L) % L).toFixed(5); }) },
      { label: 'Shift pattern right', onClick: () => editRow(row, 'Shift right', (pat) => { const L = pat.length; for (const n of pat.notes) n.start = +(((n.start + res()) % L)).toFixed(5); }) },
      { label: 'Clear pattern', icon: 'trash', onClick: () => editRow(row, 'Clear pattern', (pat) => { pat.notes = []; }) },
      '-',
      { label: 'Open in piano roll', icon: 'piano', onClick: () => openInPiano(row) },
      { label: 'Track', icon: 'menu', submenu: actions.trackMenuItems(t.id) },
    ];
  }
  function fillMenuItems() {
    const row = rows.find((r) => rowKey(r) === focusKey && r.kind !== 'head') || rows.find((r) => r.kind !== 'head');
    if (!row) return [{ label: 'Add a track first', disabled: true }];
    return [
      { header: `Fill ${row.kind === 'pad' ? row.name : row.track.name}` },
      { label: 'Every 2 steps', onClick: () => fillEvery(row, 2) },
      { label: 'Every 4 steps', onClick: () => fillEvery(row, 4) },
      { label: 'Every 4, off-beat', onClick: () => fillEvery(row, 4, 2) },
      { label: 'Every 8 steps', onClick: () => fillEvery(row, 8) },
      { label: 'Every step', onClick: () => fillEvery(row, 1) },
      '-',
      { label: 'Euclidean 5 of 16', onClick: () => euclidFill(row, 5, 16, 0) },
      { label: 'Clear row', icon: 'trash', onClick: () => setRowNotes(row, 'Clear row', () => []) },
      { header: 'Tip: click a row to choose which one Fill targets' },
    ];
  }
  function melStepMenu(row, i, e) {
    const pat = proj().patterns[row.pat?.id];
    const ns = pat ? stepNotes(row, pat, i) : [];
    const k = keyInfo();
    const curP = ns[0]?.pitch ?? row.pitch;
    const pitches = [];
    for (let s = -5; s <= 9; s++) { try { pitches.push(T.stepInScale(row.pitch, s, k.root, k.scale)); } catch { pitches.push(row.pitch + s); } }
    const setPitch = (m) => {
      if (!ns.length) editRow(row, 'Step pitch', (pt) => { pt.notes.push(mk(m, i * res(), res(), 0.8)); });
      else editRow(row, 'Step pitch', (pt) => { for (const n of pt.notes) if (inStep(n, i)) n.pitch = m; });
      audition({ ...row, pitch: m });
    };
    const setVel = (v) => editRow(row, 'Step velocity', (pt) => { for (const n of pt.notes) if (inStep(n, i)) n.vel = v; });
    contextMenu(e, [
      { header: `Step ${i + 1}${ns.length ? ` · ${T.noteName(curP)}` : ''}` },
      { label: 'Pitch', icon: 'music', submenu: [...new Set(pitches)].reverse().map((m) => ({ label: `${T.noteName(m)}${m === row.pitch ? '  (row)' : ''}`, icon: m === curP && ns.length ? 'chevronRight' : null, onClick: () => setPitch(m) })) },
      { label: 'Octave up', disabled: !ns.length, onClick: () => nudgeStep(row, i, { dPitch: 12 }) },
      { label: 'Octave down', disabled: !ns.length, onClick: () => nudgeStep(row, i, { dPitch: -12 }) },
      '-',
      { label: 'Accent (vel 127)', disabled: !ns.length, onClick: () => setVel(1) },
      { label: 'Normal (vel 100)', disabled: !ns.length, onClick: () => setVel(0.8) },
      { label: 'Ghost (vel 57)', disabled: !ns.length, onClick: () => setVel(0.45) },
      { label: 'Ratchet', submenu: [1, 2, 3, 4].map((c) => ({ label: c === 1 ? 'Off' : `×${c}`, onClick: () => setRatchet(row, i, c) })) },
      '-',
      { label: 'Clear step', disabled: !ns.length, icon: 'trash', onClick: () => setStep(row, i, false) },
      { header: 'Wheel: scale step · Alt+wheel: semitone · Shift+wheel: velocity' },
    ]);
  }

  // ---------------------------------------------------------------- rendering
  function toggleCollapse(id) {
    if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
    S.collapsed = [...collapsed];
    save();
    render(true);
  }

  function buildRuler(maxSteps) {
    const spb = Math.round(1 / res());
    const cells = [];
    for (let i = 0; i < maxSteps; i++) {
      const beatStart = i % spb === 0;
      const beatIdx = Math.floor(i / spb);
      const bpb = beatsPerBar(proj());
      const lbl = beatStart ? (beatIdx % bpb === 0 ? `${beatIdx / bpb + 1}` : `${Math.floor(beatIdx / bpb) + 1}.${(beatIdx % bpb) + 1}`) : '';
      cells.push(h(`div.rack-ruler-cell${beatStart ? '.beat' : ''}${beatStart && beatIdx % bpb === 0 ? '.bar' : ''}`, lbl));
    }
    ruler.replaceChildren(h('div.rack-head.rack-ruler-head', h('span', 'Rack'), h('span.rack-ruler-hint', { title: 'Click a step to toggle · drag to paint/erase · right-click: accent / ghost (melodic rows: pitch menu) · Shift+click: ratchet ×2/×3/×4 · wheel: velocity (melodic: pitch)' }, 'Click steps · drag to paint · right-click accent · shift-click ratchet · wheel velocity')), h('div.rack-steps', cells));
  }

  function buildRow(row, idx) {
    const t = row.track;
    const elRow = h(`div.rack-row.${row.kind}`, { dataset: { idx: String(idx) } });
    elRow.style.setProperty('--c', t.color || 'var(--accent)');
    const head = h('div.rack-head');
    const menuBtn = iconButton('menu', (e) => contextMenu(anchorEv(e), row.kind === 'head' ? headMenuItems(row) : rowMenuItems(row)), 'Row options: generate, fill, euclidean, randomize, shift, copy/paste, open in piano roll');
    menuBtn.classList.add('rack-menu');
    const mkMS = () => {
      const m = toggle({ label: 'M', value: t.mute, cls: 'mute', title: 'Mute track', onChange: (v) => actions.updateTrack(t.id, (tt) => { tt.mute = v; }, v ? 'Mute' : 'Unmute') });
      const s = toggle({ label: 'S', value: t.solo, cls: 'solo', title: 'Solo track', onChange: (v) => actions.updateTrack(t.id, (tt) => { tt.solo = v; }, v ? 'Solo' : 'Unsolo') });
      const kn = knob({ def: VOL_DEF, value: t.volume, size: 22, label: false, showValue: false, onChange: (v, { final }) => { kn.dragging = !final; actions.updateTrack(t.id, (tt) => { tt.volume = v; }, 'Track volume', { coalesce: true }); } });
      kn.title = 'Track volume (drag, wheel, double-click resets)';
      kn.classList.add('rack-vol');
      row.ctl = { m, s, kn };
      return [m, s, kn];
    };
    const nameBtn = h('button.rack-name', { type: 'button' }, row.kind === 'pad' ? row.name : t.name);
    nameBtn.addEventListener('click', () => {
      actions.selectTrack(t.id);
      focusKey = rowKey(row);
      updateFocus();
      if (row.kind !== 'head') audition(row);
    });
    row.nameBtn = nameBtn;
    if (row.kind === 'head') {
      const chev = iconButton(collapsed.has(t.id) ? 'chevronRight' : 'chevronDown', () => toggleCollapse(t.id), collapsed.has(t.id) ? 'Expand pads' : 'Collapse pads');
      chev.classList.add('rack-chev');
      nameBtn.title = `${t.name}: click to select the track (edit its kit in the Device panel)`;
      head.append(chev, h('span.rack-swatch'), nameBtn, ...mkMS(), menuBtn);
      const pats = patternsForTrack(proj(), t.id);
      const ps = h('select.rack-head-pat', { title: 'Active pattern for this drum track' }, pats.map((pp) => h('option', { value: pp.id }, pp.name)));
      if (row.pat) ps.value = row.pat.id;
      ps.addEventListener('change', () => actions.selectPattern(ps.value));
      const info = h('div.rack-head-info',
        pats.length > 1 ? ps : h('span.muted', row.pat ? row.pat.name : 'No pattern'),
        h('span.muted', row.pat ? ` · ${row.steps} steps` : ''),
        button('Generate', () => actions.generatePart('drums', { trackId: t.id }), { icon: 'dice', cls: 'small', title: `Generate a ${proj().genre || ''} beat into ${t.name}` }));
      elRow.append(head, h('div.rack-steps.rack-head-steps', info));
      return elRow;
    }
    if (row.kind === 'pad') {
      nameBtn.title = `${row.name} (MIDI ${row.pitch}) — click to audition`;
      head.append(h('span.rack-indent'), h('span.rack-pad-dot'), nameBtn, menuBtn);
    } else {
      nameBtn.title = `${t.name}: click to select & audition the row pitch`;
      const k = keyInfo();
      const opts = [];
      for (let m = 84; m >= 24; m--) if (m === row.pitch || (T.inScale ? T.inScale(m, k.root, k.scale) : true)) opts.push({ value: m, label: T.noteName(m) });
      const pitchSel = select({ options: opts, value: row.pitch, title: 'Pitch for new steps on this row (default: key root, octave 3)', cls: 'rack-pitch', onChange: (v) => { melPitch.set(t.id, Number(v)); render(true); } });
      head.append(h('span.rack-swatch'), nameBtn, pitchSel, ...mkMS(), menuBtn);
    }
    const stepsEl = h('div.rack-steps');
    const spb = Math.round(1 / res());
    row.stepEls = [];
    for (let i = 0; i < row.steps; i++) {
      const beat = Math.floor(i / spb);
      const st = h(`button.rack-step${beat % 2 ? '.alt' : ''}${i % spb === 0 ? '.beat-start' : ''}`, { type: 'button', dataset: { i: String(i) } }, h('span.rack-step-fill'), h('span.rack-step-label'));
      row.stepEls.push(st);
      stepsEl.append(st);
    }
    elRow.append(head, stepsEl);
    return elRow;
  }

  function updateRow(row) {
    const t = row.track;
    if (row.ctl) {
      row.ctl.m.setValue(t.mute);
      row.ctl.s.setValue(t.solo);
      if (!row.ctl.kn.dragging) row.ctl.kn.setValue(t.volume);
    }
    if (!row.stepEls) return;
    const pat = row.pat;
    const r = res();
    // bucket notes by step
    const buckets = new Map();
    if (pat) {
      for (const n of pat.notes) {
        if (!matches(row, n)) continue;
        const i = Math.floor(n.start / r + EPS);
        if (i < 0 || i >= row.steps) continue;
        if (!buckets.has(i)) buckets.set(i, []);
        buckets.get(i).push(n);
      }
    }
    for (let i = 0; i < row.stepEls.length; i++) {
      const st = row.stepEls[i];
      const ns = buckets.get(i);
      const on = !!ns?.length;
      st.classList.toggle('on', on);
      st.setAttribute('aria-pressed', on ? 'true' : 'false');
      const fill = st.firstChild, label = st.lastChild;
      if (on) {
        const v = Math.max(...ns.map((n) => n.vel ?? 0.8));
        fill.style.height = `${Math.round(30 + 70 * v)}%`;
        fill.style.opacity = String(0.55 + 0.45 * v);
        st.classList.toggle('accent', v >= 0.95);
        st.classList.toggle('ghost', v <= 0.5);
        let txt = '';
        if (ns.length > 1 && (row.kind === 'pad' || new Set(ns.map((n) => n.pitch)).size === 1)) txt = `×${ns.length}`;
        else if (row.kind === 'mel') {
          const p0 = ns[0].pitch;
          if (ns.length > 1) txt = `${ns.length}♪`;
          else if (p0 !== row.pitch) txt = T.noteName(p0).replace(/-?\d+$/, '') + (Math.floor(p0 / 12) !== Math.floor(row.pitch / 12) ? (p0 > row.pitch ? '↑' : '↓') : '');
        }
        label.textContent = txt;
        st.title = `Step ${i + 1} · vel ${Math.round(v * 127)}${row.kind === 'mel' ? ` · ${ns.map((n) => T.noteName(n.pitch)).join(' ')}` : ''}${ns.length > 1 ? ` · ${ns.length} notes` : ''}`;
      } else {
        fill.style.height = '';
        fill.style.opacity = '';
        st.classList.remove('accent', 'ghost');
        label.textContent = '';
        st.title = `Step ${i + 1}`;
      }
    }
  }

  function updateFocus() {
    const sel = ui.get('selectedTrackId');
    rows.forEach((r, i) => {
      const elr = list.children[i];
      if (!elr) return;
      elr.classList.toggle('selected', r.track.id === sel);
      elr.classList.toggle('focused', rowKey(r) === focusKey && r.kind !== 'head');
    });
  }

  function syncToolbar() {
    const p = proj();
    const t = selTrack();
    trackLabel.textContent = t ? t.name : '';
    trackLabel.style.color = t?.color || '';
    for (const x of [trackLabel, patSel, newPatBtn, dupPatBtn]) x.classList.toggle('hidden', !t);
    const pats = t ? patternsForTrack(p, t.id) : [];
    patSel.replaceChildren(...pats.map((pt) => h('option', { value: pt.id }, pt.name)));
    if (t?.activePatternId) patSel.value = t.activePatternId;
    patSel.disabled = !pats.length;
    const len = p.patterns[t?.activePatternId]?.length ?? rows.find((r) => r.pat)?.pat.length ?? 4;
    const steps = Math.round(len / 0.25);
    if (![8, 16, 32, 48, 64].includes(steps)) {
      if (!stepsSel.querySelector(`option[value="${steps}"]`)) stepsSel.append(h('option', { value: String(steps) }, `${steps} steps`));
    }
    stepsSel.value = String(steps);
    swingField.setValue(Math.round((p.swing || 0) * 100));
    banner.classList.toggle('hidden', p.mode !== 'song' || !rows.length);
  }

  function render(force = false) {
    if (!visible) return;
    const newRows = buildRows();
    const p = proj();
    if (!newRows.length) {
      rows = [];
      signature = '';
      scroll.classList.add('hidden');
      empty.classList.remove('hidden');
      syncToolbar();
      return;
    }
    scroll.classList.remove('hidden');
    empty.classList.add('hidden');
    const sig = sigOf(newRows);
    if (force || sig !== signature) {
      signature = sig;
      rows = newRows;
      playCols.clear();
      const maxSteps = Math.max(...rows.map((r) => r.steps));
      el.style.setProperty('--rack-step-w', res() < 0.25 ? '18px' : '26px');
      buildRuler(maxSteps);
      list.replaceChildren(...rows.map((r, i) => buildRow(r, i)));
    } else {
      // keep DOM, refresh models (patterns/tracks are new objects after every transact)
      rows.forEach((r, i) => { r.track = newRows[i].track; r.pat = newRows[i].pat; });
      for (const r of rows) {
        if (r.kind === 'head') continue;
        if (r.nameBtn && r.kind === 'mel') r.nameBtn.textContent = r.track.name;
      }
    }
    for (const r of rows) updateRow(r);
    updateFocus();
    syncToolbar();

  }

  // ---------------------------------------------------------------- step interaction (delegated)
  function locate(target) {
    const st = target?.closest?.('.rack-step');
    if (!st) return null;
    const rowEl = st.closest('.rack-row');
    const row = rows[Number(rowEl?.dataset.idx)];
    if (!row) return null;
    return { row, i: Number(st.dataset.i), st };
  }
  list.addEventListener('contextmenu', (e) => { if (e.target.closest('.rack-step')) e.preventDefault(); });
  list.addEventListener('pointerdown', (e) => {
    const loc = locate(e.target);
    if (!loc) return;
    e.preventDefault();
    const { row, i } = loc;
    focusKey = rowKey(row);
    if (ui.get('selectedTrackId') !== row.track.id) actions.selectTrack(row.track.id);
    updateFocus();
    if (e.button === 2) {
      if (row.kind === 'mel') melStepMenu(row, i, e);
      else cycleAccent(row, i);
      return;
    }
    if (e.button !== 0) return;
    if (e.shiftKey) { setRatchet(row, i); return; }
    const pat = proj().patterns[row.pat?.id];
    const wasOn = pat ? stepNotes(row, pat, i).length > 0 : false;
    const paint = !wasOn;
    const drag = { recorded: false };
    const done = new Set([i]);
    setStep(row, i, paint, drag);
    if (paint) audition(row, 0.8);
    startDrag(e, (_dx, _dy, ev) => {
      const l2 = locate(document.elementFromPoint(ev.clientX, ev.clientY));
      if (!l2 || l2.row !== row || done.has(l2.i)) return;
      // fill any skipped steps between (fast drags)
      const last = [...done].pop();
      const dir = l2.i > last ? 1 : -1;
      for (let j = last + dir; dir > 0 ? j <= l2.i : j >= l2.i; j += dir) {
        if (done.has(j)) continue;
        done.add(j);
        const cur = proj().patterns[patIdFor(row)];
        const on = cur ? stepNotes(row, cur, j).length > 0 : false;
        if (on !== paint) setStep(row, j, paint, drag);
      }
    });
  });
  list.addEventListener('wheel', (e) => {
    const loc = locate(e.target);
    if (!loc) return;
    const pat = proj().patterns[loc.row.pat?.id];
    if (!pat || !stepNotes(loc.row, pat, loc.i).length) return; // let empty steps scroll
    e.preventDefault();
    const up = e.deltaY < 0 ? 1 : -1;
    if (loc.row.kind === 'mel' && !e.shiftKey) {
      if (e.altKey) nudgeStep(loc.row, loc.i, { dPitch: up });
      else nudgeStep(loc.row, loc.i, { scaleStep: up });
    } else nudgeStep(loc.row, loc.i, { dVel: up * 0.05 });
  }, { passive: false });
  // clicking a row head focuses the row
  list.addEventListener('click', (e) => {
    const rowEl = e.target.closest('.rack-row');
    if (!rowEl || e.target.closest('.rack-step')) return;
    const row = rows[Number(rowEl.dataset.idx)];
    if (row && row.kind !== 'head') { focusKey = rowKey(row); updateFocus(); }
  });

  // ---------------------------------------------------------------- playing step indicator
  function trackLocalPos(row, pos, p) {
    const pat = row.pat;
    if (!pat || pat.length <= 0) return null;
    if (p.mode === 'song') {
      const c = p.clips.find((cl) => cl.trackId === row.track.id && cl.patternId === pat.id && pos >= cl.start && pos < cl.start + cl.length);
      if (!c) return null;
      return (((pos - c.start + (c.offset || 0)) % pat.length) + pat.length) % pat.length;
    }
    return ((pos % pat.length) + pat.length) % pat.length;
  }
  function loop() {
    raf = 0;
    if (!visible) return;
    const playing = !!engine.isPlaying;
    let pos = null;
    if (playing) { try { pos = engine.getPosition(); } catch { pos = null; } }
    const p = proj();
    rows.forEach((row, idx) => {
      if (!row.stepEls) return;
      let col = -1;
      if (pos != null) { const lp = trackLocalPos(row, pos, p); if (lp != null) col = Math.floor(lp / res() + EPS); }
      const prev = playCols.get(idx) ?? -1;
      if (prev === col) return;
      if (prev >= 0) row.stepEls[prev]?.classList.remove('playing');
      if (col >= 0) row.stepEls[col]?.classList.add('playing');
      playCols.set(idx, col);
    });
    raf = requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- empty state & banner
  empty.append(h('div.empty-state',
    icon('drum', 40),
    h('h3', 'Step Rack'),
    h('p', 'Program beats by clicking steps — like a drum machine. Every instrument track shows up here; drum tracks get one row per pad.'),
    h('div.row.wrap', { style: { justifyContent: 'center' } },
      button('Start a beat', () => actions.addTrack('drums'), { icon: 'drum', primary: true, title: 'Add a drum machine track' }),
      button('Generate a beat', () => actions.generatePart('drums'), { icon: 'dice', title: 'Add a drum track with a generated pattern for the current genre' }),
      button('Add track…', (e) => contextMenu(anchorEv(e), actions.addTrackMenuItems()), { icon: 'plus' }))));
  banner.append(icon('timeline', 14), h('span', 'Song mode is on: the rack edits each track\'s active pattern, but playback follows the arrangement.'),
    button('Switch to Pattern mode', () => actions.setMode('pattern'), { cls: 'small', title: 'Loop the active patterns (P)' }));

  // ---------------------------------------------------------------- lifecycle
  app.subscribe((r) => {
    if (!visible) return;
    if (r.project || 'selectedTrackId' in r.ui || 'selectedPatternId' in r.ui) render();
  });

  return {
    el,
    show() {
      visible = true;
      render(true);
      if (!raf) raf = requestAnimationFrame(loop);
    },
    hide() {
      visible = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
