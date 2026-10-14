// Live cursors, selection highlights and "follow" for collaborators, drawn as a fixed DOM layer
// above the arrange / piano-roll views (positions from view.collabGeom()). Also captures this
// user's own pointer / selection / scroll and publishes it as presence.
import { h } from '../ui/dom.js';

const CURSOR_SVG = (color) => `<svg width="16" height="18" viewBox="0 0 16 18"><path d="M1 1l13 7-6 1.6L5 16z" fill="${color}" stroke="#000" stroke-opacity=".5" stroke-width="1"/></svg>`;

export function installOverlay(app, session) {
  const { ui, store } = app;
  const layer = h('div.collab-overlay');
  document.body.appendChild(layer);
  const els = new Map(); // peerId -> { cursor, label, sels: [] }
  let raf = 0;
  const lockEls = [];
  let following = null;
  const attached = new WeakSet();

  const geom = () => {
    const v = app.views[ui.get('view')];
    try { return v?.collabGeom ? v.collabGeom() : null; } catch { return null; }
  };

  // ---------------------------------------------------------------- own presence
  function hookView() {
    const g = geom();
    if (!g || attached.has(g.scroller)) return;
    attached.add(g.scroller);
    const sc = g.scroller;
    sc.addEventListener('pointermove', (e) => {
      if (!session.active) return;
      const gg = geom();
      if (!gg || gg.scroller !== sc) return;
      const r = sc.getBoundingClientRect();
      const x = e.clientX - r.left + sc.scrollLeft, y = e.clientY - r.top + sc.scrollTop;
      const beat = Math.max(0, x / gg.ppb);
      const cursor = gg.kind === 'arrange' ? { beat, trackId: gg.trackAt(y), dy: 0.5 } : { beat, pitch: gg.pitchAt(y) };
      session.setPresence({ view: gg.kind, cursor, patternId: gg.patternId || ui.get('selectedPatternId') || null });
    });
    sc.addEventListener('pointerleave', () => { if (session.active) session.setPresence({ cursor: null }); });
    sc.addEventListener('pointerdown', () => { if (following) { following = null; session.emit('follow', null); app.toast('Stopped following'); } });
    sc.addEventListener('scroll', () => publishScroll(), { passive: true });
  }

  function publishScroll() {
    if (!session.active) return;
    const g = geom();
    if (!g) return;
    const sc = g.scroller;
    const scroll = { beat: sc.scrollLeft / g.ppb };
    if (g.kind === 'arrange') scroll.trackId = g.trackAt(sc.scrollTop + 1);
    else scroll.pitch = g.pitchAt(sc.scrollTop + sc.clientHeight / 2);
    session.setPresence({ scroll });
  }

  function publishSelection() {
    if (!session.active) return;
    const g = geom();
    session.setPresence({
      view: ui.get('view'),
      trackId: ui.get('selectedTrackId') || null,
      patternId: ui.get('selectedPatternId') || null,
      clipIds: (ui.get('selectedClipIds') || []).slice(0, 200),
      noteIds: g?.kind === 'piano' ? g.selected().slice(0, 400) : [],
    });
  }

  ui.on('change', (changed) => {
    if ('view' in changed) { setTimeout(hookView, 300); publishScroll(); }
    if ('view' in changed || 'selectedTrackId' in changed || 'selectedPatternId' in changed || 'selectedClipIds' in changed) publishSelection();
  });
  let lastSel = '';
  const poll = setInterval(() => {
    if (!session.active) return;
    hookView();
    const g = geom();
    if (g?.kind === 'piano') { const k = g.selected().join(','); if (k !== lastSel) { lastSel = k; publishSelection(); } }
  }, 400);

  // ---------------------------------------------------------------- follow
  function applyFollow() {
    if (!following) return;
    const p = session.peers.get(following);
    if (!p) { following = null; session.emit('follow', null); return; }
    const pr = p.presence || {};
    const patch = {};
    if (pr.view && pr.view !== ui.get('view') && app.views) patch.view = pr.view;
    if (pr.trackId && pr.trackId !== ui.get('selectedTrackId')) patch.selectedTrackId = pr.trackId;
    if (pr.patternId && pr.patternId !== ui.get('selectedPatternId') && store.get().patterns[pr.patternId]) patch.selectedPatternId = pr.patternId;
    if (Object.keys(patch).length) ui.set(patch);
    const g = geom();
    if (g && pr.scroll) {
      g.scroller.scrollLeft = Math.max(0, pr.scroll.beat * g.ppb);
      if (g.kind === 'arrange' && pr.scroll.trackId) { const r = g.rowOf(pr.scroll.trackId); if (r) g.scroller.scrollTop = r.y; }
      if (g.kind === 'piano' && pr.scroll.pitch != null) { const i = g.rowOfPitch(pr.scroll.pitch); if (i >= 0) g.scroller.scrollTop = Math.max(0, i * g.rowH - g.scroller.clientHeight / 2); }
    }
  }
  session.on('presence', (id) => { if (id === following) applyFollow(); schedule(); });

  // ---------------------------------------------------------------- drawing
  function schedule() { if (!raf) raf = requestAnimationFrame(draw); }
  function elFor(p) {
    let e = els.get(p.id);
    if (!e) {
      const cursor = h('div.collab-cursor');
      const label = h('div.collab-cursor-label');
      cursor.appendChild(label);
      layer.appendChild(cursor);
      e = { cursor, label, sels: [] };
      els.set(p.id, e);
    }
    if (e.color !== p.color) { e.color = p.color; e.cursor.insertAdjacentHTML('afterbegin', ''); e.cursor.querySelector('svg')?.remove(); e.cursor.insertAdjacentHTML('afterbegin', CURSOR_SVG(p.color)); e.label.style.background = p.color; }
    e.label.textContent = p.name;
    return e;
  }
  function sels(e, n) {
    while (e.sels.length < n) { const s = h('div.collab-sel'); layer.appendChild(s); e.sels.push(s); }
    for (let i = n; i < e.sels.length; i++) e.sels[i].style.display = 'none';
    return e.sels;
  }

  function draw() {
    raf = 0;
    const g = session.active ? geom() : null;
    const live = new Set();
    if (g) {
      const r = g.scroller.getBoundingClientRect();
      const sx = g.scroller.scrollLeft, sy = g.scroller.scrollTop;
      const inside = (x, y) => x >= r.left - 2 && x <= r.right && y >= r.top - 2 && y <= r.bottom;
      const project = store.get();
      for (const p of session.peers.values()) {
        const pr = p.presence || {};
        if (pr.view !== g.kind && pr.view !== ui.get('view')) continue;
        const e = elFor(p);
        live.add(p.id);
        // cursor
        let cx = null, cy = null;
        const c = pr.cursor;
        if (c && pr.view === g.kind) {
          if (g.kind === 'arrange' && c.trackId) { const row = g.rowOf(c.trackId); if (row) { cx = r.left + c.beat * g.ppb - sx; cy = r.top + row.y + row.h * (c.dy ?? 0.5) - sy; } }
          if (g.kind === 'piano' && pr.patternId === g.patternId && c.pitch != null) { const i = g.rowOfPitch(c.pitch); if (i >= 0) { cx = r.left + c.beat * g.ppb - sx; cy = r.top + (i + 0.5) * g.rowH - sy; } }
        }
        const show = cx != null && inside(cx, cy);
        e.cursor.style.display = show ? '' : 'none';
        if (show) e.cursor.style.transform = `translate(${Math.round(cx)}px, ${Math.round(cy)}px)`;
        // selection outlines
        const rects = [];
        if (g.kind === 'arrange' && pr.view === 'arrange') {
          for (const id of pr.clipIds || []) {
            const clip = project.clips.find((x) => x.id === id);
            const row = clip && g.rowOf(clip.trackId);
            if (row) rects.push([clip.start * g.ppb - sx, row.y - sy, clip.length * g.ppb, row.h]);
          }
          if (pr.trackId && !(pr.clipIds || []).length) { const row = g.rowOf(pr.trackId); if (row) rects.push([-2, row.y - sy, r.width + 4, row.h, 'track']); }
        } else if (g.kind === 'piano' && pr.view === 'piano' && pr.patternId === g.patternId) {
          const pat = project.patterns[g.patternId];
          const ids = new Set(pr.noteIds || []);
          for (const n of pat?.notes || []) {
            if (!ids.has(n.id)) continue;
            const i = g.rowOfPitch(n.pitch);
            if (i >= 0) rects.push([n.start * g.ppb - sx, i * g.rowH - sy, n.dur * g.ppb, g.rowH]);
          }
        }
        const boxes = sels(e, rects.length);
        rects.forEach(([x, y, w, hh, kind], i) => {
          const b = boxes[i];
          const x0 = Math.max(r.left, r.left + x), y0 = Math.max(r.top, r.top + y);
          const x1 = Math.min(r.right, r.left + x + w), y1 = Math.min(r.bottom, r.top + y + hh);
          if (x1 <= x0 || y1 <= y0) { b.style.display = 'none'; return; }
          b.style.display = '';
          b.className = kind === 'track' ? 'collab-sel track' : 'collab-sel';
          b.style.borderColor = p.color;
          b.style.left = x0 + 'px'; b.style.top = y0 + 'px'; b.style.width = (x1 - x0) + 'px'; b.style.height = (y1 - y0) + 'px';
        });
      }
    }
    // soft-lock badges ("✎ Alex") on arrange rows someone else is editing
    const locks = g && g.kind === 'arrange' ? session.locks() : [];
    while (lockEls.length < locks.length) { const b = h('div.collab-lock'); layer.appendChild(b); lockEls.push(b); }
    lockEls.forEach((b, i) => {
      const l = locks[i];
      const row = l && g.rowOf(l.trackId);
      const r = g?.scroller.getBoundingClientRect();
      const y = row ? r.top + row.y - g.scroller.scrollTop + 2 : -1;
      if (!row || y < r.top || y > r.bottom - 10) { b.style.display = 'none'; return; }
      const before = locks.slice(0, i).filter((x) => x.trackId === l.trackId).length;
      b.style.display = '';
      b.textContent = `✎ ${l.peer.name}`;
      b.style.background = l.peer.color;
      b.style.left = (r.right - 90 - before * 80) + 'px';
      b.style.top = y + 'px';
    });
    for (const [id, e] of els) if (!live.has(id)) { e.cursor.remove(); e.sels.forEach((s) => s.remove()); els.delete(id); }
    if (session.active && session.peers.size) schedule(); // keep tracking scroll / zoom
  }

  session.on('peers', schedule);
  session.on('status', () => { publishSelection(); publishScroll(); schedule(); });
  store.on('change', schedule);

  return {
    follow(peerId) { following = peerId; session.emit('follow', peerId); applyFollow(); },
    following: () => following,
    destroy() { clearInterval(poll); layer.remove(); },
  };
}
