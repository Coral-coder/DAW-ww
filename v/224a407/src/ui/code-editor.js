// Lightweight, dependency-free code editor for Strudel-style code:
// a transparent <textarea> on top of a syntax-highlighted <pre>, a line-number gutter,
// a "marks" layer (live event highlights) and an error-line band.
//
// createCodeEditor({ value, onChange(text), onApply(text), onApplyBlock(text, block), onStop(), placeholder })
//   -> { el, getValue, setValue(text, {keepUndo}), focus, insertAtCursor(text), setErrorLine(line|null),
//        setMarks([{start, end, cls?}]), getBlockAt(pos), getCursor(),
//        setHighlights([{start, end, color, alpha}]),   live token boxes (Strudel-style; cheap, per frame)
//        setBlockBars([{line0, line1, color, alpha}]),   gutter colour bars per labelled block (0-based lines)
//        setWidgets([{from, to, value, min, max, step, onInput(v), onChange(v)}]),  slider() widgets: a range
//          input at the end of the slider's line (Strudel REPL style); from/to = the value literal's range
//        lineOfOffset(offset), visibleLines() -> [first, last] }
// The root element has class `code-editor` (keyboard.js ignores global shortcuts inside it).
import { h } from './dom.js';

const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
const CLOSERS = new Set([')', ']', '}', '"', "'", '`']);
const KEYWORDS = new Set(['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'new', 'of', 'in', 'await', 'async', 'true', 'false', 'null', 'undefined', 'this', 'typeof', 'break', 'continue', 'do', 'switch', 'case', 'default']);
const CORE_FUNCS = new Set(['s', 'sound', 'n', 'note', 'stack', 'cat', 'seq', 'fastcat', 'slowcat', 'sequence', 'silence', 'setcps', 'setcpm', 'samples', 'sine', 'saw', 'square', 'tri', 'rand', 'perlin', 'irand', 'chord', 'arrange', 'pure', 'm', 'mini', 'run', 'scale', 'timeCat', 'polymeter', 'register', 'hush']);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const NOTE_RE = /^[a-gA-G](#|b|s|f)*-?\d*$/;

/** Highlight the inside of a mini-notation string. */
export function highlightMini(src) {
  let out = '';
  const re = /(\s+)|(~|-(?![\d.]))|([[\]<>{}()])|([*/!?@:,.|%_^])|(-?\d+(?:\.\d+)?)|([A-Za-z#][\w#.'-]*)|(.)/g;
  let m;
  while ((m = re.exec(src))) {
    const [tok, ws, rest, br, op, num, word] = m;
    if (ws) out += ws;
    else if (rest) out += `<span class="tk-rest">${esc(tok)}</span>`;
    else if (br) out += `<span class="tk-mbr">${esc(tok)}</span>`;
    else if (op) out += `<span class="tk-mop">${esc(tok)}</span>`;
    else if (num) out += `<span class="tk-mnum">${esc(tok)}</span>`;
    else if (word) out += `<span class="${NOTE_RE.test(word) ? 'tk-note' : 'tk-sample'}">${esc(tok)}</span>`;
    else out += esc(tok);
  }
  return out;
}

/** Tokenize JS-ish Strudel code to highlighted HTML. */
export function highlightCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let prevSig = ''; // previous significant char (for method detection)
  while (i < n) {
    const c = src[i];
    const rest = src.slice(i);
    // line start `$:` / `name:` labels
    if ((c === '$' || /[A-Za-z_]/.test(c)) && (i === 0 || src[i - 1] === '\n' || /^[ \t]*$/.test(src.slice(src.lastIndexOf('\n', i - 1) + 1, i)))) {
      const lm = /^(\$|[A-Za-z_]\w*):(?!:)/.exec(rest);
      const lineRest = rest.split('\n')[0];
      if (lm && (lm[1] === '$' || (/^\w+:\s*[A-Za-z_$][\w$]*\s*\(/.test(lineRest) && !/,\s*$/.test(lineRest)))) {
        out += `<span class="tk-label">${esc(lm[0])}</span>`;
        i += lm[0].length; prevSig = ':';
        continue;
      }
    }
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const s = end < 0 ? rest : src.slice(i, end);
      out += `<span class="tk-comment">${esc(s)}</span>`;
      i += s.length;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const s = end < 0 ? rest : src.slice(i, end + 2);
      out += `<span class="tk-comment">${esc(s)}</span>`;
      i += s.length;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (src[j] === '\n' && c !== '`') break;
        j++;
      }
      const inner = src.slice(i + 1, Math.min(j, n));
      const closed = j < n && src[j] === c;
      out += `<span class="tk-str">${esc(c)}</span><span class="tk-mini">${highlightMini(inner)}</span>${closed ? `<span class="tk-str">${esc(c)}</span>` : ''}`;
      i = closed ? j + 1 : j;
      prevSig = c;
      continue;
    }
    const num = /^(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?|\.\d+)/i.exec(rest);
    if (num && !/[\w$]/.test(src[i - 1] || '')) {
      out += `<span class="tk-num">${esc(num[0])}</span>`;
      i += num[0].length; prevSig = '0';
      continue;
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (id) {
      const w = id[0];
      const after = src.slice(i + w.length).match(/^\s*\(/);
      let cls = 'tk-id';
      if (KEYWORDS.has(w)) cls = 'tk-kw';
      else if (prevSig === '.') cls = 'tk-method';
      else if (after) cls = CORE_FUNCS.has(w) ? 'tk-fn tk-core' : 'tk-fn';
      out += `<span class="${cls}">${esc(w)}</span>`;
      i += w.length; prevSig = 'a';
      continue;
    }
    if (/[()[\]{}]/.test(c)) out += `<span class="tk-br">${esc(c)}</span>`;
    else if (/[=+\-*/<>!&|?:,;%^]/.test(c)) out += `<span class="tk-op">${esc(c)}</span>`;
    else out += esc(c);
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return out;
}

/** Split code into `$:`-blocks (or blank-line separated paragraphs). -> [{start, end, text}] */
export function splitBlocks(src) {
  const lines = src.split('\n');
  const starts = [];
  let off = 0;
  const lineOffsets = lines.map((l) => { const o = off; off += l.length + 1; return o; });
  const hasLabels = lines.some((l) => /^\s*(\$|[A-Za-z_]\w*):(?!:)/.test(l) && !/^\s*\/\//.test(l));
  lines.forEach((l, i) => {
    if (hasLabels) {
      if (/^\s*(\$|[A-Za-z_]\w*):(?!:)/.test(l)) starts.push(i);
    } else if (l.trim() && (i === 0 || !lines[i - 1].trim())) starts.push(i);
  });
  if (!starts.length) return [{ start: 0, end: src.length, text: src }];
  const blocks = [];
  starts.forEach((s, k) => {
    const st = k === 0 ? 0 : lineOffsets[s];
    const en = k + 1 < starts.length ? lineOffsets[starts[k + 1]] : src.length;
    blocks.push({ start: st, end: en, text: src.slice(st, en) });
  });
  return blocks;
}

export function createCodeEditor(opts = {}) {
  const { onChange, onApply, onApplyBlock, onStop, placeholder = '' } = opts;
  const gutterInner = h('div.ce-gutter-inner');
  const gutter = h('div.ce-gutter', { 'aria-hidden': 'true' }, gutterInner);
  const hl = h('pre.ce-highlight', { 'aria-hidden': 'true' });
  const marks = h('pre.ce-marks', { 'aria-hidden': 'true' });
  const band = h('div.ce-errband.hidden');
  const hlLayer = h('div.ce-hl', { 'aria-hidden': 'true' });
  const barLayer = h('div.ce-bars', { 'aria-hidden': 'true' });
  const flash = h('div.ce-flash');
  const widgetLayer = h('div.ce-widgets');
  const ta = h('textarea.ce-input', { spellcheck: false, autocapitalize: 'off', autocomplete: 'off', wrap: 'off', placeholder, 'aria-label': 'Code editor' });
  ta.setAttribute('autocorrect', 'off');
  const stage = h('div.ce-stage', band, flash, hl, marks, hlLayer, ta, widgetLayer);
  gutter.appendChild(barLayer);
  const el = h('div.code-editor', gutter, stage);

  let lastLineCount = 0;
  let errorLine = null;
  let markRanges = [];
  const LINE_H = 20, PAD_T = 10;

  function renderGutter() {
    const count = ta.value.split('\n').length;
    if (count !== lastLineCount || String(errorLine) !== gutterInner.dataset.err) {
      let html = '';
      for (let i = 1; i <= count; i++) html += `<div${i === errorLine ? ' class="err"' : ''}>${i}</div>`;
      gutterInner.innerHTML = html;
      lastLineCount = count;
      gutterInner.dataset.err = String(errorLine);
    }
  }
  function renderHighlight() {
    computeLines();
    hl.innerHTML = highlightCode(ta.value) + '\n ';
    placeWidgets();
    renderMarks();
    renderGutter();
    syncScroll();
  }
  function renderMarks() {
    if (!markRanges.length) { if (marks.innerHTML) marks.innerHTML = ''; return; }
    const src = ta.value;
    const rs = markRanges.filter((r) => r.start >= 0 && r.end <= src.length && r.end > r.start).sort((a, b) => a.start - b.start);
    let out = '', pos = 0;
    for (const r of rs) {
      if (r.start < pos) continue;
      out += esc(src.slice(pos, r.start)) + `<mark class="${r.cls || 'ce-active'}">${esc(src.slice(r.start, r.end))}</mark>`;
      pos = r.end;
    }
    out += esc(src.slice(pos)) + '\n ';
    marks.innerHTML = out;
  }
  function syncScroll() {
    const x = ta.scrollLeft, y = ta.scrollTop;
    hl.style.transform = marks.style.transform = hlLayer.style.transform = widgetLayer.style.transform = `translate(${-x}px, ${-y}px)`;
    gutterInner.style.transform = barLayer.style.transform = `translateY(${-y}px)`;
    if (errorLine) band.style.transform = `translateY(${PAD_T + (errorLine - 1) * LINE_H - y}px)`;
  }
  ta.addEventListener('scroll', syncScroll);
  ta.addEventListener('input', () => { renderHighlight(); onChange && onChange(ta.value); });

  // ---- editing helpers (execCommand keeps the native undo stack) ----
  function replaceRange(start, end, text, selStart, selEnd) {
    ta.focus();
    ta.setSelectionRange(start, end);
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
    if (!ok) {
      ta.setRangeText(text, start, end, 'end');
      ta.dispatchEvent(new Event('input'));
    }
    if (selStart !== undefined) ta.setSelectionRange(selStart, selEnd ?? selStart);
  }
  const lineStartOf = (pos) => ta.value.lastIndexOf('\n', pos - 1) + 1;
  const lineEndOf = (pos) => { const e = ta.value.indexOf('\n', pos); return e < 0 ? ta.value.length : e; };

  function selectedLinesRange() {
    const s = ta.selectionStart, e = ta.selectionEnd;
    const ls = lineStartOf(s);
    const le = lineEndOf(e > s && ta.value[e - 1] === '\n' ? e - 1 : e);
    return [ls, le];
  }

  function toggleComment() {
    const [ls, le] = selectedLinesRange();
    const block = ta.value.slice(ls, le);
    const lines = block.split('\n');
    const nonEmpty = lines.filter((l) => l.trim());
    const allCommented = nonEmpty.length && nonEmpty.every((l) => /^\s*\/\//.test(l));
    const indent = Math.min(...nonEmpty.map((l) => l.match(/^\s*/)[0].length), 1e9);
    const out = lines.map((l) => {
      if (!l.trim()) return l;
      if (allCommented) return l.replace(/^(\s*)\/\/ ?/, '$1');
      return l.slice(0, indent) + '// ' + l.slice(indent);
    }).join('\n');
    replaceRange(ls, le, out, ls, ls + out.length);
  }

  function indentLines(dedent) {
    const [ls, le] = selectedLinesRange();
    const lines = ta.value.slice(ls, le).split('\n');
    const out = lines.map((l) => (dedent ? l.replace(/^ {1,2}/, '') : '  ' + l)).join('\n');
    replaceRange(ls, le, out, ls, ls + out.length);
  }

  function currentBlock() {
    const pos = ta.selectionStart;
    const blocks = splitBlocks(ta.value);
    const idx = blocks.findIndex((b) => pos >= b.start && pos <= b.end);
    return { blocks, index: idx < 0 ? blocks.length - 1 : idx };
  }

  function flashRange(start, end) {
    // brief highlight of the evaluated region
    const startLine = ta.value.slice(0, start).split('\n').length - 1;
    const endLine = ta.value.slice(0, Math.max(start, end - 1)).split('\n').length - 1;
    flash.style.top = PAD_T + startLine * LINE_H - ta.scrollTop + 'px';
    flash.style.height = (endLine - startLine + 1) * LINE_H + 'px';
    flash.classList.remove('on');
    void flash.offsetWidth;
    flash.classList.add('on');
  }

  ta.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const s = ta.selectionStart, en = ta.selectionEnd;
    const v = ta.value;
    if ((mod && e.key === 'Enter') || (e.shiftKey && e.key === 'Enter' && !mod && !e.altKey)) {
      e.preventDefault();
      flashRange(0, v.length);
      onApply && onApply(v);
      return;
    }
    if (e.altKey && e.key === 'Enter') {
      e.preventDefault();
      const { blocks, index } = currentBlock();
      const b = blocks[index];
      flashRange(b.start, b.end);
      if (onApplyBlock) onApplyBlock(v, { index, blocks });
      else onApply && onApply(v);
      return;
    }
    if (mod && (e.key === '.' || e.code === 'Period')) { e.preventDefault(); onStop && onStop(); return; }
    if (mod && (e.key === '/' || e.code === 'Slash')) { e.preventDefault(); toggleComment(); return; }
    if (e.key === 'Escape') { ta.blur(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (s !== en && v.slice(s, en).includes('\n')) indentLines(e.shiftKey);
      else if (e.shiftKey) indentLines(true);
      else replaceRange(s, en, '  ');
      return;
    }
    if (e.key === 'Enter' && !mod && !e.altKey) {
      e.preventDefault();
      const ls = lineStartOf(s);
      const indent = v.slice(ls, s).match(/^[ \t]*/)[0];
      const before = v[s - 1], after = v[en];
      if (before && '([{'.includes(before) && after === PAIRS[before]) {
        const ins = '\n' + indent + '  ' + '\n' + indent;
        replaceRange(s, en, ins, s + indent.length + 3);
      } else if (before && '([{'.includes(before)) {
        replaceRange(s, en, '\n' + indent + '  ');
      } else replaceRange(s, en, '\n' + indent);
      return;
    }
    if (e.key === 'Backspace' && s === en && s > 0) {
      const a = v[s - 1], b = v[s];
      if (PAIRS[a] && PAIRS[a] === b) { e.preventDefault(); replaceRange(s - 1, s + 1, ''); return; }
      return;
    }
    if (mod || e.altKey) return;
    if (CLOSERS.has(e.key) && s === en && v[s] === e.key) {
      // type over an auto-inserted closer
      e.preventDefault(); ta.setSelectionRange(s + 1, s + 1); return;
    }
    if (PAIRS[e.key]) {
      const isQuote = e.key === '"' || e.key === "'" || e.key === '`';
      if (s !== en) {
        e.preventDefault();
        const inner = v.slice(s, en);
        replaceRange(s, en, e.key + inner + PAIRS[e.key], s + 1, en + 1);
        return;
      }
      if (isQuote) {
        const prev = v[s - 1] || '', next = v[s] || '';
        if (/[\w$]/.test(prev) || /[\w$]/.test(next)) return; // don't pair inside words (e.g. don't)
      } else if (/[\w$]/.test(v[s] || '')) return;
      e.preventDefault();
      replaceRange(s, en, e.key + PAIRS[e.key], s + 1);
    }
  });

  // ---- live highlights: absolutely positioned boxes, only for visible lines ----
  let lineStarts = [0];
  function computeLines() {
    const v = ta.value;
    lineStarts = [0];
    for (let i = v.indexOf('\n'); i >= 0; i = v.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  }
  function lineOfOffset(off) {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1; }
    return lo;
  }
  function colOf(line, off) {
    const st = lineStarts[line];
    const seg = ta.value.slice(st, off);
    if (!seg.includes('\t')) return off - st;
    let c = 0;
    for (const ch of seg) c = ch === '\t' ? c + (2 - (c % 2)) : c + 1;
    return c;
  }
  let metrics = null;
  function measure() {
    const cs = getComputedStyle(ta);
    const probe = h('span', { style: { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', font: cs.font, letterSpacing: cs.letterSpacing } }, 'x'.repeat(200));
    stage.appendChild(probe);
    const w = probe.getBoundingClientRect().width / 200;
    probe.remove();
    if (!(w > 0)) return null;
    return { cw: w, padL: parseFloat(cs.paddingLeft) || 14, padT: parseFloat(cs.paddingTop) || PAD_T };
  }
  function visibleLines() {
    const top = ta.scrollTop;
    const first = Math.max(0, Math.floor((top - PAD_T) / LINE_H) - 1);
    const last = Math.min(lineStarts.length - 1, Math.ceil((top + (ta.clientHeight || 600) - PAD_T) / LINE_H) + 1);
    return [first, last];
  }
  const hlPool = [];
  let hlUsed = 0;
  function setHighlights(list) {
    if (!list || !list.length) {
      if (hlUsed) { for (let i = 0; i < hlUsed; i++) hlPool[i].style.display = 'none'; hlUsed = 0; }
      return;
    }
    if (!metrics) metrics = measure();
    if (!metrics) return;
    const { cw, padL, padT } = metrics;
    const [first, last] = visibleLines();
    const len = ta.value.length;
    let n = 0;
    for (const r of list) {
      const s0 = r.start, e0 = Math.min(r.end, len);
      if (!(e0 > s0) || s0 < 0) continue;
      const l0 = lineOfOffset(s0), l1 = lineOfOffset(e0 - 1);
      if (l1 < first || l0 > last) continue;
      for (let l = Math.max(l0, first); l <= Math.min(l1, last); l++) {
        const a = l === l0 ? s0 : lineStarts[l];
        const b = l === l1 ? e0 : lineStarts[l + 1] - 1;
        if (b <= a) continue;
        let d = hlPool[n];
        if (!d) { d = h('div.ce-hlbox'); hlLayer.appendChild(d); hlPool[n] = d; }
        n++;
        const c0 = colOf(l, a), c1 = colOf(l, b);
        const css = `display:block;left:${(padL + c0 * cw - 2).toFixed(1)}px;top:${padT + l * LINE_H + 1}px;width:${((c1 - c0) * cw + 4).toFixed(1)}px;--hl:${r.color || 'var(--accent-2)'};opacity:${(r.alpha ?? 1).toFixed(2)}`;
        if (d._css !== css) { d.style.cssText = css; d._css = css; }
      }
    }
    for (let i = n; i < hlUsed; i++) { hlPool[i].style.display = 'none'; hlPool[i]._css = ''; }
    hlUsed = n;
  }
  const barPool = [];
  let barUsed = 0;
  function setBlockBars(list) {
    let n = 0;
    for (const b of list || []) {
      let d = barPool[n];
      if (!d) { d = h('div.ce-bar'); barLayer.appendChild(d); barPool[n] = d; }
      n++;
      const css = `display:block;top:${PAD_T + b.line0 * LINE_H}px;height:${(b.line1 - b.line0 + 1) * LINE_H}px;--bar:${b.color || 'var(--accent-2)'};opacity:${(b.alpha ?? 0.3).toFixed(2)};width:${b.alpha > 0.5 ? 4 : 3}px`;
      if (d._css !== css) { d.style.cssText = css; d._css = css; }
    }
    for (let i = n; i < barUsed; i++) { barPool[i].style.display = 'none'; barPool[i]._css = ''; }
    barUsed = n;
  }

  // ---- slider widgets ----
  let widgets = [];
  let widgetKey = '';
  function placeWidgets() {
    if (!widgets.length) return;
    if (!metrics) metrics = measure();
    if (!metrics) return;
    const { cw, padL, padT } = metrics;
    for (const w of widgets) {
      const l = lineOfOffset(w.from);
      const end = l + 1 < lineStarts.length ? lineStarts[l + 1] - 1 : ta.value.length;
      w.el.style.left = `${(padL + (colOf(l, end) + 2) * cw).toFixed(1)}px`;
      w.el.style.top = `${padT + l * LINE_H + 2}px`;
    }
  }
  function setWidgets(list) {
    list = list || [];
    const key = list.map((w) => `${w.from}|${w.to}|${w.min}|${w.max}|${w.step}`).join(';');
    if (key === widgetKey) {
      // same widgets: only follow value changes made in the text
      list.forEach((w, i) => { const cur = widgets[i]; if (cur && document.activeElement !== cur.input && String(cur.input.value) !== String(w.value)) cur.input.value = w.value; });
      return;
    }
    widgetKey = key;
    widgetLayer.replaceChildren();
    widgets = list.map((w) => {
      const min = Number(w.min ?? 0), max = Number(w.max ?? 1);
      const step = w.step != null ? Number(w.step) : (max - min) / 1000;
      const input = h('input.ce-slider', { type: 'range', min, max, step, value: Number(w.value), title: `slider(${w.value}, ${min}, ${max}) — drag to change it live` });
      input.addEventListener('input', () => w.onInput?.(Number(input.value)));
      input.addEventListener('change', () => w.onChange?.(Number(input.value)));
      input.addEventListener('pointerdown', (e) => e.stopPropagation());
      const el = h('div.ce-widget', input);
      widgetLayer.appendChild(el);
      return { ...w, el, input };
    });
    placeWidgets();
  }

  function setValue(text) {
    if (ta.value === text) return;
    const s = ta.selectionStart, y = ta.scrollTop;
    ta.value = text ?? '';
    const p = Math.min(s, ta.value.length);
    ta.setSelectionRange(p, p);
    ta.scrollTop = y;
    renderHighlight();
  }

  function insertAtCursor(text) {
    const s = ta.selectionStart, e = ta.selectionEnd;
    replaceRange(s, e, text, s + text.length);
    ta.focus();
  }

  function setErrorLine(line) {
    errorLine = Number.isFinite(line) && line > 0 ? line : null;
    band.classList.toggle('hidden', !errorLine);
    renderGutter();
    syncScroll();
  }

  function setMarks(ranges) {
    markRanges = ranges || [];
    renderMarks();
  }

  ta.value = opts.value || '';
  renderHighlight();
  // keep gutter/overlays aligned if fonts load late
  if (document.fonts?.ready) document.fonts.ready.then(() => { metrics = null; syncScroll(); });
  new ResizeObserver(() => { if (!metrics) return; const m = measure(); if (m) metrics = m; }).observe(stage);

  return {
    el,
    textarea: ta,
    getValue: () => ta.value,
    setValue,
    focus: () => ta.focus(),
    insertAtCursor,
    setErrorLine,
    setMarks,
    getCursor: () => ta.selectionStart,
    currentBlock,
    refresh: renderHighlight,
    setHighlights,
    setBlockBars,
    setWidgets,
    lineOfOffset,
    visibleLines,
    get scrollTop() { return ta.scrollTop; },
  };
}
