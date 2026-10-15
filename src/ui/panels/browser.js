// Browser panel (left): instruments, drum kits, samples, genres, code examples, patterns
// and chord progressions — searchable, collapsible, draggable (like Ableton / Bitwig browsers).
import { h, icon } from '../dom.js';
import { iconButton, button, contextMenu, modal, promptText, confirmDialog, select, toast } from '../components.js';
import { beatsPerBar, patternsForTrack, createNote } from '../../core/model.js';
import { uid, createRng } from '../../core/util.js';
import * as audio from '../../audio/index.js';
import * as genres from '../../gen/genres.js';
import * as theory from '../../theory/index.js';
import { DRUM_MACHINES } from '../../audio/library/drum-machines.js';
import { fileInput } from '../components.js';
import { effectPresetEntries } from '../../audio/effect-presets.js';
import { presetStore } from '../../core/preset-store.js';
import { DT_PRESET_REF, encodeRef, dropRef, describeKey, exportPresets, importPresetFiles, applyTemplateToTrack, PRESET_FILE_ACCEPT, isPresetFile } from '../preset-apply.js';
import { saveFxChain, saveTrackTemplate } from '../device-presets.js';

const LS_OPEN = 'daw3-browser-open';
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
const CATEGORY_ORDER = ['Strudel', 'Bass', 'Lead', 'Keys', 'Piano', 'Pad', 'Pluck', 'Chords', 'Strings', 'Brass', 'Arp', 'Mallets', 'World', 'FX'];
const AUDIO_EXT = /\.(wav|mp3|ogg|oga|flac|aiff?|m4a|aac|webm)$/i;
const fmtDur = (s) => (s ? (s < 10 ? s.toFixed(2) + ' s' : Math.round(s) + ' s') : '');
const cap = (s) => String(s || '').replace(/(^|[-\s])\w/g, (m) => m.toUpperCase()).replace(/-/g, ' ');

let optional = null;
function loadOptional() {
  if (optional) return optional;
  const imp = (p) => import(p).catch(() => ({}));
  optional = Promise.all([imp('../../code/examples.js'), imp('../../gen/index.js'), imp('../../io/wav.js')])
    .then(([ex, gen, wav]) => ({ examples: ex.CODE_EXAMPLES || [], gen, wav }));
  return optional;
}

// ---------------------------------------------------------------- tiny synth for "Generate sample"
function encodeWav16(buf) {
  const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); out.setUint32(4, 36 + len * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true); out.setUint32(24, sr, true);
  out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, len * ch * 2, true);
  const data = [...Array(ch)].map((_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, data[c][i])); out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
  return out.buffer;
}
function toBase64(ab) {
  const bytes = new Uint8Array(ab);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const SAMPLE_RECIPES = {
  kick: { name: 'Gen Kick', dur: 0.6, desc: 'Sine sweep 150→45 Hz with a click — a punchy electronic kick.' },
  snare: { name: 'Gen Snare', dur: 0.35, desc: 'Tuned body + band-passed noise.' },
  hat: { name: 'Gen Hat', dur: 0.12, desc: 'High-passed noise burst.' },
  clap: { name: 'Gen Clap', dur: 0.4, desc: 'Three quick noise bursts and a tail — the classic analog clap.' },
  chord: { name: 'Gen Chord Stab', dur: 1.2, desc: 'A saw-wave stab of the project key\'s tonic chord (7th), low-pass filtered.' },
  riser: { name: 'Gen Riser', dur: 2.5, desc: 'Filtered noise sweep that rises — use it before drops.' },
};
async function renderRecipe(kind, project) {
  const sr = 44100;
  const r = SAMPLE_RECIPES[kind];
  const ctx = new OfflineAudioContext(1, Math.ceil(sr * r.dur), sr);
  const out = ctx.createGain(); out.connect(ctx.destination);
  const noise = () => {
    const b = ctx.createBuffer(1, Math.ceil(sr * r.dur), sr);
    const d = b.getChannelData(0); const rng = createRng(7);
    for (let i = 0; i < d.length; i++) d[i] = rng() * 2 - 1;
    const s = ctx.createBufferSource(); s.buffer = b; return s;
  };
  const env = (g, a, peak, d) => { g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(peak, a); g.gain.exponentialRampToValueAtTime(0.0001, a + d); };
  if (kind === 'kick') {
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.setValueAtTime(150, 0); o.frequency.exponentialRampToValueAtTime(45, 0.12);
    env(g, 0.002, 1, 0.5); o.connect(g).connect(out); o.start(); o.stop(r.dur);
    const n = noise(); const ng = ctx.createGain(); const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3000;
    env(ng, 0.001, 0.4, 0.015); n.connect(hp).connect(ng).connect(out); n.start();
  } else if (kind === 'snare' || kind === 'hat' || kind === 'clap' || kind === 'riser') {
    const n = noise(); const f = ctx.createBiquadFilter(); const g = ctx.createGain();
    if (kind === 'snare') {
      f.type = 'bandpass'; f.frequency.value = 3000; f.Q.value = 0.7; env(g, 0.001, 0.9, 0.2);
      const o = ctx.createOscillator(); const og = ctx.createGain(); o.frequency.setValueAtTime(220, 0); o.frequency.exponentialRampToValueAtTime(160, 0.1);
      env(og, 0.001, 0.7, 0.12); o.connect(og).connect(out); o.start(); o.stop(r.dur);
    } else if (kind === 'hat') { f.type = 'highpass'; f.frequency.value = 8000; env(g, 0.001, 0.7, 0.07); }
    else if (kind === 'clap') {
      f.type = 'bandpass'; f.frequency.value = 1400; f.Q.value = 1.2;
      g.gain.setValueAtTime(0, 0);
      for (const t of [0, 0.011, 0.022]) { g.gain.setValueAtTime(1, t); g.gain.exponentialRampToValueAtTime(0.1, t + 0.01); }
      g.gain.setValueAtTime(0.8, 0.033); g.gain.exponentialRampToValueAtTime(0.0001, 0.33);
    } else {
      f.type = 'bandpass'; f.Q.value = 4; f.frequency.setValueAtTime(300, 0); f.frequency.exponentialRampToValueAtTime(9000, r.dur * 0.95);
      g.gain.setValueAtTime(0.0001, 0); g.gain.exponentialRampToValueAtTime(0.9, r.dur * 0.92); g.gain.linearRampToValueAtTime(0, r.dur);
    }
    n.connect(f).connect(g).connect(out); n.start();
  } else if (kind === 'chord') {
    const root = 48 + (project.key?.root || 0);
    const minor = /minor|dorian|phrygian|aeolian|locrian/.test(project.key?.scale || '');
    const ivs = minor ? [0, 3, 7, 10, 14] : [0, 4, 7, 11, 14];
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(4000, 0); lp.frequency.exponentialRampToValueAtTime(500, 0.6); lp.Q.value = 3;
    const g = ctx.createGain(); env(g, 0.005, 0.22, 1.1); lp.connect(g).connect(out);
    for (const iv of ivs) for (const det of [-6, 6]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 440 * Math.pow(2, (root + iv - 69) / 12); o.detune.value = det;
      o.connect(lp); o.start(); o.stop(r.dur);
    }
  }
  const buf = await ctx.startRendering();
  return buf;
}

export function createBrowserPanel(app) {
  const { store, ui, engine, actions } = app;
  const get = () => store.get();
  const PRESETS = audio.PRESETS || {};
  const DRUM_KITS = audio.DRUM_KITS || {};
  const GENRES = genres.GENRES || {};
  let query = '';
  let openState = lsGet(LS_OPEN, { instruments: true, machines: true, kits: false, samples: true, genres: false, examples: false, patterns: true, progressions: false });
  let progGenre = 'project';
  let selectedKey = null;
  let opt = { examples: [], gen: {}, wav: {} };

  // ---------------------------------------------------------------- shell
  const search = h('input.br-search', { type: 'search', placeholder: 'Search sounds, samples, genres…', title: 'Filter everything in the browser (Esc clears)' });
  const collapseBtn = iconButton('layers', () => { for (const k of Object.keys(openState)) openState[k] = false; lsSet(LS_OPEN, openState); renderAll(); }, 'Collapse all sections');
  const header = h('div.panel-header', icon('folder', 14), h('span.title', 'Browser'), h('div.spacer'), collapseBtn, iconButton('x', () => ui.set({ browserOpen: false }), 'Hide browser (B)'));
  const bodyEl = h('div.panel-body.br-body');
  const info = h('div.br-info');
  const dropHint = h('div.br-drop.hidden', icon('upload', 22), h('b', 'Drop audio files to import samples'));
  const el = h('div.br-panel', header, h('div.br-searchbar', icon('search', 13), search), bodyEl, info, dropHint);

  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); renderAll(); });
  search.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { search.value = ''; query = ''; renderAll(); search.blur(); } });

  const matches = (...parts) => !query || parts.join(' ').toLowerCase().includes(query);

  function setInfo(title, text, hint) {
    info.replaceChildren(h('b', title), text ? h('p', text) : null, hint ? h('p.muted', hint) : null);
    info.classList.toggle('empty', !title);
  }
  setInfo('', '');

  // ---------------------------------------------------------------- building blocks
  function section(key, title, ic, children, { count, extra, empty } = {}) {
    if (query && !children.length) return null;
    const det = h('details.br-section', { open: query ? true : !!openState[key], dataset: { key } },
      h('summary', icon('chevronRight', 12), icon(ic, 14), h('span.br-section-title', title), count != null ? h('span.br-count', String(count)) : null, h('div.spacer'), extra || null),
      h('div.br-section-body', children.length ? children : (empty || h('div.br-empty.muted', 'Nothing here yet.'))));
    det.addEventListener('toggle', () => { if (!query) { openState[key] = det.open; lsSet(LS_OPEN, openState); } });
    return det;
  }
  function group(key, title, children, count) {
    if (!children.length) return null;
    const gk = 'g:' + key;
    const det = h('details.br-group', { open: query ? true : openState[gk] ?? false },
      h('summary', icon('chevronRight', 11), h('span', title), h('span.br-count', String(count ?? children.length))),
      h('div.br-group-body', children));
    det.addEventListener('toggle', () => { if (!query) { openState[gk] = det.open; lsSet(LS_OPEN, openState); } });
    return det;
  }
  function item({ key, ic, label, meta, title, onClick, onDblClick, onMenu, drag, actionsEls = [], cls = '' }) {
    const clsSel = String(cls).split(/\s+/).filter(Boolean).map((c) => '.' + c).join('');
    const row = h(`div.br-item${clsSel}${selectedKey === key ? '.selected' : ''}`, { title: title || '', tabIndex: 0, draggable: !!drag, dataset: { key } },
      ic ? icon(ic, 13) : null, h('span.br-label', label), meta ? h('span.br-meta', meta) : null, h('span.br-actions', actionsEls));
    row.addEventListener('click', (e) => {
      if (e.target.closest('.br-actions')) return;
      bodyEl.querySelectorAll('.br-item.selected').forEach((x) => x.classList.remove('selected'));
      row.classList.add('selected');
      selectedKey = key;
      onClick && onClick(e);
    });
    if (onDblClick) row.addEventListener('dblclick', (e) => { if (!e.target.closest('.br-actions')) onDblClick(e); });
    if (onMenu) row.addEventListener('contextmenu', (e) => { e.preventDefault(); onMenu(e); });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); (onDblClick || onClick)?.(e); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const all = [...bodyEl.querySelectorAll('.br-item')].filter((x) => x.offsetParent);
        const i = all.indexOf(row);
        all[i + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
      }
    });
    if (drag) {
      row.addEventListener('dragstart', (e) => {
        for (const [type, val] of Object.entries(drag)) e.dataTransfer.setData(type, val);
        e.dataTransfer.setData('text/plain', label);
        e.dataTransfer.effectAllowed = 'copy';
      });
    }
    return row;
  }
  const actBtn = (ic, title, fn) => {
    const b = h('button.br-act', { type: 'button', title }, icon(ic, 12));
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(e); });
    return b;
  };

  const selectedTrack = () => get().tracks.find((t) => t.id === ui.get('selectedTrackId')) || null;

  // ---------------------------------------------------------------- instruments
  function loadPresetOnSelected(presetId) {
    const t = selectedTrack();
    const pr = PRESETS[presetId];
    if (!t || t.type !== 'instrument' || !pr) { toast('Select an instrument track first', { level: 'warn' }); return; }
    actions.updateTrack(t.id, (tt) => {
      tt.instrument = { type: pr.instrument?.type || 'synth', preset: presetId, params: {} };
      if (!tt.role && pr.roles?.[0]) tt.role = pr.roles[0];
    }, `Load ${pr.name}`);
    toast(`Loaded "${pr.name}" on ${t.name}`, { level: 'success' });
  }
  function buildInstruments() {
    const cats = new Map();
    for (const [id, pr] of Object.entries(PRESETS)) {
      const c = pr.category || 'Other';
      if (!matches(pr.name, c, (pr.roles || []).join(' '), (pr.genres || []).join(' '), id)) continue;
      if (!cats.has(c)) cats.set(c, []);
      cats.get(c).push([id, pr]);
    }
    const order = [...cats.keys()].sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    const total = [...cats.values()].reduce((s, l) => s + l.length, 0);
    const groups = order.map((c) => group('inst:' + c, c === 'Strudel' ? 'Strudel sounds' : c, cats.get(c).map(([id, pr]) => item({
      key: 'preset:' + id, ic: 'music', label: pr.name, meta: (pr.instrument?.type || '').toUpperCase().slice(0, 5),
      title: `${pr.name} — ${pr.category}${pr.roles?.length ? ' · ' + pr.roles.join(', ') : ''}\nDouble-click or drag to add a track · right-click for more`,
      drag: { 'application/x-daw3-preset': id },
      onClick: () => setInfo(pr.name, `${pr.description || `${cap(pr.instrument?.type || 'synth')} preset`}${pr.roles?.length ? ` · Roles: ${pr.roles.join(', ')}` : ''}`, `${pr.genres?.length ? 'Used in: ' + pr.genres.slice(0, 6).map(cap).join(', ') + '. ' : ''}Double-click or drag onto the timeline to add.`),
      onDblClick: () => actions.addTrack(id),
      onMenu: (e) => { const t = selectedTrack(); contextMenu(e, [
        { header: pr.name },
        { label: 'Add as new track', icon: 'plus', onClick: () => actions.addTrack(id) },
        { label: t && t.type === 'instrument' ? `Load on "${t.name}"` : 'Load on selected track', icon: 'music', disabled: !t || t.type !== 'instrument', onClick: () => loadPresetOnSelected(id) },
        { label: 'Add + generate a part', icon: 'dice', submenu: ['bass', 'chords', 'pad', 'lead', 'arp'].map((role) => ({ label: cap(role), onClick: () => { const nt = actions.addTrack(id, { role }); if (nt) actions.generatePart(role, { trackId: nt.id }); } })) },
      ]); },
      actionsEls: [actBtn('plus', 'Add as new track', () => actions.addTrack(id))],
    })), cats.get(c).length));
    return section('instruments', 'Instruments', 'piano', groups.filter(Boolean), { count: total, empty: h('div.br-empty.muted', 'Presets are loading…') });
  }

  // ---------------------------------------------------------------- drum kits
  function buildKits() {
    const items = Object.entries(DRUM_KITS).filter(([id, k]) => matches(k.name, k.description || '', id, 'drum kit drums')).map(([id, k]) => item({
      key: 'kit:' + id, ic: 'drum', label: k.name || id,
      title: `${k.description || k.name}\nDouble-click or drag to add a drum track · right-click to load on the selected drum track`,
      drag: { 'application/x-daw3-kit': id, 'application/x-daw3-preset': id },
      onClick: () => setInfo(k.name || id, k.description || 'Synthesized drum kit', 'Double-click to add a drum track with this kit.'),
      onDblClick: () => actions.addTrack(id),
      onMenu: (e) => { const t = selectedTrack(); const isDrum = t?.instrument?.type === 'drums'; contextMenu(e, [
        { header: k.name || id },
        { label: 'Add drum track', icon: 'plus', onClick: () => actions.addTrack(id) },
        { label: 'Add drum track + beat', icon: 'dice', onClick: () => { const nt = actions.addTrack(id); if (nt) actions.generatePart('drums', { trackId: nt.id }); } },
        { label: isDrum ? `Load on "${t.name}"` : 'Load on selected drum track', icon: 'drum', disabled: !isDrum, onClick: () => { actions.updateTrack(t.id, (tt) => { tt.instrument.preset = id; tt.instrument.params = { ...(tt.instrument.params || {}), kit: id }; }, `Kit ${k.name}`); toast(`${t.name} now uses the ${k.name} kit`, { level: 'success' }); } },
      ]); },
      actionsEls: [actBtn('plus', 'Add drum track', () => actions.addTrack(id))],
    }));
    return section('kits', 'Drum kits', 'drum', items, { count: items.length });
  }

  // ---------------------------------------------------------------- sampled drum machines (src/audio/library)
  function machineInstrument(id) {
    const kit = DRUM_MACHINES[id]?.kit || '808';
    return { type: 'drums', preset: kit, params: { kit, machine: id } };
  }
  function addMachineTrack(id) {
    return actions.addTrack('plugin', { instrument: machineInstrument(id), name: DRUM_MACHINES[id]?.name || id, role: 'drums' });
  }
  async function previewMachineSound(id) {
    try {
      await actions.ensureAudio?.();
      if (!engine.ctx) return;
      const { previewMachine } = await import('../../audio/library/preview.js');
      let tm = null;
      await previewMachine(engine.ctx, engine.graph?.master?.input || engine.ctx.destination, id, {
        bpm: Math.min(130, Math.max(80, get().bpm || 104)),
        onLoading: (on) => { if (on) tm = setTimeout(() => toast(`Loading ${DRUM_MACHINES[id]?.name || id} samples…`), 400); else clearTimeout(tm); },
      });
    } catch (e) { toast('Could not preview: ' + e.message, { level: 'error' }); }
  }
  function buildMachines() {
    const items = Object.entries(DRUM_MACHINES).filter(([id, m]) => matches(m.name, m.maker, String(m.year), (m.tags || []).join(' '), id, 'drum machine sampled')).map(([id, m]) => item({
      key: 'machine:' + id, ic: 'drum', label: m.name, meta: String(m.year || ''),
      title: `${m.name} — ${m.description}\nClick: preview · double-click: add a drum track · right-click for more`,
      onClick: () => { setInfo(m.name, m.description, `Real samples (Strudel bank "${id}") — ${(m.tags || []).join(', ')}. Double-click to add a drum track; the synthesized “${DRUM_KITS[m.kit]?.name || m.kit}” kit plays if the samples can't load.`); previewMachineSound(id); },
      onDblClick: () => addMachineTrack(id),
      onMenu: (e) => { const t = selectedTrack(); const isDrum = t?.instrument?.type === 'drums' || t?.instrument?.type === 'drumsampler'; contextMenu(e, [
        { header: m.name },
        { label: 'Preview', icon: 'play', onClick: () => previewMachineSound(id) },
        { label: 'Add drum track', icon: 'plus', onClick: () => addMachineTrack(id) },
        { label: 'Add drum track + beat', icon: 'dice', onClick: () => { const nt = addMachineTrack(id); if (nt) actions.generatePart('drums', { trackId: nt.id }); } },
        { label: isDrum ? `Load on "${t.name}"` : 'Load on selected drum track', icon: 'drum', disabled: !isDrum, onClick: () => { actions.updateTrack(t.id, (tt) => { tt.instrument.params = { ...(tt.instrument.params || {}), machine: id }; }, `Machine ${m.name}`); toast(`${t.name} now plays the ${m.name}`, { level: 'success' }); } },
      ]); },
      actionsEls: [actBtn('play', 'Preview', () => previewMachineSound(id)), actBtn('plus', 'Add drum track', () => addMachineTrack(id))],
    }));
    return section('machines', 'Drum machines', 'drum', items, { count: items.length });
  }

  // ---------------------------------------------------------------- samples
  async function renameSample(id) {
    const s = get().samples[id];
    if (!s) return;
    const name = await promptText('Rename sample', s.name);
    if (name) store.transact('Rename sample', (p) => { if (p.samples[id]) p.samples[id].name = name; });
  }
  async function deleteSample(id) {
    const p = get();
    const s = p.samples[id];
    if (!s) return;
    const n = p.clips.filter((c) => c.sampleId === id).length;
    const ok = await confirmDialog('Delete sample', `Delete "${s.name}"${n ? ` and the ${n} audio clip${n > 1 ? 's' : ''} that use it` : ''}? Samplers using it will be emptied. This cannot be undone.`);
    if (!ok) return;
    store.transact('Delete sample', (pp) => {
      delete pp.samples[id];
      pp.clips = pp.clips.filter((c) => c.sampleId !== id);
      for (const t of pp.tracks) {
        const prm = t.instrument?.params;
        if (!prm) continue;
        if (prm.sampleId === id) delete prm.sampleId;
        for (const [k, v] of Object.entries(prm)) if (v === id) delete prm[k];
      }
    }, { undo: false });
    toast(`Deleted "${s.name}"`);
  }
  async function auditionSample(id) {
    try { await actions.ensureAudio?.(); await engine.auditionSample(id); } catch (e) { toast('Could not play sample: ' + e.message, { level: 'error' }); }
  }
  async function generateSample(kind) {
    try {
      const buf = await renderRecipe(kind, get());
      const ab = opt.wav.encodeWav ? opt.wav.encodeWav(buf, { bitDepth: 16 }) : encodeWav16(buf);
      const r = SAMPLE_RECIPES[kind];
      const names = new Set(Object.values(get().samples).map((s) => s.name));
      let name = `${r.name}.wav`, i = 2;
      while (names.has(name)) name = `${r.name} ${i++}.wav`;
      const sample = { id: uid('smp'), name, mime: 'audio/wav', data: toBase64(ab), duration: buf.duration };
      store.transact('Generate sample', (p) => { p.samples[sample.id] = sample; });
      engine.decodeSample?.(sample.id).catch(() => {});
      toast(`Generated "${name}" — drag it onto a track or drum pad`, { level: 'success' });
      selectedKey = 'sample:' + sample.id;
      return sample;
    } catch (e) {
      console.error(e);
      toast('Could not generate sample: ' + e.message, { level: 'error' });
      return null;
    }
  }
  function buildSamples() {
    const p = get();
    const list = Object.values(p.samples || {}).filter((s) => matches(s.name, 'sample audio'));
    const items = list.sort((a, b) => a.name.localeCompare(b.name)).map((s) => item({
      key: 'sample:' + s.id, ic: 'wave', label: s.name, meta: fmtDur(s.duration),
      title: `${s.name}${s.duration ? ` (${fmtDur(s.duration)})` : ''}\nClick ▶ to listen · drag onto a track, drum pad or sampler · right-click for more`,
      drag: { 'application/x-daw3-sample': s.id },
      onClick: () => setInfo(s.name, `${s.mime || 'audio'}${s.duration ? ' · ' + fmtDur(s.duration) : ''}`, 'Drag onto the arrangement or a drum pad. Right-click: place at playhead / load into a sampler.'),
      onDblClick: () => auditionSample(s.id),
      onMenu: (e) => contextMenu(e, [
        { header: s.name },
        { label: 'Play', icon: 'play', onClick: () => auditionSample(s.id) },
        { label: 'Place on timeline at playhead', icon: 'timeline', onClick: () => { const t = selectedTrack(); actions.placeSample(s.id, { trackId: t?.type === 'audio' ? t.id : undefined, start: Math.max(0, Math.round((engine.getPosition?.() || 0) * 4) / 4) }); } },
        { label: 'Load into new sampler', icon: 'piano', onClick: () => actions.sampleToSampler(s.id) },
        { label: 'Load into selected sampler', icon: 'piano', disabled: selectedTrack()?.instrument?.type !== 'sampler', onClick: () => actions.sampleToSampler(s.id, selectedTrack().id) },
        '-',
        { label: 'Rename…', icon: 'pencil', onClick: () => renameSample(s.id) },
        { label: 'Delete…', icon: 'trash', onClick: () => deleteSample(s.id) },
      ]),
      actionsEls: [actBtn('play', 'Play', () => auditionSample(s.id))],
    }));
    const importBtn = h('button.br-mini', { type: 'button', title: 'Import audio files (wav, mp3, ogg, flac…)' }, icon('upload', 11));
    importBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); actions.importSamples(); });
    const genBtn = h('button.br-mini', { type: 'button', title: 'Generate a one-shot sample (kick, snare, chord stab, riser…)' }, icon('wand', 11));
    genBtn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const r = genBtn.getBoundingClientRect();
      contextMenu({ clientX: r.left, clientY: r.bottom + 2 }, [{ header: 'Generate a one-shot' }, ...Object.entries(SAMPLE_RECIPES).map(([k, rc]) => ({ label: rc.name.replace('Gen ', ''), icon: 'wave', onClick: async () => { const s = await generateSample(k); if (s) auditionSample(s.id); } }))]);
    });
    const dropZone = h('div.br-dropzone', { title: 'Drop audio files here' }, icon('upload', 13), h('span', 'Drop audio files here or '), h('button.br-linkbtn', { type: 'button', onclick: () => actions.importSamples() }, 'browse…'));
    if (query && !items.length) return null;
    return section('samples', 'Samples', 'wave', [...items, dropZone], { count: list.length, extra: h('span.br-extra', genBtn, importBtn) });
  }

  // ---------------------------------------------------------------- genres
  async function showGenre(id) {
    const g = GENRES[id];
    if (!g) return;
    const o = await loadOptional();
    let described = null;
    try { described = o.gen.describeGenre ? o.gen.describeGenre(id) : null; } catch { described = null; }
    const body = h('div.br-genre-modal');
    if (typeof described === 'string') body.appendChild(h('div.br-genre-desc', described.split(/\n+/).filter((l) => l.trim() && !(g.tips || []).includes(l.trim())).map((l) => h('p', l))));
    else if (described && typeof described === 'object') {
      if (described.summary || described.text || described.description) body.appendChild(h('p.br-genre-lead', described.summary || described.text || described.description));
    }
    const facts = h('div.br-facts',
      h('div', h('span', 'Tempo'), h('b', `${g.bpm?.[0] ?? '?'}–${g.bpm?.[1] ?? '?'} BPM`), h('small', `default ${g.defaultBpm ?? '–'}`)),
      h('div', h('span', 'Feel'), h('b', g.swing ? `${Math.round(g.swing * 100)}% swing` : 'straight'), h('small', (g.timeSig || [4, 4]).join('/'))),
      h('div', h('span', 'Scales'), h('b', (g.scales || []).map((s) => theory.SCALES?.[s]?.name?.replace(/ \(.*\)/, '') || cap(s)).join(', ') || '–')),
      h('div', h('span', 'Drum kit'), h('b', DRUM_KITS[g.drumKit]?.name || g.drumKit || '–')));
    body.appendChild(facts);
    if (g.tips?.length) body.appendChild(h('div', h('div.section-title', 'Tips'), h('ul.br-tips', g.tips.map((t) => h('li', t)))));
    if (g.presets) body.appendChild(h('div', h('div.section-title', 'Typical sounds'), h('div.br-chips', Object.entries(g.presets).map(([role, pid]) => h('span.chip', { title: role }, `${cap(role)}: ${PRESETS[pid]?.name || DRUM_KITS[pid]?.name || pid}`)))));
    if (g.progressions?.length) body.appendChild(h('div', h('div.section-title', 'Signature progressions'), h('div.br-chips', g.progressions.map((pid) => { const pr = theory.PROGRESSIONS?.[pid]; return pr ? h('span.chip', { title: pr.description }, pr.name) : null; }))));
    if (g.fx?.length) body.appendChild(h('div', h('div.section-title', 'Production'), h('ul.br-tips', g.fx.map((t) => h('li', t)))));
    modal({
      title: `${g.name} · ${cap(g.family)}`, body, width: 560,
      actions: [
        { label: 'Close' },
        { label: 'Set as project genre', onClick: () => { actions.applyGenreDefaults(id); toast(`${g.name}: tempo, swing & scale applied. The assistant will tailor its tips.`, { level: 'success' }); } },
        { label: 'Generate song', primary: true, onClick: () => actions.generateSong({ genre: id }) },
      ],
    });
  }
  function buildGenres() {
    const fams = new Map();
    for (const [id, g] of Object.entries(GENRES)) {
      if (!matches(g.name, g.family, id, (g.tips || []).join(' '))) continue;
      const f = g.family || 'other';
      if (!fams.has(f)) fams.set(f, []);
      fams.get(f).push([id, g]);
    }
    const cur = get().genre;
    const total = [...fams.values()].reduce((s, l) => s + l.length, 0);
    const groups = [...fams.keys()].sort().map((f) => group('genre:' + f, cap(f), fams.get(f).map(([id, g]) => item({
      key: 'genre:' + id, ic: id === cur ? 'sparkles' : 'music', label: g.name, meta: `${g.defaultBpm || g.bpm?.[0] || ''}`,
      cls: id === cur ? 'current' : '',
      title: `${g.name} — ${g.bpm?.[0]}–${g.bpm?.[1]} BPM\nClick for the genre guide · right-click for actions`,
      onClick: () => showGenre(id),
      onMenu: (e) => contextMenu(e, [
        { header: g.name },
        { label: 'Genre guide…', icon: 'help', onClick: () => showGenre(id) },
        { label: 'Set as project genre', icon: 'sparkles', onClick: () => actions.applyGenreDefaults(id) },
        { label: 'Generate song', icon: 'wand', onClick: () => actions.generateSong({ genre: id }) },
      ]),
    })), fams.get(f).length));
    return section('genres', 'Genres', 'sparkles', groups.filter(Boolean), { count: total });
  }

  // ---------------------------------------------------------------- code examples
  function openExample(ex) {
    const t = actions.addTrack('code', { code: ex.code, name: ex.name });
    if (t) ui.set({ view: 'code', selectedTrackId: t.id });
    toast(`Opened "${ex.name}" as a code track. Edit it, then Ctrl+Enter to apply.`, { level: 'success' });
  }
  function buildExamples() {
    const items = opt.examples.filter((ex) => matches(ex.name, ex.genre || '', ex.code, 'code strudel example')).map((ex) => item({
      key: 'ex:' + ex.id, ic: 'code', label: ex.name, meta: ex.genre ? cap(ex.genre).slice(0, 12) : '',
      title: `${ex.name}${ex.genre ? ` (${ex.genre})` : ''}\n\n${ex.code.slice(0, 400)}\n\nClick to open as a new code track`,
      onClick: () => openExample(ex),
      actionsEls: [actBtn('plus', 'Open as code track', () => openExample(ex))],
    }));
    return section('examples', 'Code examples', 'code', items, { count: items.length, empty: h('div.br-empty.muted', 'Examples are loading…') });
  }

  // ---------------------------------------------------------------- patterns of the selected track
  function buildPatterns() {
    const p = get();
    const t = selectedTrack();
    if (!t || t.type !== 'instrument') {
      if (query) return null;
      return section('patterns', 'Patterns', 'grid', [], { empty: h('div.br-empty.muted', t ? `"${t.name}" is a ${t.type} track — patterns belong to instrument tracks.` : 'Select an instrument track to see its patterns.') });
    }
    const isDrums = t.instrument?.type === 'drums';
    const pats = patternsForTrack(p, t.id).filter((pt) => matches(pt.name, 'pattern', t.name));
    const selPat = ui.get('selectedPatternId');
    const items = pats.map((pt) => item({
      key: 'pat:' + pt.id, ic: 'grid', label: pt.name, meta: `${Math.round((pt.length / beatsPerBar(p)) * 100) / 100} bar · ${pt.notes.length}`,
      cls: (pt.id === t.activePatternId ? 'current' : '') + (pt.id === selPat ? ' sel' : ''),
      title: `${pt.name}: ${pt.notes.length} notes, ${pt.length} beats${pt.id === t.activePatternId ? ' (active)' : ''}\nClick to select · double-click to edit`,
      drag: { 'application/x-daw3-pattern': pt.id },
      onClick: () => actions.selectPattern(pt.id),
      onDblClick: () => { actions.selectPattern(pt.id); ui.set({ view: isDrums ? 'rack' : 'piano' }); },
      onMenu: (e) => contextMenu(e, [
        { header: pt.name },
        { label: 'Edit in ' + (isDrums ? 'Step Rack' : 'Piano Roll'), icon: isDrums ? 'grid' : 'piano', onClick: () => { actions.selectPattern(pt.id); ui.set({ view: isDrums ? 'rack' : 'piano' }); } },
        { label: 'Duplicate', icon: 'copy', onClick: () => actions.duplicatePattern(pt.id) },
        { label: 'Rename…', icon: 'pencil', onClick: async () => { const n = await promptText('Rename pattern', pt.name); if (n) store.transact('Rename pattern', (pp) => { if (pp.patterns[pt.id]) pp.patterns[pt.id].name = n; }); } },
        { label: 'Delete', icon: 'trash', onClick: () => actions.deletePattern(pt.id) },
      ]),
    }));
    const add = h('button.br-mini', { type: 'button', title: 'New empty pattern on this track' }, icon('plus', 11), 'New');
    add.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); actions.newPattern(t.id); });
    if (query && !items.length) return null;
    return section('patterns', `Patterns · ${t.name}`, 'grid', items, { count: items.length, extra: h('span.br-extra', add) });
  }

  // ---------------------------------------------------------------- chord progressions
  function insertProgression(id) {
    const prog = theory.PROGRESSIONS?.[id];
    if (!prog) return;
    const p = get();
    const bpb = beatsPerBar(p);
    // chords go to the selected harmony track; never overwrite drums, bass or lead lines
    const harmonic = (x) => x && x.type === 'instrument' && x.instrument?.type !== 'drums' && !['bass', 'lead', 'arp', 'fx', 'drums'].includes(x.role);
    let t = selectedTrack();
    if (!harmonic(t)) t = p.tracks.find((x) => harmonic(x) && (x.role === 'chords' || x.role === 'pad')) || null;
    if (!t) {
      const preset = PRESETS['electric-piano'] ? 'electric-piano' : 'synth';
      t = actions.addTrack(preset, { role: 'chords', name: 'Chords' });
    }
    if (!t) return;
    const pat = actions.ensurePattern(t.id);
    if (!pat) return;
    const { root, scale } = p.key;
    const notes = [];
    let beat = 0;
    let prev = [];
    prog.romans.forEach((roman, i) => {
      const chord = theory.romanToChord(roman, root, scale);
      const dur = (prog.durs?.[i] ?? 1) * bpb;
      if (chord) {
        let voicing;
        // clean, voice-led voicings around C3–C5 (no low clusters, common tones held)
        if (theory.voiceChord) voicing = theory.voiceChord(chord, { prev, range: [52, 76], maxVoices: 5 });
        else if (prev.length && theory.voiceLead) voicing = theory.voiceLead(prev, chord.notes, [50, 76]);
        else { let r = 48 + chord.root; if (r > 55) r -= 12; voicing = theory.chordNotes(r + 12, chord.type, {}); }
        if (!voicing?.length) voicing = chord.notes.map((pc) => 60 + pc);
        prev = voicing;
        for (const pitch of voicing) notes.push(createNote(pitch, beat, dur * 0.98, 0.72));
      }
      beat += dur;
    });
    const length = Math.max(bpb, Math.ceil(beat / bpb) * bpb);
    store.transact(`Insert ${prog.name}`, (pp) => {
      const pt = pp.patterns[pat.id];
      if (!pt) return;
      pt.notes = notes;
      pt.length = Math.max(length, 1);
    });
    actions.selectPattern(pat.id);
    const names = prog.romans.map((r) => theory.romanToChord(r, root, scale)?.name || r).join(' – ');
    toast(`${prog.name} → "${t.name}": ${names}. (Ctrl+Z to undo)`, { level: 'success', timeout: 5000 });
  }
  function buildProgressions() {
    const p = get();
    const genre = progGenre === 'project' ? p.genre : progGenre === 'all' ? null : progGenre;
    const minor = theory.isMinorScale ? theory.isMinorScale(p.key.scale) : /minor/.test(p.key.scale);
    let list = Object.entries(theory.PROGRESSIONS || {}).map(([id, pr]) => ({ id, ...pr }));
    if (genre) {
      const g = list.filter((pr) => pr.genres?.includes(genre) || GENRES[genre]?.progressions?.includes(pr.id));
      if (g.length) list = g;
    }
    list = list.filter((pr) => matches(pr.name, pr.romans.join(' '), (pr.genres || []).join(' '), (pr.moods || []).join(' '), 'chord progression'));
    // progressions written for the current mode first
    list.sort((a, b) => ((a.mode === 'minor') !== minor) - ((b.mode === 'minor') !== minor));
    const items = list.slice(0, 80).map((pr) => {
      const names = pr.romans.map((r) => theory.romanToChord(r, p.key.root, p.key.scale)?.name || r);
      return item({
        key: 'prog:' + pr.id, ic: 'layers', label: pr.name.replace(/\s*\(.*\)$/, ''), meta: pr.romans.slice(0, 4).join('–') + (pr.romans.length > 4 ? '…' : ''),
        title: `${pr.name}\n${pr.description || ''}\nIn your key: ${names.join(' – ')}\nMood: ${(pr.moods || []).join(', ')}\nDouble-click to write it into the selected chords/keys track (or a new Chords track), one chord per bar`,
        onClick: () => setInfo(pr.name, `${names.join(' – ')} — ${pr.description || ''}`, 'Double-click (or +) to insert into the selected chord track.'),
        onDblClick: () => insertProgression(pr.id),
        actionsEls: [actBtn('plus', 'Insert into selected track (or a new chords track)', () => insertProgression(pr.id))],
      });
    });
    const genreOpts = [{ value: 'project', label: `Project genre${p.genre ? ` (${GENRES[p.genre]?.name || p.genre})` : ''}` }, { value: 'all', label: 'All genres' },
      ...Object.entries(GENRES).map(([id, g]) => ({ value: id, label: g.name, group: cap(g.family) }))];
    const sel = select({ options: genreOpts, value: progGenre, title: 'Filter progressions by genre', cls: 'br-select', onChange: (v) => { progGenre = v; renderAll(); } });
    sel.addEventListener('click', (e) => e.stopPropagation());
    if (query && !items.length) return null;
    return section('progressions', 'Chord progressions', 'piano', [h('div.br-filter', sel), ...items], { count: list.length });
  }

  // ---------------------------------------------------------------- presets, FX chains & track templates
  const pstore = presetStore();
  const refDrag = (ref) => ({ [DT_PRESET_REF]: encodeRef(ref) });
  async function importPresets(files) {
    const list = files || await fileInput(PRESET_FILE_ACCEPT, true);
    if (!list?.length) return;
    const r = await importPresetFiles(list);
    toast(r.message, { level: r.ok ? 'success' : 'error' });
    openState.presets = true; lsSet(LS_OPEN, openState);
    renderAll();
  }
  function buildPresets() {
    const t = selectedTrack();
    const fxName = (type) => audio.EFFECT_DEFS?.[type]?.name || type;
    const starOf = (key) => (pstore.isFavorite(key) ? '★ ' : '');
    const favMenu = (key) => ({ label: pstore.isFavorite(key) ? 'Remove from favorites' : 'Add to favorites', onClick: () => { pstore.toggleFavorite(key); renderAll(); } });
    const userMenu = (kind, e, bankKey) => [
      { label: 'Rename…', icon: 'pencil', onClick: async () => { const n = await promptText('Rename', e.name); if (n) { pstore.rename(kind, e.id, n); renderAll(); } } },
      { label: 'Export (.daw3preset)…', icon: 'download', onClick: () => exportPresets({ [bankKey]: [e] }, e.name, true) },
      { label: 'Delete', icon: 'trash', onClick: async () => { if (await confirmDialog('Delete', `Delete “${e.name}”? This cannot be undone.`)) { pstore.remove(kind, e.id); renderAll(); } } },
    ];
    const groups = [];
    // favorites (any kind)
    const favs = pstore.favorites().map((k) => ({ k, d: describeKey(k) })).filter((x) => x.d && matches(x.d.name, x.d.kind, 'favorite'));
    groups.push(group('pr:fav', '★ Favorites', favs.map(({ k, d }) => item({
      key: 'fav:' + k, ic: d.kind === 'instrument' ? 'music' : d.kind === 'template' ? 'save' : 'sliders', label: d.name, meta: d.kind.slice(0, 5).toUpperCase(),
      title: `${d.name}\nDouble-click: apply to the selected track · drag onto a track or the device chain`, drag: refDrag(d.ref),
      onDblClick: () => dropRef(app, d.ref, { trackId: t?.id }),
      onMenu: (e) => contextMenu(e, [{ header: d.name }, favMenu(k)]),
    }))));
    // FX chains
    const chains = pstore.list('chain').filter((c) => matches(c.name, 'fx chain', c.fx.map((f) => fxName(f.type)).join(' ')));
    groups.push(group('pr:chains', 'FX chains', chains.map((c) => item({
      key: 'chain:' + c.id, ic: 'layers', label: starOf('chain:' + c.id) + c.name, meta: String(c.fx.length),
      title: `${c.fx.map((f) => fxName(f.type)).join(' → ')}\nDouble-click: append to the selected track's effects · drag onto a track or the device chain`, drag: refDrag({ kind: 'chain', id: c.id }),
      onClick: () => setInfo(c.name, c.fx.map((f) => fxName(f.type)).join(' → '), 'Double-click or drag onto a track to insert this chain.'),
      onDblClick: () => dropRef(app, { kind: 'chain', id: c.id }, { trackId: t?.id }),
      onMenu: (e) => contextMenu(e, [{ header: c.name }, { label: t ? `Insert on "${t.name}"` : 'Insert on selected track', icon: 'plus', disabled: !t, onClick: () => dropRef(app, { kind: 'chain', id: c.id }, { trackId: t.id }) }, favMenu('chain:' + c.id), '-', ...userMenu('chain', c, 'chains')]),
      actionsEls: [actBtn('plus', 'Insert on the selected track', () => dropRef(app, { kind: 'chain', id: c.id }, { trackId: t?.id }))],
    })), chains.length));
    // track templates
    const tpls = pstore.list('template').filter((x) => matches(x.name, 'track template', x.track?.instrument?.type || x.track?.type));
    groups.push(group('pr:tpl', 'Track templates', tpls.map((x) => item({
      key: 'tpl:' + x.id, ic: 'save', label: starOf('tpl:' + x.id) + x.name, meta: (x.track?.instrument?.type || x.track?.type || '').toUpperCase().slice(0, 5),
      title: `${x.name} — instrument, ${x.track.fx.length} effect(s), mixer settings${x.track.macros ? ', macros' : ''}\nDouble-click: new track from this template · drag onto the arrangement`, drag: refDrag({ kind: 'tpl', id: x.id }),
      onDblClick: () => dropRef(app, { kind: 'tpl', id: x.id }),
      onMenu: (e) => contextMenu(e, [{ header: x.name }, { label: 'New track from template', icon: 'plus', onClick: () => dropRef(app, { kind: 'tpl', id: x.id }) },
        { label: t ? `Apply to "${t.name}" (keeps its notes)` : 'Apply to selected track', disabled: !t || (t.type !== (x.track.type || 'instrument')), onClick: () => applyTemplateToTrack(app, t.id, x) }, favMenu('tpl:' + x.id), '-', ...userMenu('template', x, 'templates')]),
      actionsEls: [actBtn('plus', 'New track from this template', () => dropRef(app, { kind: 'tpl', id: x.id }))],
    })), tpls.length));
    // user presets (instruments + effects)
    const ui1 = pstore.list('instrument').filter((u) => matches(u.name, u.type, 'user preset'));
    const ue = pstore.list('effect').filter((u) => matches(u.name, fxName(u.type), (u.tags || []).join(' '), 'user preset'));
    groups.push(group('pr:user', 'User presets', [
      ...ui1.map((u) => item({
        key: 'inst:user:' + u.id, ic: 'music', label: starOf('inst:user:' + u.id) + u.name, meta: String(u.type).toUpperCase().slice(0, 5), drag: refDrag({ kind: 'inst-user', id: u.id }),
        title: `${u.name} (${u.type})\nDouble-click: load on the selected track (or a new track) · drag onto a track`,
        onDblClick: () => dropRef(app, { kind: 'inst-user', id: u.id }, { trackId: t?.id }),
        onMenu: (e) => contextMenu(e, [{ header: u.name }, favMenu('inst:user:' + u.id), '-', ...userMenu('instrument', u, 'instruments')]),
      })),
      ...ue.map((u) => item({
        key: 'fx:user:' + u.id, ic: 'sliders', label: starOf('fx:user:' + u.id) + u.name, meta: fxName(u.type).slice(0, 10), drag: refDrag({ kind: 'fx-user', id: u.id }),
        title: `${fxName(u.type)} — ${u.name}\nDouble-click: add to the selected track · drag onto a track or the device chain`,
        onDblClick: () => dropRef(app, { kind: 'fx-user', id: u.id }, { trackId: t?.id }),
        onMenu: (e) => contextMenu(e, [{ header: u.name }, favMenu('fx:user:' + u.id), '-', ...userMenu('effect', u, 'effects')]),
      })),
    ], ui1.length + ue.length));
    // factory effect presets, one group per effect
    let fxTotal = 0;
    for (const [type, def] of Object.entries(audio.EFFECT_DEFS || {})) {
      if (def.plugin) continue;
      const list = effectPresetEntries(type).filter((e) => matches(e.name, def.name, e.tags.join(' '), e.description, 'effect preset'));
      fxTotal += list.length;
      groups.push(group('pr:fx:' + type, def.name, list.map((e) => {
        const ref = { kind: 'fx', type, name: e.name };
        const key = `fx:${type}:${e.name}`;
        return item({
          key: 'fxp:' + key, ic: 'sliders', label: starOf(key) + e.name, meta: e.tags[0] || '', drag: refDrag(ref),
          title: `${def.name}: ${e.name}${e.description ? ' — ' + e.description : ''}\nTags: ${e.tags.join(', ')}\nDouble-click: add to the selected track · drag onto a track or the device chain`,
          onClick: () => setInfo(`${def.name}: ${e.name}`, e.description || def.description || '', `Tags: ${e.tags.join(', ') || '—'}. Double-click or drag onto a track.`),
          onDblClick: () => dropRef(app, ref, { trackId: t?.id }),
          onMenu: (ev) => contextMenu(ev, [{ header: `${def.name}: ${e.name}` }, { label: t ? `Add to "${t.name}"` : 'Add to selected track', icon: 'plus', disabled: !t, onClick: () => dropRef(app, ref, { trackId: t.id }) }, favMenu(key)]),
        });
      }), list.length));
    }
    const shown = groups.filter(Boolean);
    const extra = h('span.br-extra',
      actBtn('upload', 'Import presets (.daw3preset / .daw3bank)', () => importPresets()),
      actBtn('download', 'Export all user presets, FX chains and templates (.daw3bank)', () => exportPresets({ instruments: pstore.list('instrument'), effects: pstore.list('effect'), chains: pstore.list('chain'), templates: pstore.list('template') }, 'daW3 presets')),
      actBtn('save', 'Save the selected track as a template / its effects as an FX chain', (e) => contextMenu(e, [
        { header: t ? t.name : 'No track selected' },
        { label: 'Save track as template…', icon: 'save', disabled: !t, onClick: () => saveTrackTemplate(app, t.id) },
        { label: 'Save its effects as FX chain…', icon: 'layers', disabled: !t?.fx?.length, onClick: () => saveFxChain(app, t.id) },
      ])));
    return section('presets', 'Presets, chains & templates', 'sparkles', shown, { count: chains.length + tpls.length + ui1.length + ue.length + fxTotal, extra });
  }
  pstore.subscribe(() => renderAll());

  // ---------------------------------------------------------------- render
  let lastSig = '';
  function dynamicSig() {
    const p = get();
    const t = selectedTrack();
    const pats = t ? patternsForTrack(p, t.id).map((x) => `${x.id}:${x.name}:${x.notes.length}:${x.length}`).join(',') : '';
    const samples = Object.values(p.samples || {}).map((s) => `${s.id}:${s.name}:${s.duration || 0}`).join(',');
    return [t?.id, t?.type, t?.name, t?.activePatternId, t?.instrument?.type, ui.get('selectedPatternId'), pats, samples, p.genre, p.key.root, p.key.scale, p.timeSig.join('/')].join('|');
  }
  function renderAll() {
    const st = bodyEl.scrollTop;
    const sections = [buildInstruments(), buildPresets(), buildMachines(), buildKits(), buildSamples(), buildPatterns(), buildProgressions(), buildGenres(), buildExamples()].filter(Boolean);
    if (!sections.length) sections.push(h('div.br-empty.muted', { style: { padding: '16px' } }, `No results for "${query}".`));
    bodyEl.replaceChildren(...sections);
    bodyEl.scrollTop = st;
    lastSig = dynamicSig();
  }

  app.subscribe((r) => {
    if (!r.project && !('selectedTrackId' in r.ui) && !('selectedPatternId' in r.ui)) return;
    if (dynamicSig() !== lastSig) renderAll();
  });
  engine.on?.('samples', () => { if (dynamicSig() !== lastSig) renderAll(); });

  // ---------------------------------------------------------------- audio file drops
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  el.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; dropHint.classList.remove('hidden'); });
  el.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) dropHint.classList.add('hidden'); });
  el.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  el.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0; dropHint.classList.add('hidden');
    const files = [...e.dataTransfer.files];
    const audioFiles = files.filter((f) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name));
    const codeFiles = files.filter((f) => /\.(strudel|str|tidal)$/i.test(f.name));
    const presetFiles = files.filter(isPresetFile);
    if (presetFiles.length) await importPresets(presetFiles);
    if (audioFiles.length) { await actions.importSamples(audioFiles); openState.samples = true; lsSet(LS_OPEN, openState); renderAll(); }
    for (const f of codeFiles) await actions.importStrudel(f);
    if (!audioFiles.length && !codeFiles.length && !presetFiles.length) toast('Drop audio files (wav, mp3, ogg, flac…) or .strudel files', { level: 'warn' });
  });

  loadOptional().then((o) => { opt = o; renderAll(); });
  renderAll();

  return { el, focusSearch: () => search.focus(), generateSample };
}
