// Hum / whistle to notes (Pocket). Mic -> AudioWorklet capture (ScriptProcessor fallback) -> live YIN pitch display
// -> on Stop: pitch track + note segmentation (src/mobile/pitch.js) -> review (grid, key snap, fit to chords,
// octave, preview with the track's instrument) -> "Use" writes the notes into the pattern (one undo step).
import { h, icon, fitCanvas, cssVar } from '../ui/dom.js';
import { createNote, beatsPerBar } from '../core/model.js';
import { createRng } from '../core/util.js';
import { scalePitchClasses, pitchClassName } from '../theory/index.js';
import { fitNotesToHarmony } from '../gen/fit.js';
import { PRESETS } from '../audio/index.js';
import { scheduleClick } from '../audio/metronome.js';
import { estimateLatency } from '../audio/recorder.js';
import { yin, yinGeometry, trackPitch, segmentNotes, humToPattern, freqToMidi, GRIDS } from './pitch.js';
import { openSheet, bigButton, chips, haptic } from './touch.js';
import { isMelodic, soundName, pickTrack } from './pages/common.js';

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const nameOf = (m) => `${NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;
const MAX_SEC = 60;
const workletCtx = new WeakSet();
const LS = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const SS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } };

/** Open the microphone and stream Float32 blocks to onBlock. Call from a tap (iOS). */
export async function openMic(ctx, onBlock) {
  try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch { /* */ }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (e) {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* */ }
    throw new Error(e?.name === 'NotAllowedError' ? 'Microphone access was denied — allow it in Settings ▸ Safari ▸ Microphone (or the site settings).' : `Could not open the microphone: ${e?.message || e}`);
  }
  const src = ctx.createMediaStreamSource(stream);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  sink.connect(ctx.destination);
  let node;
  try {
    if (!ctx.audioWorklet) throw new Error('no worklet');
    if (!workletCtx.has(ctx)) { await ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url)); workletCtx.add(ctx); }
    node = new AudioWorkletNode(ctx, 'daw3-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    node.port.onmessage = (e) => onBlock(e.data);
  } catch {
    node = ctx.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = (e) => onBlock(new Float32Array(e.inputBuffer.getChannelData(0)));
  }
  src.connect(node);
  node.connect(sink);
  const startedAt = ctx.currentTime;
  const latency = estimateLatency(ctx, stream.getAudioTracks()[0]);
  return {
    startedAt, latency, sampleRate: ctx.sampleRate,
    close() {
      try { src.disconnect(); node.disconnect(); sink.disconnect(); } catch { /* */ }
      if (node.port) node.port.onmessage = null; else node.onaudioprocess = null;
      for (const t of stream.getTracks()) { try { t.stop(); } catch { /* */ } }
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* */ }
    },
  };
}

function concat(blocks) {
  const n = blocks.reduce((s, b) => s + b.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const b of blocks) { out.set(b, o); o += b.length; }
  return out;
}

export function openHumSheet(app, { trackId = null } = {}) {
  const { store, ui, actions, engine } = app;
  const get = () => store.get();
  // the track the melody goes to: the given / selected melodic track, else the first melodic one, else a new lead
  let tid = [trackId, ui.get('selectedTrackId')].map((id) => get().tracks.find((t) => t.id === id)).find(isMelodic)?.id || get().tracks.find(isMelodic)?.id || null;
  const track = () => get().tracks.find((t) => t.id === tid);

  let phase = 'ready';
  let mic = null, blocks = [], total = 0, raf = 0, ring = null, ringN = 0, geom = null, trace = [];
  let playAlong = LS('daw3-hum-along', get().tracks.length > 0);
  let raw = [], startSec = 0, recSec = 0;
  let grid = LS('daw3-hum-grid', 0.25), snapKey = LS('daw3-hum-snap', true), fit = LS('daw3-hum-fit', false), octave = 0, replace = true;

  const content = h('div.pk-hum');
  const sheet = openSheet({ title: 'Hum / whistle to notes', body: content, tall: true, cls: 'pk-hum-sheet', onClose: () => stopAll() });

  const trackChip = () => {
    const t = track();
    const b = h('button.pk-select.small', { type: 'button' }, h('span.pk-tc-dot', { style: { background: t?.color || 'var(--text-3)' } }), h('span', t ? `${t.name} · ${soundName(t)}` : 'New lead track'), icon('chevronDown', 16));
    b.addEventListener('click', () => pickTrack(app, { filter: isMelodic, title: 'Notes go to…', onPick: (id) => { tid = id; render(); } }));
    return b;
  };

  // ------------------------------------------------------------------ phases
  function render() {
    cancelAnimationFrame(raf);
    if (phase === 'ready') renderReady();
    else if (phase === 'recording') renderRecording();
    else if (phase === 'analysing') content.replaceChildren(h('div.pk-hum-big', '…'), h('p.pk-p.center', 'Finding your notes…'));
    else renderReview();
  }

  function renderReady() {
    const k = get().key;
    const along = chips([{ value: true, label: 'Play along with the beat' }, { value: false, label: 'Free (no beat)' }], playAlong, (v) => { playAlong = v; SS('daw3-hum-along', v); });
    const rec = bigButton('Record', () => startRec(), { ic: 'record', cls: 'rec huge' });
    content.replaceChildren(
      h('div.pk-row', trackChip()),
      h('p.pk-p', `Hum, sing “da da da” or whistle a melody. You'll get notes in ${pitchClassName(k.root)} ${k.scale} on the beat grid — then tweak and use them.`),
      along, rec,
      h('p.pk-hint', 'Tip: short, clear syllables (“da”, “doo”) give the cleanest notes. Whistling works too (it is moved into a sensible octave).'),
      bigButton('Record audio instead', () => { sheet.close(); app.recordAudio?.(); }, { ic: 'wave', cls: 'ghost' }),
    );
  }

  const bigNote = h('div.pk-hum-big');
  const cents = h('div.pk-hum-cents');
  const needle = h('div.pk-hum-needle');
  const level = h('div.pk-hum-level-fill');
  const traceCv = h('canvas.pk-hum-trace');
  const timeEl = h('div.pk-hum-time');
  function renderRecording() {
    const stop = bigButton('Stop', () => stopRec(), { ic: 'stop', cls: 'primary huge' });
    content.replaceChildren(h('div.pk-hum-live', bigNote, h('div.pk-hum-meter', needle), cents), traceCv, h('div.pk-hum-level', level), timeEl, stop);
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!ring || !geom) return;
      // newest frame -> live pitch
      const frame = new Float32Array(geom.frameLength);
      const n = ring.length;
      for (let i = 0; i < geom.frameLength; i++) frame[i] = ring[(ringN - geom.frameLength + i + n * 4) % n];
      const r = yin(frame, mic.sampleRate, { geometry: geom });
      const voiced = r.freq > 0 && r.conf > 0.6 && r.rms > 0.01;
      const m = voiced ? freqToMidi(r.freq) : NaN;
      trace.push(m);
      if (trace.length > 300) trace.shift();
      if (voiced) {
        const c = Math.round((m - Math.round(m)) * 100);
        bigNote.textContent = nameOf(m);
        cents.textContent = `${c > 0 ? '+' : ''}${c}¢ · ${Math.round(r.freq)} Hz`;
        needle.style.left = `${50 + c}%`;
        bigNote.classList.add('on');
      } else { bigNote.classList.remove('on'); cents.textContent = '—'; }
      level.style.width = `${Math.min(100, Math.sqrt(r.rms) * 220)}%`;
      const sec = total / mic.sampleRate;
      timeEl.textContent = `${sec.toFixed(1)} s`;
      drawTrace();
      if (sec > MAX_SEC) stopRec();
    };
    raf = requestAnimationFrame(loop);
  }

  function drawTrace() {
    const { ctx: c, w, h: H } = fitCanvas(traceCv);
    c.clearRect(0, 0, w, H);
    const vals = trace.filter((x) => !Number.isNaN(x));
    const mid = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 64;
    const lo = mid - 9, hi = mid + 9;
    const y = (m) => H - ((m - lo) / (hi - lo)) * H;
    const pcs = new Set(scalePitchClasses(get().key.root, get().key.scale));
    for (let p = Math.ceil(lo); p <= hi; p++) {
      c.fillStyle = pcs.has(((p % 12) + 12) % 12) ? 'rgba(124,92,255,0.22)' : 'rgba(128,128,128,0.07)';
      c.fillRect(0, y(p) - 0.5, w, 1);
      if (p % 12 === get().key.root) { c.fillStyle = cssVar('--text-3'); c.font = '10px system-ui'; c.fillText(nameOf(p), 2, y(p) - 2); }
    }
    c.strokeStyle = cssVar('--accent-2');
    c.lineWidth = 3;
    c.beginPath();
    let pen = false;
    trace.forEach((m, i) => {
      const x = (i / 300) * w;
      if (Number.isNaN(m)) { pen = false; return; }
      if (!pen) c.moveTo(x, y(m)); else c.lineTo(x, y(m));
      pen = true;
    });
    c.stroke();
  }

  // ------------------------------------------------------------------ record / stop
  async function startRec() {
    haptic(15);
    // iOS: start audio + ask for the mic inside this tap
    const ready = actions.ensureAudio();
    try {
      await ready;
      const ctx = engine.ctx;
      blocks = []; total = 0; trace = [];
      geom = yinGeometry(ctx.sampleRate);
      ring = new Float32Array(8192); ringN = 0;
      mic = await openMic(ctx, (b) => {
        if (phase !== 'recording') return;
        blocks.push(b); total += b.length;
        for (let i = 0; i < b.length; i++) ring[(ringN + i) % ring.length] = b[i];
        ringN = (ringN + b.length) % ring.length;
      });
    } catch (e) {
      app.toast(e.message || String(e), { level: 'error', timeout: 7000 });
      return;
    }
    phase = 'recording';
    render();
    startSec = 0;
    if (playAlong) {
      // one bar of count-in clicks, then the loop plays from the top while you hum
      const ctx = engine.ctx;
      if (engine.isPlaying) engine.stop();
      engine.setPosition(0);
      const bpb = beatsPerBar(get());
      const spb = 60 / get().bpm;
      const t0 = ctx.currentTime + 0.1;
      for (let i = 0; i < bpb; i++) scheduleClick(ctx, engine.graph.clickOut, t0 + i * spb, i === 0);
      const tPlay = t0 + bpb * spb;
      setTimeout(async () => {
        if (phase !== 'recording') return;
        await engine.play();
        const tNow = engine.ctx.currentTime;
        const b = engine.beatAtTime?.(tNow);
        const beat0 = Number.isFinite(b) ? tNow - (b * 60) / get().bpm : tPlay;
        startSec = beat0 - mic.startedAt + mic.latency;
      }, Math.max(0, (tPlay - ctx.currentTime - 0.05) * 1000));
      startSec = tPlay - mic.startedAt + mic.latency; // refined once the transport runs
    }
  }

  async function stopRec() {
    if (phase !== 'recording') return;
    haptic(15);
    phase = 'analysing';
    if (playAlong && engine.isPlaying) engine.stop();
    const sr = mic.sampleRate;
    mic.close(); mic = null;
    render();
    await new Promise((r) => setTimeout(r, 30));
    const samples = concat(blocks);
    blocks = [];
    recSec = samples.length / sr;
    raw = segmentNotes(trackPitch(samples, sr));
    if (!playAlong) startSec = raw.length ? raw[0].start : 0;
    phase = 'review';
    render();
  }

  function stopAll() {
    cancelAnimationFrame(raf);
    if (mic) { mic.close(); mic = null; }
    if (phase === 'recording' && playAlong && engine.isPlaying) engine.stop();
    phase = 'closed';
  }

  // ------------------------------------------------------------------ review
  function patternFor() {
    const t = track();
    return t ? get().patterns[t.activePatternId] || null : null;
  }
  /** Notes in beats, ready for the pattern, with the current options. */
  function build() {
    const p = get();
    const bpb = beatsPerBar(p);
    let { notes, length } = humToPattern(raw, { bpm: p.bpm, bpb, grid, startSec, pcs: snapKey ? scalePitchClasses(p.key.root, p.key.scale) : null, role: track()?.role, octave });
    if (fit && notes.length) {
      try { notes = fitNotesToHarmony(notes, actions.currentProgression(Math.max(1, Math.round(length / bpb)), createRng(7)), { key: p.key }); } catch (e) { console.warn('[hum] fit', e); }
    }
    return { notes, length };
  }

  const prevCv = h('canvas.pk-hum-preview');
  function renderReview() {
    const { notes } = build();
    if (!raw.length) {
      content.replaceChildren(h('div.pk-hum-big', '?'), h('p.pk-p.center', `No clear notes found in ${recSec.toFixed(1)} s. Try a bit louder, closer to the mic, with short “da da” syllables.`), bigButton('Try again', () => { phase = 'ready'; render(); }, { ic: 'record', cls: 'rec huge' }));
      return;
    }
    const gridChips = chips(GRIDS.map((g) => ({ value: g.value, label: g.label })), grid, (v) => { grid = v; SS('daw3-hum-grid', v); renderReview(); }, { cls: 'small' });
    const opt = (label, val, on) => { const b = h(`button.pk-chip${val ? '.on' : ''}`, { type: 'button' }, `${val ? '✓ ' : ''}${label}`); b.addEventListener('click', () => { haptic(5); on(!val); renderReview(); }); return b; };
    const k = get().key;
    const octChips = chips([-2, -1, 0, 1, 2].map((o) => ({ value: o, label: o === 0 ? 'Auto' : `${o > 0 ? '+' : '−'}${Math.abs(o)} oct` })), octave, (v) => { octave = v; renderReview(); }, { cls: 'small' });
    const modeChips = chips([{ value: true, label: 'Replace pattern' }, { value: false, label: 'Add to pattern' }], replace, (v) => { replace = v; });
    content.replaceChildren(
      h('div.pk-row', trackChip()),
      h('div.pk-hum-summary', `${notes.length} note${notes.length === 1 ? '' : 's'}: ${notes.slice(0, 10).map((n) => nameOf(n.pitch)).join(' ')}${notes.length > 10 ? ' …' : ''}`),
      prevCv,
      h('div.pk-label', 'Timing grid'), gridChips,
      h('div.pk-chips', opt(`Snap to ${pitchClassName(k.root)} ${k.scale}`, snapKey, (v) => { snapKey = v; SS('daw3-hum-snap', v); }), opt('Fit to chords', fit, (v) => { fit = v; SS('daw3-hum-fit', v); })),
      h('div.pk-label', 'Octave'), octChips,
      modeChips,
      h('div.pk-grid3',
        bigButton('Preview', () => preview(), { ic: 'play' }),
        bigButton('Again', () => { phase = 'ready'; render(); }, { ic: 'record' }),
        bigButton('Use', () => use(), { ic: 'plus', cls: 'primary' })),
    );
    requestAnimationFrame(() => drawPreview(notes));
  }

  function drawPreview(notes) {
    const { ctx: c, w, h: H } = fitCanvas(prevCv);
    c.clearRect(0, 0, w, H);
    if (!notes.length) return;
    const end = Math.max(...notes.map((n) => n.start + n.dur));
    const lo = Math.min(...notes.map((n) => n.pitch)) - 2, hi = Math.max(...notes.map((n) => n.pitch)) + 2;
    const bpb = beatsPerBar(get());
    c.fillStyle = 'rgba(128,128,128,0.25)';
    for (let b = 0; b <= end; b += bpb) c.fillRect((b / end) * w, 0, 1, H);
    c.fillStyle = track()?.color || cssVar('--accent');
    const rh = Math.max(3, H / (hi - lo + 1));
    for (const n of notes) c.fillRect((n.start / end) * w + 1, H - ((n.pitch - lo + 1) / (hi - lo + 1)) * H, Math.max(3, (n.dur / end) * w - 2), rh - 1);
  }

  async function ensureTrack() {
    if (track()) return track();
    const lead = Object.entries(PRESETS).find(([, pr]) => pr.category === 'Lead')?.[0] || 'synth';
    const t = actions.addTrack(lead, { role: 'lead' });
    tid = t.id;
    return t;
  }

  async function preview() {
    await actions.ensureAudio();
    const t = await ensureTrack();
    const inst = engine.graph?.getInstrument(t.id);
    const { notes } = build();
    if (!inst) return;
    const spb = 60 / get().bpm;
    const t0 = engine.ctx.currentTime + 0.08;
    for (const n of notes) { try { inst.trigger(t0 + n.start * spb, n.pitch, n.vel, n.dur * spb); } catch { /* */ } }
  }

  async function use() {
    const t = await ensureTrack();
    const pat = actions.ensurePattern(t.id) || patternFor();
    if (!pat) return;
    const { notes, length } = build();
    store.transact('Hum to notes', (p) => {
      const pt = p.patterns[pat.id];
      if (!pt) return;
      const fresh = notes.map((n) => createNote(n.pitch, n.start, n.dur, n.vel));
      pt.length = Math.max(replace ? length : pt.length, length);
      pt.notes = replace ? fresh : [...pt.notes, ...fresh];
    });
    actions.selectPattern(pat.id);
    haptic(25);
    app.toast(`${notes.length} notes written into ${t.name} — Undo (↶) if you want them back out.`, { level: 'success' });
    sheet.close();
    app.nav?.go({ page: 'notes' });
  }

  render();
  return sheet;
}
