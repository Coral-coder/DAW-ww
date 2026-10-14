// Engine health metrics for the status bar: DSP load, audio dropouts (xruns), scheduler lateness, latency.
//
//   const m = new EngineMonitor(engine); m.start();  m.read() -> {
//     load: 0..1 | null      average render load (AudioContext.renderCapacity where the browser has it, else null)
//     peakLoad: 0..1 | null
//     xruns: number          audio dropouts since start (AudioContext.playoutStats.underrunEvents when available,
//                            else detected from the audio clock falling behind the wall clock)
//     late: number           scheduler windows that had to skip ahead (main thread blocked) since start
//     lateEvents: number     events dispatched after their time
//     lateMs: number         worst scheduler lateness (ms) over the last ~2 s
//     latencyMs: number      device latency (baseLatency + outputLatency)
//     pdcMs: number          plugin delay compensation (whole-mix pre-roll)
//     sampleRate, state
//   }
// Everything is read lazily from browser APIs, so this module imports fine under Node.
export class EngineMonitor {
  constructor(engine, { interval = 500 } = {}) {
    this.engine = engine;
    this.interval = interval;
    this.timer = null;
    this.reset();
  }

  reset() {
    this.xruns = 0;
    this.load = null;
    this.peakLoad = null;
    this._last = null;
    this._lateHist = [];
    this._ctx = null;
    this._baseUnderruns = null;
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => this.poll(), this.interval);
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this._rc?.stop?.(); } catch { /* */ }
  }

  _attach(ctx) {
    if (this._ctx === ctx) return;
    this._ctx = ctx;
    this._last = null;
    this._baseUnderruns = null;
    this.load = null;
    // Chrome's experimental AudioContext.renderCapacity: periodic {averageLoad, peakLoad, underrunRatio}
    const rc = ctx?.renderCapacity;
    if (rc && typeof rc.start === 'function') {
      try {
        this._rc = rc;
        rc.addEventListener?.('update', (e) => { this.load = e.averageLoad ?? null; this.peakLoad = e.peakLoad ?? null; });
        rc.start({ updateInterval: 1 });
      } catch { /* */ }
    }
  }

  poll() {
    const e = this.engine;
    const ctx = e.ctx;
    if (!ctx) return;
    this._attach(ctx);
    // dropouts: playoutStats when the browser has it, else audio-clock vs wall-clock drift
    const ps = ctx.playoutStats;
    if (ps && Number.isFinite(ps.underrunEvents)) {
      if (this._baseUnderruns == null) this._baseUnderruns = ps.underrunEvents;
      this.xruns = ps.underrunEvents - this._baseUnderruns;
    } else if (ctx.state === 'running' && typeof ctx.getOutputTimestamp === 'function') {
      const ts = ctx.getOutputTimestamp();
      if (ts && ts.performanceTime > 0) {
        const last = this._last;
        if (last) {
          const dWall = (ts.performanceTime - last.performanceTime) / 1000;
          const dAudio = ts.contextTime - last.contextTime;
          // the audio clock lost more than ~2 render quanta + 15 ms against the wall clock: a dropout
          if (dWall > 0.1 && dWall < 5 && dWall - dAudio > 0.015 + 256 / ctx.sampleRate) this.xruns++;
        }
        this._last = { performanceTime: ts.performanceTime, contextTime: ts.contextTime };
      }
    } else {
      this._last = null;
    }
    const s = e.scheduler;
    this._lateHist.push(s?.playing ? (s.lateness || 0) : 0);
    if (this._lateHist.length > Math.max(1, Math.round(2000 / this.interval))) this._lateHist.shift();
  }

  read() {
    const e = this.engine;
    const ctx = e.ctx;
    const s = e.scheduler;
    return {
      load: this.load,
      peakLoad: this.peakLoad,
      xruns: this.xruns,
      late: s?.dropouts || 0,
      lateEvents: s?.lateEvents || 0,
      lateMs: Math.max(0, ...this._lateHist) * 1000,
      latencyMs: ctx ? ((Number(ctx.baseLatency) || 0) + (Number(ctx.outputLatency) || 0)) * 1000 : 0,
      pdcMs: (e.graph?.latency || 0) * 1000,
      sampleRate: ctx?.sampleRate || null,
      state: ctx?.state || 'closed',
    };
  }
}
