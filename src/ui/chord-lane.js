// Chord track lane for the Arrange view (between the tempo lane and the timeline, locked to its scroll).
//
//   · chord symbols over time (project.chordTrack — core/chord-track.js), labelled in the key's spelling + roman numeral
//   · click a chord: audition it · drag it: move (snapped; Ctrl/⌘ = free) · drag its right edge: resize
//   · double-click empty space: add the key's chord at that bar (pick it from the menu) · double-click a chord: type a
//     new symbol ("Am7", "F/C", "Bbmaj7")
//   · right-click: change root / quality / bass, delete, write as MIDI on the selected track, detect from MIDI, clear
//   · drop chords / progressions from the chord pads onto it
//   · header: current chord, chord pads, detect, follow mode of the selected track
import { h, startDrag, fitCanvas } from './dom.js';
import { button, contextMenu, promptText, toast, confirmDialog } from './components.js';
import { songTempoMap } from '../time/tempo-map.js';
import { CHORD_TYPES, parseChordName, chordToRoman, diatonicChords, pitchClassName, mod12 } from '../theory/index.js';
import { chordList, addChord, moveChord, removeChord, updateChord, chordAt, chordLabel, CHORD_FOLLOW_MODES } from '../core/chord-track.js';
import { auditionChord, dropOnChordTrack, dropChordsAsNotes, detectChordsFromMidi, setChordFollow, DT_CHORDS, parseChordDrag } from './chord-actions.js';

const LANE_H = 40;
const EDGE = 6;
const COMMON_TYPES = ['maj', 'min', '7', 'maj7', 'm7', 'sus2', 'sus4', 'dim', 'm7b5', 'aug', 'add9', '6', 'm6', '9', 'm9', 'dim7'];

/**
 * @param {object} app
 * @param {{ getPpb(), getHeadW(), getScroller(), snapB(beat, ev, fn?), pos(), openPads() }} view
 */
export function createChordLane(app, view) {
  const { store, ui } = app;
  const get = () => store.get();
  let pref = (() => { try { return localStorage.getItem('daw3-chord-lane'); } catch { return null; } })();
  let shown = pref === '1' || (pref == null && chordList(get()).length > 0);

  const readout = h('span.chord-lane-now', '');
  const followBtn = button('', (e) => followMenu(e), { cls: 'small chord-lane-follow', title: 'Chord follow mode of the selected track: its MIDI clips are conformed to the chord track at playback (non-destructive)' });
  const head = h('div.chord-lane-head',
    h('div.chord-lane-title', h('span', 'Chords'), readout),
    h('div.chord-lane-btns',
      button('Pads', () => view.openPads(), { cls: 'small', title: 'Chord pads: chords of the key to audition and drag onto the chord track or a MIDI clip' }),
      button('Detect', () => detect(), { cls: 'small', title: 'Detect the chord track from the MIDI clips of the arrangement' }),
      followBtn));
  const canvas = h('canvas.chord-lane-canvas');
  const el = h('div.chord-lane', { style: { height: LANE_H + 'px' } }, head, canvas);
  el.classList.toggle('hidden', !shown);

  let hover = null; // chord id
  let drag = null; // { id, mode }
  let dropAt = null; // beat while dragging pads over the lane

  const sx = () => view.getScroller()?.scrollLeft || 0;
  const ppb = () => view.getPpb();
  const localX = (e) => e.clientX - canvas.getBoundingClientRect().left;
  const beatAt = (e) => Math.max(0, (localX(e) + sx()) / ppb());
  const key = () => get().key || { root: 0, scale: 'major' };

  function pick(e) {
    const b = beatAt(e), x = localX(e);
    for (const c of chordList(get())) {
      const x0 = c.beat * ppb() - sx(), x1 = (c.beat + c.length) * ppb() - sx();
      if (x >= x0 && x < x1) return { chord: c, edge: x >= x1 - EDGE && x1 - x0 > EDGE * 2 ? 'right' : null, beat: b };
    }
    return { chord: null, edge: null, beat: b };
  }

  function draw() {
    if (!shown || !el.isConnected) return;
    el.style.setProperty('--arr-head-w', view.getHeadW() + 'px');
    const { ctx, w: W, h: H } = fitCanvas(canvas);
    const p = get();
    const cs = getComputedStyle(el);
    const v = (n, d) => cs.getPropertyValue(n).trim() || d;
    const accent = v('--accent-3', '#ff4fa3'), line = v('--line', '#2a3040'), text = v('--text', '#e6e9f2'), text3 = v('--text-3', '#6d7590');
    const font = v('--font', 'system-ui');
    ctx.fillStyle = v('--bg', '#0f1116');
    ctx.fillRect(0, 0, W, H);
    const s = sx(), k = ppb();
    const map = songTempoMap(p);
    ctx.fillStyle = line;
    let lastX = -1e9;
    for (const g of map.gridLines(Math.max(0, s / k - 1), (s + W) / k + 1, { beats: false, maxLines: 2000 })) {
      const x = Math.round(g.beat * k - s);
      if (x - lastX < 6) continue;
      lastX = x;
      ctx.fillRect(x, 0, 1, H);
    }
    const kk = key();
    ctx.textBaseline = 'middle';
    for (const c of chordList(p)) {
      const x0 = c.beat * k - s, x1 = (c.beat + c.length) * k - s;
      if (x1 < 0 || x0 > W) continue;
      const on = c.id === hover || c.id === drag?.id;
      ctx.globalAlpha = on ? 0.42 : 0.26;
      ctx.fillStyle = accent;
      roundRect(ctx, x0 + 1, 4, Math.max(2, x1 - x0 - 2), H - 8, 4);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = accent;
      ctx.lineWidth = on ? 1.5 : 1;
      roundRect(ctx, x0 + 1.5, 4.5, Math.max(2, x1 - x0 - 3), H - 9, 4);
      ctx.stroke();
      if (x1 - x0 > 16) {
        ctx.save();
        ctx.beginPath(); ctx.rect(x0 + 2, 0, x1 - x0 - 4, H); ctx.clip();
        ctx.fillStyle = text;
        ctx.font = `700 12px ${font}`;
        const label = chordLabel(c, kk);
        ctx.fillText(label, Math.max(x0, 0) + 6, H / 2 - (H > 34 ? 5 : 0));
        if (H > 34 && x1 - x0 > 40) {
          ctx.fillStyle = text3;
          ctx.font = `600 9.5px ${font}`;
          ctx.fillText(chordToRoman(c, kk.root), Math.max(x0, 0) + 6, H / 2 + 9);
        }
        ctx.restore();
      }
    }
    if (dropAt != null) { ctx.fillStyle = accent; ctx.fillRect(Math.round(dropAt * k - s), 0, 2, H); }
    const px = Math.round(view.pos() * k - s);
    if (px >= 0 && px <= W) { ctx.fillStyle = v('--accent', '#7c5cff'); ctx.fillRect(px, 0, 1, H); }
    if (!chordList(p).length && W > 200) {
      ctx.fillStyle = text3;
      ctx.font = `11px ${font}`;
      ctx.fillText('Double-click to add a chord · drag chords here from the Pads · Detect reads your MIDI clips', 8, H / 2);
    }
    updateReadout();
  }

  function updateReadout() {
    const c = chordAt(get(), Math.max(0, view.pos()));
    readout.textContent = c ? chordLabel(c, key()) : '';
    const t = get().tracks.find((x) => x.id === ui.get('selectedTrackId'));
    const mode = t?.type === 'instrument' && t.instrument?.type !== 'drums' ? (t.chordFollow || 'off') : null;
    followBtn.classList.toggle('hidden', mode == null);
    const lbl = `Follow: ${CHORD_FOLLOW_MODES.find((m) => m.value === mode)?.label || 'Off'}`;
    if (followBtn.textContent !== lbl) followBtn.replaceChildren(h('span', lbl));
    followBtn.classList.toggle('on', !!mode && mode !== 'off');
  }

  // ------------------------------------------------------------------ editing
  const tx = (label, fn) => store.transact(label, fn);
  function chooseChordMenu(e, at, { replaceId = null } = {}) {
    const kk = key();
    const dia = diatonicChords(kk.root, kk.scale, {});
    const sev = diatonicChords(kk.root, kk.scale, { sevenths: true });
    const bar = songTempoMap(get()).barAt(at);
    const len = bar.length || 4;
    const put = (c) => {
      if (replaceId) tx('Change chord', (p) => updateChord(p, replaceId, { root: c.root, type: c.type, bass: null }));
      else tx('Add chord', (p) => addChord(p, { beat: at, length: len, root: c.root, type: c.type }));
      auditionChord(app, c);
    };
    contextMenu(e, [
      { header: replaceId ? 'Change chord' : `Chord at bar ${bar.bar + 1}` },
      ...dia.map((c) => ({ label: `${chordLabel(c, kk)}   ${c.roman}`, onClick: () => put(c) })),
      { label: 'Sevenths', submenu: sev.map((c) => ({ label: `${chordLabel(c, kk)}   ${c.roman}`, onClick: () => put(c) })) },
      { label: 'Any chord', submenu: rootItems((root) => COMMON_TYPES.map((type) => ({ label: chordLabel({ root, type }, kk), onClick: () => put({ root, type }) }))) },
      '-',
      { label: 'Type a chord symbol…', icon: 'pencil', onClick: () => typeChord(at, replaceId, len) },
    ]);
  }
  function rootItems(fn) {
    const kk = key();
    return Array.from({ length: 12 }, (_, i) => mod12(kk.root + i)).map((root) => ({ label: chordLabel({ root, type: 'maj' }, kk), submenu: fn(root) }));
  }
  async function typeChord(at, replaceId, len) {
    const cur = replaceId ? chordList(get()).find((c) => c.id === replaceId) : null;
    const text = await promptText('Chord symbol (e.g. Am7, F/C, Bbmaj7, C#m7b5)', cur ? chordLabel(cur, key()) : '');
    if (text == null || !text.trim()) return;
    const c = parseChordName(text.trim());
    if (!c) { toast(`"${text}" is not a chord symbol daW³ knows`, { level: 'warn' }); return; }
    if (replaceId) tx('Change chord', (p) => updateChord(p, replaceId, { root: c.root, type: c.type, bass: c.bass ?? null }));
    else tx('Add chord', (p) => addChord(p, { beat: at, length: len, ...c }));
    auditionChord(app, c);
  }

  async function detect() {
    if (chordList(get()).length && !(await confirmDialog('Detect chord track', 'Replace the chord track with chords detected from the MIDI clips?'))) return;
    if (detectChordsFromMidi(app)) { if (!shown) toggle(true); }
  }

  function followMenu(e) {
    const t = get().tracks.find((x) => x.id === ui.get('selectedTrackId'));
    if (!t) return;
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault() {} }, [
      { header: `${t.name}: follow chord track` },
      ...CHORD_FOLLOW_MODES.map((m) => ({ label: `${(t.chordFollow || 'off') === m.value ? '● ' : ''}${m.label}`, title: m.description, onClick: () => setChordFollow(app, { trackId: t.id, mode: m.value }) })),
    ]);
  }

  // ------------------------------------------------------------------ pointer
  canvas.addEventListener('pointermove', (e) => {
    if (drag) return;
    const hit = pick(e);
    const id = hit.chord?.id || null;
    if (id !== hover) { hover = id; draw(); }
    canvas.style.cursor = hit.edge ? 'ew-resize' : hit.chord ? 'grab' : 'copy';
  });
  canvas.addEventListener('pointerleave', () => { if (hover) { hover = null; draw(); } });
  canvas.addEventListener('dblclick', (e) => {
    const hit = pick(e);
    if (hit.chord) { typeChord(hit.chord.beat, hit.chord.id, hit.chord.length); return; }
    chooseChordMenu(e, view.snapB(beatAt(e), e, Math.floor));
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const hit = pick(e);
    if (!hit.chord) return;
    e.preventDefault();
    const c0 = { ...hit.chord };
    const grab = beatAt(e) - c0.beat;
    let started = false, moved = false;
    drag = { id: c0.id, mode: hit.edge ? 'resize' : 'move' };
    const step = (fn) => { store.transact(drag.mode === 'resize' ? 'Resize chord' : 'Move chord', fn, started ? { undo: false } : {}); started = true; };
    startDrag(e, (dx, dy, ev) => {
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      if (drag.mode === 'resize') {
        const end = view.snapB(beatAt(ev), ev);
        const len = Math.max(0.25, end - c0.beat);
        step((p) => updateChord(p, c0.id, { length: len }));
      } else {
        const b = Math.max(0, view.snapB(beatAt(ev) - grab, ev));
        step((p) => moveChord(p, c0.id, b));
      }
      draw();
    }, () => {
      const d = drag;
      drag = null;
      if (!moved && d) auditionChord(app, c0);
      draw();
    });
  });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const hit = pick(e);
    const p = get();
    const kk = key();
    const items = [];
    if (hit.chord) {
      const c = hit.chord;
      items.push(
        { header: `${chordLabel(c, kk)} · ${chordToRoman(c, kk.root)}` },
        { label: 'Play', icon: 'play', onClick: () => auditionChord(app, c) },
        { label: 'Change chord', icon: 'music', onClick: () => chooseChordMenu(e, c.beat, { replaceId: c.id }) },
        { label: 'Quality', submenu: COMMON_TYPES.map((type) => ({ label: `${type === c.type ? '● ' : ''}${CHORD_TYPES[type].name}`, onClick: () => tx('Chord quality', (pp) => updateChord(pp, c.id, { type })) })) },
        { label: 'Bass note', submenu: [
          { label: 'Root (no slash)', onClick: () => tx('Chord bass', (pp) => updateChord(pp, c.id, { bass: null })) },
          ...Array.from({ length: 12 }, (_, i) => mod12(c.root + i)).slice(1).map((pc) => ({ label: `/${pitchClassName(pc, 'common')}${c.bass === pc ? '  ●' : ''}`, onClick: () => tx('Chord bass', (pp) => updateChord(pp, c.id, { bass: pc })) })),
        ] },
        { label: 'Type a chord symbol…', icon: 'pencil', onClick: () => typeChord(c.beat, c.id, c.length) },
        { label: 'Write as notes on the selected track', icon: 'piano', onClick: () => writeAsNotes([c], c.beat) },
        { label: 'Delete chord', icon: 'trash', onClick: () => tx('Delete chord', (pp) => removeChord(pp, c.id)) },
        '-',
      );
    } else {
      items.push({ label: 'Add chord here…', icon: 'plus', onClick: () => chooseChordMenu(e, view.snapB(beatAt(e), e, Math.floor)) });
    }
    const list = chordList(p);
    items.push(
      { label: 'Chord pads…', icon: 'grid', onClick: () => view.openPads() },
      { label: 'Detect chords from MIDI clips', icon: 'wand', onClick: () => detect() },
      list.length ? { label: 'Write the whole chord track as notes on the selected track', icon: 'piano', onClick: () => writeAsNotes(list, list[0].beat) } : null,
      list.length ? { label: 'Clear chord track', icon: 'trash', onClick: async () => { if (await confirmDialog('Clear chord track', 'Remove every chord from the chord track?')) tx('Clear chord track', (pp) => { pp.chordTrack = { chords: [] }; }); } } : null,
    );
    contextMenu(e, items.filter(Boolean));
  });

  function writeAsNotes(chords, at) {
    const t = get().tracks.find((x) => x.id === ui.get('selectedTrackId'));
    const payload = { chords: chords.map((c) => ({ root: c.root, type: c.type, ...(c.bass != null ? { bass: c.bass } : {}), beat: c.beat - at, length: c.length })), voicing: 'close', inversion: 0, voiceLeading: true, octave: 4 };
    dropChordsAsNotes(app, payload, { track: t, beat: at });
  }

  // ------------------------------------------------------------------ drop (chord pads)
  const accepts = (e) => [...(e.dataTransfer?.types || [])].includes(DT_CHORDS);
  canvas.addEventListener('dragover', (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dropAt = view.snapB(beatAt(e), e, Math.floor);
    draw();
  });
  canvas.addEventListener('dragleave', () => { dropAt = null; draw(); });
  canvas.addEventListener('drop', (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    dropAt = null;
    const payload = parseChordDrag(e.dataTransfer.getData(DT_CHORDS));
    if (payload) dropOnChordTrack(app, payload, view.snapB(beatAt(e), e, Math.floor));
    draw();
  });

  const sc = () => view.getScroller();
  let hooked = null;
  function hook() {
    const s = sc();
    if (s && s !== hooked) { hooked = s; s.addEventListener('scroll', () => draw(), { passive: true }); }
  }
  function toggle(v = !shown) {
    shown = v;
    api.onToggle?.(v);
    try { localStorage.setItem('daw3-chord-lane', v ? '1' : '0'); } catch { /* */ }
    el.classList.toggle('hidden', !shown);
    draw();
  }

  const api = {
    el,
    onToggle: null,
    get shown() { return shown; },
    toggle,
    draw() { hook(); draw(); },
    tick() { if (shown) { if (app.engine?.isPlaying) draw(); else updateReadout(); } },
  };
  return api;
}

function roundRect(ctx, x, y, w, hh, r) {
  r = Math.min(r, w / 2, hh / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + hh, r);
  ctx.arcTo(x + w, y + hh, x, y + hh, r);
  ctx.arcTo(x, y + hh, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
