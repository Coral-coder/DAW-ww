// A tiny linear-time-invariant Web Audio mock for Node tests: enough of BaseAudioContext to build a MixGraph
// (gain, delay, panner, splitter, analyser, buffer source) and to compute the impulse response between two nodes
// by summing every path (gain products, delay sums). Automation methods just set the value (static analysis).

class MockParam {
  constructor(value = 0) { this.value = value; this.defaultValue = value; }
  setValueAtTime(v) { this.value = v; return this; }
  setTargetAtTime(v) { this.value = v; return this; }
  linearRampToValueAtTime(v) { this.value = v; return this; }
  exponentialRampToValueAtTime(v) { this.value = v; return this; }
  setValueCurveAtTime(c) { this.value = c[c.length - 1]; return this; }
  cancelScheduledValues() { return this; }
  cancelAndHoldAtTime() { return this; }
}

let nextId = 1;
export class MockNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.id = nextId++;
    this.outs = []; // [node]
    this.channelCount = 2;
    this.channelCountMode = 'max';
    this.channelInterpretation = 'speakers';
  }
  connect(dst) {
    if (dst instanceof MockParam) return dst; // modulation: not part of the LTI path
    this.outs.push(dst);
    return dst;
  }
  disconnect(dst) {
    if (dst === undefined || typeof dst === 'number') { this.outs = []; return; }
    const i = this.outs.indexOf(dst);
    if (i < 0) throw new Error('InvalidAccessError: not connected');
    this.outs = this.outs.filter((n) => n !== dst);
  }
}

export class MockContext {
  constructor({ sampleRate = 48000 } = {}) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.state = 'running';
    this.destination = new MockNode(this, 'destination');
    this.started = []; // buffer sources started: {src, when, offset, dur}
  }
  createGain() { const n = new MockNode(this, 'gain'); n.gain = new MockParam(1); return n; }
  createDelay(max = 1) { const n = new MockNode(this, 'delay'); n.delayTime = new MockParam(0); n.maxDelayTime = max; return n; }
  createStereoPanner() { const n = new MockNode(this, 'panner'); n.pan = new MockParam(0); return n; }
  createChannelSplitter() { return new MockNode(this, 'splitter'); }
  createChannelMerger() { return new MockNode(this, 'merger'); }
  createAnalyser() {
    const n = new MockNode(this, 'analyser');
    n.fftSize = 2048; n.smoothingTimeConstant = 0.8;
    n.getFloatTimeDomainData = (a) => a.fill(0);
    n.connect = () => {}; // sink
    return n;
  }
  createBufferSource() {
    const n = new MockNode(this, 'source');
    n.playbackRate = new MockParam(1);
    n.start = (when = 0, offset = 0, dur) => this.started.push({ src: n, when, offset, dur });
    n.stop = () => {};
    return n;
  }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: (c) => data[c] };
  }
}

/**
 * Impulse response from `from` to `to`: Map(delayFrames -> summed gain) over every signal path.
 * Gain nodes multiply by gain.value, delay nodes add round(delayTime * sampleRate) frames.
 */
export function impulseResponse(from, to, sampleRate) {
  const out = new Map();
  const walk = (node, frames, amp, depth) => {
    if (depth > 200) throw new Error('cycle in mock graph');
    if (node.kind === 'gain') amp *= node.gain.value;
    if (node.kind === 'delay') frames += Math.round(node.delayTime.value * sampleRate);
    if (node === to) { out.set(frames, (out.get(frames) || 0) + amp); return; }
    for (const n of node.outs) walk(n, frames, amp, depth + 1);
  };
  walk(from, 0, 1, 0);
  for (const [k, v] of out) if (Math.abs(v) < 1e-12) out.delete(k);
  return out;
}

/** An insert effect for MixGraph's `createEffect` hook: a pure delay of `frames` with gain 1. */
export function latentEffectFactory(latencyOf) {
  return (ctx, def) => {
    const input = ctx.createGain();
    const d = ctx.createDelay(1);
    const output = ctx.createGain();
    input.connect(d); d.connect(output);
    let def0 = def;
    const fx = {
      type: def.type, input, output, keyInput: null,
      get latency() { return latencyOf(def0) / ctx.sampleRate; },
      update(dd) { def0 = dd || def0; d.delayTime.value = latencyOf(def0) / ctx.sampleRate; },
      refreshLatency() { return false; },
      setBypass() {}, setTempo() {}, sync() {}, dispose() {},
    };
    fx.update(def);
    return fx;
  };
}
