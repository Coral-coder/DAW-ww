// Pro export dialog (File ▸ Export ▸ Export audio…, Ctrl+E): format / bit depth / dither, sample rate, normalisation
// (peak or LUFS target with delivery presets + true-peak ceiling), range, tail, stems, metadata, naming template, and
// an export report (LUFS, true peak, LRA, duration) after the render. The work is done by src/audio/export.js.
import { h, clear } from './dom.js';
import { modal, button, toast } from './components.js';
import { EXPORT_FORMATS, EXPORT_SAMPLE_RATES, DITHER_OPTIONS, EXPORT_DEFAULTS, resolveRange, clipSpan, formatFileName, stemTargets } from '../io/export-plan.js';
import { LOUDNESS_PRESETS } from '../audio/dsp/loudness.js';
import { downloadBlob } from '../io/project-file.js';
import { groupSelection } from '../core/mixer-model.js';

const LS = 'daw3-export';
const load = () => { try { return { ...EXPORT_DEFAULTS, ...JSON.parse(localStorage.getItem(LS) || '{}') }; } catch { return { ...EXPORT_DEFAULTS }; } };
const save = (o) => { try { const { selection, selectedIds, ...rest } = o; localStorage.setItem(LS, JSON.stringify(rest)); } catch { /* */ } };

function sel(options, value, onChange, title) {
  const el = h('select', { title }, options.map((o) => h('option', { value: String(o.value), disabled: !!o.disabled }, o.label)));
  el.value = String(value);
  el.addEventListener('change', () => onChange(el.value));
  return el;
}
const row = (label, ...controls) => h('label.xp-row', h('span.xp-label', label), h('span.xp-ctl', ...controls));
const num = (value, onChange, { step = 0.1, min, max, width = 64, title } = {}) => {
  const el = h('input', { type: 'number', step, min, max, value, title, style: { width: width + 'px' } });
  el.addEventListener('input', () => { const v = parseFloat(el.value); if (Number.isFinite(v)) onChange(v); });
  return el;
};
const text = (value, onChange, placeholder = '', width = 220) => {
  const el = h('input', { type: 'text', value: value || '', placeholder, style: { width: width + 'px' } });
  el.addEventListener('input', () => onChange(el.value));
  return el;
};
const check = (label, value, onChange, title) => {
  const el = h('input', { type: 'checkbox', checked: !!value });
  el.addEventListener('change', () => onChange(el.checked));
  return h('label.xp-check', { title }, el, h('span', label));
};

/** Open the export dialog. opts.stems preselects a stem export. */
export async function openExportDialog(app, { stems = false } = {}) {
  const { store, engine, ui } = app;
  await app.actions?.ensureAudio?.();
  const o = load();
  if (stems && o.stems === 'none') o.stems = 'all';
  const p = store.get();
  const lossy = await import('../audio/export.js').then((m) => m.lossyFormats()).catch(() => []);
  if (EXPORT_FORMATS.find((f) => f.id === o.format)?.lossy && !lossy.includes(o.format)) o.format = 'wav24';
  const selClips = ui.get('selectedClipIds') || [];
  const selection = clipSpan(p, selClips);
  const selTrack = ui.get('selectedTrackId');
  const selectedIds = selTrack ? groupSelection(p, selTrack) : [];
  if (o.range === 'selection' && !selection) o.range = 'song';

  const body = h('div.xp');
  const preview = h('div.xp-preview');
  const summary = h('div.xp-summary');
  const set = (k, v) => { o[k] = v; save(o); refresh(); };

  function refresh() {
    clear(body);
    const fmt = EXPORT_FORMATS.find((f) => f.id === o.format) || EXPORT_FORMATS[1];
    const formats = EXPORT_FORMATS.filter((f) => !f.lossy || lossy.includes(f.id)).map((f) => ({ value: f.id, label: f.label }));
    const presetOpts = [...LOUDNESS_PRESETS.map((x) => ({ value: x.id, label: x.label })), { value: 'custom', label: 'Custom…' }];
    const r = resolveRange(p, { range: o.range, selection, custom: o.custom });
    const targets = o.stems !== 'none' ? stemTargets(p, { which: o.stems, selectedIds }) : [];
    body.append(
      h('div.xp-section', h('h3', 'Format'),
        row('Format', sel(formats, o.format, (v) => set('format', v), 'File format (lossy formats appear when this browser can encode them)')),
        !fmt.lossy && fmt.bitDepth !== 32 ? row('Dither', sel(DITHER_OPTIONS.map((d) => ({ value: d.id, label: d.label })), o.dither, (v) => set('dither', v), 'Dither / noise shaping for the integer formats')) : null,
        row('Sample rate', sel(EXPORT_SAMPLE_RATES.map((s) => ({ value: s, label: `${(s / 1000).toFixed(1).replace('.0', '')} kHz` })), o.sampleRate, (v) => set('sampleRate', +v), 'Rendered offline at this rate')),
      ),
      h('div.xp-section', h('h3', 'Loudness'),
        row('Normalize', sel([{ value: 'off', label: 'Off' }, { value: 'peak', label: 'Peak (true peak)' }, { value: 'lufs', label: 'Loudness target (LUFS)' }], o.normalize, (v) => set('normalize', v))),
        o.normalize === 'lufs' ? row('Target', sel(presetOpts, o.preset, (v) => {
          const pr = LOUDNESS_PRESETS.find((x) => x.id === v);
          o.preset = v;
          if (pr) { o.target = pr.lufs; o.ceiling = pr.ceiling; }
          save(o); refresh();
        }), num(o.target, (v) => { o.target = v; o.preset = 'custom'; save(o); updSummary(); }, { min: -40, max: -3, title: 'Integrated loudness target (LUFS)' }), h('span.muted', 'LUFS')) : null,
        o.normalize === 'peak' ? row('Peak', num(o.target > -0.01 ? -1 : Math.min(0, o.target), (v) => { o.target = v; save(o); updSummary(); }, { min: -24, max: 0, title: 'True-peak level (dBTP)' }), h('span.muted', 'dBTP')) : null,
        row('True-peak ceiling', num(o.ceiling, (v) => { o.ceiling = v; save(o); updSummary(); }, { min: -6, max: 0, title: 'Look-ahead true-peak limiter ceiling (dBTP)' }), h('span.muted', 'dBTP'),
          o.normalize === 'off' ? check('limit', o.limit, (v) => set('limit', v), 'Apply the true-peak limiter even without normalisation') : null),
      ),
      h('div.xp-section', h('h3', 'Range'),
        row('Range', sel([{ value: 'song', label: 'Whole song' }, { value: 'loop', label: 'Loop region' }, { value: 'selection', label: selection ? 'Selected clips' : 'Selected clips (none)', disabled: !selection }, { value: 'custom', label: 'Custom bars…' }], o.range, (v) => set('range', v))),
        o.range === 'custom' ? row('Bars', num(o.custom?.start ?? 1, (v) => { o.custom = { ...(o.custom || { end: 9 }), start: Math.max(1, Math.round(v)) }; save(o); updSummary(); }, { step: 1, min: 1, width: 56 }), h('span.muted', 'to'), num(o.custom?.end ?? 9, (v) => { o.custom = { ...(o.custom || { start: 1 }), end: Math.max(2, Math.round(v)) }; save(o); updSummary(); }, { step: 1, min: 2, width: 56 })) : null,
        row('Tail', sel([{ value: 'auto', label: 'Auto (detect reverb / delay tail)' }, { value: 'none', label: 'None (cut at the end)' }, { value: '2', label: '2 s' }, { value: '5', label: '5 s' }], String(o.tail), (v) => set('tail', v))),
        h('div.xp-hint', `${r.label}: beats ${+r.startBeat.toFixed(2)}–${+r.endBeat.toFixed(2)} (${((r.endBeat - r.startBeat) * 60 / p.bpm).toFixed(1)} s) · ${r.mode} mode`),
      ),
      h('div.xp-section', h('h3', 'Stems'),
        row('Mixdown', check('stereo mix', o.mixdown !== false, (v) => set('mixdown', v))),
        row('Stems', sel([{ value: 'none', label: 'No stems' }, { value: 'all', label: 'All tracks' }, { value: 'selected', label: `Selected track${selectedIds.length > 1 ? 's (group)' : ''}`, disabled: !selectedIds.length }, { value: 'buses', label: 'Buses (returns / folders)' }, { value: 'groups', label: 'Groups' }], o.stems, (v) => set('stems', v))),
        o.stems !== 'none' ? row('Stem tap', sel([{ value: 'post', label: 'Post-fader (with sends)' }, { value: 'pre', label: 'Pre-fader (dry, unity)' }], o.stemTap, (v) => set('stemTap', v)), check('through master chain', o.stemMaster, (v) => set('stemMaster', v), 'Process every stem through the master effects')) : null,
        o.stems !== 'none' ? h('div.xp-hint', `${targets.length} stem${targets.length === 1 ? '' : 's'}: ${targets.map((t) => t.name).join(', ') || '—'} · all files start together and have the same length`) : null,
      ),
      h('div.xp-section', h('h3', 'Metadata & names'),
        row('Title', text(o.title, (v) => { o.title = v; save(o); updSummary(); }, p.name)),
        row('Artist', text(o.artist, (v) => { o.artist = v; save(o); updSummary(); })),
        row('ISRC', text(o.isrc, (v) => { o.isrc = v; save(o); }, 'CC-XXX-YY-NNNNN', 160)),
        row('File name', text(o.nameTemplate, (v) => { o.nameTemplate = v; save(o); updSummary(); }, '{project}')),
        o.stems !== 'none' ? row('Stem names', text(o.stemTemplate, (v) => { o.stemTemplate = v; save(o); updSummary(); }, '{project} - {n} {stem}')) : null,
        h('div.xp-hint', 'Tokens: {project} {title} {artist} {stem} {n} {bpm} {key} {date} {time} {sr} {bits} {lufs} {range}'),
      ),
      summary, preview,
    );
    updSummary();
  }

  function updSummary() {
    const fmt = EXPORT_FORMATS.find((f) => f.id === o.format) || EXPORT_FORMATS[1];
    const vars = { project: p, title: o.title, artist: o.artist, sampleRate: o.sampleRate, bits: fmt.bitDepth ? (fmt.bitDepth === 32 ? '32f' : `${fmt.bitDepth}bit`) : fmt.id };
    const first = stemTargets(p, { which: o.stems === 'none' ? 'all' : o.stems, selectedIds })[0];
    clear(summary);
    summary.append(...[
      o.mixdown !== false ? h('div', h('span.muted', 'File: '), `${formatFileName(o.nameTemplate, vars)}.${fmt.ext}`) : null,
      o.stems !== 'none' && first ? h('div', h('span.muted', 'Stem: '), `${formatFileName(o.stemTemplate, { ...vars, n: 1, stem: first.name })}.${fmt.ext}`) : null,
      h('div', h('span.muted', 'Loudness: '), o.normalize === 'lufs' ? `${o.target} LUFS integrated, true peak ≤ ${o.ceiling} dBTP` : o.normalize === 'peak' ? `true peak at ${o.target > -0.01 ? -1 : o.target} dBTP` : o.limit ? `as mixed, true peak ≤ ${o.ceiling} dBTP` : 'as mixed (no processing)'),
    ].filter(Boolean));
  }

  let busy = false;
  const go = async () => {
    if (busy) return false;
    busy = true;
    const bar = h('div.progress', h('div'));
    const status = h('div.xp-status', 'Preparing…');
    clear(preview);
    preview.append(status, bar);
    preview.scrollIntoView({ block: 'end', behavior: 'smooth' });
    try {
      const { runExport } = await import('../audio/export.js');
      const { renderOffline } = await import('../audio/render.js');
      const opts = { ...o, selection, selectedIds, target: o.normalize === 'peak' ? (o.target > -0.01 ? -1 : o.target) : o.target };
      let noticed = false;
      const res = await runExport({
        project: store.get(),
        opts,
        render: (proj, ro) => renderOffline(proj, { ...ro, sampleCache: engine.buffers, onError: (e) => console.warn('[export]', e), onNotice: (msg) => { if (!noticed) toast(msg, { level: 'warn', timeout: 9000 }); noticed = true; } }),
        onProgress: (f, msg) => { bar.firstChild.style.width = `${Math.round(f * 100)}%`; status.textContent = msg; },
      });
      const files = res.files;
      if (files.length > 1) {
        const { writeZip } = await import('../io/interchange/zip.js');
        const base = formatFileName(o.nameTemplate, { project: p, title: o.title, artist: o.artist });
        const zip = await writeZip([...files.map((f) => ({ name: f.name, data: new Uint8Array(f.data), compress: false })), { name: 'export-report.txt', data: res.report.text }]);
        downloadBlob(new Blob([zip], { type: 'application/zip' }), `${base}.zip`);
      } else if (files.length) {
        downloadBlob(new Blob([files[0].data], { type: files[0].mime }), files[0].name);
      }
      app.lastExport = res; // (tests / automation)
      showReport(res);
      toast(`Exported ${files.length} file${files.length === 1 ? '' : 's'}`, { level: 'success' });
    } catch (e) {
      console.error(e);
      status.textContent = 'Export failed: ' + (e.message || e);
      toast('Export failed: ' + (e.message || e), { level: 'error', timeout: 7000 });
    } finally {
      busy = false;
    }
    return false;
  };

  function showReport(res) {
    clear(preview);
    const rep = res.report;
    const tbl = (rows) => h('table.xp-report', rows.map(([k, v]) => h('tr', h('td', k), h('td', v))));
    preview.append(h('h3', 'Export report'));
    if (rep.mix) preview.append(h('div.xp-file', rep.mix.name), tbl(rep.mix.rows));
    if (rep.stems.length) {
      preview.append(h('table.xp-report.stems', h('tr', h('th', 'Stem'), h('th', 'LUFS'), h('th', 'dBTP')),
        rep.stems.map((s) => h('tr', h('td', s.name), h('td', Number.isFinite(s.measure.integrated) ? s.measure.integrated.toFixed(1) : '−∞'), h('td', Number.isFinite(s.measure.truePeakDb) ? s.measure.truePeakDb.toFixed(1) : '−∞')))));
    }
    requestAnimationFrame(() => preview.scrollIntoView({ block: 'end' }));
    preview.append(button('Copy report', () => navigator.clipboard?.writeText(rep.text).then(() => toast('Report copied')), { cls: 'small' }));
  }

  refresh();
  return modal({ title: 'Export audio', body, width: 640, cls: 'xp-modal', actions: [{ label: 'Close' }, { label: 'Export', primary: true, onClick: go }] });
}
