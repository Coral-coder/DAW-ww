// Browser-only dialogs for the interchange formats (lazy-loaded from src/ui/actions.js — never
// imported by Node tests). ctx = { app, ensureAudio, loadProjectObject, selectTrack }.
import { h } from '../../ui/dom.js';
import { modal, toast, fileInput, select, confirmDialog } from '../../ui/components.js';
import { downloadBlob, safeFileName } from '../project-file.js';
import { encodeWav } from '../wav.js';
import { saveLocal } from '../autosave.js';
import { renderOffline, decodeAllSamples } from '../../audio/render.js';
import { writeZip } from './zip.js';
import { exportDawproject, importDawproject, summarizeReport, DAWPROJECT_EXTENSION } from './dawproject.js';
import { renderStems, buildMixBundle, stemRenderPlan } from './stems.js';
import { exportMusicXml, readMusicXmlFile, addMusicXmlToProject, melodyTrack } from './musicxml.js';

const checkbox = (label, value, onChange) => {
  const input = h('input', { type: 'checkbox', checked: !!value });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label.row', { style: { gap: '8px', alignItems: 'center', cursor: 'pointer' } }, input, h('span', label));
};
const field = (label, control) => h('label.col', { style: { gap: '4px' } }, h('span.muted', label), control);
const progressBox = (text) => {
  const bar = h('div.progress', h('div'));
  const msg = h('p', text);
  const m = modal({ title: 'Exporting…', body: h('div.col', msg, bar) });
  return {
    set(frac, t) { bar.firstChild.style.width = `${Math.round(Math.max(0.03, Math.min(1, frac)) * 100)}%`; if (t) msg.textContent = t; },
    close: () => m.close(),
  };
};

/** Lists everything that didn't transfer 1:1 (only when there is something to say). */
function showReport(title, report) {
  const sections = [['Mapped to the nearest equivalent', report.mapped.filter((s) => !/: automation "/.test(s))], ['Placeholders', report.placeholders], ['Not transferred', report.unmapped], ['Notes', report.warnings]]
    .filter(([, list]) => list.length);
  if (!sections.length) return;
  modal({
    title, width: 640,
    body: h('div.col', { style: { maxHeight: '60vh', overflow: 'auto', gap: '10px' } }, sections.map(([head, list]) => h('div',
      h('strong', `${head} (${list.length})`),
      h('ul', { style: { margin: '4px 0 0 18px', padding: 0 } }, list.slice(0, 200).map((s) => h('li', s)))))),
    actions: [{ label: 'OK', primary: true }],
  });
}

const renderWith = (ctx, sampleRate) => (variant, o) => renderOffline(variant, {
  ...o, sampleRate, sampleCache: ctx.app.engine?.buffers || new Map(), onError: (e) => console.warn('[interchange render]', e),
});

const bufferToWav = (buffer, bitDepth = 24) => new Uint8Array(encodeWav(buffer, { bitDepth }));

// ------------------------------------------------------------------------------- DAWproject

export async function exportDawprojectDialog(ctx) {
  const p = ctx.app.store.get();
  const inst = p.tracks.filter((t) => (t.type === 'instrument' || t.type === 'code') && !t.mute);
  let renderAudio = inst.length > 0;
  let sampleRate = 48000;
  modal({
    title: 'Export DAWproject (.dawproject)', width: 560,
    body: h('div.col', { style: { gap: '12px' } },
      h('p.muted', 'Opens in Bitwig Studio, Studio One, Cubase and other DAWs that read DAWproject 1.0: tracks, mixer, sends, clips, notes, automation, tempo and markers. daW³ instruments travel as named placeholders.'),
      checkbox(`Render instrument tracks to audio alongside MIDI (${inst.length} track${inst.length === 1 ? '' : 's'}) — the project opens playable`, renderAudio, (v) => { renderAudio = v; }),
      field('Sample rate of rendered audio', select({ options: [{ value: 44100, label: '44.1 kHz' }, { value: 48000, label: '48 kHz' }], value: sampleRate, onChange: (v) => { sampleRate = Number(v); } }))),
    actions: [{ label: 'Cancel' }, { label: 'Export', primary: true, onClick: () => { runDawprojectExport(ctx, { renderAudio, sampleRate }); } }],
  });
}

async function runDawprojectExport(ctx, { renderAudio, sampleRate }) {
  const p = ctx.app.store.get();
  const prog = progressBox('Preparing…');
  try {
    const cache = ctx.app.engine?.buffers || new Map();
    await decodeAllSamples(p, cache, sampleRate).catch(() => {});
    const sampleInfo = {};
    for (const id of Object.keys(p.samples || {})) {
      const b = cache.get(id);
      if (b) sampleInfo[id] = { duration: b.duration, channels: b.numberOfChannels, sampleRate: b.sampleRate };
    }
    const renders = {};
    if (renderAudio) {
      const ids = p.tracks.filter((t) => (t.type === 'instrument' || t.type === 'code') && !t.mute).map((t) => t.id);
      if (ids.length) {
        const stems = await renderStems(p, {
          tap: 'post-insert', trackIds: ids, tail: 2, render: renderWith(ctx, sampleRate),
          onProgress: (i, n, t) => prog.set(0.05 + 0.85 * (i / Math.max(1, n)), t ? `Rendering "${t.name}" (${i + 1}/${n})…` : 'Packing…'),
        });
        for (const s of stems) renders[s.track.id] = { data: bufferToWav(s.buffer, 24), sampleRate: s.buffer.sampleRate, channels: s.buffer.numberOfChannels, duration: s.buffer.duration };
      }
    }
    prog.set(0.95, 'Packing…');
    const { bytes, report } = await exportDawproject(p, { renders, sampleInfo });
    downloadBlob(new Blob([bytes], { type: 'application/zip' }), `${safeFileName(p.name, 'project')}${DAWPROJECT_EXTENSION}`);
    toast(`DAWproject exported${Object.keys(renders).length ? ` with ${Object.keys(renders).length} rendered audio track(s)` : ''}. ${report.unmapped.length ? summarizeReport(report, { max: 1 }) : ''}`, { level: 'success', timeout: 6000 });
    if (report.unmapped.length || report.warnings.length) showReport('DAWproject export — details', report);
  } catch (e) {
    console.error(e);
    toast('DAWproject export failed: ' + e.message, { level: 'error', timeout: 8000 });
  } finally {
    prog.close();
  }
}

export async function importDawprojectFile(ctx, file) {
  if (!(file instanceof Blob)) [file] = await fileInput(`${DAWPROJECT_EXTENSION},application/zip`);
  if (!file) return;
  try {
    const { project, report } = await importDawproject(new Uint8Array(await file.arrayBuffer()), { name: String(file.name || '').replace(/\.[^.]+$/, '') });
    const cur = ctx.app.store.get();
    if (cur.tracks.length && !(await confirmDialog('Open DAWproject', `Replace the current project with "${project.name}"? The current one stays in the browser's recent projects.`))) return;
    await saveLocal(cur).catch(() => {});
    ctx.loadProjectObject(project, 'Imported DAWproject');
    const issues = report.placeholders.length + report.unmapped.length + report.warnings.length + report.mapped.filter((s) => !/: automation "/.test(s)).length;
    toast(`${report.exported[0] || 'Imported'}. ${summarizeReport(report, { max: 2 })}`, { level: issues ? 'warn' : 'success', timeout: 9000 });
    if (issues) showReport('DAWproject import — what changed', report);
  } catch (e) {
    console.error(e);
    toast('DAWproject import failed: ' + e.message, { level: 'error', timeout: 8000 });
  }
}

// ------------------------------------------------------------------- stems + MIDI bundle

export async function exportMixBundleDialog(ctx) {
  const p = ctx.app.store.get();
  const plan = stemRenderPlan(p);
  const opts = { tap: 'post-fader', bitDepth: 24, sampleRate: 48000, includeMidi: true };
  modal({
    title: 'Export for mixing engineer', width: 560,
    body: h('div.col', { style: { gap: '12px' } },
      h('p.muted', `${plan.tracks.length} stem(s), all from bar 1 with the same length, + MIDI file, tempo map and README in one ZIP.`),
      field('Stems', select({ options: [{ value: 'post-fader', label: 'Post-fader, pre-master (fader, pan, automation, sends printed)' }, { value: 'post-insert', label: 'Post-insert, pre-fader (dry of fader / sends — engineer rebalances)' }], value: opts.tap, onChange: (v) => { opts.tap = v; } })),
      field('Bit depth', select({ options: [{ value: 16, label: '16-bit' }, { value: 24, label: '24-bit' }, { value: 32, label: '32-bit float' }], value: opts.bitDepth, onChange: (v) => { opts.bitDepth = Number(v); } })),
      field('Sample rate', select({ options: [{ value: 44100, label: '44.1 kHz' }, { value: 48000, label: '48 kHz' }, { value: 96000, label: '96 kHz' }], value: opts.sampleRate, onChange: (v) => { opts.sampleRate = Number(v); } })),
      checkbox('Include MIDI file of all note parts', opts.includeMidi, (v) => { opts.includeMidi = v; })),
    actions: [{ label: 'Cancel' }, { label: 'Export ZIP', primary: true, onClick: () => { runMixBundle(ctx, opts); } }],
  });
}

async function runMixBundle(ctx, opts) {
  const p = ctx.app.store.get();
  const prog = progressBox('Rendering stems…');
  try {
    const stems = await renderStems(p, {
      tap: opts.tap, tail: 2, render: renderWith(ctx, opts.sampleRate),
      onProgress: (i, n, t) => prog.set(0.9 * (i / Math.max(1, n)), t ? `Rendering "${t.name}" (${i + 1}/${n})…` : 'Packing…'),
    });
    if (!stems.length) { toast('Nothing to export — no unmuted track has content.', { level: 'warn' }); return; }
    const plan = stemRenderPlan(p);
    const entries = buildMixBundle(p, {
      stems: stems.map((s) => ({ track: s.track, wav: bufferToWav(s.buffer, opts.bitDepth) })),
      sampleRate: opts.sampleRate, bitDepth: opts.bitDepth, tap: opts.tap, lengthSec: stems[0].buffer.duration, endBeat: plan.endBeat, includeMidi: opts.includeMidi,
    });
    prog.set(0.95, 'Packing…');
    const zip = await writeZip(entries);
    downloadBlob(new Blob([zip], { type: 'application/zip' }), `${safeFileName(p.name, 'Mix')} - stems.zip`);
    toast(`Exported ${stems.length} stem(s) + ${opts.includeMidi ? 'MIDI, ' : ''}tempo map and README`, { level: 'success' });
  } catch (e) {
    console.error(e);
    toast('Stem export failed: ' + e.message, { level: 'error', timeout: 8000 });
  } finally {
    prog.close();
  }
}

// ------------------------------------------------------------------------------- MusicXML

export async function exportMusicXmlDialog(ctx) {
  const p = ctx.app.store.get();
  const melodic = p.tracks.filter((t) => t.type === 'instrument' && t.instrument?.type !== 'drums' && t.instrument?.type !== 'drumsampler');
  if (!melodic.length) { toast('No melodic instrument track to write as a lead sheet.', { level: 'warn' }); return; }
  let trackId = melodyTrack(p)?.id || melodic[0].id;
  let withChords = true;
  modal({
    title: 'Export MusicXML lead sheet', width: 520,
    body: h('div.col', { style: { gap: '12px' } },
      h('p.muted', 'Melody (top line) with chord symbols from the chords / pad track — opens in MuseScore, Dorico, Sibelius, Finale.'),
      field('Melody track', select({ options: melodic.map((t) => ({ value: t.id, label: t.name })), value: trackId, onChange: (v) => { trackId = v; } })),
      checkbox('Chord symbols from the project\'s harmony', withChords, (v) => { withChords = v; })),
    actions: [{ label: 'Cancel' }, {
      label: 'Export', primary: true, onClick: () => {
        const out = exportMusicXml(p, { trackId, ...(withChords ? {} : { chords: [] }) });
        downloadBlob(new Blob([out.xml], { type: 'application/vnd.recordare.musicxml+xml' }), `${safeFileName(p.name, 'lead sheet')}.musicxml`);
        const w = out.report.warnings.filter((s) => withChords || !/chord/i.test(s));
        toast(`MusicXML exported (${out.chords.length} chord symbol(s)).${w.length ? ' ' + w.join(' ') : ''}`, { level: w.length ? 'warn' : 'success', timeout: 6000 });
      },
    }],
  });
}

export async function importMusicXmlFile(ctx, file) {
  if (!(file instanceof Blob)) [file] = await fileInput('.musicxml,.mxl,.xml,application/vnd.recordare.musicxml+xml');
  if (!file) return;
  try {
    const parsed = await readMusicXmlFile(new Uint8Array(await file.arrayBuffer()));
    const notes = parsed.parts.reduce((s, part) => s + part.notes.length, 0);
    if (!notes) { toast('No pitched notes found in that MusicXML file.', { level: 'warn' }); return; }
    let ids = [];
    ctx.app.store.transact('Import MusicXML', (pp) => {
      ({ trackIds: ids } = addMusicXmlToProject(pp, parsed, { setTempo: !pp.tracks.length }));
    });
    if (ids[0]) ctx.selectTrack?.(ids[0]);
    toast(`Imported ${parsed.parts.filter((pt) => pt.notes.length).length} part(s), ${notes} note(s)${parsed.chords.length ? ` and ${parsed.chords.length} chord symbol(s)` : ''}.${parsed.report.warnings.length ? ' ' + parsed.report.warnings.join(' ') : ''}`, { level: 'success', timeout: 6000 });
  } catch (e) {
    console.error(e);
    toast('MusicXML import failed: ' + e.message, { level: 'error', timeout: 8000 });
  }
}
