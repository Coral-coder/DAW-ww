// Browser-panel preview of a sampled drum machine: loads the machine's samples, then plays a short
// groove (previewGroove) straight to `dest`. Returns { stop(), done: Promise }.
import { DrumSamplerInstrument } from './drum-sampler.js';
import { previewGroove, DRUM_MACHINES } from './drum-machines.js';

let current = null;

export async function previewMachine(ctx, dest, machineId, { bpm = 104, bars = 2, gain = 0.8, loadTimeoutMs = 6000, onLoading } = {}) {
  current?.stop();
  const out = ctx.createGain();
  out.gain.value = gain;
  out.connect(dest || ctx.destination);
  const inst = new DrumSamplerInstrument(ctx, out, { machine: machineId, kit: DRUM_MACHINES[machineId]?.kit || '808', gain: 0.8, humanize: 0.2 });
  let stopped = false;
  const handle = {
    stop() {
      stopped = true;
      try { inst.allNotesOff?.(ctx.currentTime); } catch { /* */ }
      setTimeout(() => { try { inst.dispose?.(); out.disconnect(); } catch { /* */ } }, 300);
      if (current === handle) current = null;
    },
  };
  current = handle;
  onLoading?.(true);
  let timer;
  await Promise.race([inst.ready, new Promise((r) => { timer = setTimeout(r, loadTimeoutMs); })]);
  clearTimeout(timer);
  onLoading?.(false);
  if (stopped) return handle;
  const spb = 60 / bpm;
  const t0 = ctx.currentTime + 0.06;
  const groove = previewGroove(machineId);
  for (let b = 0; b < bars; b++) {
    for (const n of groove) inst.trigger(t0 + (b * 4 + n.start) * spb, n.pitch, n.vel, n.dur * spb);
  }
  const len = bars * 4 * spb + 1.5;
  handle.done = new Promise((r) => setTimeout(() => { if (current === handle) handle.stop(); r(); }, len * 1000));
  return handle;
}

export function stopPreview() { current?.stop(); }
