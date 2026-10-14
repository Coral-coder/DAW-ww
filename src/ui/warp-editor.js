// Audio clip warp editor (modal) + warp actions (analysis, auto-warp, detect tempo, project tempo from clip,
// quantize, groove extraction). Model: src/audio/warp/markers.js.
//
// Waveform drawn in CONTENT BEATS (x = beat of the clip's content, so the beat grid is straight and the audio is
// drawn the way it will play): warp markers are the yellow handles — drag one to move that sample moment to another
// beat (the audio around it stretches), double-click the waveform to add a marker (snaps to a nearby transient),
// right-click a marker to delete it. Transients are the small ticks along the bottom.
import { h, startDrag, fitCanvas } from './dom.js';
import { button, select, toggle, numberField, modal, toast, contextMenu } from './components.js';
import { WARP_MODES, WARP_MODE_LABELS, isWarped, secAtBeat, beatAtSec, autoWarp, addMarker, moveMarker, removeMarker, setWarpBpm, normalizeMarkers, warpedLength } from '../audio/warp/markers.js';
import { analyzeBuffer } from '../audio/warp/analyze.js';
import { quantizeWarp, grooveFromAudio, applyGrooveToNotes } from '../time/groove.js';
import { songTempoMap } from '../time/tempo-map.js';
import { setTempoPoint } from '../time/tempo-edit.js';

// ------------------------------------------------------------------ actions (UI-agnostic, need app)
/** Decode + analyse a sample (cached on sample.analysis). Resolves to the analysis or null (streamed / failed). */
export async function analyzeSample(app, sampleId, { force = false } = {}) {
  const { store, engine } = app;
  const s = store.get().samples?.[sampleId];
  if (!s) return null;
  if (s.analysis && !force) return s.analysis;
  let buf;
  try { buf = await engine.decodeSample(sampleId, { full: true }); } catch { return null; }
  if (!buf || buf.streamed || typeof buf.getChannelData !== 'function') return null;
  const analysis = analyzeBuffer(buf, { beatsPerBar: 4 });
  store.transact('Analyse sample', (p) => { if (p.samples[sampleId]) p.samples[sampleId].analysis = analysis; }, { undo: false });
  return analysis;
}

/** Auto-warp a freshly placed clip (analysis -> markers, mode, length in whole beats). */
export async function autoWarpClip(app, clipId, { setLength = true } = {}) {
  const { store } = app;
  const clip = store.get().clips.find((c) => c.id === clipId);
  if (!clip?.sampleId) return null;
  const an = await analyzeSample(app, clip.sampleId);
  if (!an) return null;
  const s = store.get().samples[clip.sampleId];
  const dur = s.duration || 0;
  const w = autoWarp(an, dur);
  store.transact('Auto-warp clip', (p) => {
    const c = p.clips.find((x) => x.id === clipId);
    if (!c) return;
    c.warp = w;
    if (setLength && w.mode !== 'off') { c.offset = 0; c.length = Math.max(0.25, Math.round(warpedLength(w, dur) * 4) / 4); }
  }, { undo: false });
  return w;
}

const findClip = (p, id) => p.clips.find((c) => c.id === id);
const editClip = (app, id, label, fn, opts) => app.store.transact(label, (p) => { const c = findClip(p, id); if (c) fn(c, p); }, opts);
const ensureWarp = (c, sample) => {
  if (!c.warp) c.warp = { mode: 'off', markers: [{ beat: 0, sec: 0 }], bpm: sample?.analysis?.bpm || 120, transpose: 0, formants: false, quality: 'normal' };
  return c.warp;
};

/** Detect the clip's tempo (re-analysis) and re-warp it to it. -> bpm */
export async function detectClipTempo(app, clipId) {
  const clip = findClip(app.store.get(), clipId);
  if (!clip) return null;
  const an = await analyzeSample(app, clip.sampleId, { force: true });
  if (!an) { toast('Could not analyse this audio (still loading or too long to decode).', { level: 'warn' }); return null; }
  const s = app.store.get().samples[clip.sampleId];
  const w = autoWarp(an, s.duration || 0);
  editClip(app, clipId, 'Detect clip tempo', (c) => {
    const mode = isWarped(c) ? c.warp.mode : w.mode === 'off' ? 'complex' : w.mode;
    c.warp = { ...w, mode, transpose: c.warp?.transpose || 0, formants: !!c.warp?.formants, quality: c.warp?.quality || 'normal' };
  });
  toast(`Clip tempo: ${an.bpm} BPM${an.alternatives?.length ? ` (or ${an.alternatives.join(' / ')})` : ''}`, { level: 'success' });
  return an.bpm;
}

/** Project tempo := the clip's source tempo (at the clip start when the song has tempo changes). */
export function projectTempoFromClip(app, clipId) {
  const p = app.store.get();
  const clip = findClip(p, clipId);
  const bpm = clip?.warp?.bpm || p.samples?.[clip?.sampleId]?.analysis?.bpm;
  if (!(bpm > 0)) { toast('Detect the clip tempo first.', { level: 'warn' }); return null; }
  const map = songTempoMap(p);
  app.store.transact('Tempo from clip', (pp) => {
    if (map.isConstant || clip.start < 1e-9) setTempoPoint(pp, 0, bpm); else setTempoPoint(pp, clip.start, bpm, 'jump');
  });
  toast(`Project tempo ${+bpm.toFixed(2)} BPM${!map.isConstant && clip.start > 0 ? ` from beat ${clip.start}` : ''}`, { level: 'success' });
  return bpm;
}

/** Audio quantize of a clip (transients -> grid / groove). */
export async function quantizeClip(app, clipId, opts = {}) {
  const clip = findClip(app.store.get(), clipId);
  if (!clip) return;
  const an = await analyzeSample(app, clip.sampleId);
  if (!an?.transients?.length) { toast('No transients found to quantize.', { level: 'warn' }); return; }
  const s = app.store.get().samples[clip.sampleId];
  editClip(app, clipId, 'Quantize audio', (c) => {
    ensureWarp(c, s);
    c.warp = quantizeWarp(c, an.transients, { ...opts, duration: s.duration });
  });
}

/** Extract a groove template from the clip (stored in project.grooves). */
export async function extractClipGroove(app, clipId, { grid = 0.25, length = 4 } = {}) {
  const clip = findClip(app.store.get(), clipId);
  const an = clip && await analyzeSample(app, clip.sampleId);
  if (!an?.transients?.length) { toast('No transients found.', { level: 'warn' }); return null; }
  const s = app.store.get().samples[clip.sampleId];
  const g = grooveFromAudio(clip.warp?.markers?.length ? clip : { ...clip, warp: { markers: [{ beat: 0, sec: 0 }], bpm: an.bpm } }, an.transients, { grid, length, name: `Groove: ${s?.name || 'audio'}` });
  app.store.transact('Extract groove', (p) => { p.grooves = [...(p.grooves || []), g]; });
  toast(`Groove “${g.name}” saved (${g.hits.filter(Boolean).length}/${g.offsets.length} slots).`, { level: 'success' });
  return g;
}

/** Apply a stored groove to a pattern's notes. */
export function applyGrooveToPattern(app, patternId, grooveId, opts = {}) {
  app.store.transact('Apply groove', (p) => {
    const pat = p.patterns[patternId];
    const g = (p.grooves || []).find((x) => x.id === grooveId);
    if (pat && g) pat.notes = applyGrooveToNotes(pat.notes, g, opts);
  });
}

// ------------------------------------------------------------------ editor UI
export function openWarpEditor(app, clipId) {
  const { store, engine } = app;
  const get = () => store.get();
  const clip0 = findClip(get(), clipId);
  if (!clip0) return null;
  const sample0 = get().samples[clip0.sampleId];
  let buffer = null;
  let peaks = null; // { min, max, bucketSec }

  const modeSel = select({ options: WARP_MODES.map((m) => ({ value: m, label: WARP_MODE_LABELS[m] })), value: clip0.warp?.mode || 'off', title: 'Warp mode: Re-Pitch = speed & pitch follow the tempo; Beats = slice at transients (drums); Tones = WSOLA (melodic); Complex = long-grain WSOLA (full mixes)', onChange: (v) => edit('Warp mode', (c, p) => { ensureWarp(c, p.samples[c.sampleId]).mode = v; }) });
  const transpose = numberField({ value: clip0.warp?.transpose || 0, min: -24, max: 24, step: 1, width: 46, title: 'Transpose (semitones) — Beats / Tones / Complex', onChange: (v, { final }) => edit('Clip transpose', (c, p) => { ensureWarp(c, p.samples[c.sampleId]).transpose = v; }, { coalesce: !final }) });
  const formants = toggle({ label: 'Formants', value: !!clip0.warp?.formants, title: 'Keep the formants (vocal character) while transposing — Tones / Complex', onChange: (v) => edit('Formants', (c, p) => { ensureWarp(c, p.samples[c.sampleId]).formants = v; }) });
  const quality = select({ options: [{ value: 'draft', label: 'Draft' }, { value: 'normal', label: 'Normal' }, { value: 'high', label: 'High' }], value: clip0.warp?.quality || 'normal', title: 'Stretch quality (grain size / search effort)', onChange: (v) => edit('Warp quality', (c, p) => { ensureWarp(c, p.samples[c.sampleId]).quality = v; }) });
  const srcBpm = numberField({ value: clip0.warp?.bpm || sample0?.analysis?.bpm || 120, min: 20, max: 400, step: 0.01, width: 64, title: 'Source tempo of the audio (re-scales the warp markers)', onChange: (v, { final }) => { if (final) edit('Clip tempo', (c, p) => setWarpBpm(ensureWarp(c, p.samples[c.sampleId]), v)); } });
  const info = h('div.warp-info');
  const canvas = h('canvas.warp-canvas');
  const qStrength = numberField({ value: 100, min: 0, max: 100, step: 5, width: 44, title: 'Quantize strength %' });
  const qSwing = numberField({ value: 0, min: 0, max: 100, step: 5, width: 44, title: 'Swing %' });
  const qGrid = select({ options: [{ value: '1', label: '1/4' }, { value: '0.5', label: '1/8' }, { value: '0.25', label: '1/16' }, { value: '0.125', label: '1/32' }], value: '0.25', title: 'Quantize grid' });
  const grooveSel = select({ options: [{ value: '', label: 'Grid' }, ...(get().grooves || []).map((g) => ({ value: g.id, label: g.name }))], value: '', title: 'Quantize to the straight grid or to a groove template' });

  const body = h('div.warp-editor',
    h('div.warp-row',
      h('label.hfield', h('span.hlabel', 'Warp'), modeSel),
      h('label.hfield', h('span.hlabel', 'Transpose'), transpose), formants,
      h('label.hfield', h('span.hlabel', 'Quality'), quality),
      h('label.hfield', h('span.hlabel', 'Clip BPM'), srcBpm)),
    h('div.warp-row',
      button('Detect tempo', async () => { await detectClipTempo(app, clipId); await load(); }, { icon: 'search', cls: 'small', title: 'Analyse the audio: tempo, downbeat, transients -> warp markers on each bar' }),
      button('Set project tempo from clip', () => projectTempoFromClip(app, clipId), { icon: 'metronome', cls: 'small' }),
      button('Auto-warp', async () => { await autoWarpClip(app, clipId); await load(); }, { icon: 'wand', cls: 'small', title: 'Markers on the detected bars, mode by material (percussive -> Beats, else Tones)' }),
      button('Reset markers', () => edit('Reset warp markers', (c, p) => { const w = ensureWarp(c, p.samples[c.sampleId]); w.markers = [{ beat: 0, sec: 0 }]; }), { cls: 'small' })),
    h('div.warp-row',
      h('span.hlabel', 'Quantize'), qGrid, h('span.hlabel', 'Strength'), qStrength, h('span.hlabel', 'Swing'), qSwing, grooveSel,
      button('Quantize audio', async () => {
        const g = (get().grooves || []).find((x) => x.id === grooveSel.value) || null;
        await quantizeClip(app, clipId, { grid: Number(qGrid.value) || 0.25, strength: (qStrength.value ?? 100) / 100, swing: (qSwing.value ?? 0) / 100, groove: g });
      }, { icon: 'magnet', cls: 'small', title: 'Warp markers on the transients, pulled to the grid / groove' }),
      button('Extract groove', () => extractClipGroove(app, clipId), { icon: 'sparkles', cls: 'small', title: 'Save this clip’s timing / accents as a groove template (apply it to MIDI from the piano roll or here)' })),
    h('div.warp-wave', canvas),
    info,
    h('p.warp-help', 'Drag a yellow warp marker to move that moment of the audio to another beat. Double-click to add a marker (snaps to a transient), right-click a marker to delete it. Warped clips follow the song’s tempo map.'));

  const dlg = modal({ title: `Warp: ${clip0.name || sample0?.name || 'Audio clip'}`, body, width: 860, cls: 'warp-modal', onClose: () => { unsub?.(); } });

  function edit(label, fn, opts) { editClip(app, clipId, label, fn, opts); }

  // view: content beats [v0, v1]
  let v0 = 0, v1 = 8;
  function fitView() {
    const c = findClip(get(), clipId);
    if (!c) return;
    const w = c.warp || { markers: [{ beat: 0, sec: 0 }], bpm: get().bpm };
    const total = buffer ? beatAtSec(w, buffer.duration) : (c.offset || 0) + c.length;
    v0 = Math.min(c.offset || 0, beatAtSec(w, 0)) - 0.5;
    v1 = Math.max(total, (c.offset || 0) + c.length) + 0.5;
  }

  async function load() {
    try { buffer = await engine.decodeSample(clip0.sampleId, { full: true }); } catch { buffer = null; }
    if (buffer?.getChannelData) {
      const d = buffer.getChannelData(0), bucket = Math.max(1, Math.floor(buffer.sampleRate / 400));
      const n = Math.ceil(d.length / bucket);
      const min = new Float32Array(n), max = new Float32Array(n);
      for (let i = 0; i < n; i++) { let lo = 1, hi = -1; for (let j = i * bucket, e = Math.min(d.length, j + bucket); j < e; j++) { const x = d[j]; if (x < lo) lo = x; if (x > hi) hi = x; } min[i] = lo; max[i] = hi; }
      peaks = { min, max, bucketSec: bucket / buffer.sampleRate };
      if (!get().samples[clip0.sampleId]?.analysis) analyzeSample(app, clip0.sampleId).then(() => draw());
    }
    fitView();
    draw();
  }

  const X = (b, W) => ((b - v0) / (v1 - v0)) * W;
  const B = (x, W) => v0 + (x / W) * (v1 - v0);

  function draw() {
    if (!canvas.isConnected) return;
    const { ctx, w: W, h: H } = fitCanvas(canvas);
    const p = get();
    const c = findClip(p, clipId);
    if (!c) return;
    const w = c.warp || { markers: [{ beat: 0, sec: 0 }], bpm: p.bpm };
    const cs = getComputedStyle(canvas);
    const v = (n, d) => cs.getPropertyValue(n).trim() || d;
    ctx.fillStyle = v('--bg', '#0f1116'); ctx.fillRect(0, 0, W, H);
    // clip region
    const r0 = X(c.offset || 0, W), r1 = X((c.offset || 0) + c.length, W);
    ctx.fillStyle = 'rgba(124,92,255,.10)'; ctx.fillRect(r0, 0, r1 - r0, H);
    // beat grid (content beats)
    for (let b = Math.ceil(v0); b <= v1; b++) {
      ctx.fillStyle = b % 4 === 0 ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.08)';
      ctx.fillRect(Math.round(X(b, W)), 0, 1, H);
      if (b % 4 === 0) { ctx.fillStyle = v('--text-3', '#6d7590'); ctx.font = `10px ${v('--font', 'system-ui')}`; ctx.fillText(String(b / 4 + 1), X(b, W) + 3, 11); }
    }
    // waveform (sampled through the warp: x -> beat -> sample second)
    if (peaks) {
      const mid = H / 2 + 6, amp = (H - 30) / 2;
      ctx.fillStyle = v('--accent-2', '#00d4ff');
      for (let x = 0; x < W; x++) {
        const s0 = secAtBeat(w, B(x, W)), s1 = secAtBeat(w, B(x + 1, W));
        const i0 = Math.max(0, Math.floor(s0 / peaks.bucketSec)), i1 = Math.min(peaks.min.length, Math.max(i0 + 1, Math.ceil(s1 / peaks.bucketSec)));
        if (i0 >= peaks.min.length || s1 < 0) continue;
        let lo = 0, hi = 0;
        for (let i = i0; i < i1; i++) { if (peaks.min[i] < lo) lo = peaks.min[i]; if (peaks.max[i] > hi) hi = peaks.max[i]; }
        ctx.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
      }
    } else { ctx.fillStyle = v('--text-3', '#6d7590'); ctx.fillText('Loading audio…', 10, H / 2); }
    // transients
    const an = p.samples[c.sampleId]?.analysis;
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    for (const s of an?.transients || []) { const x = X(beatAtSec(w, s), W); if (x >= 0 && x <= W) ctx.fillRect(Math.round(x), H - 8, 1, 8); }
    // markers
    ctx.font = `600 9.5px ${v('--font', 'system-ui')}`;
    (w.markers || []).forEach((m, i) => {
      const x = X(m.beat, W);
      ctx.fillStyle = i === dragI ? '#fff' : '#ffd43b';
      ctx.fillRect(Math.round(x), 14, 1, H - 14);
      ctx.beginPath(); ctx.moveTo(x - 5, 14); ctx.lineTo(x + 5, 14); ctx.lineTo(x, 22); ctx.closePath(); ctx.fill();
      ctx.fillText(`${+m.sec.toFixed(3)}s`, x + 6, 22);
    });
    const mode = isWarped(c) ? WARP_MODE_LABELS[c.warp.mode] : 'Off (plays at its own speed)';
    const bpmTxt = w.bpm ? `${+w.bpm.toFixed(2)} BPM source` : '';
    info.textContent = `${mode} · ${(w.markers || []).length} marker(s) · ${bpmTxt}${an ? ` · detected ${an.bpm} BPM, ${an.transients.length} transients` : ''}${c.warp?.transpose ? ` · ${c.warp.transpose > 0 ? '+' : ''}${c.warp.transpose} st` : ''}`;
  }

  let dragI = -1;
  const xy = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, W: r.width }; };
  function pickMarker(e) {
    const c = findClip(get(), clipId);
    const { x, W } = xy(e);
    let best = -1, bd = 7;
    (c?.warp?.markers || []).forEach((m, i) => { const d = Math.abs(X(m.beat, W) - x); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const i = pickMarker(e);
    if (i < 0) return;
    e.preventDefault();
    dragI = i;
    let started = false;
    startDrag(e, (dx, dy, ev) => {
      const { x, W } = xy(ev);
      let b = B(x, W);
      if (!(ev.ctrlKey || ev.metaKey)) b = Math.round(b * 4) / 4; // snap to 16ths
      edit('Move warp marker', (c) => { if (c.warp) moveMarker(c.warp, dragI, b); }, started ? { undo: false } : {});
      started = true;
    }, () => { dragI = -1; draw(); });
  });
  canvas.addEventListener('dblclick', (e) => {
    const { x, W } = xy(e);
    const p = get();
    const c = findClip(p, clipId);
    const w = ensureWarp({ ...c, warp: c.warp ? { ...c.warp } : null }, p.samples[c.sampleId]);
    let beat = B(x, W);
    // snap to a transient within 8 px
    const an = p.samples[c.sampleId]?.analysis;
    let best = null, bd = 8;
    for (const s of an?.transients || []) { const d = Math.abs(X(beatAtSec(w, s), W) - x); if (d < bd) { bd = d; best = s; } }
    if (best != null) beat = beatAtSec(w, best);
    edit('Add warp marker', (cc, pp) => { const ww = ensureWarp(cc, pp.samples[cc.sampleId]); addMarker(ww, beat); if (ww.mode === 'off') ww.mode = 'beats'; });
  });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const i = pickMarker(e);
    if (i < 0) return;
    contextMenu(e, [{ label: 'Delete warp marker', icon: 'trash', onClick: () => edit('Delete warp marker', (c) => { if (c.warp) removeMarker(c.warp, i); }) }]);
  });
  canvas.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const { x, W } = xy(e);
    const at = B(x, W), f = e.deltaY > 0 ? 1.25 : 0.8;
    v0 = at - (at - v0) * f; v1 = at + (v1 - at) * f;
    draw();
  }, { passive: false });

  const sync = () => {
    const c = findClip(get(), clipId);
    if (!c) { dlg.close(); return; }
    modeSel.value = c.warp?.mode || 'off';
    if (c.warp) { transpose.setValue?.(c.warp.transpose || 0); srcBpm.setValue?.(c.warp.bpm || 120); }
    draw();
  };
  const unsub = store.on('change', sync);
  requestAnimationFrame(() => load());
  return { close: dlg.close, draw, el: dlg.el };
}
