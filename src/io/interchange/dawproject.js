// DAWproject 1.0 (https://github.com/bitwig/dawproject) export / import — pure, Node-safe.
//
//   buildDawproject(project, opts) -> { projectXml, metadataXml, files:[{path, data, compress}], report }
//   await exportDawproject(project, opts) -> { bytes: Uint8Array (.dawproject ZIP), report }
//   parseDawproject(projectXml, files: Map(path -> Uint8Array), opts) -> { project, report }
//   await importDawproject(bytes, opts) -> { project, report }
//   summarizeReport(report) -> short human text (toasts)
//
// opts (export):
//   renders:    { [trackId]: { data: Uint8Array (WAV), sampleRate, channels, duration (s) } } — rendered audio of
//               instrument / code tracks, written as extra audio tracks next to the MIDI tracks
//               ("Render instrument tracks to audio alongside MIDI"); see ./render-stems.js.
//   sampleInfo: { [sampleId]: { duration, channels, sampleRate } } — decoded media info (WAV headers are parsed
//               automatically; other formats fall back to sample.duration).
//   codec:      ZIP codec override (tests).
//
// Mapping (see docs/ARCHITECTURE.md "Interchange"):
//   track/bus/master       -> <Track><Channel role=regular|effect|master> (Volume linear 0..2, Pan normalized 0..1, Mute, Sends)
//   instrument / code      -> <BuiltinDevice deviceRole="instrument" deviceID="daw3.instrument.<type>"> with every
//                             numeric/enum/bool param as a Parameter + a daW³ State file (plugins/*.json) for exact restore
//   effects                -> <Compressor>/<Limiter>/<NoiseGate>/<Equalizer> where a generic device exists, else
//                             <BuiltinDevice deviceRole="audioFX">; always with the daW³ State file
//   pattern clips          -> <Clip playStart loopStart=0 loopEnd=patternLength><Notes>, notes unrolled over the
//                             played range so importers that ignore loops still play the right notes
//   audio clips            -> <Clip contentTimeUnit="beats" fade*><Warps> (beats->seconds, natural speed) <Audio><File>
//   automation             -> <Points><Target parameter=…> in the owner's arrangement lane (volume, pan, mute, sends,
//                             instrument / effect params, effect on/off); others are reported and omitted
//   tempo / time signature -> <Transport> + <TempoAutomation>/<TimeSignatureAutomation> (project.tempoAutomation /
//                             project.timeSigAutomation, optional), markers -> <Markers>
import { el, toXml, parseXml, child, children, numAttr, boolAttr } from './xml.js';
import { writeZip, readZip, zipText } from './zip.js';
import { wavInfo, extForMime, mimeForPath, safeName, uniqueNamer } from './media.js';
import {
  beatsPerBar, songLengthBeats, createProject, createTrack, createPattern, createNote, createClip, createBus, createEffect,
  createScene, normalizeProject, TRACK_COLORS,
} from '../../core/model.js';
import { uid, dbToGain, gainToDb, clamp } from '../../core/util.js';
import { createAutomationLane, sortPoints } from '../../core/automation.js';
import { INSTRUMENT_DEFS } from '../../audio/defs.js';
import { EFFECT_DEFS } from '../../audio/effect-defs.js';
import { PRESETS, resolveInstrumentDef } from '../../audio/presets.js';
import { DRUM_KITS } from '../../audio/kits.js';
import { codeToPatterns } from '../../code/convert.js';
import { base64ToArrayBuffer, arrayBufferToBase64 } from '../samples.js';

export const DAWPROJECT_EXTENSION = '.dawproject';
export const DAWPROJECT_VERSION = '1.0';
export const APP_NAME = 'daW³';
export const APP_VERSION = '1.0';
const STATE_FORMAT = 'daw3-device';
const RENDERED_PREFIX = 'daw3:rendered-from:';

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const newReport = () => ({ exported: [], mapped: [], placeholders: [], unmapped: [], warnings: [] });

// ------------------------------------------------------------------------------- units

const UNIT_BY_SUFFIX = { dB: 'decibel', Hz: 'hertz', s: 'seconds', ms: 'seconds', st: 'semitones', semi: 'semitones', '%': 'percent', beats: 'beats', bpm: 'bpm' };
const unitFor = (u) => UNIT_BY_SUFFIX[u] || 'linear';
const ratioToPct = (r) => clamp((1 - 1 / Math.max(1, r)) * 100, 0, 100);
const pctToRatio = (p) => clamp(1 / Math.max(0.05, 1 - clamp(p, 0, 99.9) / 100), 1, 20);

// Generic DAWproject devices daW³ can fill / read: [element, daW³ key, unit, toXml?, fromXml?] in XSD order.
const TYPED_FX = {
  compressor: {
    tag: 'Compressor',
    fields: [['Attack', 'attack', 'seconds'], ['OutputGain', 'makeup', 'decibel'], ['Ratio', 'ratio', 'percent', ratioToPct, pctToRatio], ['Release', 'release', 'seconds'], ['Threshold', 'threshold', 'decibel']],
  },
  limiter: { tag: 'Limiter', fields: [['InputGain', 'gain', 'decibel'], ['Release', 'release', 'seconds'], ['Threshold', 'threshold', 'decibel']] },
  gate: { tag: 'NoiseGate', fields: [['Attack', 'attack', 'seconds'], ['Range', 'range', 'decibel'], ['Release', 'release', 'seconds'], ['Threshold', 'threshold', 'decibel']] },
};
const TAG_TO_FX = { Compressor: 'compressor', Limiter: 'limiter', NoiseGate: 'gate', Equalizer: 'eq8' };
const EQ_TYPE_OUT = { peaking: 'bell', lowshelf: 'lowShelf', highshelf: 'highShelf', lowpass: 'lowPass', highpass: 'highPass', bandpass: 'bandPass', notch: 'notch' };
const EQ_TYPE_IN = Object.fromEntries(Object.entries(EQ_TYPE_OUT).map(([k, v]) => [v, k]));
const DEVICE_TAGS = ['Device', 'Vst2Plugin', 'Vst3Plugin', 'ClapPlugin', 'BuiltinDevice', 'Equalizer', 'Compressor', 'NoiseGate', 'Limiter', 'AuPlugin'];

// ===================================================================================== EXPORT

/** Builds project.xml / metadata.xml and the media + plugin-state files of a .dawproject. */
export function buildDawproject(project, opts = {}) {
  const report = newReport();
  const renders = opts.renders || {};
  let nid = 0;
  const nextId = () => `id${nid++}`;
  const files = [];
  const audioName = uniqueNamer();
  const stateName = uniqueNamer();
  const spb = 60 / (project.bpm || 120);
  const bpb = beatsPerBar(project);
  const songBeats = songLengthBeats(project);

  // ---- samples -> audio/ files (shared by clips and sampler instruments)
  const samplePaths = new Map(); // sampleId -> { path, info }
  const sampleFile = (sampleId) => {
    if (samplePaths.has(sampleId)) return samplePaths.get(sampleId);
    const s = project.samples?.[sampleId];
    if (!s?.data) return null;
    const bytes = new Uint8Array(base64ToArrayBuffer(s.data));
    const path = `audio/${audioName(safeName(s.name, 'sample'), extForMime(s.mime))}`;
    files.push({ path, data: bytes, compress: false });
    let info = opts.sampleInfo?.[sampleId] || wavInfo(bytes);
    if (!info) {
      info = { duration: Number(s.duration) || 0, channels: 2, sampleRate: 44100 };
      if (!info.duration) report.warnings.push(`Sample "${s.name}": duration unknown (not a WAV file and not decoded) — clip lengths are used instead.`);
    }
    const entry = { path, info };
    samplePaths.set(sampleId, entry);
    return entry;
  };

  // ---- parameter registry for automation: owner -> target -> { id, kind, unit, to }
  const registry = new Map();
  const reg = (owner, target, entry) => {
    if (!registry.has(owner)) registry.set(owner, new Map());
    registry.get(owner).set(target, entry);
  };

  const realParam = (tag, owner, target, { name, value, unit = 'linear', min, max, to = (v) => v, parameterID } = {}) => {
    const id = nextId();
    if (owner && target) reg(owner, target, { id, kind: 'real', unit, to });
    return el(tag, { id, name, parameterID, unit, min, max, value: r6(to(value)) });
  };
  const boolParam = (tag, owner, target, name, value) => {
    const id = nextId();
    if (owner && target) reg(owner, target, { id, kind: 'bool' });
    return el(tag, { id, name, value: value ? 'true' : 'false' });
  };

  /** Device <Parameters> from ParamDefs (numbers -> RealParameter, enums -> EnumParameter, bools -> BoolParameter). */
  const defParams = (defs, values, owner, prefix, skip = new Set()) => {
    const out = [];
    defs.forEach((p, i) => {
      if (skip.has(p.key)) return;
      const v = values?.[p.key] ?? p.default;
      const target = `${prefix}${p.key}`;
      if (p.type === 'number') {
        out.push(realParam('RealParameter', owner, target, { name: p.key, parameterID: i, unit: unitFor(p.unit), min: p.min, max: p.max, value: Number(v) || 0 }));
      } else if (p.type === 'enum') {
        const id = nextId();
        const opts2 = p.options || [];
        const idx = Math.max(0, opts2.findIndex((o) => o.value === v || String(o.value) === String(v)));
        reg(owner, target, { id, kind: 'enum', count: opts2.length });
        out.push(el('EnumParameter', { id, name: p.key, parameterID: i, count: opts2.length, labels: opts2.map((o) => String(o.value).replace(/\s+/g, '_')).join(' '), value: idx }));
      } else if (p.type === 'bool') {
        const id = nextId();
        reg(owner, target, { id, kind: 'bool' });
        out.push(el('BoolParameter', { id, name: p.key, parameterID: i, value: v ? 'true' : 'false' }));
      }
    });
    return out;
  };

  /** Extra RealParameters for automated keys that are not top-level defs (drum pads, Faust values). */
  const extraAutomatedParams = (lanes, prefix, known, owner, valuesOf) => {
    const out = [];
    for (const l of lanes || []) {
      if (!String(l.target).startsWith(prefix)) continue;
      const key = l.target.slice(prefix.length);
      if (known.has(key) || registry.get(owner)?.has(l.target)) continue;
      out.push(realParam('RealParameter', owner, l.target, { name: key, value: Number(valuesOf(key)) || l.points?.[0]?.value || 0 }));
    }
    return out;
  };

  /** Sample ids referenced anywhere inside a device state -> exported with the state. */
  const stateSamples = (obj) => {
    const out = {};
    const visit = (v) => {
      if (typeof v === 'string' && project.samples?.[v]) {
        const f = sampleFile(v);
        if (f) out[v] = { path: f.path, name: project.samples[v].name, mime: project.samples[v].mime };
      } else if (v && typeof v === 'object') Object.values(v).forEach(visit);
    };
    visit(obj);
    return out;
  };
  const stateFile = (base, payload) => {
    const path = `plugins/${stateName(safeName(base, 'device'), 'json')}`;
    files.push({ path, data: JSON.stringify({ format: STATE_FORMAT, version: 1, ...payload, samples: stateSamples(payload) }, null, 1), compress: true });
    return el('State', { path });
  };

  const instrumentDevice = (track, owner) => {
    if (track.type === 'code') {
      const id = nextId();
      return el('BuiltinDevice', { id, name: 'Code', deviceRole: 'instrument', deviceName: 'daW³ Code (Strudel)', deviceID: 'daw3.code', deviceVendor: APP_NAME, loaded: 'false' },
        el('Parameters'), boolParam('Enabled', null, null, 'On/Off', true),
        stateFile(`${track.name} code`, { kind: 'code', code: track.code || '', codeSound: track.codeSound || null, role: track.role || null }));
    }
    const inst = track.instrument || { type: 'synth', params: {} };
    let resolved;
    try { resolved = resolveInstrumentDef(inst); } catch { resolved = { type: inst.type || 'synth', params: inst.params || {} }; }
    const def = INSTRUMENT_DEFS[resolved.type] || INSTRUMENT_DEFS.synth;
    const presetName = inst.preset ? (PRESETS[inst.preset]?.name || DRUM_KITS[inst.preset]?.name || inst.preset) : null;
    const params = [
      ...defParams(def.params, resolved.params, owner, 'inst:'),
      ...extraAutomatedParams(track.automation, 'inst:', new Set(def.params.map((p) => p.key)), owner, (k) => readNested(resolved.params, k)),
    ];
    return el('BuiltinDevice', {
      id: nextId(), name: presetName || def.name, deviceRole: 'instrument', deviceName: `daW³ ${def.name}${presetName ? ` – ${presetName}` : ''}`,
      deviceID: `daw3.instrument.${resolved.type}`, deviceVendor: APP_NAME, loaded: 'false',
    }, el('Parameters', {}, params), boolParam('Enabled', null, null, 'On/Off', true),
    stateFile(`${track.name} ${def.name}`, { kind: 'instrument', instrument: inst, role: track.role || null }));
  };

  const effectDevice = (fx, owner, lanes) => {
    const def = EFFECT_DEFS[fx.type];
    const defsList = def?.params || [];
    const values = { ...Object.fromEntries(defsList.map((p) => [p.key, p.default])), ...(fx.params || {}) };
    const typed = TYPED_FX[fx.type];
    const isEq = fx.type === 'eq3' || fx.type === 'eq8';
    const prefix = `fx:${fx.id}:`;
    const consumed = new Set();
    const tail = [];
    if (typed) {
      for (const [tag, key, unit, to] of typed.fields) {
        consumed.add(key);
        tail.push(realParam(tag, owner, prefix + key, { name: key, unit, value: Number(values[key]) || 0, ...(to ? { to } : {}) }));
      }
    } else if (isEq) {
      const bands = fx.type === 'eq3'
        ? [['lowShelf', 'lowFreq', 'low', null, null], ['bell', 'midFreq', 'mid', 'midQ', null], ['highShelf', 'highFreq', 'high', null, null]]
        : Array.from({ length: 8 }, (_, k) => [EQ_TYPE_OUT[values[`b${k + 1}Type`]] || 'bell', `b${k + 1}Freq`, `b${k + 1}Gain`, `b${k + 1}Q`, `b${k + 1}On`]);
      bands.forEach(([type, fKey, gKey, qKey, onKey], order) => {
        [fKey, gKey, qKey, onKey].forEach((k) => k && consumed.add(k));
        tail.push(el('Band', { type, order },
          realParam('Freq', owner, prefix + fKey, { name: fKey, unit: 'hertz', min: 20, max: 20000, value: Number(values[fKey]) || 1000 }),
          realParam('Gain', owner, prefix + gKey, { name: gKey, unit: 'decibel', value: Number(values[gKey]) || 0 }),
          qKey ? realParam('Q', owner, prefix + qKey, { name: qKey, unit: 'linear', value: Number(values[qKey]) || 0.7 }) : null,
          onKey ? boolParam('Enabled', owner, prefix + onKey, onKey, !!values[onKey]) : null));
      });
      consumed.add('output');
      tail.push(realParam('OutputGain', owner, `${prefix}output`, { name: 'output', unit: 'decibel', value: Number(values.output) || 0 }));
    }
    const tag = typed ? typed.tag : isEq ? 'Equalizer' : 'BuiltinDevice';
    const params = [
      ...defParams(defsList, values, owner, prefix, consumed),
      ...extraAutomatedParams(lanes, prefix, new Set(defsList.map((p) => p.key)), owner, (k) => readNested(values, k)),
    ];
    const enabledId = nextId();
    reg(owner, `fxen:${fx.id}`, { id: enabledId, kind: 'bool' });
    return el(tag, {
      id: nextId(), name: def?.name || fx.type, deviceRole: 'audioFX', deviceName: def?.name || fx.type,
      deviceID: `daw3.fx.${fx.type}`, deviceVendor: APP_NAME, loaded: 'false',
    }, el('Parameters', {}, params), el('Enabled', { id: enabledId, name: 'On/Off', value: fx.enabled === false ? 'false' : 'true' }),
    stateFile(def?.name || fx.type, { kind: 'effect', effect: { type: fx.type, enabled: fx.enabled !== false, params: fx.params || {} } }), tail);
  };

  /** Placeholders for devices imported from another DAW (track.foreignDevices) — written back unloaded. */
  const foreignDevice = (d) => el(DEVICE_TAGS.includes(d.tag) && !TAG_TO_FX[d.tag] ? d.tag : 'BuiltinDevice', {
    id: nextId(), name: d.name || d.deviceName, deviceRole: d.deviceRole || 'audioFX', deviceName: d.deviceName || d.name || 'Unknown device',
    deviceID: d.deviceID, deviceVendor: d.deviceVendor, loaded: 'false',
  }, boolParam('Enabled', null, null, 'On/Off', d.enabled !== false));

  const busChannelIds = new Map(project.buses.map((b) => [b.id, nextId()]));
  const masterChannelId = nextId();

  const channel = (owner, { role, devices = [], volume, pan, mute, solo, sends, channelId, volumeMax = 2 }) => el('Channel', {
    id: channelId || nextId(), role, audioChannels: 2, destination: role === 'master' ? undefined : masterChannelId, solo: solo ? 'true' : 'false',
  },
  devices.length ? el('Devices', {}, devices) : null,
  boolParam('Mute', owner, 'mute', 'Mute', !!mute),
  realParam('Pan', owner, 'pan', { name: 'Pan', unit: 'normalized', min: 0, max: 1, value: pan || 0, to: (v) => clamp((v + 1) / 2, 0, 1) }),
  sends ? el('Sends', {}, Object.entries(sends).filter(([busId, amt]) => busChannelIds.has(busId) && amt > 0).map(([busId, amt]) => el('Send', { id: nextId(), destination: busChannelIds.get(busId), type: 'post', name: project.buses.find((b) => b.id === busId)?.name },
    realParam('Volume', owner, `send:${busId}`, { name: 'Send', unit: 'linear', min: 0, max: 1, value: amt })))) : null,
  realParam('Volume', owner, 'volume', { name: 'Volume', unit: 'linear', min: 0, max: volumeMax, value: volume ?? 0.8 }));

  // ---- Structure
  const structure = [];
  const trackXmlIds = new Map(); // owner key -> Track xml id
  const lanesByOwner = []; // [{ owner, trackXmlId, clips: [], automation: [] , name }]
  if (project.tracks.some((t) => t.patch?.enabled)) report.warnings.push('Plugboard routings were flattened to serial insert chains.');

  for (const t of project.tracks) {
    const owner = `track:${t.id}`;
    const devices = [];
    if (t.type === 'instrument' || t.type === 'code') devices.push(instrumentDevice(t, owner));
    for (const fx of t.fx || []) devices.push(effectDevice(fx, owner, t.automation));
    for (const d of t.foreignDevices || []) devices.push(foreignDevice(d));
    const xmlId = nextId();
    trackXmlIds.set(owner, xmlId);
    structure.push(el('Track', { id: xmlId, name: t.name, color: t.color, contentType: t.type === 'audio' ? 'audio' : 'notes', loaded: 'true' },
      channel(owner, { role: 'regular', devices, volume: t.volume, pan: t.pan, mute: t.mute, solo: t.solo, sends: t.sends })));
    lanesByOwner.push({ owner, track: t, trackXmlId: xmlId, name: t.name, automation: t.automation });
    report.exported.push(`Track "${t.name}" (${t.type})`);
    const rend = renders[t.id];
    if (rend && (t.type === 'instrument' || t.type === 'code')) {
      const rOwner = `render:${t.id}`;
      const rId = nextId();
      structure.push(el('Track', { id: rId, name: `${t.name} (audio)`, color: t.color, contentType: 'audio', loaded: 'true', comment: `${RENDERED_PREFIX}${xmlId}` },
        channel(rOwner, { role: 'regular', volume: t.volume, pan: t.pan, mute: t.mute, solo: t.solo, sends: t.sends })));
      const path = `audio/${audioName(`${safeName(t.name, 'track')} (rendered)`, 'wav')}`;
      files.push({ path, data: rend.data, compress: false });
      const info = { duration: rend.duration, channels: rend.channels || 2, sampleRate: rend.sampleRate || 44100 };
      lanesByOwner.push({
        owner: rOwner, trackXmlId: rId, name: `${t.name} (audio)`, rendered: { path, info },
        automation: (t.automation || []).filter((l) => /^(volume|pan|mute|send:)/.test(String(l.target))),
      });
      report.exported.push(`Track "${t.name} (audio)" — rendered instrument audio`);
    }
  }
  for (const b of project.buses) {
    const owner = `bus:${b.id}`;
    const xmlId = nextId();
    structure.push(el('Track', { id: xmlId, name: b.name, contentType: 'audio', loaded: 'true' },
      channel(owner, { role: 'effect', channelId: busChannelIds.get(b.id), devices: (b.fx || []).map((fx) => effectDevice(fx, owner, b.automation)), volume: b.volume, pan: b.pan, mute: b.mute })));
    lanesByOwner.push({ owner, trackXmlId: xmlId, name: b.name, automation: b.automation });
  }
  {
    const owner = 'master';
    const xmlId = nextId();
    structure.push(el('Track', { id: xmlId, name: 'Master', contentType: 'audio notes', loaded: 'true' },
      channel(owner, { role: 'master', channelId: masterChannelId, devices: (project.master?.fx || []).map((fx) => effectDevice(fx, owner, project.master?.automation)), volume: project.master?.volume ?? 0.9, pan: 0, mute: false })));
    lanesByOwner.push({ owner, trackXmlId: xmlId, name: 'Master', automation: project.master?.automation });
  }

  // ---- Transport
  const tempoId = nextId();
  const tsId = nextId();
  const [num, den] = project.timeSig || [4, 4];
  const transport = el('Transport', {},
    el('Tempo', { id: tempoId, name: 'Tempo', unit: 'bpm', min: 20, max: 999, value: project.bpm || 120 }),
    el('TimeSignature', { id: tsId, name: 'Time Signature', numerator: num, denominator: den }));

  // ---- Arrangement clips
  let clips = (project.clips || []).filter((c) => project.tracks.some((t) => t.id === c.trackId));
  if (!clips.length) {
    // pattern-mode project: one clip per track with its active pattern so the arrangement isn't empty
    for (const t of project.tracks) {
      const pat = project.patterns[t.activePatternId];
      if (pat && t.type === 'instrument') clips.push({ id: uid('clip'), trackId: t.id, type: 'pattern', patternId: pat.id, start: 0, length: pat.length || bpb, offset: 0, gain: 1 });
    }
    if (clips.length) report.warnings.push('The project has no arrangement — each track\'s active pattern was exported as one clip at bar 1.');
  }
  const clipLength = Math.max(songBeats, ...clips.map((c) => c.start + c.length), bpb);

  const noteClip = (c) => {
    const pat = project.patterns[c.patternId];
    if (!pat) return null;
    const len = pat.length > 0 ? pat.length : bpb;
    const gain = c.gain ?? 1;
    const playStart = ((c.offset || 0) % len + len) % len;
    const contentEnd = playStart + c.length;
    const notes = [];
    for (let k = 0; k * len < contentEnd - 1e-9; k++) {
      for (const n of pat.notes || []) {
        if (!(n.start >= 0 && n.start < len)) continue;
        const t = k * len + n.start;
        if (t >= contentEnd - 1e-9) continue;
        notes.push({ t, n });
      }
    }
    notes.sort((a, b) => a.t - b.t || a.n.pitch - b.n.pitch);
    return el('Clip', { time: r6(c.start), duration: r6(c.length), contentTimeUnit: 'beats', playStart: r6(playStart), loopStart: 0, loopEnd: r6(len), name: c.name || pat.name },
      el('Notes', { id: nextId() }, notes.map(({ t, n }) => el('Note', {
        time: r6(t), duration: r6(Math.max(1e-4, n.dur)), channel: 0, key: clamp(Math.round(n.pitch), 0, 127),
        vel: r6(clamp((n.vel ?? 0.8) * gain, 0, 1)), rel: r6(clamp(n.vel ?? 0.8, 0, 1)),
      }))));
  };

  const audioClipEl = ({ start, length, offset = 0, fadeIn = 0, fadeOut = 0, name }, file) => {
    const dur = file.info.duration || (offset + length) * spb;
    return el('Clip', { time: r6(start), duration: r6(length), contentTimeUnit: 'beats', playStart: r6(offset), fadeTimeUnit: 'beats', fadeInTime: r6(fadeIn), fadeOutTime: r6(fadeOut), name },
      el('Warps', { id: nextId(), timeUnit: 'beats', contentTimeUnit: 'seconds' },
        el('Audio', { id: nextId(), channels: file.info.channels || 2, sampleRate: Math.round(file.info.sampleRate || 44100), duration: r6(dur) }, el('File', { path: file.path })),
        el('Warp', { time: 0, contentTime: 0 }),
        el('Warp', { time: r6(dur / spb), contentTime: r6(dur) })));
  };

  const codeClip = (t) => {
    let groups = [];
    try { groups = codeToPatterns(t.code || '', { cycles: Math.max(1, Math.ceil(clipLength / bpb)), beatsPerCycle: bpb, trim: false }); } catch (e) {
      report.warnings.push(`Code track "${t.name}": could not render notes (${e.message}).`);
    }
    const notes = groups.flatMap((g) => g.notes || []).filter((n) => n.start < clipLength).sort((a, b) => a.start - b.start);
    if (!notes.length) return null;
    return el('Clip', { time: 0, duration: r6(clipLength), contentTimeUnit: 'beats', playStart: 0, name: `${t.name} (code)` },
      el('Notes', { id: nextId() }, notes.map((n) => el('Note', { time: r6(n.start), duration: r6(Math.max(1e-4, n.dur)), channel: 0, key: clamp(Math.round(n.pitch), 0, 127), vel: r6(clamp(n.vel ?? 0.8, 0, 1)) }))));
  };

  const pointsEl = (lane, owner, name) => {
    if (lane.enabled === false) { report.unmapped.push(`${name}: disabled automation lane "${lane.target}" omitted`); return null; }
    if (!lane.points?.length) return null;
    const r = registry.get(owner)?.get(lane.target);
    if (!r) { report.unmapped.push(`${name}: automation "${lane.target}" (${lane.points.length} points) has no DAWproject parameter — omitted`); return null; }
    let pts;
    if (r.kind === 'bool' || r.kind === 'enum') {
      // daW³ step lanes interpolate linearly and then threshold (>= 0.5 / nearest option): write the switch points
      const qf = r.kind === 'bool' ? (v) => (v >= 0.5 ? 1 : 0) : (v) => clamp(Math.round(v), 0, Math.max(0, r.count - 1));
      pts = stepPoints(sortPoints(lane.points), qf).map(({ beat, value }) => (r.kind === 'bool'
        ? el('BoolPoint', { time: r6(beat), value: value ? 'true' : 'false' })
        : el('EnumPoint', { time: r6(beat), value })));
    } else {
      pts = sortPoints(lane.points).map((p) => el('RealPoint', { time: r6(p.beat), value: r6(r.to(p.value)), interpolation: 'linear' }));
    }
    report.mapped.push(`${name}: automation "${lane.target}"`);
    return el('Points', { id: nextId(), unit: r.kind === 'real' ? r.unit : undefined }, el('Target', { parameter: r.id }), pts);
  };

  const trackLanes = lanesByOwner.map((o) => {
    const clipEls = [];
    if (o.track) {
      const t = o.track;
      if (t.type === 'code') { const c = codeClip(t); if (c) clipEls.push(c); }
      for (const c of clips.filter((cc) => cc.trackId === t.id).sort((a, b) => a.start - b.start)) {
        if (c.type === 'audio') {
          const f = c.sampleId && sampleFile(c.sampleId);
          if (!f) { report.warnings.push(`Track "${t.name}": audio clip at beat ${c.start} has no sample — skipped.`); continue; }
          if ((c.gain ?? 1) !== 1) report.unmapped.push(`Track "${t.name}": audio clip gain ${c.gain} (DAWproject clips have no gain) — omitted`);
          clipEls.push(audioClipEl({ start: c.start, length: c.length, offset: c.offset || 0, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0, name: c.name || project.samples[c.sampleId]?.name }, f));
        } else if (t.type === 'instrument') {
          const ce = noteClip(c);
          if (ce) clipEls.push(ce);
        }
      }
    } else if (o.rendered) {
      clipEls.push(audioClipEl({ start: 0, length: r6(o.rendered.info.duration / spb), name: o.name }, o.rendered));
    }
    const pts = (o.automation || []).map((l) => pointsEl(l, o.owner, o.name)).filter(Boolean);
    return el('Lanes', { id: nextId(), track: o.trackXmlId }, el('Clips', { id: nextId() }, clipEls), pts);
  });

  const markers = [...(project.markers || [])].filter((m) => Number.isFinite(m.beat)).sort((a, b) => a.beat - b.beat);
  const tempoPts = (project.tempoAutomation || []).filter((p) => Number.isFinite(p.beat) && p.bpm > 0);
  const tsPts = (project.timeSigAutomation || []).filter((p) => Number.isFinite(p.beat) && p.num > 0 && p.den > 0);
  const arrangement = el('Arrangement', { id: nextId() },
    el('Lanes', { id: nextId(), timeUnit: 'beats' }, trackLanes),
    markers.length ? el('Markers', { id: nextId() }, markers.map((m) => el('Marker', { time: r6(m.beat), name: m.name || 'Marker', color: m.color }))) : null,
    tempoPts.length ? el('TempoAutomation', { id: nextId(), unit: 'bpm' }, el('Target', { parameter: tempoId }),
      tempoPts.map((p) => el('RealPoint', { time: r6(p.beat), value: r6(p.bpm), interpolation: p.interpolation === 'hold' ? 'hold' : 'linear' }))) : null,
    tsPts.length ? el('TimeSignatureAutomation', { id: nextId() }, el('Target', { parameter: tsId }),
      tsPts.map((p) => el('TimeSignaturePoint', { time: r6(p.beat), numerator: p.num, denominator: p.den }))) : null);

  if ((project.scenes || []).some((s) => Object.keys(s.slots || {}).length)) report.unmapped.push('Scenes (clip launcher) are not exported.');

  const root = el('Project', { version: DAWPROJECT_VERSION },
    el('Application', { name: APP_NAME, version: APP_VERSION }),
    transport, el('Structure', {}, structure), arrangement, el('Scenes'));
  const meta = el('MetaData', {},
    el('Title', {}, project.name || 'Untitled'),
    project.genre ? el('Genre', {}, String(project.genre)) : null,
    el('Comment', {}, `Exported from ${APP_NAME}. Instruments are daW³ devices (placeholders elsewhere)${Object.keys(renders).length ? '; rendered audio tracks are included' : ''}.`));
  return { projectXml: toXml(root), metadataXml: toXml(meta), files, report };
}

/** Linear lane + quantizer -> the points where the quantized value changes (first point included). */
export function stepPoints(points, qf) {
  if (!points.length) return [];
  const out = [{ beat: points[0].beat, value: qf(points[0].value) }];
  let cur = out[0].value;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const qb = qf(b.value);
    if (qb === cur) continue;
    if (!(b.beat > a.beat)) { out.push({ beat: b.beat, value: qb }); cur = qb; continue; }
    // walk the crossings between a and b (thresholds at k + 0.5 for integers, 0.5 for bools)
    const steps = 64;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      let lo = (k - 1) / steps, hi = t;
      const qt = qf(a.value + (b.value - a.value) * t);
      if (qt === cur) continue;
      for (let it = 0; it < 30; it++) { // bisect the switch point
        const mid = (lo + hi) / 2;
        if (qf(a.value + (b.value - a.value) * mid) === cur) lo = mid; else hi = mid;
      }
      cur = qf(a.value + (b.value - a.value) * hi);
      out.push({ beat: a.beat + (b.beat - a.beat) * hi, value: cur });
    }
  }
  return out;
}

function readNested(obj, key) {
  let v = obj;
  for (const k of String(key).split('.')) { if (v == null) return undefined; v = v[k]; }
  return v;
}

/** Full .dawproject ZIP. */
export async function exportDawproject(project, opts = {}) {
  const b = buildDawproject(project, opts);
  const bytes = await writeZip([
    { name: 'project.xml', data: b.projectXml },
    { name: 'metadata.xml', data: b.metadataXml },
    ...b.files.map((f) => ({ name: f.path, data: f.data, compress: f.compress })),
  ], { codec: opts.codec });
  return { bytes, report: b.report, projectXml: b.projectXml };
}

// ===================================================================================== IMPORT

const INSTRUMENT_GUESS = [
  [/drum|kit\b|battery|\b80[89]\b|\b909\b|percussion|beat ?box|groove agent|impact|spark|xo\b/, { type: 'drums', preset: '808' }],
  [/rhodes|wurli|e-?piano|electric piano|ep\b|stage/, { preset: 'electric-piano' }],
  [/piano|grand|keyscape|una corda/, { preset: 'grand-piano' }],
  [/organ|hammond|\bb-?3\b/, { preset: 'organ-drawbar' }],
  [/sub ?bass|808 bass/, { preset: 'sub-bass' }],
  [/bass/, { preset: 'saw-bass' }],
  [/string|violin|cello|orchestra/, { preset: 'strings' }],
  [/choir|vox|voice/, { preset: 'choir-pad' }],
  [/pad|atmos|ambient/, { preset: 'warm-pad' }],
  [/pluck|harp|kalimba|koto/, { preset: 'pluck' }],
  [/bell|vibra|marimba|mallet|glock|celesta/, { preset: 'vibraphone' }],
  [/brass|horn|trumpet/, { preset: 'brass-section' }],
  [/guitar/, { preset: 'guitar-clean' }],
  [/flute|wind/, { preset: 'flute' }],
  [/\bfm\b|dx7|dexed|operator/, { type: 'fm', preset: null }],
  [/sampler|simpler|kontakt|sample/, { type: 'sampler', preset: null }],
  [/arp/, { preset: 'arp-pluck' }],
  [/lead|saw|serum|vital|surge|massive|sylenth|diva|synth|analog/, { preset: 'saw-lead' }],
];
const EFFECT_GUESS = [
  [/reverb|verb\b|room|hall|plate|space/, 'reverb'], [/delay|echo/, 'delay'], [/chorus/, 'chorus'], [/flang/, 'flanger'],
  [/phase/, 'phaser'], [/distort|overdrive|fuzz|amp\b|drive/, 'distortion'], [/saturat|tape/, 'saturator'],
  [/crush|bit|decimat/, 'bitcrusher'], [/tremolo/, 'tremolo'], [/auto ?pan/, 'autopan'], [/filter/, 'filter'],
  [/\beq\b|equali[sz]/, 'eq8'], [/compress|glue|comp\b/, 'compressor'], [/limit|maximi/, 'limiter'], [/gate/, 'gate'],
  [/widen|stereo|imager/, 'widener'], [/utility|gain|tool/, 'utility'],
];

function guessInstrument(text, notes) {
  const s = String(text || '').toLowerCase();
  for (const [re, inst] of INSTRUMENT_GUESS) {
    if (re.test(s)) {
      const preset = inst.preset ?? null;
      const type = inst.type || (preset ? PRESETS[preset]?.instrument?.type : null) || 'synth';
      if (preset && !PRESETS[preset] && type !== 'drums') continue;
      return { type, preset };
    }
  }
  if (notes?.length) {
    const avg = notes.reduce((a, n) => a + n.pitch, 0) / notes.length;
    if (notes.every((n) => n.pitch >= 35 && n.pitch <= 81) && /drum|perc|beat/.test(s)) return { type: 'drums', preset: '808' };
    if (avg < 48) return { type: 'synth', preset: 'saw-bass' };
    const poly = notes.filter((n, i) => notes.some((m, j) => j !== i && Math.abs(m.start - n.start) < 0.01)).length / notes.length;
    if (poly > 0.4) return { type: 'synth', preset: 'electric-piano' };
  }
  return { type: 'synth', preset: 'saw-lead' };
}

const guessEffect = (text) => {
  const s = String(text || '').toLowerCase();
  for (const [re, type] of EFFECT_GUESS) if (re.test(s) && EFFECT_DEFS[type]) return type;
  return null;
};

/** Parses project.xml (+ files of the archive) into a daW³ project. */
export function parseDawproject(projectXml, files = new Map(), opts = {}) {
  const report = newReport();
  const root = parseXml(projectXml);
  if (root.name !== 'Project') throw new Error('Not a DAWproject file (root element is not <Project>).');
  const metaXml = opts.metadataXml ? (() => { try { return parseXml(opts.metadataXml); } catch { return null; } })() : null;
  const app = child(root, 'Application');

  const project = createProject({ name: child(metaXml, 'Title')?.text?.trim() || opts.name || 'Imported project' });
  project.tracks = [];
  project.buses = [];
  project.master.fx = [];
  project.markers = [];
  const transport = child(root, 'Transport');
  const tempoEl = child(transport, 'Tempo');
  let bpm = numAttr(tempoEl, 'value', 120);
  if (tempoEl?.attrs.unit && tempoEl.attrs.unit !== 'bpm') report.warnings.push(`Tempo unit "${tempoEl.attrs.unit}" — read as BPM.`);
  if (!(bpm > 0 && bpm < 1000)) bpm = 120;
  project.bpm = r6(bpm);
  const tsEl = child(transport, 'TimeSignature');
  if (tsEl) project.timeSig = [numAttr(tsEl, 'numerator', 4), numAttr(tsEl, 'denominator', 4)];
  const genre = child(metaXml, 'Genre')?.text?.trim();
  if (genre) project.genre = genre.toLowerCase();

  // id -> element index (for IDREFs)
  const byId = new Map();
  const index = (n) => { if (n.attrs.id) byId.set(n.attrs.id, n); n.children.forEach(index); };
  index(root);

  const spb = () => 60 / project.bpm;
  const toBeats = (v, unit) => (unit === 'seconds' ? v / spb() : v);

  // ---------------------------------------------------------------- Structure
  const params = new Map(); // xml param id -> { owner, target, from(value), kind }
  const channelOwner = new Map(); // channel xml id -> { kind:'track'|'bus'|'master'|'group', ref }
  const trackByXmlId = new Map(); // Track xml id -> daW³ track
  const pendingSends = []; // { track, sendEl }
  const stateOf = (dev) => {
    const path = child(dev, 'State')?.attrs.path;
    if (!path) return null;
    const txt = zipText(files, path.replace(/^\.?\//, ''));
    if (!txt) return null;
    try {
      const j = JSON.parse(txt);
      return j?.format === STATE_FORMAT ? j : null;
    } catch { return null; }
  };
  const sampleIdByPath = new Map();
  const sampleFromPath = (path, name, extra = {}) => {
    const p = String(path || '').replace(/^\.?\//, '');
    if (sampleIdByPath.has(p)) return sampleIdByPath.get(p);
    const data = files.get(p);
    if (!data) return null;
    const id = uid('smp');
    project.samples[id] = { id, name: name || p.split('/').pop().replace(/\.[^.]+$/, ''), mime: mimeForPath(p), data: arrayBufferToBase64(data), duration: extra.duration ?? null };
    sampleIdByPath.set(p, id);
    return id;
  };
  /** Re-links sample ids referenced by a daW³ device state to freshly imported samples. */
  const relinkState = (obj, samples) => {
    const map = {};
    for (const [oldId, s] of Object.entries(samples || {})) {
      const nid2 = sampleFromPath(s.path, s.name);
      if (nid2) map[oldId] = nid2;
    }
    const fix = (v) => {
      if (typeof v === 'string') return map[v] || v;
      if (Array.isArray(v)) return v.map(fix);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]));
      return v;
    };
    return fix(obj);
  };

  const ownerName = (o) => (o === project.master ? 'Master' : o?.name || '?');
  const regParam = (pel, owner, target, from = (v) => v, kind = 'real') => {
    if (pel?.attrs?.id) params.set(pel.attrs.id, { owner, target, from, kind });
  };
  const realVal = (pel, fallback = 0) => numAttr(pel, 'value', fallback);
  const normFrom = (pel) => {
    const min = numAttr(pel, 'min', 0);
    const max = numAttr(pel, 'max', 1);
    return (v) => (max > min ? clamp((v - min) / (max - min), 0, 1) : clamp(v, 0, 1));
  };
  const volFrom = (pel, max = 1.5) => {
    const unit = pel?.attrs?.unit;
    return (v) => clamp(unit === 'decibel' ? dbToGain(v) : v, 0, max);
  };
  const panFrom = (pel) => {
    const unit = pel?.attrs?.unit;
    const n = normFrom(pel);
    return unit === 'normalized' || numAttr(pel, 'min', 0) >= 0 ? (v) => r6(n(v) * 2 - 1) : (v) => clamp(v, -1, 1);
  };
  const dbFrom = (pel) => (pel?.attrs?.unit === 'linear' ? (v) => gainToDb(v) : (v) => v);

  /** Reads one <Devices> child into the owner (instrument / effects / placeholder). */
  const readDevice = (dev, owner, isTrack, notesForGuess) => {
    const role = dev.attrs.deviceRole || (dev.name === 'BuiltinDevice' ? 'audioFX' : 'audioFX');
    const name = dev.attrs.deviceName || dev.attrs.name || dev.name;
    const enabledEl = child(dev, 'Enabled');
    const enabled = enabledEl ? boolAttr(enabledEl, 'value', true) : true;
    const state = stateOf(dev);
    const paramEls = children(child(dev, 'Parameters'));
    if (role === 'instrument') {
      if (!isTrack) { report.placeholders.push(`${ownerName(owner)}: instrument "${name}" on a non-track channel ignored`); return; }
      if (state?.kind === 'code') {
        owner.type = 'code';
        owner.instrument = null;
        owner.code = state.code || '';
        if (state.codeSound) owner.codeSound = state.codeSound;
        if (state.role) owner.role = state.role;
        owner._restored = true;
        return;
      }
      if (state?.kind === 'instrument' && state.instrument) {
        owner.instrument = relinkState(state.instrument, state.samples);
        if (state.role) owner.role = state.role;
        owner._restored = true;
      } else {
        const g = guessInstrument(`${name} ${dev.attrs.deviceID || ''} ${owner.name}`, notesForGuess?.());
        owner.instrument = { type: g.type, preset: g.preset, params: {} };
        if (g.type === 'drums') owner.role = 'drums';
        const label = g.preset ? (PRESETS[g.preset]?.name || DRUM_KITS[g.preset]?.name || g.preset) : INSTRUMENT_DEFS[g.type]?.name;
        report.mapped.push(`Track "${owner.name}": instrument "${name}" → daW³ ${label} (nearest match)`);
        owner._mappedInstrument = true;
      }
      const native = !!state || String(dev.attrs.deviceID || '').startsWith('daw3.');
      if (native) {
        for (const pel of paramEls) {
          const key = pel.attrs.name;
          if (!key) continue;
          regParam(pel, owner, `inst:${key}`, pel.name === 'BoolParameter' ? (v) => (v ? 1 : 0) : (v) => v, pel.name === 'BoolParameter' ? 'bool' : 'real');
        }
      }
      return;
    }
    // ---- effects
    let fx = null;
    const native = state?.kind === 'effect' && state.effect && EFFECT_DEFS[state.effect.type];
    if (native) {
      fx = createEffect(state.effect.type, relinkState({ ...(state.effect.params || {}) }, state.samples));
    } else if (TAG_TO_FX[dev.name]) {
      fx = createEffect(TAG_TO_FX[dev.name], {});
      report.mapped.push(`${ownerName(owner)}: ${dev.name} "${name}" → daW³ ${EFFECT_DEFS[fx.type].name}`);
    } else {
      const type = String(dev.attrs.deviceID || '').startsWith('daw3.fx.') ? dev.attrs.deviceID.slice(8) : guessEffect(`${name} ${dev.attrs.deviceID || ''}`);
      if (type && EFFECT_DEFS[type]) {
        fx = createEffect(type, {});
        report.mapped.push(`${ownerName(owner)}: effect "${name}" → daW³ ${EFFECT_DEFS[type].name} (nearest match, default settings)`);
      }
    }
    if (!fx) {
      (owner.foreignDevices ||= []).push({ tag: dev.name, deviceName: name, name: dev.attrs.name || null, deviceID: dev.attrs.deviceID || null, deviceRole: role, deviceVendor: dev.attrs.deviceVendor || null, enabled });
      report.placeholders.push(`${ownerName(owner)}: "${name}"${dev.attrs.deviceVendor ? ` (${dev.attrs.deviceVendor})` : ''} kept as a placeholder (no daW³ equivalent)`);
      return;
    }
    fx.enabled = enabled;
    if (enabledEl) regParam(enabledEl, owner, `fxen:${fx.id}`, (v) => (v ? 1 : 0), 'bool');
    const prefix = `fx:${fx.id}:`;
    // generic typed devices
    const typed = TYPED_FX[fx.type];
    if (typed && !native) {
      for (const [tag, key, , , from] of typed.fields) {
        const pel = child(dev, tag);
        if (!pel) continue;
        let conv = (v) => v;
        if (from) conv = pel.attrs.unit === 'percent' || !pel.attrs.unit ? from : (v) => clamp(v, 1, 20);
        else if (/Threshold|Gain|Range/.test(tag)) conv = dbFrom(pel);
        fx.params[key] = r6(conv(realVal(pel)));
        regParam(pel, owner, prefix + key, conv);
      }
    } else if (typed && native) {
      for (const [tag, key, , , from] of typed.fields) {
        const pel = child(dev, tag);
        if (pel) regParam(pel, owner, prefix + key, from || ((v) => v));
      }
    }
    if (dev.name === 'Equalizer') {
      const bands = children(dev, 'Band');
      if (fx.type === 'eq3' && native) {
        const keys = [['lowFreq', 'low', null], ['midFreq', 'mid', 'midQ'], ['highFreq', 'high', null]];
        bands.slice(0, 3).forEach((b, k) => {
          regParam(child(b, 'Freq'), owner, prefix + keys[k][0]);
          regParam(child(b, 'Gain'), owner, prefix + keys[k][1]);
          if (keys[k][2]) regParam(child(b, 'Q'), owner, prefix + keys[k][2]);
        });
      } else {
        bands.slice(0, 8).forEach((b, k) => {
          const i = k + 1;
          const f = child(b, 'Freq');
          const g = child(b, 'Gain');
          const q = child(b, 'Q');
          const on = child(b, 'Enabled');
          if (!native) {
            fx.params[`b${i}Type`] = EQ_TYPE_IN[b.attrs.type] || 'peaking';
            if (f) fx.params[`b${i}Freq`] = realVal(f, 1000);
            if (g) fx.params[`b${i}Gain`] = r6(dbFrom(g)(realVal(g, 0)));
            if (q) fx.params[`b${i}Q`] = realVal(q, 0.9);
            fx.params[`b${i}On`] = on ? boolAttr(on, 'value', true) : true;
          }
          regParam(f, owner, `${prefix}b${i}Freq`);
          regParam(g, owner, `${prefix}b${i}Gain`, dbFrom(g));
          regParam(q, owner, `${prefix}b${i}Q`);
          regParam(on, owner, `${prefix}b${i}On`, (v) => (v ? 1 : 0), 'bool');
        });
        if (!native) for (let i = bands.length + 1; i <= 8; i++) fx.params[`b${i}On`] = false;
        if (bands.length > 8) report.unmapped.push(`${ownerName(owner)}: equalizer "${name}" has ${bands.length} bands — only 8 imported`);
      }
      const og = child(dev, 'OutputGain');
      if (og) {
        if (!native) fx.params.output = r6(dbFrom(og)(realVal(og, 0)));
        regParam(og, owner, `${prefix}output`, dbFrom(og));
      }
    }
    if (native || String(dev.attrs.deviceID || '').startsWith('daw3.')) {
      for (const pel of paramEls) {
        if (pel.attrs.name) regParam(pel, owner, prefix + pel.attrs.name, pel.name === 'BoolParameter' ? (v) => (v ? 1 : 0) : (v) => v, pel.name === 'BoolParameter' ? 'bool' : 'real');
      }
    }
    if (owner === project.master) project.master.fx.push(fx);
    else owner.fx.push(fx);
  };

  const readMixer = (ch, owner, isTrack, notesForGuess) => {
    for (const dev of children(child(ch, 'Devices'))) readDevice(dev, owner, isTrack, notesForGuess);
    const mute = child(ch, 'Mute');
    if (mute) { owner.mute = boolAttr(mute, 'value', false); regParam(mute, owner, 'mute', (v) => (v ? 1 : 0), 'bool'); }
    const pan = child(ch, 'Pan');
    if (pan) { const f = panFrom(pan); owner.pan = r6(f(realVal(pan, 0.5))); regParam(pan, owner, 'pan', f); }
    const vol = child(ch, 'Volume');
    if (vol) { const f = volFrom(vol); owner.volume = r6(f(realVal(vol, 0.8))); regParam(vol, owner, 'volume', f); }
    if (isTrack) for (const s of children(child(ch, 'Sends'), 'Send')) pendingSends.push({ track: owner, send: s });
  };

  // Notes per Track xml id (lazy) for instrument guessing — scanned before devices are read
  const notesByTrackXml = new Map();
  {
    const scan = (n, trackXml) => {
      const t = n.attrs.track || trackXml;
      if (n.name === 'Note' && t) {
        if (!notesByTrackXml.has(t)) notesByTrackXml.set(t, []);
        notesByTrackXml.get(t).push({ pitch: numAttr(n, 'key', 60), start: numAttr(n, 'time', 0) });
      }
      n.children.forEach((c) => scan(c, t));
    };
    const arr = child(root, 'Arrangement');
    if (arr) scan(arr, null);
  }

  const groupNames = new Map(); // channel id -> group name
  const visitTrack = (tEl, groupName) => {
    const ch = child(tEl, 'Channel');
    const ctypes = String(tEl.attrs.contentType || '').split(/\s+/).filter(Boolean);
    const role = ch?.attrs.role || 'regular';
    const name = tEl.attrs.name || 'Track';
    const subTracks = children(tEl, 'Track');
    if (role === 'master') {
      if (ch) { channelOwner.set(ch.attrs.id, { kind: 'master' }); readMixer(ch, project.master, false); }
      project.master.name = 'Master';
      return;
    }
    if (role === 'effect') {
      const bus = createBus(name, []);
      project.buses.push(bus);
      if (ch) { channelOwner.set(ch.attrs.id, { kind: 'bus', ref: bus }); readMixer(ch, bus, false); }
      trackByXmlId.set(tEl.attrs.id, bus);
      if (ctypes.includes('notes')) report.warnings.push(`Effect track "${name}" had note content — ignored.`);
      return;
    }
    if (subTracks.length || ctypes.includes('tracks')) {
      if (ch) {
        channelOwner.set(ch.attrs.id, { kind: 'group', name });
        groupNames.set(ch.attrs.id, name);
        const devs = children(child(ch, 'Devices'));
        const vol = child(ch, 'Volume');
        if (devs.length || (vol && Math.abs(realVal(vol, 1) - 1) > 0.01)) report.unmapped.push(`Group "${name}": group channel (volume / ${devs.length} device(s)) flattened — its tracks go straight to the master`);
      }
      for (const st of subTracks) visitTrack(st, name);
      return;
    }
    if (String(tEl.attrs.comment || '').startsWith(RENDERED_PREFIX) && opts.skipRendered !== false) {
      const origin = tEl.attrs.comment.slice(RENDERED_PREFIX.length);
      if (byId.get(origin)) {
        // rendered audio companion of a daW³ instrument track: skipped when the original comes back with its State
        const originEl = byId.get(origin);
        const restorable = children(child(child(originEl, 'Channel'), 'Devices')).some((d) => stateOf(d));
        if (restorable) { trackByXmlId.set(tEl.attrs.id, null); report.skippedRendered = (report.skippedRendered || 0) + 1; return; }
      }
    }
    const isAudio = ctypes.includes('audio') && !ctypes.includes('notes');
    const track = createTrack({ type: isAudio ? 'audio' : 'instrument', name, color: /^#[0-9a-f]{6}$/i.test(tEl.attrs.color || '') ? tEl.attrs.color : TRACK_COLORS[project.tracks.length % TRACK_COLORS.length] });
    track.volume = 0.8;
    track.solo = boolAttr(ch, 'solo', false) || false;
    project.tracks.push(track);
    trackByXmlId.set(tEl.attrs.id, track);
    if (ch) {
      channelOwner.set(ch.attrs.id, { kind: 'track', ref: track });
      readMixer(ch, track, true, () => notesByTrackXml.get(tEl.attrs.id) || []);
      const dest = ch.attrs.destination;
      if (dest && groupNames.has(dest)) report.warnings.push(`Track "${name}" was routed into group "${groupNames.get(dest)}" — now routed to the master.`);
    }
    if (track.type === 'instrument' && !track.instrument?.type) track.instrument = { type: 'synth', preset: null, params: {} };
    if (track.type === 'instrument' && !track._restored && !track._mappedInstrument) {
      const g = guessInstrument(name, notesByTrackXml.get(tEl.attrs.id));
      track.instrument = { type: g.type, preset: g.preset, params: {} };
      if (g.type === 'drums') track.role = 'drums';
      report.mapped.push(`Track "${name}": no instrument in the file → daW³ ${PRESETS[g.preset]?.name || DRUM_KITS[g.preset]?.name || INSTRUMENT_DEFS[g.type]?.name}`);
    }
    if (groupName) track.group = groupName;
  };

  const structure = child(root, 'Structure');
  for (const n of children(structure)) {
    if (n.name === 'Track') visitTrack(n, null);
    else if (n.name === 'Channel') {
      // bare channels (returns / master without a Track wrapper)
      const role = n.attrs.role || 'regular';
      if (role === 'master') { channelOwner.set(n.attrs.id, { kind: 'master' }); readMixer(n, project.master, false); } else if (role === 'effect') {
        const bus = createBus(n.attrs.name || 'Return', []);
        project.buses.push(bus);
        channelOwner.set(n.attrs.id, { kind: 'bus', ref: bus });
        readMixer(n, bus, false);
      } else report.unmapped.push(`Channel "${n.attrs.name || n.attrs.id}" without a track ignored`);
    }
  }
  for (const { track, send } of pendingSends) {
    const dest = channelOwner.get(send.attrs.destination);
    const vol = child(send, 'Volume');
    if (dest?.kind !== 'bus') { report.unmapped.push(`Track "${track.name}": send to "${send.attrs.name || send.attrs.destination}" (not an effect return) ignored`); continue; }
    const enable = child(send, 'Enable');
    const f = volFrom(vol, 1);
    const amt = enable && !boolAttr(enable, 'value', true) ? 0 : f(realVal(vol, 0));
    track.sends[dest.ref.id] = r6(amt);
    regParam(vol, track, `send:${dest.ref.id}`, f);
    if (send.attrs.type === 'pre') report.warnings.push(`Track "${track.name}": pre-fader send to "${dest.ref.name}" imported as post-fader.`);
  }

  // ---------------------------------------------------------------- Arrangement
  const patternKeys = new Map(); // trackId|len|notes -> patternId
  const addPattern = (track, notes, len, name) => {
    const sorted = notes.map((n) => ({ pitch: n.pitch, start: r6(n.start), dur: r6(n.dur), vel: r6(n.vel) })).sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    const key = `${track.id}|${r6(len)}|${JSON.stringify(sorted)}`;
    if (patternKeys.has(key)) return patternKeys.get(key);
    const pat = createPattern(track.id, { name: name || `${track.name} ${Object.values(project.patterns).filter((p) => p.trackId === track.id).length + 1}`, length: r6(len), notes: sorted.map((n) => createNote(n.pitch, n.start, n.dur, n.vel)) });
    project.patterns[pat.id] = pat;
    patternKeys.set(key, pat.id);
    if (!track.activePatternId) track.activePatternId = pat.id;
    return pat.id;
  };

  const readNotes = (notesEl, unit) => children(notesEl, 'Note').map((n) => {
    let vel = numAttr(n, 'vel', 0.8);
    if (vel > 1) vel /= 127;
    return { pitch: clamp(Math.round(numAttr(n, 'key', 60)), 0, 127), start: toBeats(numAttr(n, 'time', 0), unit), dur: Math.max(1e-4, toBeats(numAttr(n, 'duration', 0.25), unit)), vel: clamp(vel, 0, 1) };
  });
  const firstDesc = (n, names) => {
    for (const c of n.children) {
      if (names.includes(c.name)) return c;
      if (c.name === 'Lanes') { const d = firstDesc(c, names); if (d) return d; }
    }
    return null;
  };

  /** Warps -> function(content position in beats) -> seconds; plus playback-rate check. */
  const warpMap = (warps, contentUnit) => {
    const wu = warps.attrs.timeUnit || contentUnit || 'beats';
    const cu = warps.attrs.contentTimeUnit || 'seconds';
    const pts = children(warps, 'Warp').map((w) => ({ t: toBeats(numAttr(w, 'time', 0), wu), c: cu === 'beats' ? numAttr(w, 'contentTime', 0) * spb() : numAttr(w, 'contentTime', 0) })).sort((a, b) => a.t - b.t);
    if (pts.length < 2) return { map: (b) => b * spb(), stretched: false };
    const map = (b) => {
      let i = 0;
      while (i < pts.length - 2 && b > pts[i + 1].t) i++;
      const a = pts[i], z = pts[i + 1];
      return z.t > a.t ? a.c + ((b - a.t) * (z.c - a.c)) / (z.t - a.t) : a.c;
    };
    const stretched = pts.some((p, i) => i > 0 && p.t > pts[i - 1].t && Math.abs((p.c - pts[i - 1].c) / ((p.t - pts[i - 1].t) * spb()) - 1) > 0.01);
    return { map, stretched };
  };

  const companions = new Map();
  /** Hybrid tracks (audio clips on a note track): the audio goes to an audio track right below. */
  const audioCompanion = (track) => {
    if (companions.has(track.id)) return companions.get(track.id);
    const t = createTrack({ type: 'audio', name: `${track.name} (audio)`, color: track.color, volume: track.volume, pan: track.pan });
    t.mute = track.mute;
    t.sends = { ...track.sends };
    project.tracks.splice(project.tracks.indexOf(track) + 1, 0, t);
    companions.set(track.id, t);
    report.warnings.push(`Track "${track.name}": audio clips on a note track moved to "${t.name}".`);
    return t;
  };
  let disabledClips = 0;
  let stretchedClips = 0;
  const lanesAutomation = [];

  const processClip = (clipEl, ctx) => {
    if (boolAttr(clipEl, 'enable', true) === false) { disabledClips++; return; }
    const unit = ctx.unit;
    const t0 = ctx.base + toBeats(numAttr(clipEl, 'time', 0), unit);
    const contentUnit = clipEl.attrs.contentTimeUnit || unit;
    const ps = toBeats(numAttr(clipEl, 'playStart', 0), contentUnit);
    let dur = clipEl.attrs.duration !== undefined ? toBeats(numAttr(clipEl, 'duration', 0), unit) : null;
    if (dur === null) {
      const stop = clipEl.attrs.playStop !== undefined ? toBeats(numAttr(clipEl, 'playStop', 0), contentUnit) : null;
      dur = stop !== null ? stop - ps : 4;
    }
    let start = t0;
    let end = t0 + dur;
    const lo = Math.max(ctx.lo, start);
    const hi = Math.min(ctx.hi, end);
    if (!(hi > lo + 1e-9)) return;
    const trim = lo - start;
    start = lo; end = hi;
    const track = ctx.track;
    const content = firstDesc(clipEl, ['Notes', 'Audio', 'Warps', 'Clips', 'Points']);
    if (!content) return;
    const fu = clipEl.attrs.fadeTimeUnit || unit;
    const fadeIn = toBeats(numAttr(clipEl, 'fadeInTime', 0), fu);
    const fadeOut = toBeats(numAttr(clipEl, 'fadeOutTime', 0), fu);
    if (content.name === 'Clips') {
      // container clip (Bitwig audio clips): inner clips live on its content timeline; its fades apply at its edges
      const outer = { start: trim > 0 ? null : start, end, fadeIn: trim > 0 ? 0 : fadeIn, fadeOut, name: clipEl.attrs.name || null };
      for (const inner of children(content, 'Clip')) processClip(inner, { ...ctx, unit: contentUnit, base: t0 - ps, lo: start, hi: end, outer });
      return;
    }
    if (content.name === 'Points') return; // clip-level automation: not supported
    if (!track || track.type === 'code') return;
    if (content.name === 'Notes') {
      if (track.type !== 'instrument') { report.warnings.push(`Track "${track.name}": note clip on an audio track skipped.`); return; }
      const notes = readNotes(content, contentUnit);
      const ls = clipEl.attrs.loopStart !== undefined ? toBeats(numAttr(clipEl, 'loopStart', 0), contentUnit) : null;
      const le = clipEl.attrs.loopEnd !== undefined ? toBeats(numAttr(clipEl, 'loopEnd', 0), contentUnit) : null;
      let len, offset, patNotes;
      if (ls !== null && le !== null && le > ls + 1e-9) {
        len = le - ls;
        patNotes = notes.filter((n) => n.start >= ls - 1e-9 && n.start < le - 1e-9).map((n) => ({ ...n, start: n.start - ls }));
        offset = ps + trim - ls;
        offset = ((offset % len) + len) % len;
      } else {
        len = ps + trim + (end - start);
        patNotes = notes.filter((n) => n.start >= -1e-9 && n.start < len - 1e-9);
        offset = ps + trim;
      }
      if (!(len > 0)) return;
      const patternId = addPattern(track, patNotes, len, clipEl.attrs.name);
      project.clips.push(createClip(track.id, { patternId, start: r6(start), length: r6(end - start), offset: r6(offset), name: clipEl.attrs.name || null }));
      return;
    }
    // audio
    const audio = content.name === 'Audio' ? content : child(content, 'Audio');
    if (!audio) { report.unmapped.push(`Track "${track.name}": clip content <${content.name}> not supported`); return; }
    const file = child(audio, 'File');
    if (!file) return;
    if (boolAttr(file, 'external', false) && !files.has(file.attrs.path)) { report.warnings.push(`Track "${track.name}": external audio "${file.attrs.path}" is not inside the archive — clip skipped.`); return; }
    const sampleId = sampleFromPath(file.attrs.path, null, { duration: numAttr(audio, 'duration', null) });
    if (!sampleId) { report.warnings.push(`Track "${track.name}": audio file "${file.attrs.path}" missing from the archive — clip skipped.`); return; }
    const target = track.type === 'audio' ? track : audioCompanion(track);
    let offSec;
    if (content.name === 'Warps') {
      const w = warpMap(content, contentUnit);
      if (w.stretched) stretchedClips++;
      offSec = w.map(ps + trim);
    } else {
      offSec = (ps + trim) * spb(); // ps is already in beats (content unit converted)
    }
    const clip = createClip(target.id, { type: 'audio', sampleId, start: r6(start), length: r6(end - start), offset: r6(Math.max(0, offSec / spb())), name: clipEl.attrs.name || ctx.outer?.name || project.samples[sampleId].name });
    let fi = trim > 0 ? 0 : fadeIn;
    let fo = end < t0 + dur - 1e-9 ? 0 : fadeOut;
    if (ctx.outer) {
      if (!fi && ctx.outer.start !== null && Math.abs(start - ctx.outer.start) < 1e-6) fi = ctx.outer.fadeIn;
      if (!fo && Math.abs(end - ctx.outer.end) < 1e-6) fo = ctx.outer.fadeOut;
    }
    if (fi > 0) clip.fadeIn = r6(fi);
    if (fo > 0) clip.fadeOut = r6(fo);
    project.clips.push(clip);
  };

  const processLanes = (node, ctx) => {
    for (const c of node.children) {
      const track = c.attrs.track ? (trackByXmlId.has(c.attrs.track) ? trackByXmlId.get(c.attrs.track) : undefined) : ctx.track;
      if (c.attrs.track && track === null) continue; // skipped (rendered companion)
      const sub = { ...ctx, track: track === undefined ? ctx.track : track, unit: c.attrs.timeUnit || ctx.unit };
      if (c.name === 'Lanes') processLanes(c, sub);
      else if (c.name === 'Clips') for (const clip of children(c, 'Clip')) processClip(clip, sub);
      else if (c.name === 'Points') lanesAutomation.push({ el: c, unit: sub.unit });
      else if (c.name === 'Notes' && sub.track?.type === 'instrument') {
        const notes = readNotes(c, sub.unit);
        if (notes.length) {
          const end = Math.max(...notes.map((n) => n.start + n.dur));
          const len = Math.max(beatsPerBar(project), Math.ceil(end / beatsPerBar(project)) * beatsPerBar(project));
          const patternId = addPattern(sub.track, notes, len);
          project.clips.push(createClip(sub.track.id, { patternId, start: 0, length: len }));
        }
      }
    }
  };

  // Audio clips on note tracks: move them to companion audio tracks (DAWs with hybrid tracks)
  const arrangement = child(root, 'Arrangement');
  if (arrangement) {
    const lanes = child(arrangement, 'Lanes');
    if (lanes) {
      processLanes({ children: [lanes] }, { track: null, unit: lanes.attrs.timeUnit || 'beats', base: 0, lo: -Infinity, hi: Infinity });
    }
    const mk = child(arrangement, 'Markers');
    for (const m of children(mk, 'Marker')) project.markers.push({ id: uid('mk'), beat: r6(toBeats(numAttr(m, 'time', 0), mk.attrs.timeUnit || lanes?.attrs.timeUnit || 'beats')), name: m.attrs.name || 'Marker' });
    const ta = child(arrangement, 'TempoAutomation');
    if (ta) {
      const pts = children(ta).filter((p) => p.name === 'RealPoint').map((p) => ({ beat: r6(numAttr(p, 'time', 0)), bpm: r6(numAttr(p, 'value', project.bpm)), ...(p.attrs.interpolation === 'hold' ? { interpolation: 'hold' } : {}) }));
      if (pts.length) {
        project.tempoAutomation = pts;
        const first = pts.reduce((a, b) => (b.beat < a.beat ? b : a));
        project.bpm = first.bpm;
        if (pts.some((p) => Math.abs(p.bpm - first.bpm) > 1e-6)) report.warnings.push(`Tempo changes (${pts.length} points) are kept in the project but daW³ plays a constant ${first.bpm} BPM.`);
      }
    }
    const tsa = child(arrangement, 'TimeSignatureAutomation');
    if (tsa) {
      const pts = children(tsa, 'TimeSignaturePoint').map((p) => ({ beat: r6(numAttr(p, 'time', 0)), num: numAttr(p, 'numerator', 4), den: numAttr(p, 'denominator', 4) }));
      if (pts.length) {
        project.timeSigAutomation = pts;
        project.timeSig = [pts[0].num, pts[0].den];
        if (pts.some((p) => p.num !== pts[0].num || p.den !== pts[0].den)) report.warnings.push('Time-signature changes are kept in the project but daW³ plays the first one.');
      }
    }
  }

  // ---- automation
  for (const { el: pe, unit } of lanesAutomation) {
    const target = child(pe, 'Target');
    const ref = target?.attrs.parameter && params.get(target.attrs.parameter);
    if (!ref) {
      const what = target?.attrs.expression ? `${target.attrs.expression} expression` : target?.attrs.controller ? `MIDI CC ${target.attrs.controller}` : `parameter ${target?.attrs.parameter || '?'}`;
      const owner = byId.get(pe.attrs.track) || null;
      report.unmapped.push(`Automation of ${what}${owner?.attrs?.name ? ` on "${owner.attrs.name}"` : ''} (${children(pe).length - 1} points) — no daW³ target, omitted`);
      continue;
    }
    const pts = [];
    let prev = null;
    for (const p of children(pe)) {
      if (p.name === 'Target') continue;
      const beat = toBeats(numAttr(p, 'time', 0), pe.attrs.timeUnit || unit);
      let raw;
      if (p.name === 'BoolPoint') raw = boolAttr(p, 'value', false);
      else raw = numAttr(p, 'value', 0);
      const value = r6(ref.kind === 'bool' ? (raw === true || raw === 1 ? 1 : 0) : Number(ref.from(raw)));
      if (prev?.hold && beat > prev.beat) pts.push({ beat: r6(beat), value: prev.value });
      pts.push({ beat: r6(beat), value });
      prev = { beat, value, hold: p.attrs.interpolation === 'hold' || p.name !== 'RealPoint' };
    }
    if (!pts.length) continue;
    const owner = ref.owner;
    const list = owner.automation || (owner.automation = []);
    const existing = list.find((l) => l.target === ref.target);
    if (existing) existing.points = sortPoints([...existing.points, ...pts]);
    else list.push(createAutomationLane(ref.target, pts));
  }

  if (disabledClips) report.warnings.push(`${disabledClips} disabled clip(s) skipped.`);
  if (stretchedClips) report.warnings.push(`${stretchedClips} time-stretched audio clip(s) play at their original speed in daW³.`);
  const scenes = children(child(root, 'Scenes'), 'Scene');
  if (scenes.length) report.unmapped.push(`${scenes.length} clip-launcher scene(s) not imported.`);

  // ---- finish
  for (const t of project.tracks) {
    delete t._restored;
    delete t._mappedInstrument;
    if (t.type === 'instrument' && !t.activePatternId) {
      const pat = createPattern(t.id, { name: `${t.name} 1`, length: beatsPerBar(project) });
      project.patterns[pat.id] = pat;
      t.activePatternId = pat.id;
    }
  }
  if (!project.master.mute) delete project.master.mute;
  if (!project.master.pan) delete project.master.pan;
  project.mode = project.clips.length ? 'song' : 'pattern';
  const len = songLengthBeats(project);
  project.loop = { enabled: false, start: 0, end: len };
  project.scenes = [createScene('Scene 1')];
  report.exported.push(`${project.tracks.length} track(s), ${project.buses.length} return(s), ${project.clips.length} clip(s), ${Object.keys(project.samples).length} audio file(s)` + (app ? ` from ${app.attrs.name || '?'} ${app.attrs.version || ''}`.trimEnd() : ''));
  if (report.skippedRendered) report.exported.push(`${report.skippedRendered} rendered audio track(s) of daW³ instruments skipped (the instruments are restored).`);
  return { project: normalizeProject(project), report };
}

/** Reads a .dawproject archive. */
export async function importDawproject(bytes, opts = {}) {
  const files = await readZip(bytes, { codec: opts.codec });
  const xml = zipText(files, 'project.xml');
  if (!xml) throw new Error('Not a DAWproject file (project.xml missing).');
  return parseDawproject(xml, files, { ...opts, metadataXml: zipText(files, 'metadata.xml') });
}

/** One-paragraph summary of an import/export report (for toasts). */
export function summarizeReport(report, { max = 4 } = {}) {
  const parts = [];
  if (report.mapped.length) parts.push(`${report.mapped.length} device/automation mapping(s)`);
  if (report.placeholders.length) parts.push(`${report.placeholders.length} placeholder device(s)`);
  if (report.unmapped.length) parts.push(`${report.unmapped.length} item(s) not transferable`);
  if (report.warnings.length) parts.push(`${report.warnings.length} note(s)`);
  const details = [...report.placeholders, ...report.unmapped, ...report.warnings].slice(0, max);
  return parts.length ? `${parts.join(', ')}.${details.length ? ' ' + details.join(' · ') : ''}` : 'Everything transferred.';
}
