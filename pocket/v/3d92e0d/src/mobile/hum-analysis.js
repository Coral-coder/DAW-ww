// Hum take analysis off the main thread. Protocol (both directions are plain structured-clone data):
//   main -> worker: {type: 'analyze', id, samples: Float32Array, sampleRate, opts}
//   worker -> main: {type: 'progress', id, p (0..1)}  ...  {type: 'result', id, notes}  |  {type: 'error', id, error}
// handleAnalysisMessage() is the worker's whole job (also used by the tests); analyzeTakeAsync() runs it in a
// module Worker and falls back to the main thread (in slices, yielding so the progress bar keeps moving).
import { analyzeTake, trackPitch, segmentNotes, yinGeometry, yin } from './pitch.js';

/** Worker side: handle one message, report through post(msg). */
export function handleAnalysisMessage(data, post) {
  if (!data || data.type !== 'analyze') return;
  const { id, samples, sampleRate, opts = {} } = data;
  try {
    let lastP = -1;
    const notes = analyzeTake(samples, sampleRate, {
      ...opts,
      onProgress: (p) => { const q = Math.round(p * 100) / 100; if (q !== lastP) { lastP = q; post({ type: 'progress', id, p: q }); } },
    });
    post({ type: 'result', id, notes });
  } catch (e) {
    post({ type: 'error', id, error: String(e?.message || e) });
  }
}

/** Main-thread fallback: same frames as trackPitch, computed in slices of ~sliceMs with a yield in between. */
export async function analyzeTakeSliced(samples, sampleRate, { onProgress = null, pitch = {}, segment = {}, sliceMs = 12, yieldFn = (r) => setTimeout(r, 0) } = {}) {
  const geometry = yinGeometry(sampleRate, pitch);
  const hop = Math.max(1, Math.round(sampleRate * (pitch.hopSec ?? 0.01)));
  const last = samples.length - geometry.frameLength;
  const frames = [];
  let off = 0;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  while (off <= last) {
    const t0 = now();
    while (off <= last && now() - t0 < sliceMs) {
      const r = yin(samples, sampleRate, { ...pitch, geometry, offset: off });
      frames.push({ time: (off + geometry.W / 2) / sampleRate, ...r });
      off += hop;
    }
    onProgress?.(Math.min(1, off / Math.max(1, last)));
    if (off <= last) await new Promise(yieldFn);
  }
  const notes = segmentNotes(frames, segment);
  onProgress?.(1);
  return notes;
}

let worker = null, workerBroken = false, seq = 0;
function getWorker() {
  if (workerBroken || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./hum-worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('error', () => { workerBroken = true; worker = null; });
    return worker;
  } catch { workerBroken = true; return null; }
}

/** Analyse a take: Worker when possible, else sliced on the main thread. -> Promise<notes>. */
export function analyzeTakeAsync(samples, sampleRate, { onProgress = null, opts = {}, timeoutMs = 120000 } = {}) {
  const w = getWorker();
  if (!w) return analyzeTakeSliced(samples, sampleRate, { ...opts, onProgress });
  const id = ++seq;
  return new Promise((resolve) => {
    let done = false;
    const fallback = () => { if (done) return; done = true; cleanup(); workerBroken = true; try { worker?.terminate(); } catch { /* */ } worker = null; resolve(analyzeTakeSliced(samples, sampleRate, { ...opts, onProgress })); };
    const timer = setTimeout(fallback, timeoutMs);
    const onMsg = (e) => {
      const m = e.data;
      if (!m || m.id !== id) return;
      if (m.type === 'progress') { onProgress?.(m.p); return; }
      if (done) return;
      done = true;
      cleanup();
      if (m.type === 'result') resolve(m.notes);
      else { workerBroken = true; resolve(analyzeTakeSliced(samples, sampleRate, { ...opts, onProgress })); }
    };
    const onErr = () => fallback();
    function cleanup() { clearTimeout(timer); w.removeEventListener('message', onMsg); w.removeEventListener('error', onErr); }
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    // copy: the caller keeps its samples (the review can re-run); transfer the copy
    const copy = new Float32Array(samples);
    try { w.postMessage({ type: 'analyze', id, samples: copy, sampleRate, opts }, [copy.buffer]); } catch { fallback(); }
  });
}

export { trackPitch, segmentNotes };
