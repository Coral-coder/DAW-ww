// Export with native plugins (Mac app).
//  • Native instruments that support offline processing are rendered faster than realtime: the
//    plugin host renders each instrument part (offline mode) and the OfflineAudioContext plays it
//    back (see render.js → prerenderNative).
//  • Anything else (native effects, plugins that need realtime) goes through a realtime bounce:
//    the song plays through the live engine and the master output is captured, with progress.
import { nativePluginsIn } from './state.js';
import { createRingBuffer, RingBuffer } from './ring.js';
import { getStatus } from '../plugins/status.js';
import { nativeStatusKey } from '../plugins/native.js';

/** How a project with native plugins exports: 'none' | 'offline' | 'realtime' (+ reason). */
export function nativeExportMode(project) {
  const list = nativePluginsIn(project);
  if (!list.length) return { mode: 'none' };
  const fx = list.find((x) => x.where === 'fx');
  if (fx) return { mode: 'realtime', reason: `“${fx.def.params?.name || 'a native effect'}” processes live audio` };
  const rt = list.find((x) => getStatus(nativeStatusKey(x.def.params))?.info?.offline === false);
  if (rt) return { mode: 'realtime', reason: `“${rt.def.params?.name}” only runs in realtime` };
  return { mode: 'offline' };
}

/** render.js hook: pre-render every native instrument of an offline graph (faster than realtime). */
export async function prerenderNative(graph, notesFor, frames, onError = () => {}) {
  const jobs = [];
  for (const [id, e] of graph.tracks || []) {
    const pl = e.instrument?.engine?.plugin;
    if (!pl?.isNative || !pl.prerender) continue;
    jobs.push(pl.prerender(notesFor(id), frames).then((ok) => { if (!ok) onError(new Error(`Native plugin: ${pl.error || 'could not render'} — rendered silent.`)); },
      (err) => onError(new Error(`Native plugin render failed: ${err?.message || err}`))));
  }
  await Promise.all(jobs);
}

/**
 * Realtime bounce of [startBeat, endBeat) + tail through the live engine -> stereo AudioBuffer.
 * onProgress(0..1); `signal` (AbortSignal) cancels.
 */
export async function realtimeBounce(engine, { startBeat = 0, endBeat, tail = 2, onProgress, signal } = {}) {
  await engine.init();
  const ctx = engine.ctx;
  const client = engine.native;
  const tap = client?.outputs?.get(ctx)?.tap;
  if (!tap) throw new Error('Realtime bounce needs the daW³ Mac app audio bridge');
  await client.ensureWorklet(ctx);
  const sr = ctx.sampleRate;
  const sab = createRingBuffer(1 << 18, 2);
  const ring = new RingBuffer(sab);
  const node = new AudioWorkletNode(ctx, 'daw3-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { sab } });
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute);
  mute.connect(ctx.destination);
  tap.connect(node);
  const spb = 60 / engine.project.bpm;
  const total = Math.ceil(((endBeat - startBeat) * spb + tail) * sr);
  const L = new Float32Array(total), R = new Float32Array(total);
  const wasPlaying = engine.isPlaying;
  if (wasPlaying) engine.stop();
  engine.setPosition(startBeat);
  // ring stream index of ctx time t: frames since the capture started
  let streamStart = null; // ctx frame of ring index 0
  let got = 0;
  let begin = null;       // ring index where the song starts
  const tmp = new Float32Array(8192 * 2);
  try {
    for (let i = 0; i < 100 && !ring.available(); i++) await new Promise((r) => setTimeout(r, 10));
    streamStart = ring.flag; // the capture worklet stores its first block's context frame
    await engine.play();
    const tNow = ctx.currentTime;
    const t0 = tNow - ((engine.scheduler?.beatAt?.(tNow) ?? startBeat) - startBeat) * spb;
    begin = Math.round(t0 * sr) - streamStart;
    let consumed = Atomics.load(ring.h, 1) >>> 0; // ring read index == frames consumed so far
    while (got < total) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      await new Promise((r) => setTimeout(r, 40));
      let n;
      while ((n = ring.read(tmp, 8192)) > 0) {
        for (let i = 0; i < n; i++) {
          const idx = consumed + i - begin;
          if (idx >= 0 && idx < total) { L[idx] = tmp[2 * i]; R[idx] = tmp[2 * i + 1]; }
        }
        consumed += n;
        got = Math.max(got, Math.min(total, consumed - begin));
      }
      onProgress?.(got / total);
    }
  } finally {
    engine.stop();
    try { tap.disconnect(node); } catch { /* */ }
    try { node.disconnect(); mute.disconnect(); } catch { /* */ }
  }
  const buf = ctx.createBuffer(2, total, sr);
  buf.copyToChannel(L, 0);
  buf.copyToChannel(R, 1);
  return buf;
}
