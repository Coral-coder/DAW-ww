// Clip effects (take FX): a per-clip mini effect chain (same effect types / defs as track inserts) that processes a
// clip only while it plays. Used by both the realtime engine and the offline renderer through MixGraph.
//
// Model: clip.fx = [Effect] (createEffect shape: {id, type, enabled, params}); an empty / all-bypassed list = none.
//
// Graph (only for tracks that have clips with fx; others keep input -> inStage untouched):
//
//   strip.input ─┬─ dryGate ──── delay(L) ────────────────┐
//                ├─ gate[c1] ─ head[c1] ─ fx… ─ delay(L − L1) ─┤─> strip.inStage (trim / inserts / fader …)
//                └─ gate[c2] ─ head[c2] ─ fx… ─ delay(L − L2) ─┘
//
//   · audio clips with fx play their sources straight into head[c] (sample-exact, no switching)
//   · MIDI (pattern) clips share the track's instrument: the scheduler emits one 'clipfx' event per window that
//     lists the fx-clip spans inside it (clipFxSpans); playEvent turns them into gate ramps — the instrument output
//     crossfades (XFADE s, ending at the boundary) from the dry path into the clip's chain and back at its end
//   · every path is padded to the slowest chain (L = max chain latency), and the strip reports insertLatency + L to
//     PDC, so clip effects with look-ahead stay aligned with the rest of the mix (latency.js)
import { createEffect as createEffectImpl } from './effects.js';

export const XFADE = 0.005;
const EPS = 1e-7;

/** Does this clip have an active clip-effect chain? */
export const hasClipFx = (clip) => Array.isArray(clip?.fx) && clip.fx.some((f) => f && f.type && f.enabled !== false);

/**
 * Spans of pattern clips with clip fx on a track inside the beat window [b0, b1): [{clipId, start, end}] clipped to
 * the window, sorted. (Audio clips route straight into their chain and need no spans.)
 */
export function clipFxSpans(clips, b0, b1) {
  const out = [];
  for (const c of clips) {
    if (c.type === 'audio' || !hasClipFx(c)) continue;
    const s = Math.max(b0, c.start), e = Math.min(b1, c.start + c.length);
    if (e > s + EPS) out.push({ clipId: c.id, start: s, end: e });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Gate automation of one 'clipfx' window: [{at (s, relative to the window start), gates: {dry, [clipId]: 0|1}}]
 * — the state at the window start and after every boundary inside it. Overlapping fx clips both get the signal
 * (rare: overlapping pattern clips on one track). timeOf(beat) -> seconds after the window start.
 */
export function gateSchedule(spans, b0, b1, ids, timeOf) {
  const points = new Set([b0]);
  for (const s of spans) { if (s.start > b0 + EPS) points.add(s.start); if (s.end < b1 - EPS) points.add(s.end); }
  return [...points].sort((a, b) => a - b).map((beat) => {
    const gates = { dry: 1 };
    for (const id of ids) gates[id] = 0;
    for (const s of spans) if (beat >= s.start - EPS && beat < s.end - EPS) { gates[s.clipId] = 1; gates.dry = 0; }
    return { at: timeOf(beat), beat, gates };
  });
}

/** Rack of clip-effect chains on one channel strip. */
export class ClipFxRack {
  constructor(strip, { createEffect = null, onError = (e) => console.error(e) } = {}) {
    this.strip = strip;
    this.ctx = strip.ctx;
    this.onError = onError;
    this.createEffect = createEffect || strip.env?.createEffect || createEffectImpl;
    this.chains = new Map(); // clipId -> { key, gate, head, fx: [{id, type, fx}], tail, pad (DelayNode), latency }
    this.dryGate = this.ctx.createGain();
    this.dryPad = this.ctx.createDelay(1);
    // rewire: input -> dryGate -> dryPad -> inStage (instead of input -> inStage)
    try { strip.input.disconnect(strip.inStage); } catch { /* */ }
    strip.input.connect(this.dryGate);
    this.dryGate.connect(this.dryPad);
    this.dryPad.connect(strip.inStage);
    this.latency = 0;
  }

  /** Build / update the chains for these clips (each with hasClipFx). Returns true when the latency changed. */
  sync(clips) {
    const want = new Map(clips.map((c) => [c.id, c]));
    for (const [id, ch] of this.chains) if (!want.has(id)) { this._dispose(ch); this.chains.delete(id); }
    for (const clip of clips) {
      const list = clip.fx.filter((f) => f && f.type);
      const key = list.map((f) => `${f.id}:${f.type}`).join('|');
      let ch = this.chains.get(clip.id);
      if (ch && ch.key !== key) { this._dispose(ch); this.chains.delete(clip.id); ch = null; }
      if (!ch) { ch = this._build(list, key); this.chains.set(clip.id, ch); }
      for (const e of ch.fx) {
        const def = list.find((f) => f.id === e.id);
        try { if (def) e.fx.update(def); } catch (err) { this.onError(err); }
      }
    }
    return this._align();
  }

  _build(list, key) {
    const ctx = this.ctx;
    const gate = ctx.createGain();
    gate.gain.value = 0;
    const head = ctx.createGain();
    const tail = ctx.createGain();
    const pad = ctx.createDelay(1);
    this.strip.input.connect(gate);
    gate.connect(head);
    const fx = [];
    let prev = head;
    for (const def of list) {
      try {
        const inst = this.createEffect(ctx, def, this.strip.env || {});
        prev.connect(inst.input);
        prev = inst.output;
        fx.push({ id: def.id, type: def.type, fx: inst });
      } catch (err) { this.onError(err); }
    }
    prev.connect(tail);
    tail.connect(pad);
    pad.connect(this.strip.inStage);
    return { key, gate, head, fx, tail, pad, latency: 0 };
  }

  /** Pad every path to the slowest chain. -> true when the rack latency changed. */
  _align() {
    let max = 0;
    for (const ch of this.chains.values()) {
      ch.latency = ch.fx.reduce((s, e) => { const l = Number(e.fx.latency); return s + (Number.isFinite(l) && l > 0 ? l : 0); }, 0);
      max = Math.max(max, ch.latency);
    }
    const sr = this.ctx.sampleRate;
    max = Math.round(max * sr) / sr;
    for (const ch of this.chains.values()) ch.pad.delayTime.value = Math.max(0, Math.min(1, Math.round((max - ch.latency) * sr) / sr));
    this.dryPad.delayTime.value = Math.min(1, max);
    const changed = Math.abs(max - this.latency) > 1e-12;
    this.latency = max;
    return changed;
  }

  /** Re-read effect latencies (plugins report theirs once loaded). */
  refreshLatency() { return this._align(); }

  /** Chain input of an audio clip with clip fx (its sources connect here), else null. */
  inputFor(clipId) { return this.chains.get(clipId)?.head || null; }

  /**
   * Schedule the gates of one window (see gateSchedule): ramps of XFADE s that END at each boundary, so the notes
   * starting there are fully inside the new path.
   */
  scheduleWindow(points, t0) {
    const ids = [...this.chains.keys()];
    const params = [['dry', this.dryGate.gain], ...ids.map((id) => [id, this.chains.get(id).gate.gain])];
    for (const pt of points) {
      const t = Math.max(0, t0 + pt.at);
      for (const [id, param] of params) {
        const v = pt.gates[id] ?? 0;
        if (param._last == null || param._last === v) param.setValueAtTime(v, t);
        else { param.setValueAtTime(param._last, Math.max(0, t - XFADE)); param.linearRampToValueAtTime(v, t); }
        param._last = v;
      }
    }
  }

  /** Transport stop / seek: back to the dry path. */
  reset(time) {
    const t = time ?? this.ctx.currentTime;
    const set = (param, v) => { try { param.cancelScheduledValues(t); param.setValueAtTime(v, t); } catch { /* */ } param._last = v; };
    set(this.dryGate.gain, 1);
    for (const ch of this.chains.values()) set(ch.gate.gain, 0);
  }

  setTempo(bpm) { for (const ch of this.chains.values()) for (const e of ch.fx) e.fx.setTempo?.(bpm); }
  syncLfos(time) { for (const ch of this.chains.values()) for (const e of ch.fx) e.fx.sync?.(time); }

  /** Probe / effect lookups (UI). */
  effect(fxId) { for (const ch of this.chains.values()) { const e = ch.fx.find((x) => x.id === fxId); if (e) return e.fx; } return null; }

  _dispose(ch) {
    for (const e of ch.fx) { try { e.fx.dispose(); } catch { /* */ } }
    for (const n of [ch.gate, ch.head, ch.tail, ch.pad]) { try { n.disconnect(); } catch { /* */ } }
    try { this.strip.input.disconnect(ch.gate); } catch { /* */ }
  }

  /** Remove the rack: the strip's input goes straight to its insert section again. */
  dispose() {
    for (const ch of this.chains.values()) this._dispose(ch);
    this.chains.clear();
    try { this.strip.input.disconnect(this.dryGate); } catch { /* */ }
    for (const n of [this.dryGate, this.dryPad]) { try { n.disconnect(); } catch { /* */ } }
    try { this.strip.input.connect(this.strip.inStage); } catch { /* */ }
    this.latency = 0;
  }
}
