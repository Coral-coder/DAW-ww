// Project save / load (JSON file format `heroic-daw-project`).
import { PROJECT_FORMAT, normalizeProject } from '../core/model.js';

export const PROJECT_EXTENSION = '.heroic.json';

/** Pretty JSON including samples (base64). */
export function serializeProject(project) {
  return JSON.stringify({ ...project, format: PROJECT_FORMAT }, null, 2);
}

/**
 * Parses project file text (or an already-parsed object). Validates and normalizes.
 * Returns the normalized project; non-fatal issues are listed in a non-enumerable `warnings` array.
 * Throws a readable Error on anything that is not a project.
 */
export function parseProjectFile(input) {
  let data = input;
  if (typeof input === 'string' || input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    let text = typeof input === 'string' ? input : new TextDecoder().decode(input);
    text = text.replace(/^﻿/, '').trim();
    if (!text) throw new Error('The file is empty.');
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`Not a valid project file (JSON parse error: ${e.message}).`);
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Not a valid project file (expected a JSON object).');
  const warnings = [];
  if (data.format !== PROJECT_FORMAT) {
    const looksLikeProject = Array.isArray(data.tracks) || (data.patterns && typeof data.patterns === 'object') || typeof data.bpm === 'number';
    if (!looksLikeProject) throw new Error('Not a daWWW project (missing format, tracks and patterns).');
    warnings.push(data.format ? `Unknown format "${data.format}" — loaded as best effort.` : 'File has no format marker — loaded as best effort.');
  }
  if (data.tracks !== undefined && !Array.isArray(data.tracks)) throw new Error('Invalid project: "tracks" must be an array.');
  if (data.patterns !== undefined && (typeof data.patterns !== 'object' || data.patterns === null || Array.isArray(data.patterns))) {
    throw new Error('Invalid project: "patterns" must be an object.');
  }
  if (data.clips !== undefined && !Array.isArray(data.clips)) throw new Error('Invalid project: "clips" must be an array.');
  const project = normalizeProject(data);
  if (!(typeof project.bpm === 'number' && project.bpm > 0 && project.bpm < 1000)) {
    warnings.push(`Invalid bpm "${project.bpm}" — reset to 120.`);
    project.bpm = 120;
  }
  const trackIds = new Set(project.tracks.map((t) => t.id));
  const before = project.clips.length;
  project.clips = project.clips.filter((c) => c && trackIds.has(c.trackId));
  if (project.clips.length !== before) warnings.push(`${before - project.clips.length} clip(s) referenced missing tracks and were removed.`);
  for (const p of Object.values(project.patterns)) {
    if (!Array.isArray(p.notes)) { p.notes = []; warnings.push(`Pattern "${p.name}" had no notes array.`); }
  }
  Object.defineProperty(project, 'warnings', { value: warnings, enumerable: false, configurable: true, writable: true });
  return project;
}

/** Generic browser download helper. No-op (returns false) outside the browser. */
export function downloadBlob(blob, filename) {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return false;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  return true;
}

export function safeFileName(name, fallback = 'project') {
  const s = String(name || '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').slice(0, 120);
  return s || fallback;
}

/** Download the project as `<name>.heroic.json`. */
export function downloadProject(project, filename) {
  let name = filename || `${safeFileName(project.name, 'project')}${PROJECT_EXTENSION}`;
  if (!name.endsWith('.json')) name += PROJECT_EXTENSION;
  return downloadBlob(new Blob([serializeProject(project)], { type: 'application/json' }), name);
}

/** Read a File/Blob (from <input type=file> or drag & drop) as a project. */
export async function readFileAsProject(file) {
  const text = typeof file.text === 'function' ? await file.text() : new TextDecoder().decode(await file.arrayBuffer());
  return parseProjectFile(text);
}
