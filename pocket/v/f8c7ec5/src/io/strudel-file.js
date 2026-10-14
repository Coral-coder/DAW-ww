// Strudel file import/export (.strudel / .js / .txt / .str) and strudel.cc share links.
import { downloadBlob, safeFileName } from './project-file.js';
import { arrayBufferToBase64, base64ToArrayBuffer } from './samples.js';

const EXT_RE = /\.(strudel|str|js|mjs|txt|tidal)$/i;

/** strudel.cc encodes code in the URL hash as base64(utf-8), URI-encoded. */
export function decodeStrudelHash(hash) {
  const raw = decodeURIComponent(String(hash).replace(/^#/, '').trim());
  return new TextDecoder().decode(new Uint8Array(base64ToArrayBuffer(raw)));
}

export function encodeStrudelHash(code) {
  return encodeURIComponent(arrayBufferToBase64(new TextEncoder().encode(code)));
}

/** Link that opens the code on strudel.cc. */
export function codeToShareUrl(code) {
  return `https://strudel.cc/#${encodeStrudelHash(code)}`;
}

function fromText(text, name = 'strudel') {
  let code = String(text).replace(/^﻿/, '');
  const trimmed = code.trim();
  const m = /^https?:\/\/[^\s#]*strudel[^\s#]*#(\S+)$/i.exec(trimmed);
  if (m) {
    try {
      code = decodeStrudelHash(m[1]);
      name = 'strudel-share';
    } catch {
      throw new Error('Could not decode the strudel.cc link.');
    }
  }
  return { name, code: code.replace(/\r\n?/g, '\n') };
}

/** Accepts a File/Blob or text (code or a strudel.cc share URL). Resolves { name, code }. */
export async function readStrudelFile(fileOrText) {
  if (typeof fileOrText === 'string') return fromText(fileOrText);
  if (!fileOrText || typeof fileOrText.text !== 'function') throw new Error('readStrudelFile expects a File or text.');
  const name = String(fileOrText.name || 'strudel').replace(EXT_RE, '') || 'strudel';
  return fromText(await fileOrText.text(), name);
}

/** Download code as `<name>.strudel`. Returns false outside the browser. */
export function downloadStrudel(code, name = 'pattern') {
  let file = safeFileName(name, 'pattern');
  if (!EXT_RE.test(file)) file += '.strudel';
  return downloadBlob(new Blob([code], { type: 'text/plain' }), file);
}
