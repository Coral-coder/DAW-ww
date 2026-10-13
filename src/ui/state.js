// UI-only state (never saved in the project): view, selection, zoom, panels.
import { Emitter } from '../core/util.js';

const PERSIST_KEYS = ['browserOpen', 'assistantOpen', 'deviceOpen', 'deviceHeight', 'view', 'theme', 'keyboardOctave', 'autoMode'];

export class UIState extends Emitter {
  constructor() {
    super();
    this.state = {
      view: 'arrange', // 'arrange' | 'session' | 'rack' | 'piano' | 'mixer' | 'code' | 'patch'
      selectedTrackId: null,
      selectedPatternId: null,
      selectedClipIds: [],
      browserOpen: true,
      assistantOpen: true,
      deviceOpen: true,
      deviceHeight: 260,
      recording: false,
      autoArm: false, // automation recording armed (header A● / Shift+A) — never persisted
      autoMode: 'touch', // automation write mode: 'touch' | 'latch' | 'write'
      followPlayhead: true,
      keyboardOctave: 4,
      snap: 0.25, // beats (piano roll / arrangement)
      theme: 'dark',
      expertMode: false,
    };
    try {
      const saved = JSON.parse(localStorage.getItem('dawww-ui') || '{}');
      for (const k of PERSIST_KEYS) if (k in saved) this.state[k] = saved[k];
    } catch { /* storage unavailable */ }
  }

  get(k) { return k ? this.state[k] : this.state; }

  set(partial) {
    const changed = {};
    for (const [k, v] of Object.entries(partial)) {
      if (this.state[k] !== v) { this.state[k] = v; changed[k] = v; }
    }
    if (Object.keys(changed).length) {
      try {
        const out = {};
        for (const k of PERSIST_KEYS) out[k] = this.state[k];
        localStorage.setItem('dawww-ui', JSON.stringify(out));
      } catch { /* ignore */ }
      this.emit('change', changed, this.state);
    }
  }
}
