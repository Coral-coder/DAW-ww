// Utility meters (pure JS, Node-testable): bit usage, DC offset and clip counting. The realtime version is the
// 'daw3-utility' AudioWorklet (src/audio/utility-worklet.js), which accumulates the same raw statistics per 100 ms
// block; the interpretation lives here.
//
//   bitMask(samples, bits = 24)        -> {mask, frac}: OR of |round(x · 2^(bits−1))| over the block (bit k set = the
//                                         k-th least significant bit toggled somewhere), frac = finer detail than `bits`
//   analyzeBits(mask, {bits, frac})    -> {used: [bool × bits] (MSB first), effective, msb, silent, float, verdict}
//   new ClipCounter({level, minRun})   streaming: process(channelIndex, samples) — a run of ≥ minRun consecutive
//                                       samples at or above `level` (full scale) is one clip event
//   dcOffset(samples)                  -> mean (linear)
//   new UtilityStats()                 accumulates worklet blocks (or process(channels) offline) -> read()

export const CLIP_LEVEL = 32767 / 32768; // full scale of 16-bit audio; float overs (> 1) count too
export const CLIP_MIN_RUN = 3; // consecutive full-scale samples that make a clip (common mastering convention)

/** Bit-usage mask of a block at `bits` resolution (sign ignored: the bits of the magnitude). */
export function bitMask(x, bits = 24) {
  const scale = Math.pow(2, bits - 1);
  const max = scale - 1;
  let mask = 0, frac = false;
  for (let i = 0; i < x.length; i++) {
    const s = x[i] * scale;
    let v = Math.round(s);
    if (!frac && v !== s) frac = true;
    if (v < 0) v = -v;
    if (v > max) v = max;
    mask |= v;
  }
  return { mask, frac };
}

/**
 * Interpret a bit mask. effective = resolution actually in use (24 − trailing zero bits): 16-bit material padded to
 * 24 bits reads 16; msb = highest bit in use (bits − msb ≈ unused headroom in 6 dB steps).
 */
export function analyzeBits(mask, { bits = 24, frac = false } = {}) {
  const used = [];
  for (let b = bits - 2; b >= 0; b--) used.push(!!(mask & (1 << b))); // magnitude bits, MSB first (sign bit excluded)
  if (!mask) return { used, effective: 0, msb: 0, silent: true, float: false, verdict: 'Digital silence' };
  let lsb = 0;
  while (!(mask & (1 << lsb))) lsb++;
  let msb = 0;
  for (let b = bits - 2; b >= 0; b--) if (mask & (1 << b)) { msb = b + 1; break; }
  const effective = bits - lsb;
  const float = !!frac && lsb === 0;
  let verdict;
  if (float) verdict = `Full ${bits}-bit resolution (float detail below the ${bits}th bit)`;
  else if (effective < bits) verdict = `Only ${effective} of ${bits} bits in use — ${effective}-bit material (padded or truncated)`;
  else verdict = `Full ${bits}-bit resolution`;
  return { used, effective, msb, silent: false, float, verdict };
}

/** DC offset (mean) of a block. */
export function dcOffset(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  return x.length ? s / x.length : 0;
}

/** Counts clip events (runs of ≥ minRun consecutive full-scale samples) per channel, across block boundaries. */
export class ClipCounter {
  constructor({ level = CLIP_LEVEL, minRun = CLIP_MIN_RUN, channels = 2 } = {}) {
    this.level = level;
    this.minRun = Math.max(1, minRun | 0);
    this.n = channels;
    this.reset();
  }
  reset() {
    this.run = new Array(this.n).fill(0);
    this.events = new Array(this.n).fill(0);
    this.longest = 0;
    this.overs = 0; // samples beyond ±1.0 (float)
    this.fullScale = 0; // samples at / above `level`
  }
  process(c, x) {
    const lv = this.level, mr = this.minRun;
    let run = this.run[c], ev = this.events[c], longest = this.longest, overs = this.overs, fs = this.fullScale;
    for (let i = 0; i < x.length; i++) {
      const a = x[i] < 0 ? -x[i] : x[i];
      if (a >= lv) {
        fs++;
        if (a > 1) overs++;
        run++;
        if (run === mr) ev++;
        if (run > longest) longest = run;
      } else run = 0;
    }
    this.run[c] = run; this.events[c] = ev; this.longest = longest; this.overs = overs; this.fullScale = fs;
    return this;
  }
  get total() { return this.events.reduce((a, b) => a + b, 0); }
}

/**
 * Accumulated utility statistics: feed worklet blocks with push(msg) (msg: {n, sum:[l,r], mask, frac, clips:[l,r],
 * longest, overs}) or whole channels with process(channels). read() -> {dc: [l, r], dcDb, bits (analyzeBits of the
 * whole run), recentBits (last ~1 s), clips: {events: [l, r], total, longest, overs}}.
 */
export class UtilityStats {
  constructor({ bits = 24 } = {}) { this.bits = bits; this.reset(); }
  reset() {
    this.n = 0;
    this.sum = [0, 0];
    this.mask = 0;
    this.frac = false;
    this.recent = []; // [{mask, frac}] of the last 10 blocks
    this.clips = [0, 0];
    this.longest = 0;
    this.overs = 0;
    this.counter = null;
  }
  push(m) {
    this.n += m.n;
    this.sum[0] += m.sum[0]; this.sum[1] += m.sum[1];
    this.mask |= m.mask;
    this.frac = this.frac || !!m.frac;
    this.recent.push({ mask: m.mask, frac: !!m.frac });
    if (this.recent.length > 10) this.recent.shift();
    // the worklet sends running totals since its last reset
    if (m.clips) { this.clips = [m.clips[0], m.clips[1]]; this.longest = m.longest || 0; this.overs = m.overs || 0; }
  }
  process(channels) {
    this.counter ||= new ClipCounter({ channels: channels.length });
    const st = channels.map((c) => bitMask(c, this.bits));
    for (let c = 0; c < channels.length; c++) this.counter.process(c, channels[c]);
    const R = channels[1] || channels[0];
    const L = channels[0];
    this.push({ n: L.length, sum: [L.length * dcOffset(L), R.length * dcOffset(R)], mask: st.reduce((a, s) => a | s.mask, 0), frac: st.some((s) => s.frac),
      clips: [this.counter.events[0], this.counter.events[1] ?? this.counter.events[0]], longest: this.counter.longest, overs: this.counter.overs });
    return this;
  }
  read() {
    const dc = this.n ? [this.sum[0] / this.n, this.sum[1] / this.n] : [0, 0];
    const rm = this.recent.reduce((a, r) => a | r.mask, 0), rf = this.recent.some((r) => r.frac);
    const worst = Math.max(Math.abs(dc[0]), Math.abs(dc[1]));
    return {
      dc, dcDb: worst > 0 ? 20 * Math.log10(worst) : -Infinity,
      bits: analyzeBits(this.mask, { bits: this.bits, frac: this.frac }),
      recentBits: analyzeBits(rm, { bits: this.bits, frac: rf }),
      clips: { events: [...this.clips], total: this.clips[0] + this.clips[1], longest: this.longest, overs: this.overs },
      samples: this.n,
    };
  }
}

/** One-shot analysis of finished channels (export report). */
export function analyzeUtility(channels, opts = {}) {
  return new UtilityStats(opts).process(channels).read();
}
