// Live utility meters of one tap (the master output): bit meter, DC offset, clip counter. Runs the 'daw3-utility'
// AudioWorklet (utility-worklet.js); without AudioWorklet it polls an analyser every 100 ms (approximate: the samples
// between polls are not seen). Statistics and their interpretation: dsp/utility-meters.js.
import { UtilityStats, ClipCounter, bitMask, dcOffset } from './dsp/utility-meters.js';

const WORKLET_URL = new URL('./utility-worklet.js', import.meta.url).href;
const loaded = new WeakMap();

export class UtilityMeter {
  constructor(ctx, tap) {
    this.ctx = ctx;
    this.tap = tap;
    this.stats = new UtilityStats();
    this.mode = 'pending';
    this.paused = false;
    this._start();
  }

  async _start() {
    const ctx = this.ctx;
    try {
      if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') throw new Error('no worklet');
      if (!loaded.has(ctx)) loaded.set(ctx, ctx.audioWorklet.addModule(WORKLET_URL));
      await Promise.race([loaded.get(ctx), new Promise((_, rej) => setTimeout(() => rej(new Error('worklet timeout')), 3000))]);
      if (this.disposed) return;
      this.node = new AudioWorkletNode(ctx, 'daw3-utility', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
      this.node.port.onmessage = (e) => { if (!this.paused) this.stats.push(e.data); };
      this.tap.connect(this.node);
      this.mode = 'worklet';
    } catch {
      if (this.disposed) return;
      const sp = ctx.createChannelSplitter(2);
      const aL = ctx.createAnalyser(), aR = ctx.createAnalyser();
      aL.fftSize = aR.fftSize = 4096;
      this.tap.connect(sp); sp.connect(aL, 0); sp.connect(aR, 1);
      this.fb = [sp, aL, aR];
      const bl = new Float32Array(4096), br = new Float32Array(4096);
      const clips = new ClipCounter();
      this.fbClips = clips;
      this.timer = setInterval(() => {
        if (this.paused) return;
        aL.getFloatTimeDomainData(bl); aR.getFloatTimeDomainData(br);
        clips.process(0, bl); clips.process(1, br);
        const a = bitMask(bl), b = bitMask(br);
        this.stats.push({ n: bl.length, sum: [dcOffset(bl) * bl.length, dcOffset(br) * br.length], mask: a.mask | b.mask, frac: a.frac || b.frac,
          clips: [...clips.events], longest: clips.longest, overs: clips.overs });
      }, 100);
      this.mode = 'analyser';
    }
  }

  read() { return { ...this.stats.read(), mode: this.mode }; }
  reset() { this.stats.reset(); this.fbClips?.reset(); this.node?.port.postMessage('reset'); }

  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    try { this.node && this.tap.disconnect(this.node); } catch { /* */ }
    for (const n of [this.node, ...(this.fb || [])]) { try { n?.disconnect(); } catch { /* */ } }
    try { this.fb && this.tap.disconnect(this.fb[0]); } catch { /* */ }
  }
}
