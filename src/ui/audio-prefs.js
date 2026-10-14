// Audio & Plugin Settings (Mac app only): output / input device, channels, sample rate, buffer size,
// the measured round-trip latency (loopback calibration) and the native plugin folders / scan.
// Talks to window.daw3Native.audio / .plugins; never loaded in the browser.
import { h, clear } from './dom.js';
import { modal, select, toggle, button } from './components.js';
import { SAMPLE_RATES, BUFFER_SIZES, normalizeAudioConfig } from '../native/protocol.js';
import { getNativeClient, nativeAudioApi, nativePluginsApi } from '../native/client.js';
import { FORMAT_LABELS } from '../native/plugin-db.js';

const ms = (frames, sr) => `${((frames / sr) * 1000).toFixed(1)} ms`;

/** Channel-pair options for a device with n channels: [{value: offset, label: '1/2'}]. */
export function channelPairs(n) {
  const out = [];
  for (let i = 0; i + 1 < Math.max(2, n); i += 2) out.push({ value: i, label: `Outputs ${i + 1}/${i + 2}` });
  return out.length ? out : [{ value: 0, label: 'Outputs 1/2' }];
}

export async function openAudioPrefs(app) {
  const api = nativeAudioApi();
  if (!api) { app.toast('Audio settings are part of the daW³ Mac app', { level: 'warn' }); return null; }
  const plugins = nativePluginsApi();
  const body = h('div.aprefs');
  const msg = h('div.plg-msg');
  const setMsg = (t, level = 'info') => { msg.textContent = t || ''; msg.dataset.level = level; };
  let cfg = normalizeAudioConfig(await api.getConfig().catch(() => ({})));
  let devices = { outputs: [], inputs: [] };
  try { devices = await api.listDevices(); } catch (e) { setMsg(`Could not list audio devices: ${e.message}`, 'error'); }
  const statusEl = h('div.aprefs-status');
  const latencyEl = h('div.aprefs-latency');
  const form = h('div.aprefs-form');

  const apply = async (patch, label) => {
    setMsg(`${label || 'Applying'}…`);
    try {
      const r = await api.setConfig(patch);
      cfg = r.config;
      if (r.error) setMsg(r.error, 'error'); else setMsg(label ? `${label}: done` : '');
      const ctx = app.engine?.ctx;
      if (getNativeClient()?.rateMismatch(ctx)) setMsg(`The new sample rate (${cfg.sampleRate} Hz) applies after a reload (View → Reload, or restart daW³).`, 'warn');
    } catch (e) { setMsg(e.message, 'error'); }
    render();
  };

  const devOptions = (list) => [{ value: '', label: 'System default' }, ...list.map((d) => ({ value: d.id, label: `${d.name}${d.isDefault ? ' (default)' : ''} · ${d.maxChannels} ch` }))];
  const findDev = (list, id) => list.find((d) => d.id === id) || list.find((d) => d.isDefault) || list[0] || null;

  function row(label, ctrl, hint) {
    return h('div.aprefs-row', h('label', label), ctrl, hint ? h('span.aprefs-hint', hint) : null);
  }

  function render() {
    clear(form);
    const out = findDev(devices.outputs, cfg.outputId);
    const inp = findDev(devices.inputs, cfg.inputId);
    const outCh = Math.max(2, out?.maxChannels || 2);
    const inCh = Math.max(1, inp?.maxChannels || 2);
    const rates = (out?.sampleRates?.length ? out.sampleRates : SAMPLE_RATES).filter((r) => SAMPLE_RATES.includes(r));
    form.append(
      row('Native audio engine', toggle({ label: cfg.enabled ? 'On' : 'Off', value: cfg.enabled, onChange: (v) => apply({ enabled: v }, v ? 'Starting the audio device' : 'Stopping') }),
        'Plays daW³ through the device below (instead of the macOS default output), with your interface’s channels and buffer size.'),
      row('Output device', select({ options: devOptions(devices.outputs), value: cfg.outputId, onChange: (v) => apply({ outputId: v, deviceOutChannels: findDev(devices.outputs, v)?.maxChannels || 2, outOffset: 0 }, 'Output device') })),
      row('Output channels', select({ options: channelPairs(outCh), value: cfg.outOffset, onChange: (v) => apply({ outOffset: Number(v), deviceOutChannels: outCh }, 'Output channels') }), `${outCh} channels on this device`),
      row('Input device', select({ options: [{ value: '__off', label: 'No input' }, ...devOptions(devices.inputs)], value: cfg.inputEnabled ? cfg.inputId : '__off',
        onChange: (v) => apply(v === '__off' ? { inputEnabled: false } : { inputEnabled: true, inputId: v, deviceInChannels: findDev(devices.inputs, v)?.maxChannels || 2 }, 'Input device') })),
      row('Input channels', select({ options: Array.from({ length: Math.min(64, inCh) }, (_, i) => ({ value: i + 1, label: `${i + 1} channel${i ? 's' : ''}` })), value: Math.min(cfg.deviceInChannels, inCh),
        onChange: (v) => apply({ deviceInChannels: Number(v) }, 'Input channels') }), 'Every channel opened here is available for recording.'),
      row('Sample rate', select({ options: rates.map((r) => ({ value: r, label: `${r / 1000} kHz` })), value: cfg.sampleRate, onChange: (v) => apply({ sampleRate: Number(v) }, 'Sample rate') })),
      row('Buffer size', select({ options: BUFFER_SIZES.map((b) => ({ value: b, label: `${b} samples (${ms(b, cfg.sampleRate)})` })), value: cfg.bufferFrames, onChange: (v) => apply({ bufferFrames: Number(v) }, 'Buffer size') }),
        'Smaller = lower latency, more CPU. Raise it if you hear clicks.'),
    );
    renderLatency();
  }

  function renderLatency() {
    clear(latencyEl);
    const measured = cfg.latencyMs != null ? `${cfg.latencyMs.toFixed(1)} ms (${cfg.latencySamples} samples) measured` : 'not measured yet';
    latencyEl.append(
      h('div', h('b', 'Round-trip latency: '), measured),
      h('div.aprefs-hint', 'Connect an output of your interface to an input with a cable (or hold the mic near a speaker), then Measure. Recordings are shifted by this amount.'),
      button('Measure (loopback ping)', async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        setMsg('Measuring… (a short chirp plays on the selected output)');
        try {
          const r = await api.calibrate({ outChannel: cfg.outOffset, inChannel: 0 });
          setMsg(r.message, r.ok ? 'info' : 'warn');
          cfg = await api.getConfig();
        } catch (err) { setMsg(err.message, 'error'); }
        b.disabled = false;
        renderLatency();
      }, { icon: 'wave', cls: 'small', title: 'Play a chirp and time how long it takes to come back in' }));
  }

  async function refreshStatus() {
    if (!body.isConnected) return;
    try {
      const s = await api.status();
      const c = getNativeClient();
      statusEl.textContent = s.running
        ? `● Running · ${s.outputName || 'output'}${s.inputName ? ` + ${s.inputName}` : ''} · ${s.sampleRate} Hz · buffer ${s.bufferFrames} · ${s.backend} · bridge ≈ ${ms(s.bridgeLatencyFrames, s.sampleRate)} · dropouts ${s.underruns}${c?.stats ? ` · sent ${Math.round(c.stats.outFrames / s.sampleRate)} s` : ''}`
        : s.error ? `○ ${s.error}` : '○ Off — daW³ plays through the macOS default output';
      statusEl.dataset.state = s.running ? 'on' : 'off';
    } catch { statusEl.textContent = '○ The audio server is not running'; }
    setTimeout(refreshStatus, 1000);
  }

  // ---- plugins
  const pluginsEl = h('div.aprefs-plugins');
  async function renderPlugins() {
    clear(pluginsEl);
    if (!plugins) return;
    let r = null;
    try { r = await plugins.list(); } catch { /* */ }
    const counts = {};
    for (const p of r?.plugins || []) counts[p.format] = (counts[p.format] || 0) + 1;
    pluginsEl.append(
      h('h3', 'Plugins (VST3 / Audio Unit / CLAP)'),
      h('div', r?.scannedAt ? `${r.plugins.length} plugins — ${Object.entries(counts).map(([f, n]) => `${n} ${FORMAT_LABELS[f]}`).join(', ') || 'none'} · scanned ${new Date(r.scannedAt).toLocaleString()}` : 'Not scanned yet.'),
      h('div.aprefs-hint', `Folders: ${[...(r?.folders?.vst3 || []), ...(r?.folders?.clap || [])].join(' · ')} · Audio Units: system registry`),
      r?.failed?.length ? h('details', h('summary', `${r.failed.length} could not be loaded`), h('ul', ...r.failed.map((f) => h('li', `${f.path.split('/').pop()} — ${f.error}`)))) : null,
      button('Rescan plugins', async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        const m = await import('./plugins-dialog.js');
        try {
          const s = await m.scanNativePlugins({ force: true, onProgress: (p) => setMsg(`Scanning ${p.done}/${p.total}: ${String(p.path).split('/').pop()}`) });
          setMsg(`${s.count} plugins found${s.failed.length ? `, ${s.failed.length} failed` : ''}`);
        } catch (err) { setMsg(err.message, 'error'); }
        b.disabled = false;
        renderPlugins();
      }, { icon: 'search', cls: 'small' }));
  }

  body.append(statusEl, form, h('div.aprefs-section', latencyEl), h('div.aprefs-section', pluginsEl), msg);
  render();
  renderPlugins();
  const m = modal({ title: 'Audio & Plugin Settings', body, width: 640, cls: 'aprefs-modal' });
  refreshStatus();
  return m;
}
