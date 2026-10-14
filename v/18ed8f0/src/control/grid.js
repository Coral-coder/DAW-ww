// Pad-grid clip launching (Node-safe): Novation Launchpad / Akai APC mini / APC40 / Push-style 8×8 grids
// mapped onto the Scenes view (tracks × scenes) or the Setlist view (layers × actions). LED colours are sent
// as note velocities (each layout has its own palette).
//
// host (Scenes): tracks() -> [{ id, activePatternId }], scenes() -> [{ id, slots:{trackId: patternId} }],
//                launchSlot(trackId, patternId), launchScene(sceneId), stopTrack(trackId), playing()
// host (Setlist): layers() -> [{ id, mute, solo, locked }], layerAction(id, 'mute'|'solo'|'regenerate'|'next'|'lock'),
//                sections() -> [{ id, label, current, queued }], queueSection(id), active()
export const GRID_LAYOUTS = {
  launchpad: {
    label: 'Novation Launchpad (programmer mode)',
    padNote: (r, c) => (8 - r) * 10 + c + 1,
    padOf: (n) => { const row = Math.floor(n / 10), col = (n % 10) - 1; return row >= 1 && row <= 8 && col >= 0 && col <= 7 ? { r: 8 - row, c: col } : null; },
    sceneOf: (n) => (n % 10 === 9 && n >= 19 && n <= 89 ? 8 - Math.floor(n / 10) : null), // right column (note or CC)
    sceneMsg: (r, v) => [0xb0, (8 - r) * 10 + 9, v],
    navOf: (cc) => ({ 91: 'up', 92: 'down', 93: 'left', 94: 'right' })[cc] || null,
    colors: { off: 0, has: 45, playing: 21, stop: 5, scene: 13, mute: 9, solo: 13, action: 3, current: 21, queued: 37 },
  },
  'apc-mini': {
    label: 'Akai APC mini',
    padNote: (r, c) => (7 - r) * 8 + c,
    padOf: (n) => (n >= 0 && n < 64 ? { r: 7 - Math.floor(n / 8), c: n % 8 } : null),
    sceneOf: (n) => (n >= 82 && n <= 89 ? n - 82 : null),
    sceneMsg: (r, v) => [0x90, 82 + r, v ? 1 : 0],
    navOf: (n) => ({ 64: 'up', 65: 'down', 66: 'left', 67: 'right' })[n] || null,
    navIsNote: true,
    colors: { off: 0, has: 5, playing: 1, stop: 3, scene: 1, mute: 3, solo: 5, action: 5, current: 1, queued: 2 },
  },
  push: {
    label: 'Ableton Push (user mode) / generic 36-99 grid',
    padNote: (r, c) => 36 + (7 - r) * 8 + c,
    padOf: (n) => (n >= 36 && n < 100 ? { r: 7 - Math.floor((n - 36) / 8), c: (n - 36) % 8 } : null),
    sceneOf: (n) => (n >= 36 && n <= 43 ? 43 - n : null), // CC 43 (top) … 36
    sceneIsCc: true,
    sceneMsg: (r, v) => [0xb0, 43 - r, v],
    navOf: (cc) => ({ 46: 'up', 47: 'down', 44: 'left', 45: 'right' })[cc] || null,
    colors: { off: 0, has: 45, playing: 126, stop: 127, scene: 122, mute: 9, solo: 13, action: 122, current: 126, queued: 37 },
  },
};

const SETLIST_ROWS = ['mute', 'solo', 'regenerate', 'next', 'lock'];

export class GridController {
  constructor({ layout = 'launchpad', send, host, mode = 'session' } = {}) {
    this.layoutId = GRID_LAYOUTS[layout] ? layout : 'launchpad';
    this.L = GRID_LAYOUTS[this.layoutId];
    this.send = send || (() => {});
    this.host = host;
    this.mode = mode;
    this.trackOffset = 0;
    this.sceneOffset = 0;
    this.cache = new Map();
  }

  setMode(mode) { if (mode !== this.mode) { this.mode = mode; this.cache.clear(); this.refresh(); } }

  handle(data) {
    const st = data[0] & 0xf0, n = data[1], v = data[2];
    const press = (st === 0x90 && v > 0) || (st === 0xb0 && v > 0);
    if (!press) return false;
    const L = this.L;
    const isNote = st === 0x90, isCc = st === 0xb0;
    if (L.navIsNote ? isNote : isCc) { const nav = L.navOf(n); if (nav) { this._nav(nav); return true; } }
    if (L.sceneIsCc ? isCc : this.layoutId === 'launchpad' || isNote) {
      const scene = L.sceneOf(n);
      if (scene != null) { this._scene(scene); return true; }
    }
    if (isNote) {
      const pad = L.padOf(n);
      if (pad) { this._pad(pad.r, pad.c); return true; }
    }
    return false;
  }

  _nav(dir) {
    if (dir === 'up') this.sceneOffset = Math.max(0, this.sceneOffset - 1);
    if (dir === 'down') this.sceneOffset++;
    if (dir === 'left') this.trackOffset = Math.max(0, this.trackOffset - 1);
    if (dir === 'right') this.trackOffset++;
    this.refresh();
  }

  _pad(r, c) {
    if (this.mode === 'setlist') {
      const layer = this.host.layers?.()[this.trackOffset + c];
      if (r < SETLIST_ROWS.length && layer) this.host.layerAction?.(layer.id, SETLIST_ROWS[r]);
      else if (r === 7) { const sec = this.host.sections?.()[c]; if (sec) this.host.queueSection?.(sec.id); }
      this.refresh();
      return;
    }
    const t = this.host.tracks()[this.trackOffset + c];
    const sc = this.host.scenes()[this.sceneOffset + r];
    if (!t) return;
    const pid = sc?.slots?.[t.id];
    if (pid) this.host.launchSlot(t.id, pid);
    else this.host.stopTrack(t.id);
    this.refresh();
  }

  _scene(r) {
    if (this.mode === 'setlist') { const sec = this.host.sections?.()[r]; if (sec) this.host.queueSection?.(sec.id); this.refresh(); return; }
    const sc = this.host.scenes()[this.sceneOffset + r];
    if (sc) this.host.launchScene(sc.id);
    this.refresh();
  }

  /** Colour (velocity) of every pad: [{ r, c, color }]. */
  padColors() {
    const C = this.L.colors;
    const out = [];
    if (this.mode === 'setlist') {
      const layers = this.host.layers?.() || [];
      const secs = this.host.sections?.() || [];
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        let color = C.off;
        const l = layers[this.trackOffset + c];
        if (r < SETLIST_ROWS.length && l) {
          const row = SETLIST_ROWS[r];
          color = row === 'mute' ? (l.mute ? C.off : C.mute) : row === 'solo' ? (l.solo ? C.solo : C.off) : row === 'lock' ? (l.locked ? C.stop : C.off) : C.action;
        } else if (r === 7 && secs[c]) color = secs[c].current ? C.current : secs[c].queued ? C.queued : C.has;
        out.push({ r, c, color });
      }
      return out;
    }
    const tracks = this.host.tracks();
    const scenes = this.host.scenes();
    const playing = this.host.playing?.() ?? true;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const t = tracks[this.trackOffset + c], sc = scenes[this.sceneOffset + r];
      const pid = t && sc?.slots?.[t.id];
      out.push({ r, c, color: !pid ? C.off : pid === t.activePatternId && playing ? C.playing : C.has });
    }
    return out;
  }

  refresh() {
    const L = this.L;
    for (const { r, c, color } of this.padColors()) this._out(`p${r}:${c}`, [0x90, L.padNote(r, c), color]);
    const n = this.mode === 'setlist' ? (this.host.sections?.() || []).length : this.host.scenes().length - this.sceneOffset;
    for (let r = 0; r < 8; r++) this._out(`s${r}`, L.sceneMsg(r, r < n ? L.colors.scene : L.colors.off));
  }

  _out(key, msg) {
    const ser = msg.join(',');
    if (this.cache.get(key) === ser) return;
    this.cache.set(key, ser);
    this.send([msg]);
  }
}
