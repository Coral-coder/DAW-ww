// Preferences → Hardware check (also Cmd+K "Hardware check…"): guided tests for real devices — MIDI monitor (all
// inputs, decoded log, MPE view), MIDI output test, control-surface test (MCU / HUI handshake, fader sweep, LEDs,
// scribble strips), audio I/O (input meters, per-channel test tone, loopback round-trip latency, dropouts) and the
// Ableton Link bridge. Every section shows pass / fail and "Copy report" produces plain text to paste back to us.
// Logic (decoding, handshake, test patterns, report) is in src/control/hwcheck.js.
import { h, icon } from './dom.js';
import { select, toast } from './components.js';
import { decodeMidi, hex, MpeTracker, MCU_QUERY, MCU_XT_QUERY, HUI_PING, surfaceReply, mcuConnectionReply, faderSweepFrames, ledTestFrames, scribbleTestFrames, toDb, latencyVerdict, sectionStatus, buildReport, noteLabel } from '../control/hwcheck.js';
import { createProtocol } from '../control/surface-protocol.js';
import { listInputSources, openInputSource, DEFAULT_SOURCE, isCaptureSupported } from '../record/inputs.js';

// results survive re-renders / reopening during the session (the report is cumulative)
const R = {
  monitor: { checks: [], details: [] },
  out: { checks: [], details: [] },
  surface: { checks: [], details: [] },
  audio: { checks: [], details: [] },
  link: { checks: [], details: [] },
};
const TITLES = { monitor: 'MIDI monitor', out: 'MIDI output test', surface: 'Control surface', audio: 'Audio I/O', link: 'Ableton Link bridge' };
const setCheck = (sec, name, status, text = '') => {
  const list = R[sec].checks;
  const i = list.findIndex((c) => c.name === name);
  const c = { name, status, text };
  if (i >= 0) list[i] = c; else list.push(c);
};
const btn = (label, onClick, { title, primary, ic } = {}) => {
  const b = h(`button.btn.small${primary ? '.primary' : ''}`, { type: 'button', title }, ic ? icon(ic, 13) : null, label);
  b.addEventListener('click', onClick);
  return b;
};
const chip = (status) => h(`span.hw-chip.hw-${status}`, { title: 'Section result' }, { pass: 'Pass', fail: 'Fail', skip: 'Skipped', pending: 'Not run' }[status] || status);

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Report copied — paste it into your message to us.', { level: 'success' }); return true; } catch { /* fall back */ }
  const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
  ta.value = text; document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* */ }
  ta.remove();
  toast(ok ? 'Report copied.' : 'Could not copy automatically — select the report text below and copy it.', { level: ok ? 'success' : 'warn' });
  return ok;
}

function envInfo(app) {
  const ctx = app.engine?.ctx;
  const extra = [];
  if (ctx) extra.push(`Audio: ${ctx.sampleRate} Hz, ${ctx.destination?.maxChannelCount ?? '?'} output channels, base ${((ctx.baseLatency || 0) * 1000).toFixed(1)} ms + output ${((ctx.outputLatency || 0) * 1000).toFixed(1)} ms`);
  const d = app.control?.devices;
  if (d?.ready) extra.push(`MIDI: ${d.inputs().length} in / ${d.outputs().length} out, SysEx ${d.sysex ? 'granted' : 'not granted'}`);
  return { date: new Date().toISOString(), ua: typeof navigator !== 'undefined' ? navigator.userAgent : '', app: `daW³ ${typeof location !== 'undefined' ? location.pathname : ''}`, extra };
}
const sectionReport = (app, ids) => buildReport(ids.map((id) => ({ title: TITLES[id], checks: R[id].checks, details: R[id].details.slice(-40) })), envInfo(app));

/** One section frame: title, status chip, body, copy-report button. */
function section(app, id, desc, body) {
  const st = sectionStatus(R[id].checks);
  const head = h('div.hw-head', h('h4', TITLES[id]), chip(st), h('div.spacer'), btn('Copy report', () => copyText(sectionReport(app, [id])), { ic: 'copy', title: 'Copy this section’s results as text' }));
  return h(`section.hw-section`, { dataset: { sec: id } }, head, h('p.ctl-help', desc), ...[].concat(body), h('ul.hw-checks'));
}
/** Refresh every section's status chip + check list from the results (no re-render: logs / meters keep running). */
function paintStatus(root) {
  for (const sec of root.querySelectorAll('section.hw-section')) {
    const id = sec.dataset.sec;
    const st = sectionStatus(R[id].checks);
    const old = sec.querySelector('.hw-chip');
    if (old && !old.classList.contains(`hw-${st}`)) old.replaceWith(chip(st));
    const ul = sec.querySelector('ul.hw-checks');
    const sig = JSON.stringify(R[id].checks);
    if (ul && ul.dataset.sig !== sig) {
      ul.dataset.sig = sig;
      ul.replaceChildren(...R[id].checks.map((c) => h(`li.hw-${c.status}`, h('b', `${{ pass: '✓', fail: '✗', skip: '–', pending: '…' }[c.status] || ''} ${c.name}`), c.text ? h('span', ` — ${c.text}`) : null)));
    }
  }
}

// ------------------------------------------------------------------------------------------- tab
/** Render the Hardware check tab. `rerender` rebuilds it; timers / listeners stop when the tab leaves the DOM. */
export function hardwareCheckTab(app, rerender) {
  const c = app.control;
  const d = c?.devices;
  const cleanups = [];
  const root = h('div.hw-check');
  // stop everything once this tab is gone (closed dialog, other tab, re-render)
  const watch = setInterval(() => {
    if (!root.isConnected) { clearInterval(watch); for (const f of cleanups.splice(0)) { try { f(); } catch { /* */ } } return; }
    paintStatus(root);
  }, 400);
  const midiOn = !!d?.ready;
  const enableMidi = midiOn ? null : h('div.ctl-row', d?.supported
    ? btn('Enable MIDI', async () => { if (await c.openMidi()) rerender(); }, { primary: true, ic: 'piano', title: 'Ask the browser for MIDI access (with SysEx for surfaces)' })
    : h('p.ctl-warn', 'This browser has no Web MIDI — use Chrome / Edge / Opera or the desktop app.'));
  if (!midiOn) { setCheck('monitor', 'Web MIDI access', d?.supported ? 'pending' : 'fail', d?.supported ? 'not enabled yet' : 'not supported by this browser'); }
  else setCheck('monitor', 'Web MIDI access', 'pass', `${d.inputs().length} input(s), ${d.outputs().length} output(s), SysEx ${d.sysex ? 'granted' : 'NOT granted'}`);

  root.append(
    h('div.ctl-row', h('b', 'Run the sections that match your setup, then press '), btn('Copy full report', () => copyText(sectionReport(app, Object.keys(R))), { primary: true, ic: 'copy' }), h('span.muted', ' and paste it into your message.')),
    midiMonitor(app, midiOn, enableMidi, cleanups),
    midiOutput(app, midiOn, enableMidi, rerender),
    surfaceTest(app, midiOn, enableMidi, cleanups, rerender),
    audioTest(app, cleanups, rerender),
    linkTest(app, cleanups, rerender),
  );
  paintStatus(root);
  return [root];
}

// ------------------------------------------------------------------------------------------- MIDI monitor
function midiMonitor(app, midiOn, enableMidi, cleanups) {
  const d = app.control?.devices;
  const desc = 'Every message from every MIDI input (enabled in MIDI devices or not), decoded. Play notes, move knobs, press the pedal; MPE controllers show per-note bend / pressure / timbre below.';
  if (!midiOn) return section(app, 'monitor', desc, [enableMidi]);
  const access = d.access;
  const log = h('div.hw-log', { role: 'log', 'aria-live': 'off' });
  const mpeEl = h('div.hw-mpe');
  const counts = h('span.muted');
  const showQuiet = h('input', { type: 'checkbox', title: 'Show clock / active-sensing / MTC (very chatty)' });
  const mpe = new MpeTracker();
  const seen = new Map(); // port -> { n, types:Set }
  let total = 0;
  const paintMpe = () => {
    const ns = mpe.notes();
    mpeEl.replaceChildren(...(ns.length ? ns.map((n) => h('div.hw-mpe-note',
      h('b', `ch ${n.ch} · ${noteLabel(n.note)}`),
      h('span', `bend ${n.bend >= 0 ? '+' : ''}${n.bend} st`), h('span.hw-bar', h('i', { style: { width: `${Math.round(n.pressure * 100)}%` } }), 'pressure'),
      h('span.hw-bar', h('i', { style: { width: `${Math.round(n.timbre * 100)}%` } }), 'timbre'))) : [h('span.muted', mpe.isMpe ? 'No notes held.' : 'MPE: hold notes on an MPE controller (notes on channels 2-16).')]));
  };
  const onMsg = (port) => (ev) => {
    const data = ev.data;
    const dec = decodeMidi(data);
    const s = seen.get(port.name) || { n: 0, types: new Set() };
    s.n++; s.types.add(dec.type); seen.set(port.name, s);
    total++;
    if (mpe.feed(data)) paintMpe();
    if (!dec.quiet || showQuiet.checked) {
      log.prepend(h('div.hw-log-row', h('span.hw-t', (ev.timeStamp / 1000).toFixed(3)), h('span.hw-port', port.name), h('span.hw-type', dec.type), h('span', dec.text), h('code', hex(data))));
      while (log.childElementCount > 200) log.lastChild.remove();
    }
    counts.textContent = `${total} message${total === 1 ? '' : 's'}`;
    setCheck('monitor', 'Messages received', 'pass', [...seen].map(([n, x]) => `${n}: ${x.n} (${[...x.types].join(', ')})`).join('; '));
    if (mpe.isMpe) setCheck('monitor', 'MPE', 'pass', 'notes on member channels 2-16 with per-note expression');
    if (R.monitor.details.length < 400 && !dec.quiet) R.monitor.details.push(`${port.name}: ${dec.type} ${dec.text} [${hex(data)}]`);
  };
  const bound = [];
  const bind = () => {
    for (const [p, f] of bound.splice(0)) p.removeEventListener('midimessage', f);
    for (const p of access.inputs.values()) { const f = onMsg(p); p.addEventListener('midimessage', f); bound.push([p, f]); try { p.open?.(); } catch { /* */ } }
  };
  bind();
  const offDev = d.on('devices', bind);
  cleanups.push(() => { offDev(); for (const [p, f] of bound) p.removeEventListener('midimessage', f); });
  const ins = d.inputs();
  if (!ins.length) setCheck('monitor', 'Inputs connected', 'fail', 'no MIDI inputs found');
  else setCheck('monitor', 'Inputs connected', 'pass', ins.map((i) => `${i.name}${i.manufacturer ? ` (${i.manufacturer})` : ''}${i.settings.enabled ? '' : ' [disabled in daW³]'}`).join(', '));
  if (!R.monitor.checks.some((x) => x.name === 'Messages received')) setCheck('monitor', 'Messages received', 'pending', 'play / move something on your controller');
  paintMpe();
  return section(app, 'monitor', desc, [
    h('div.ctl-row', h('span', `Inputs: ${ins.map((i) => i.name).join(', ') || 'none'}`), h('div.spacer'), h('label.hw-inline', showQuiet, ' clock / sensing'), counts,
      btn('Clear', () => { log.replaceChildren(); R.monitor.details.length = 0; }, { ic: 'trash' })),
    log, h('h5', 'MPE view'), mpeEl,
  ]);
}

// ------------------------------------------------------------------------------------------- MIDI output
function midiOutput(app, midiOn, enableMidi, rerender) {
  const d = app.control?.devices;
  const desc = 'Sends test messages to an output you choose — a hardware synth should play a note, show a CC or follow the clock. Confirm what happened.';
  if (!midiOn) return section(app, 'out', desc, [enableMidi]);
  const outs = d.outputs();
  if (!outs.length) { setCheck('out', 'Outputs', 'fail', 'no MIDI outputs found'); return section(app, 'out', desc, [h('p.ctl-help', 'No MIDI outputs.')]); }
  let port = outs[0].name, ch = 0;
  const outSel = select({ options: outs.map((o) => ({ value: o.name, label: o.name })), value: port, onChange: (v) => { port = v; }, cls: 'ctl-select', title: 'Output port' });
  const chSel = select({ options: Array.from({ length: 16 }, (_, i) => ({ value: i, label: `ch ${i + 1}` })), value: 0, onChange: (v) => { ch = Number(v); }, cls: 'ctl-select', title: 'MIDI channel' });
  // raw send to the port (ignores daW³'s per-output enable switch: this is a test)
  const raw = (msgs, ts) => {
    const p = d.output(port);
    if (!p) { setCheck('out', `Send to ${port}`, 'fail', 'port not available'); return false; }
    try { for (const m of msgs) { if (m[0] === 0xf0 && !d.sysex) continue; p.send(m, ts); } return true; } catch (e) { setCheck('out', `Send to ${port}`, 'fail', e.message); return false; }
  };
  const t = () => performance.now();
  const sent = (what) => { R.out.details.push(`${port} ch ${ch + 1}: sent ${what}`); setCheck('out', `Send to ${port}`, 'pass', 'messages accepted by the port'); };
  const ask = (what) => h('span.hw-ask', `${what}? `,
    btn('Yes', () => { setCheck('out', `${what} (${port})`, 'pass', 'confirmed by the user'); }),
    btn('No', () => { setCheck('out', `${what} (${port})`, 'fail', 'user saw / heard nothing'); }));
  return section(app, 'out', desc, [
    h('div.ctl-row', outSel, chSel),
    h('div.hw-grid',
      h('div.ctl-row', btn('Send note C4', () => { if (raw([[0x90 | ch, 60, 100]], t())) { raw([[0x80 | ch, 60, 0]], t() + 500); sent('note C4 (0.5 s)'); } }, { ic: 'piano' }), ask('Did the device play the note')),
      h('div.ctl-row', btn('Send CC sweep', () => { const now = t(); const ok = raw(Array.from({ length: 17 }, (_, i) => [0xb0 | ch, 74, Math.min(127, i * 8)]).map((m) => m), now); if (ok) sent('CC 74 sweep 0→127'); }, { ic: 'sliders' }), ask('Did it react to CC 74')),
      h('div.ctl-row', btn('Send 2 beats of clock', () => { const now = t() + 20; const msgs = [[0xfa]]; if (raw(msgs, now)) { for (let k = 0; k < 48; k++) raw([[0xf8]], now + k * (500 / 24)); raw([[0xfc]], now + 1000); sent('Start + 48 clocks @120 BPM + Stop'); } }, { ic: 'metronome' }), ask('Did it start / follow the clock')),
      h('div.ctl-row', btn('All notes off', () => { raw(Array.from({ length: 16 }, (_, i) => [0xb0 | i, 123, 0]), t()); sent('all notes off (16 channels)'); }, { ic: 'x' })),
    ),
  ]);
}

// ------------------------------------------------------------------------------------------- control surface
function surfaceTest(app, midiOn, enableMidi, cleanups, rerender) {
  const c = app.control, d = c?.devices;
  const desc = 'Detects a Mackie Control (MCU / XT) or HUI surface by handshake, then moves the motor faders, lights every LED and writes the scribble strips. Pick the surface’s input and output ports.';
  if (!midiOn) return section(app, 'surface', desc, [enableMidi]);
  const ins = d.inputs(), outs = d.outputs();
  if (!ins.length || !outs.length) { setCheck('surface', 'Ports', 'skip', 'needs a MIDI input and output'); return section(app, 'surface', desc, [h('p.ctl-help', 'Connect the surface (it needs both an input and an output port).')]); }
  const cfg = c.settings.surfaces.find((s) => s.enabled) || {};
  let inName = cfg.input || ins[0].name, outName = cfg.output || d.partnerOutput(inName) || outs[0].name, kind = cfg.kind || 'mcu';
  const inSel = select({ options: ins.map((o) => ({ value: o.name, label: o.name })), value: inName, onChange: (v) => { inName = v; outName = d.partnerOutput(v) || outName; outSel.setValue(outName); }, cls: 'ctl-select', title: 'Surface input (what the surface sends)' });
  const outSel = select({ options: outs.map((o) => ({ value: o.name, label: o.name })), value: outName, onChange: (v) => { outName = v; }, cls: 'ctl-select', title: 'Surface output (what daW³ sends to it)' });
  const kindSel = select({ options: [{ value: 'mcu', label: 'Mackie Control' }, { value: 'mcu-xt', label: 'Mackie XT' }, { value: 'hui', label: 'HUI' }], value: kind, onChange: (v) => { kind = v; }, cls: 'ctl-select', title: 'Protocol for the fader / LED / display tests' });
  const status = h('span.muted', '');
  const send = (msgs) => { const p = d.output(outName); if (!p) return false; try { for (const m of msgs) { if (m[0] === 0xf0 && !d.sysex) continue; p.send(m); } return true; } catch (e) { status.textContent = e.message; return false; } };
  const portIn = () => [...d.access.inputs.values()].find((p) => p.name === inName);
  async function detect() {
    const p = portIn();
    if (!p) { status.textContent = 'Input not available.'; return; }
    const got = [];
    const f = (ev) => { const r = surfaceReply([...ev.data]); if (r) { got.push(r); const q = [...ev.data]; if (q[5] === 0x01) { const rep = mcuConnectionReply(q); if (rep) send([rep]); } } };
    p.addEventListener('midimessage', f);
    status.textContent = 'Listening for the handshake…';
    send([MCU_QUERY, MCU_XT_QUERY, HUI_PING]);
    await new Promise((r) => setTimeout(r, 1500));
    p.removeEventListener('midimessage', f);
    if (got.length) {
      kind = got[0].kind; kindSel.setValue(kind);
      setCheck('surface', 'Handshake', 'pass', `${got.map((g) => g.label).join('; ')} on ${inName} → ${outName}`);
    } else setCheck('surface', 'Handshake', 'fail', `no MCU / HUI reply on ${inName} (sent device query + HUI ping to ${outName}${d.sysex ? '' : '; SysEx not granted'})`);
    status.textContent = got.length ? `Detected: ${got[0].label}` : 'No handshake reply.';
  }
  const proto = () => createProtocol(kind);
  async function sweep() {
    const frames = faderSweepFrames(proto());
    for (const f of frames) { if (!send(f)) break; await new Promise((r) => setTimeout(r, 60)); }
    status.textContent = 'Faders swept up and back (odd strips the other way).';
  }
  async function leds() { const [on, off] = ledTestFrames(proto()); send(on); await new Promise((r) => setTimeout(r, 1500)); send(off); status.textContent = 'All LEDs on for 1.5 s, then off.'; }
  const scribble = () => { send(scribbleTestFrames(proto())); status.textContent = 'Scribble strips: "Strip 1…8" + a message (needs SysEx).'; };
  const ask = (what) => h('span.hw-ask', `${what}? `,
    btn('Yes', () => { setCheck('surface', what, 'pass', `${kind} on ${outName}`); }),
    btn('No', () => { setCheck('surface', what, 'fail', `${kind} on ${outName}`); }));
  if (!R.surface.checks.length) setCheck('surface', 'Handshake', 'pending', 'press Detect');
  return section(app, 'surface', desc, [
    h('div.ctl-row', h('span', 'In '), inSel, h('span', 'Out '), outSel, kindSel, btn('Detect', detect, { primary: true, ic: 'search' })),
    h('div.hw-grid',
      h('div.ctl-row', btn('Fader sweep', sweep, { ic: 'sliders' }), ask('Faders moved')),
      h('div.ctl-row', btn('LED test', leds, { ic: 'bulb' }), ask('All LEDs lit')),
      h('div.ctl-row', btn('Scribble strips', scribble, { ic: 'pencil' }), ask('Displays show the text'))),
    status,
  ]);
}

// ------------------------------------------------------------------------------------------- audio I/O
function audioTest(app, cleanups, rerender) {
  const engine = app.engine;
  const desc = 'Input meters per device and channel, a test tone on each output channel, round-trip latency with a loopback cable (output → input) and the dropout (buffer underrun) counter.';
  const box = h('div');
  const meters = h('div.hw-meters');
  const xr = h('span.hw-xruns');
  const srcSel = h('select.ctl-select', { title: 'Input device' }, h('option', { value: DEFAULT_SOURCE }, 'Default input'));
  let open = null, raf = 0;
  const closeIn = () => { cancelAnimationFrame(raf); raf = 0; try { open?.close(); } catch { /* */ } open = null; };
  cleanups.push(closeIn);
  listInputSources().then((list) => { srcSel.replaceChildren(...list.map((s) => h('option', { value: s.id }, `${s.label}${s.channels ? ` (${s.channels} ch)` : ''}`))); }).catch(() => {});
  async function openIn() {
    closeIn();
    if (!isCaptureSupported()) { setCheck('audio', 'Input', 'fail', 'getUserMedia not available'); return; }
    await engine.init?.();
    const ctx = engine.ctx;
    try { await ctx.resume?.(); } catch { /* */ }
    let src;
    try { src = await openInputSource(ctx, srcSel.value); } catch (e) { setCheck('audio', 'Input', 'fail', e.message || String(e)); return; }
    const n = Math.max(1, src.channels || 1);
    const split = ctx.createChannelSplitter(n);
    src.node.connect(split);
    const ans = Array.from({ length: n }, (_, i) => { const a = ctx.createAnalyser(); a.fftSize = 1024; split.connect(a, i); return a; });
    const peaks = new Array(n).fill(-120);
    const bars = ans.map((_, i) => { const fill = h('i'); const lbl = h('small', `in ${i + 1}`); const el = h('div.hw-meter', h('span.hw-bar', fill), lbl); el.fill = fill; el.lbl = lbl; return el; });
    meters.replaceChildren(...bars);
    const buf = new Float32Array(1024);
    const label = srcSel.selectedOptions[0]?.textContent || srcSel.value;
    open = { close: () => { try { src.node.disconnect(); } catch { /* */ } try { src.close(); } catch { /* */ } } };
    const tick = () => {
      ans.forEach((a, i) => {
        a.getFloatTimeDomainData(buf);
        let pk = 0; for (const v of buf) pk = Math.max(pk, Math.abs(v));
        const db = toDb(pk);
        peaks[i] = Math.max(peaks[i], db);
        bars[i].fill.style.width = `${Math.max(0, Math.min(100, (db + 60) / 60 * 100))}%`;
        bars[i].lbl.textContent = `in ${i + 1}: ${db.toFixed(0)} dB (peak ${peaks[i].toFixed(0)})`;
      });
      const best = Math.max(...peaks);
      setCheck('audio', `Input: ${label}`, best > -55 ? 'pass' : 'pending', `${n} channel(s); peaks ${peaks.map((p) => `${p.toFixed(0)} dBFS`).join(' / ')}${best > -55 ? '' : ' — no signal yet'}`);
      raf = requestAnimationFrame(tick);
    };
    tick();
  }
  // per-channel test tone
  const ctx0 = engine.ctx;
  const maxCh = ctx0?.destination?.maxChannelCount || 2;
  const chOpt = h('select.ctl-select', { title: 'Output channel' }, ...Array.from({ length: Math.max(2, maxCh) }, (_, i) => h('option', { value: String(i) }, `out ${i + 1}`)));
  async function tone() {
    await engine.init?.();
    const ctx = engine.ctx;
    try { await ctx.resume?.(); } catch { /* */ }
    const dest = ctx.destination;
    const n = Math.max(2, dest.maxChannelCount || 2);
    const prev = { count: dest.channelCount, mode: dest.channelCountMode, interp: dest.channelInterpretation };
    const ch = Number(chOpt.value);
    try { if (n > 2) { dest.channelCount = n; dest.channelCountMode = 'explicit'; dest.channelInterpretation = 'discrete'; } } catch { /* */ }
    const merger = ctx.createChannelMerger(n);
    const osc = ctx.createOscillator(); osc.frequency.value = 440 * Math.pow(2, (ch % 12) / 12);
    const g = ctx.createGain(); const t = ctx.currentTime + 0.02;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.25, t + 0.02); g.gain.setValueAtTime(0.25, t + 0.9); g.gain.linearRampToValueAtTime(0, t + 1);
    osc.connect(g); g.connect(merger, 0, ch); merger.connect(dest);
    osc.start(t); osc.stop(t + 1.05);
    osc.onended = () => { try { merger.disconnect(); } catch { /* */ } try { if (n > 2) Object.assign(dest, { channelCount: prev.count, channelCountMode: prev.mode, channelInterpretation: prev.interp }); } catch { /* */ } };
    R.audio.details.push(`test tone ${osc.frequency.value.toFixed(0)} Hz on output ${ch + 1} of ${n}`);
  }
  const askTone = h('span.hw-ask', 'Heard it on the right channel? ',
    btn('Yes', () => { setCheck('audio', `Output channel ${Number(chOpt.value) + 1}`, 'pass', 'tone heard'); }),
    btn('No', () => { setCheck('audio', `Output channel ${Number(chOpt.value) + 1}`, 'fail', 'tone not heard'); }));
  // loopback round trip
  const latBtn = btn('Measure round trip', async () => {
    latBtn.disabled = true; latBtn.lastChild.textContent = 'Measuring…';
    try {
      const r = await app.rec?.calibrate?.(srcSel.value, { store: false });
      const ctx = engine.ctx;
      const est = ctx ? ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000 : NaN;
      if (r?.ok) { const v = latencyVerdict(r.ms, est); setCheck('audio', 'Round-trip latency', v.status, `${v.text}, ${r.hits} pings, spread ${r.spread?.toFixed?.(1) ?? '?'} ms`); }
      else setCheck('audio', 'Round-trip latency', 'fail', r?.message || 'not measured');
    } catch (e) { setCheck('audio', 'Round-trip latency', 'fail', e.message || String(e)); }
    latBtn.disabled = false; latBtn.lastChild.textContent = 'Measure round trip';
  }, { ic: 'loop', title: 'Connect an output to an input with a cable (or hold the mic to a speaker), then measure' });
  // dropouts
  const xrTimer = setInterval(() => {
    const m = engine.getMetrics?.();
    if (!m) return;
    xr.textContent = `Dropouts (buffer underruns): ${m.xruns} · late scheduler windows: ${m.late} · output latency ${m.latencyMs?.toFixed?.(1) ?? '?'} ms · ${m.sampleRate || engine.ctx?.sampleRate || '?'} Hz${m.load != null ? ` · DSP load ${(m.load * 100).toFixed(0)}%` : ''}`;
    setCheck('audio', 'Dropouts', m.xruns > 0 ? 'fail' : 'pass', `${m.xruns} underrun(s), ${m.late} late window(s) since the audio started`);
  }, 700);
  cleanups.push(() => clearInterval(xrTimer));
  box.append(
    h('div.ctl-row', srcSel, btn('Open input', openIn, { primary: true, ic: 'record', title: 'Open the device and show a meter per channel' }), btn('Close', closeIn)),
    meters,
    h('div.ctl-row', chOpt, btn('Play test tone', tone, { ic: 'volume', title: '1 s tone on the chosen output channel (pitch rises with the channel number)' }), askTone),
    h('div.ctl-row', latBtn, h('span.muted', 'Needs a loopback: cable from an output to the selected input.')),
    xr,
  );
  return section(app, 'audio', desc, [box]);
}

// ------------------------------------------------------------------------------------------- Link
function linkTest(app, cleanups, rerender) {
  const c = app.control;
  const link = c?.link;
  const desc = 'Ableton Link needs the small companion bridge (node tools/link-bridge/link-bridge.mjs). Shows whether daW³ reaches it and what the Link session reports.';
  const st = h('div.hw-link');
  const paint = () => {
    if (!link) { st.textContent = 'Link client unavailable.'; return; }
    const s = link.state;
    st.replaceChildren(h('div', `Status: ${link.status}${link.lastMessage ? ` — ${link.lastMessage}` : ''}`),
      s ? h('div.muted', `tempo ${s.tempo?.toFixed?.(2) ?? '?'} · peers ${s.peers ?? '?'} · ${s.playing ? 'playing' : 'stopped'} · phase ${s.phase?.toFixed?.(2) ?? '?'} / ${s.quantum ?? 4}`) : null);
    setCheck('link', 'Bridge connection', link.status === 'connected' ? 'pass' : link.status === 'error' ? 'fail' : 'pending', `${link.status}${s ? `, ${s.peers ?? 0} peer(s), ${s.tempo?.toFixed?.(1)} BPM` : ''}`);
  };
  const off = link?.on?.('status', (e) => { link.lastMessage = e?.message || null; paint(); });
  const off2 = link?.on?.('state', paint);
  cleanups.push(() => { off?.(); off2?.(); });
  paint();
  return section(app, 'link', desc, [st, h('div.ctl-row',
    btn(link?.status === 'connected' ? 'Reconnect' : 'Connect', () => { c.settings.link.enabled = true; c.save?.(); link.connect(c.settings.link.url); setTimeout(rerender, 1500); }, { ic: 'plug' }),
    h('span.muted', `Bridge URL: ${c?.settings?.link?.url || '?'}`))]);
}
