// Recording settings dialog: count-in / pre-roll / post-roll, punch, MIDI recording mode + input quantize, monitoring,
// per-track inputs of audio tracks, per-device latency compensation (measured with the loopback ping wizard + manual
// offset), capture MIDI and step input. See src/record/*.
import { h } from './dom.js';
import { modal, select, button, toggle, numberField, toast } from './components.js';
import { QUANTIZE_OPTIONS, roundTrip } from '../record/timing.js';
import { listInputSources, deviceLatency, setDeviceLatency, trackChannels, DEFAULT_SOURCE } from '../record/inputs.js';

const row = (label, ...ctl) => h('div.rec-row', h('label.rec-lbl', label), h('div.rec-ctl', ...ctl));
const bars = (n) => [0, 1, 2, 4].map((v) => ({ value: v, label: v ? `${v} bar${v > 1 ? 's' : ''}` : 'Off' }));

export async function showRecordSettings(app) {
  const { store, ui } = app;
  const rec = app.rec;
  await app.engine.init().catch(() => {});
  const pr = rec.prefs();
  const set = (patch) => rec.setPrefs(patch);
  const p = store.get();
  const sources = await listInputSources();

  // ---------------------------------------------------------------- transport
  const punch = p.punch || { enabled: false, start: p.loop.start, end: p.loop.end };
  const bpb = p.timeSig[0] * (4 / p.timeSig[1]);
  const punchOn = toggle({ label: punch.enabled ? 'On' : 'Off', value: !!punch.enabled, title: 'Record only inside the punch range (Shift-drag in the loop lane to draw it)', onChange: (v) => { punchOn.textContent = v ? 'On' : 'Off'; store.transact('Punch', (pp) => { pp.punch = { ...(pp.punch || punch), enabled: v }; }); } });
  const barField = (val, key) => numberField({ value: +(val / bpb + 1).toFixed(2), min: 1, max: 9999, step: 0.25, width: 64, title: 'Bar (1 = first bar)', onChange: (v) => store.transact('Punch', (pp) => { pp.punch = { ...(pp.punch || punch), [key]: (v - 1) * bpb }; }) });
  const transport = h('div.rec-sec',
    h('h3', 'Transport'),
    row('Count-in', select({ options: bars(), value: pr.countInBars || 0, onChange: (v) => { set({ countInBars: Number(v) }); ui.set({ countIn: Number(v) > 0 }); } })),
    row('Pre-roll', select({ options: bars(), value: pr.preRollBars || 0, onChange: (v) => set({ preRollBars: Number(v) }) }), h('span.rec-hint', 'playback starts this much before the record-in point')),
    row('Post-roll', select({ options: bars(), value: pr.postRollBars || 0, onChange: (v) => set({ postRollBars: Number(v) }) }), h('span.rec-hint', 'after the punch-out, then stop')),
    row('Punch in / out', punchOn, h('span.rec-hint', 'bar'), barField(punch.start, 'start'), h('span.rec-hint', 'to'), barField(punch.end, 'end')),
    row('Cycle', h('span.rec-hint', p.loop?.enabled ? 'Loop is on: every loop pass becomes a new take (audio and, in “takes” mode, MIDI).' : 'Turn the loop on (L) to record a new take on every pass.')),
  );

  // ---------------------------------------------------------------- MIDI
  const midi = h('div.rec-sec',
    h('h3', 'MIDI'),
    row('Song-mode recording', select({ options: [
      { value: 'overdub', label: 'Overdub — add to the clips there' }, { value: 'replace', label: 'Replace — clear the recorded range' },
      { value: 'takes', label: 'Takes — new take per pass (comp them)' }, { value: 'merge', label: 'Merge — every cycle pass into one clip' },
    ], value: pr.midiMode || 'overdub', onChange: (v) => set({ midiMode: v }) })),
    row('Input quantize', select({ options: QUANTIZE_OPTIONS, value: QUANTIZE_OPTIONS.find((o) => Math.abs(o.value - (pr.inputQuantize || 0)) < 1e-6)?.value ?? 0, onChange: (v) => set({ inputQuantize: Number(v) }) }),
      toggle({ label: 'lengths too', value: !!pr.quantizeLength, onChange: (v) => set({ quantizeLength: v }) })),
    row('Capture MIDI', button('Capture what I just played', () => { rec.captureMidi(); }, { cls: 'small', title: 'Retrospective record: the last 2 minutes of notes are always kept (Shift+R)' })),
    row('Step input', toggle({ label: ui.get('stepInput') ? 'On' : 'Off', value: !!ui.get('stepInput'), title: 'With the transport stopped, each note / chord you play goes in at the step cursor of the selected pattern', onChange: (v) => { rec.setStepMode(v); } }),
      select({ options: [{ value: 1, label: '1/4' }, { value: 0.5, label: '1/8' }, { value: 0.25, label: '1/16' }, { value: 0.125, label: '1/32' }], value: pr.stepLength || 0.25, onChange: (v) => { set({ stepLength: Number(v) }); if (rec.step) rec.step.step = Number(v); } }),
      button('Rest', () => rec.stepRest(), { cls: 'small' }), button('Back', () => rec.stepBack(), { cls: 'small' })),
  );

  // ---------------------------------------------------------------- audio inputs
  const srcOpts = sources.map((s) => ({ value: s.id, label: s.label }));
  const audioTracks = p.tracks.filter((t) => t.type === 'audio');
  const upd = (id, label, fn) => app.actions.updateTrack(id, fn, label);
  const trackRows = audioTracks.length ? audioTracks.map((t) => {
    const cur = t.recInput?.source || DEFAULT_SOURCE;
    const n = rec.inputs.sources.get(cur)?.channels || 2;
    const chans = trackChannels(t, n);
    const chOpts = [];
    for (let c = 0; c < Math.max(2, n); c++) chOpts.push({ value: `${c}`, label: `Mono ${c + 1}` });
    for (let c = 0; c + 1 < Math.max(2, n); c += 2) chOpts.push({ value: `${c},${c + 1}`, label: `Stereo ${c + 1}–${c + 2}` });
    const lat = rec.inputs.monitorLatencyMs(t.id);
    return h('div.rec-track',
      h('span.rec-tname', { style: { borderLeftColor: t.color } }, t.name, t.arm ? h('span.rec-armed', ' ● armed') : null),
      select({ options: srcOpts, value: cur, onChange: (v) => upd(t.id, 'Input device', (tt) => { tt.recInput = { source: v, channels: tt.recInput?.channels }; }) }),
      select({ options: chOpts, value: chans.join(','), onChange: (v) => upd(t.id, 'Input channel', (tt) => { tt.recInput = { source: tt.recInput?.source || DEFAULT_SOURCE, channels: String(v).split(',').map(Number) }; }) }),
      select({ options: [{ value: 'off', label: 'Monitor: off' }, { value: 'auto', label: 'Monitor: auto' }, { value: 'on', label: 'Monitor: on' }], value: t.monitor || 'off', onChange: (v) => upd(t.id, 'Monitoring', (tt) => { tt.monitor = v; }) }),
      h('span.rec-hint', lat != null ? `≈ ${lat.toFixed(1)} ms monitor latency` : ''),
    );
  }) : [h('p.rec-hint', 'No audio tracks yet — add one (Track ▸ Audio) and arm it (●) to record from a microphone or interface.')];
  const inputs = h('div.rec-sec',
    h('h3', 'Audio inputs'),
    ...trackRows,
    row('Low-latency monitoring', toggle({ label: pr.lowLatencyMonitor ? 'On' : 'Off', value: !!pr.lowLatencyMonitor, title: 'Monitor straight to the output: skips the track\'s effects and their plugin delay', onChange: (v) => set({ lowLatencyMonitor: v }) })),
  );

  // ---------------------------------------------------------------- latency
  const latBody = h('div');
  const renderLat = () => {
    latBody.replaceChildren(...sources.filter((s) => s.id === DEFAULT_SOURCE || audioTracks.some((t) => (t.recInput?.source || DEFAULT_SOURCE) === s.id)).map((s) => {
      const d = deviceLatency(s.id);
      const est = rec.inputs.estimateRoundTrip(s.id);
      const eff = roundTrip({ estimate: est, calibratedMs: d.calibratedMs ?? null, manualMs: d.manualMs || 0 }) * 1000;
      const status = h('span.rec-hint', d.calibratedMs != null ? `measured ${d.calibratedMs.toFixed(1)} ms` : `browser estimate ${(est * 1000).toFixed(1)} ms`);
      const measure = button('Measure (ping)', async () => {
        status.textContent = 'Measuring… connect the output to this input (or hold the mic to the speaker)';
        const r = await rec.calibrate(s.id);
        if (r.ok) { toast(`Round-trip latency of ${s.label}: ${r.ms.toFixed(1)} ms (${r.hits} pings)`, { level: 'success' }); renderLat(); }
        else { status.textContent = r.message; }
      }, { cls: 'small', title: 'Loopback calibration: plays short pings and finds them in the input' });
      const reset = button('Use estimate', () => { setDeviceLatency(s.id, { calibratedMs: null }); renderLat(); }, { cls: 'small' });
      const manual = numberField({ value: d.manualMs || 0, min: -200, max: 500, step: 0.1, width: 64, title: 'Manual offset (ms) added on top: positive = takes move earlier', onChange: (v) => { setDeviceLatency(s.id, { manualMs: v }); renderLat(); } });
      return h('div.rec-track', h('span.rec-tname', s.label), status, measure, reset, h('span.rec-hint', 'offset ms'), manual, h('b.rec-eff', `→ ${eff.toFixed(1)} ms`));
    }));
  };
  renderLat();
  const latency = h('div.rec-sec', h('h3', 'Record latency compensation'), h('p.rec-hint', 'Takes are moved earlier by the round trip (output → your ears → input) so they land on the grid sample-accurately. Measured per input device and kept in this browser.'), latBody);

  modal({ title: 'Recording settings', body: h('div.rec-panel', transport, inputs, latency, midi), width: 760, actions: [{ label: 'Done', primary: true }] });
}
