// Rhythm effect builders. Receives the shared DSP helpers from effects.js and returns { type: builder }
// entries merged into BUILDERS. A builder is (ctx, sh, env) => { apply(p, immediate), setTempo?(bpm),
// sync?(time), dispose?(), getReduction?(), probe? } — see the comment above BUILDERS in effects.js.
// probe: optional live data for the effect's custom UI (read through engine.getFxProbe(fxId)).
//
// Trance Gate, Volume Shaper, Beat Repeat and Time Shaper all run in one AudioWorklet processor
// (fx/rhythm-worklet.js, realtime and OfflineAudioContext). Their timing comes from a beat clock: on every
// transport start / seek / loop wrap (sync) the builder samples env.getBeatAt into piecewise-linear segments
// (fx/rhythm-dsp.js beatSegments — exact for tempo maps) and posts them to the processor, which evaluates the
// song beat of every sample. A main-thread mirror of that clock drives the card UI playheads and the
// hold / trigger buttons. Stopped transport: the clock free-runs at the project tempo (live input still gates).
// Without AudioWorklet support (insecure context, very old browser) the gate and the shaper fall back to a
// looped gain buffer (pump-style, synced the same way); repeat / time effects then pass audio through.
import {
  gateConfig, shaperConfig, repeatConfig, timeConfig, beatSegments, BeatClock, gateEnvAt, gateGain,
  shaperValueAt, repeatAt, repeatSlice, timeWindowAt, manualWindowAt, stepAt, stepStart, mod,
} from '../rhythm-dsp.js';

const WORKLET_URL = new URL('../rhythm-worklet.js', import.meta.url).href;
const LEAD = 0.03; // s: sync() without a time re-anchors this far ahead (message transit to the audio thread)
const loaded = new WeakMap(); // ctx -> Promise<boolean>

/** Load the rhythm worklet module once per context (false = unavailable -> fallbacks). */
export function loadRhythmWorklet(ctx) {
  let p = loaded.get(ctx);
  if (p) return p;
  if (!ctx?.audioWorklet || typeof AudioWorkletNode !== 'function' || globalThis.DAW3_NO_RHYTHM_WORKLET) p = Promise.resolve(false);
  else {
    // some sandboxed browsers never settle addModule: give up after 8 s (fallbacks take over)
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), 8000); });
    p = Promise.race([ctx.audioWorklet.addModule(WORKLET_URL), timeout]).then((r) => {
      clearTimeout(timer);
      if (r === 'timeout') { console.warn('[fx] rhythm worklet did not load'); return false; }
      return true;
    }, (e) => { clearTimeout(timer); console.warn('[fx] rhythm worklet unavailable:', e?.message || e); return false; });
  }
  loaded.set(ctx, p);
  return p;
}

/** Seconds of input history the buffer effects need (worst case at half the current tempo, + margin). */
export function ringSeconds(kind, cfg, bpm) {
  const spb = 60 / Math.max(20, bpm);
  let beats = 1;
  if (kind === 'beatrepeat') beats = Math.max(cfg.grid, 0.25);
  else if (kind === 'timeshaper') beats = 2 * Math.max(cfg.length, cfg.tapeStart || cfg.mode === 'tapestart' ? cfg.startLength : 0);
  return Math.min(48, Math.max(4, beats * spb * 2 + 0.5));
}

export default function rhythmBuilders(H) {
  const divBeats = (d) => (d === '1/64' ? 1 / 16 : H.divisionToBeats(d));
  const CONFIG = {
    trancegate: (p) => gateConfig(p, divBeats),
    volshaper: (p) => shaperConfig(p, divBeats),
    beatrepeat: (p) => repeatConfig(p, divBeats),
    timeshaper: (p) => timeConfig(p, divBeats),
  };

  /** Native fallback for gate / shaper: a stereo gain curve rendered over one cycle, looped and beat-synced. */
  function gainLoop(ctx, sh, kind, mirror) {
    const inp = H.stereoGain(ctx);
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    const vL = ctx.createGain(), vR = ctx.createGain();
    vL.gain.value = 0; vR.gain.value = 0;
    const modSplit = ctx.createChannelSplitter(2);
    sh.fxIn.connect(inp); inp.connect(split);
    split.connect(vL, 0); split.connect(vR, 1);
    vL.connect(merge, 0, 0); vR.connect(merge, 0, 1);
    merge.connect(sh.wet);
    modSplit.connect(vL.gain, 0); modSplit.connect(vR.gain, 1);
    let src = null, buf = null, cycleBeats = 4, renderBpm = 120, cfg = null, bpm = 120;
    const render = () => {
      if (!cfg) return;
      cycleBeats = kind === 'trancegate' ? cfg.n * cfg.stepBeats : cfg.lengthBeats;
      renderBpm = bpm;
      const cycleSec = (cycleBeats * 60) / bpm;
      const rate = Math.max(3000, Math.min(ctx.sampleRate, 400000 / cycleSec));
      const frames = Math.max(16, Math.ceil(cycleSec * rate));
      buf = ctx.createBuffer(2, frames, rate);
      const L = buf.getChannelData(0), R = buf.getChannelData(1);
      for (let i = 0; i < frames; i++) {
        const b = (i / frames) * cycleBeats;
        if (kind === 'trancegate') {
          const eL = gateEnvAt(b, cfg.L, cfg, bpm / 60);
          L[i] = gateGain(eL, cfg.depth);
          R[i] = cfg.stereoSame ? L[i] : gateGain(gateEnvAt(b, cfg.R, cfg, bpm / 60), cfg.depth);
        } else {
          L[i] = R[i] = cfg.target === 'filter' ? 1 : shaperValueAt(b, cfg);
        }
      }
    };
    const start = (t) => {
      if (!buf) return;
      t = Math.max(t, ctx.currentTime);
      const old = src;
      src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.playbackRate.value = bpm / renderBpm;
      src.connect(modSplit);
      const beat = mirror.beatAt(t * ctx.sampleRate);
      src.start(t, mod(beat / cycleBeats, 1) * buf.duration);
      if (old) { try { old.stop(t); } catch { /* */ } setTimeout(() => { try { old.disconnect(); } catch { /* */ } }, 1000); }
    };
    return {
      apply(c, b) { cfg = c; bpm = b; render(); start(ctx.currentTime + LEAD); },
      setTempo(b) {
        bpm = b;
        if (Math.abs(b / renderBpm - 1) > 0.02) { render(); start(ctx.currentTime + LEAD); } else if (src) src.playbackRate.value = b / renderBpm;
      },
      resync(t) { start(t); },
      dispose() {
        try { src?.stop(); } catch { /* */ }
        for (const n of [src, inp, split, merge, vL, vR, modSplit]) { try { n?.disconnect(); } catch { /* */ } }
      },
    };
  }

  function makeRhythm(kind) {
    return (ctx, sh, env) => {
      const sr = ctx.sampleRate;
      const mirror = new BeatClock(env.getBpm() || 120, sr);
      const cfgOf = CONFIG[kind];
      let params = null, cfg = null, ringSec = 0;
      let node = null, fallback = null, disposed = false, mode = 'loading';
      let hold = null, manualAt = null;
      // until the worklet is up, the wet path passes the input through
      const pass = ctx.createGain();
      sh.fxIn.connect(pass); pass.connect(sh.wet);
      const post = (m) => { try { node?.port.postMessage(m); } catch { /* closed */ } };
      const pings = new Map();
      let pingId = 0;

      const resync = (time) => {
        const t = Math.max(0, time ?? ctx.currentTime + LEAD);
        mirror.prune(Math.min(t, ctx.currentTime) * sr);
        const s = beatSegments(env.getBeatAt, t);
        if (s) {
          const segs = BeatClock.fromSeconds(s, sr);
          mirror.set(segs);
          post({ type: 'clock', segs });
        } else {
          const bpm = env.getBpm() || 120;
          mirror.free(t * sr, bpm);
          post({ type: 'free', f: t * sr, bpm });
        }
        fallback?.resync(t);
      };
      resync(ctx.currentTime); // offline renders: the clock is valid from frame 0 before the node exists

      const sendCfg = () => {
        if (!cfg) return;
        const need = kind === 'beatrepeat' || kind === 'timeshaper' ? ringSeconds(kind, cfg, env.getBpm() || 120) : 0;
        if (need > ringSec) ringSec = need;
        post({ type: 'cfg', cfg, ringSec });
      };

      const ready = loadRhythmWorklet(ctx).then((ok) => {
        if (disposed) return true;
        if (ok) {
          try {
            mirror.prune(ctx.currentTime * sr);
            node = new AudioWorkletNode(ctx, 'daw3-rhythm', {
              numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
              channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
              processorOptions: { kind, cfg, bpm: env.getBpm() || 120, segs: mirror.segs, ringSec: ringSec || 6 },
            });
            if (hold) post({ type: 'hold', start: hold.start, end: Number.isFinite(hold.end) ? hold.end : null });
            if (manualAt != null) post({ type: 'trigger', at: manualAt });
            node.port.onmessage = (e) => { if (e.data?.type === 'pong') { pings.get(e.data.id)?.(); pings.delete(e.data.id); } };
            sh.fxIn.connect(node);
            node.connect(sh.wet);
            mode = 'worklet';
          } catch (e) {
            console.warn('[fx] rhythm worklet node failed:', e?.message || e);
            node = null;
          }
        }
        if (!node) {
          mode = 'fallback';
          if (kind === 'trancegate' || kind === 'volshaper') {
            fallback = gainLoop(ctx, sh, kind, mirror);
            if (cfg) fallback.apply(cfg, env.getBpm() || 120);
          } else return true; // buffer effects without a worklet: audio passes through
        }
        try { sh.fxIn.disconnect(pass); } catch { /* */ }
        try { pass.disconnect(); } catch { /* */ }
        return true;
      });

      /** Song beat heard right now through this effect (output latency removed). */
      const heardBeat = () => mirror.beatAt((ctx.currentTime - (ctx.outputLatency || 0) - (ctx.baseLatency || 0)) * sr);
      const beatSoon = () => mirror.beatAt((ctx.currentTime + LEAD) * sr);

      const probe = {
        kind,
        get mode() { return mode; },
        get params() { return params; },
        get config() { return cfg; },
        /** Heard song beat (null before the clock exists). */
        beat: heardBeat,
        playing: () => env.getBeatAt(ctx.currentTime) != null,
        /** Trance gate: step index (0..n-1) of each channel playing now. */
        step() {
          if (kind !== 'trancegate' || !cfg) return -1;
          return stepAt(mod(heardBeat(), cfg.n * cfg.stepBeats), cfg.n, cfg.stepBeats, cfg.swing);
        },
        /** Volume shaper: phase (0..1) of the curve playing now. */
        phase() { return cfg && kind === 'volshaper' ? mod(heardBeat() / cfg.lengthBeats + cfg.offset, 1) : 0; },
        /** Beat repeat: manual stutter (starts on the next repeat-grid line, stops after a short fade). */
        hold(on) {
          if (kind !== 'beatrepeat' || !cfg) return;
          const b = beatSoon();
          if (on) {
            if (hold && !Number.isFinite(hold.end)) return;
            const start = Math.ceil(b / cfg.grid - 1e-6) * cfg.grid;
            hold = { start, end: Infinity };
            post({ type: 'hold', start, end: null });
          } else if (hold) {
            hold = { start: hold.start, end: Math.max(hold.start, b) + 0.002 };
            post({ type: 'hold', start: hold.start, end: hold.end });
          }
        },
        get holding() { return !!hold && !Number.isFinite(hold.end); },
        /** Time shaper: fire the effect window on the next 1/16 (manual trigger). */
        trigger() {
          if (kind !== 'timeshaper') return;
          manualAt = Math.ceil(beatSoon() * 4 - 1e-6) / 4;
          post({ type: 'trigger', at: manualAt });
        },
        /** What the effect is doing at the heard beat: {active, n?, mode?, u?}. */
        state() {
          if (!cfg) return { active: false };
          const b = heardBeat();
          if (kind === 'beatrepeat') {
            const st = hold && b >= hold.start && b < hold.end ? repeatSlice(b, hold.start, cfg.grid, cfg) : repeatAt(b, cfg);
            return st ? { active: true, n: st.n, manual: !!(hold && b >= hold.start && b < hold.end) } : { active: false };
          }
          if (kind === 'timeshaper') {
            const w = cfg.trigger === 'manual' ? manualWindowAt(b, manualAt, cfg) : timeWindowAt(b, cfg);
            return w ? { active: true, mode: w.mode, u: w.u } : { active: false };
          }
          return { active: true };
        },
        stepStart: (k) => (cfg && kind === 'trancegate' ? stepStart(k, cfg.stepBeats, cfg.swing) : 0),
      };

      return {
        ready,
        get error() { return mode === 'fallback' && (kind === 'beatrepeat' || kind === 'timeshaper') ? 'AudioWorklet unavailable — passing audio through' : null; },
        probe,
        apply(p) {
          params = p;
          cfg = cfgOf(p);
          sendCfg();
          fallback?.apply(cfg, env.getBpm() || 120);
        },
        setTempo(bpm) {
          const t = ctx.currentTime + LEAD;
          const actual = env.getBeatAt(t);
          if (actual == null) resync(t); // stopped: free-run at the new tempo
          else if (Math.abs(mirror.beatAt(t * sr) - actual) > 1e-4) resync(t);
          if (cfg && (kind === 'beatrepeat' || kind === 'timeshaper') && ringSeconds(kind, cfg, bpm) > ringSec) sendCfg();
          fallback?.setTempo(bpm);
        },
        sync(time) { resync(time); },
        /** Offline renders (render.js flushAll): wait until the processor has every message posted so far. */
        flush() {
          if (!node) return Promise.resolve();
          const id = ++pingId;
          return new Promise((resolve) => {
            const timer = setTimeout(() => { pings.delete(id); resolve(); }, 1000);
            pings.set(id, () => { clearTimeout(timer); resolve(); });
            post({ type: 'ping', id });
          });
        },
        dispose() {
          disposed = true;
          post({ type: 'dispose' });
          for (const n of [node, pass]) { try { n?.disconnect(); } catch { /* */ } }
          fallback?.dispose();
        },
      };
    };
  }

  return {
    trancegate: makeRhythm('trancegate'),
    volshaper: makeRhythm('volshaper'),
    beatrepeat: makeRhythm('beatrepeat'),
    timeshaper: makeRhythm('timeshaper'),
  };
}
