// Applying edited song code back to the project — shared by the desktop Code view (src/ui/views/code.js) and
// the Pocket Code page (src/mobile/pages/code.js). Node-safe (no DOM).
//
//   planSongApply(project, text, {song, songBase, presets, kits}) -> what an Apply would do:
//     {kind: 'unchanged'} | {kind: 'foreign'} (a different song was pasted: replace the project with it)
//     | {kind: 'error', error} | {kind: 'apply', dry, applyFn, opts}
//   commitSongApply(store, plan, text, {keep}) -> report {changed, changes, muted, complex, warnings}
//   splitCodeIntoTracks(text) / replaceProjectWithCode(project, text, res) — the "foreign song" path.
import { createProject, createTrack, beatsPerBar } from '../core/model.js';
import { deepClone } from '../core/util.js';
import * as strudel from './strudel.js';
import { applySongCode } from './song-code.js';
import { applyLiveCode } from './livecoder.js';

/** True when the editor holds a different song: none of the project's track labels / section names remain. */
export function isForeignSong(project, song, text) {
  if (!project.tracks.length) return text.trim().length > 0;
  const names = new Set([...Object.keys(song?.labels || {}), ...[...(song?.code || '').matchAll(/\bconst\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1])]);
  if (!names.size) return false;
  for (const n of names) if (new RegExp(`(^|[^\\w$])${n.replace(/[$]/g, '\\$')}([^\\w$]|$)`).test(text)) return false;
  return true;
}

/**
 * One code track per instrument: every labelled block ($:, name:, _$:) becomes its own track, with the
 * shared setup (register / setcpm / samples / const …) copied in front so each track runs on its own.
 */
export function splitCodeIntoTracks(text) {
  const COLORS = ['#ffd43b', '#4dabf7', '#ff5f6d', '#38d9a9', '#9775fa', '#ffa94d', '#f783ac', '#3bc9db'];
  const DRUMS = /^(bd|sd|hh|oh|cp|rim|lt|mt|ht|cr|rd|cb|sh|perc|tb|cl|tbd|kick|snare|hat|clap|breaks?\d*|.*_(bd|sd|hh|oh|cp))$/i;
  let items = [];
  try { items = strudel.splitTopLevel ? strudel.splitTopLevel(text) : []; } catch { items = []; }
  const blocks = items.filter((it) => it.kind === 'label');
  if (blocks.length < 2) return [createTrack({ type: 'code', name: 'Strudel', code: text, role: 'code', color: COLORS[0] })];
  const setup = items.filter((it) => it.kind !== 'label').map((it) => text.slice(it.start, it.end)).join('\n');
  const used = new Map();
  return blocks.map((b, i) => {
    const body = text.slice(b.start, b.end);
    let name = b.name && b.name !== '$' ? b.name : '';
    if (!name) {
      const snd = /(?:^|[.\s(])(?:s|sound)\(\s*["'`]\s*([A-Za-z0-9_]+)/.exec(body)?.[1];
      const isNote = /\b(?:note|n)\(/.test(body);
      name = snd ? (DRUMS.test(snd) && !isNote ? 'Drums' : snd[0].toUpperCase() + snd.slice(1)) : `Part ${i + 1}`;
    }
    const k = used.get(name) || 0;
    used.set(name, k + 1);
    if (k) name = `${name} ${k + 1}`;
    // un-mute the label inside its own track; the track's mute button carries the state instead
    const code = (setup ? setup + '\n\n' : '') + body.replace(/^_(\$|[A-Za-z_][\w]*)\s*:/, '$1:');
    const t = createTrack({ type: 'code', name, code, role: 'code', color: COLORS[i % COLORS.length] });
    if (b.muted) t.mute = true;
    return t;
  });
}

/** Mutator (inside store.transact): the whole project becomes code tracks playing `text`; buses & master stay. */
export function replaceProjectWithCode(p, text, res, tracks = splitCodeIntoTracks(text)) {
  const fresh = createProject();
  const keep = { buses: p.buses, master: p.master, samples: p.samples };
  for (const k of Object.keys(p)) if (!(k in keep)) delete p[k];
  Object.assign(p, fresh, keep, { id: p.id, name: 'Strudel song', mode: 'pattern', tracks, patterns: {}, clips: [], markers: [] });
  if (res?.cps > 0) p.bpm = Math.round(res.cps * 60 * beatsPerBar(p) * 100) / 100;
  for (const s of p.scenes || []) s.slots = {};
  return tracks;
}

/** Decide what applying `text` means and dry-run it on a copy of the project. */
export function planSongApply(project, text, { song, songBase = null, songDraft = null, presets, kits } = {}) {
  if (!song) return { kind: 'error', error: 'No song code' };
  if (text === song.code && songDraft === null) return { kind: 'unchanged' };
  if (isForeignSong(project, song, text)) return { kind: 'foreign' };
  const opts = { presets, kits };
  const live = song.mode === 'live';
  const original = live && songBase?.mode === 'live' ? songBase : song;
  const applyFn = live ? (p, t, o) => applyLiveCode(p, t, { ...o, original }) : applySongCode;
  let dry;
  try { dry = applyFn(deepClone(project), text, opts); } catch (e) { dry = { error: String(e?.message || e) }; }
  if (dry.error) return { kind: 'error', error: dry.error };
  return { kind: 'apply', dry, applyFn, opts };
}

/** Commit a planned apply (one undo step when something changes). keep: keep complex blocks as code tracks. */
export function commitSongApply(store, plan, text, { keep = false } = {}) {
  let rep = plan.dry;
  if (plan.dry.changed || (keep && plan.dry.complex.length)) {
    store.transact('Apply song code', (p) => { rep = plan.applyFn(p, text, { ...plan.opts, keepComplexAsCode: keep }); });
  }
  return rep;
}

/** Human summary lines of an apply report (toasts). */
export function songApplySummary(rep, { keep = false } = {}) {
  const parts = [];
  if (rep.changes.length) parts.push(rep.changes.slice(0, 4).join(' · ') + (rep.changes.length > 4 ? ` · +${rep.changes.length - 4} more` : ''));
  if (rep.muted.length) parts.push(`Muted (block removed or "_" added): ${rep.muted.join(', ')} — tracks are never deleted from here; unmute or delete them in the mixer.`);
  if (!keep && rep.complex?.length) parts.push(`Skipped: ${rep.complex.map((c) => c.label).join(', ')}`);
  if (!parts.length && !rep.warnings.length) parts.push('Nothing to change — the project already matches the code.');
  return parts;
}
