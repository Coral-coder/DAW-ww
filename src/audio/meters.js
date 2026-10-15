// Master analysis for the Loudness panel (browser): BS.1770 loudness (momentary / short-term / integrated / LRA),
// true peak, phase correlation, stereo vector scope and pre / post master spectrum.
//
// Loudness runs in an AudioWorklet ('daw3-loudness': K-weighting + 100 ms energy blocks + 4x true peak + correlation
// sums, posted 10x per second) feeding dsp/loudness.js LoudnessMeter on the main thread. Without AudioWorklet it falls
// back to native biquads (K-weighting approximation) + an AnalyserNode polled every 100 ms. The scope / correlation /
// spectrum use AnalyserNodes only (cheap; read when the panel draws). Created lazily (MixGraph.masterAnalysis()).
//
// The same class meters any channel strip (analysis-hub.js): opts.truePeak = false skips the 4x true-peak interpolator
// (a sample peak stands in) and opts.views = false skips the scope / spectrum analysers (strip LUFS readouts).
// Statistics on top of the meter (dsp/loudness-stats.js): short-term histogram, PSR over the last 3 s, DR.
import { LoudnessMeter, kWeighting, correlation } from './dsp/loudness.js';
import { LoudnessHistogram, PeakWindow, DynamicRange, plr, psr } from './dsp/loudness-stats.js';

const WORKLET_URL = new URL('./loudness-worklet.js', import.meta.url).href;

const workletLoaded = new WeakMap();

export class MasterAnalysis {
  /** pre: master input (pre master fx), post: master output (post fader). */
  constructor(ctx, pre, post, { truePeak = true, views = true } = {}) {
    this.ctx = ctx;
    this.meter = new LoudnessMeter();
    this.hist = new LoudnessHistogram();
    this.tpWin = new PeakWindow(30);
    this.drm = new DynamicRange();
    this.opts = { truePeak, views };
    this.corr = 0;
    this.mode = 'pending';
    this.post = post;
    if (!views) { this._start().catch(() => { this.mode = 'unavailable'; }); return; }
    const an = (size = 2048) => { const a = ctx.createAnalyser(); a.fftSize = size; a.smoothingTimeConstant = 0.75; return a; };
    this.preAn = an(4096);
    this.postAn = an(4096);
    this.pre = pre;
    pre.connect(this.preAn);
    post.connect(this.postAn);
    this.split = ctx.createChannelSplitter(2);
    this.scopeL = an(2048);
    this.scopeR = an(2048);
    post.connect(this.split);
    this.split.connect(this.scopeL, 0);
    this.split.connect(this.scopeR, 1);
    this._l = new Float32Array(2048);
    this._r = new Float32Array(2048);
    this._start().catch(() => { this.mode = 'unavailable'; });
  }

  async _start() {
    const ctx = this.ctx;
    const coeffs = kWeighting(ctx.sampleRate);
    try {
      if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') throw new Error('no worklet');
      if (!workletLoaded.has(ctx)) {
        workletLoaded.set(ctx, ctx.audioWorklet.addModule(WORKLET_URL));
      }
      // some environments never settle addModule (no audio thread): fall back after 3 s
      await Promise.race([workletLoaded.get(ctx), new Promise((_, rej) => setTimeout(() => rej(new Error('worklet timeout')), 3000))]);
      if (this.disposed) return;
      this.node = new AudioWorkletNode(ctx, 'daw3-loudness', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit', processorOptions: { coeffs, truePeak: this.opts.truePeak } });
      this.node.port.onmessage = (e) => this._block(e.data);
      this.post.connect(this.node);
      this.mode = 'worklet';
    } catch {
      if (this.disposed) return;
      if (!this.opts.views) { this.mode = 'unavailable'; return; }
      // fallback: native K-weighting approximation + polled analyser (energy of the last ~85 ms every 100 ms)
      const shelf = ctx.createBiquadFilter(); shelf.type = 'highshelf'; shelf.frequency.value = 1500; shelf.gain.value = 4;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 38; hp.Q.value = 0.5;
      const sp = ctx.createChannelSplitter(2);
      this.fbL = ctx.createAnalyser(); this.fbR = ctx.createAnalyser();
      this.fbL.fftSize = this.fbR.fftSize = 4096;
      this.post.connect(shelf); shelf.connect(hp); hp.connect(sp); sp.connect(this.fbL, 0); sp.connect(this.fbR, 1);
      this.fbNodes = [shelf, hp, sp];
      const bl = new Float32Array(4096), br = new Float32Array(4096);
      this.timer = setInterval(() => {
        this.fbL.getFloatTimeDomainData(bl); this.fbR.getFloatTimeDomainData(br);
        let el = 0, er = 0;
        for (let i = 0; i < bl.length; i++) { el += bl[i] * bl[i]; er += br[i] * br[i]; }
        // (sample peak of the scope taps stands in for the true peak in this mode)
        this.scopeL.getFloatTimeDomainData(this._l); this.scopeR.getFloatTimeDomainData(this._r);
        let pk = 0;
        for (let i = 0; i < this._l.length; i++) pk = Math.max(pk, Math.abs(this._l[i]), Math.abs(this._r[i]));
        this._block({ e: (el + er) / bl.length, tp: pk });
      }, 100);
      this.mode = 'analyser';
    }
  }

  _block(d) {
    if (this.paused) return;
    this.meter.push(d.e, d.tp);
    this.tpWin.push(d.tp);
    const st = this.meter.shortTerm;
    if (this.meter.sub.length >= 30 && st > -70) this.hist.add(st); // gated short-term values, once a full 3 s window exists
    if (d.ss) this.drm.push(d);
    if (d.ll != null) {
      const den = Math.sqrt(d.ll * d.rr);
      const c = den > 1e-9 ? d.lr / den : 0;
      this.corr = this.corr * 0.7 + c * 0.3;
    }
  }

  /** {momentary, shortTerm, integrated, lra, truePeakDb, maxMomentary, maxShort, correlation, mode}. */
  read() {
    const m = this.meter;
    let corr = this.corr;
    if (this.mode !== 'worklet' && this.opts.views) {
      this.scopeL.getFloatTimeDomainData(this._l); this.scopeR.getFloatTimeDomainData(this._r);
      corr = this.corr = this.corr * 0.7 + correlation(this._l, this._r) * 0.3;
    }
    const integrated = m.integrated, shortTerm = m.shortTerm;
    return {
      momentary: m.momentary, shortTerm, integrated, lra: m.lra, truePeakDb: m.truePeakDb, maxMomentary: m.maxMomentary, maxShort: m.maxShort, correlation: corr, mode: this.mode,
      plr: plr(m.truePeakDb, integrated), psr: psr(this.tpWin.maxDb, shortTerm), dr: this.drm.value, histogram: this.hist, paused: !!this.paused, truePeak: this.opts.truePeak,
    };
  }

  /** Stop / resume accumulating (the readouts freeze). */
  setPaused(on) { this.paused = !!on; }

  /** Time-domain blocks for the vector scope. */
  scope() {
    this.scopeL.getFloatTimeDomainData(this._l);
    this.scopeR.getFloatTimeDomainData(this._r);
    return { l: this._l, r: this._r };
  }

  /** Spectrum analyser of the master input ('pre') or output ('post'). */
  analyser(which = 'post') { return which === 'pre' ? this.preAn : this.postAn; }

  reset() { this.meter.reset(); this.hist.reset(); this.tpWin.reset(); this.drm.reset(); this.node?.port.postMessage('reset'); }

  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    for (const n of [this.preAn, this.postAn, this.split, this.scopeL, this.scopeR, this.node, this.fbL, this.fbR, ...(this.fbNodes || [])]) { try { n?.disconnect(); } catch { /* */ } }
    for (const n of [this.split, this.node, this.postAn, this.fbNodes?.[0]]) { try { if (n) this.post.disconnect(n); } catch { /* */ } }
    try { if (this.preAn) this.pre.disconnect(this.preAn); } catch { /* */ }
  }
}
