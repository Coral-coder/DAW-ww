// Pocket ▸ Code — pure helpers: the snippet bar and inserting at the cursor (Node-testable).
// A snippet's `text` may contain one `|` marking where the cursor lands (or `|…|` to select a placeholder).

export const SNIPPETS = [
  { label: 's()', text: 's("|bd sd|")', tip: 'Play samples / drum sounds' },
  { label: 'n()', text: 'n("|0 2 4|")', tip: 'Scale degrees / sample numbers' },
  { label: 'note()', text: 'note("|c3 e3 g3|")', tip: 'Notes by name or MIDI number' },
  { label: '.s()', text: '.s("|sawtooth|")', tip: 'Choose the sound' },
  { label: '.lpf()', text: '.lpf(|800|)', tip: 'Low-pass filter (Hz)' },
  { label: '.hpf()', text: '.hpf(|300|)', tip: 'High-pass filter (Hz)' },
  { label: '.room()', text: '.room(|0.4|)', tip: 'Reverb amount' },
  { label: '.delay()', text: '.delay(|0.25|)', tip: 'Delay amount' },
  { label: '.gain()', text: '.gain(|0.8|)', tip: 'Volume' },
  { label: '.fast()', text: '.fast(|2|)', tip: 'Speed up' },
  { label: '.slow()', text: '.slow(|2|)', tip: 'Slow down' },
  { label: '.every()', text: '.every(|4|, x => x.rev())', tip: 'Do something every N cycles' },
  { label: '.rev()', text: '.rev()|', tip: 'Reverse each cycle' },
  { label: '.scale()', text: '.scale("|C:minor|")', tip: 'Map n() to a scale' },
  { label: '.bank()', text: '.bank("|RolandTR909|")', tip: 'Drum machine' },
  { label: 'stack()', text: 'stack(\n  |s("bd*4")|,\n)', tip: 'Play patterns together' },
  { label: 'cat()', text: 'cat(|"c3 e3"|, "g3 b3")', tip: 'One pattern per cycle' },
  { label: 'arrange()', text: 'arrange(\n  [|4|, a],\n  [4, b],\n)', tip: 'Song form: [cycles, pattern] pairs' },
  { label: '$:', text: '\n$: |s("hh*8")|\n', tip: 'A new block (part)' },
  { label: '"…"', text: '"|~|"', tip: 'Mini-notation string' },
  { label: '*', text: '*|2|', tip: 'Repeat (mini-notation)' },
  { label: '<>', text: '<|a b|>', tip: 'Alternate per cycle (mini-notation)' },
  { label: '[ ]', text: '[|a b|]', tip: 'Group in one step (mini-notation)' },
  { label: '~', text: '~|', tip: 'Rest' },
];

/**
 * Insert a snippet into `text` replacing the selection [selStart, selEnd]. A selection replaces the snippet's
 * placeholder (so selecting "800" and tapping .lpf() wraps nothing — it inserts `.lpf(800)` around the
 * selected value). Method snippets (starting with '.') typed right after whitespace at the start of a line keep
 * the indent. -> {text, selStart, selEnd} (the new selection: the placeholder, or the cursor).
 */
export function insertSnippet(text, selStart, selEnd, snippet) {
  const src = typeof snippet === 'string' ? snippet : snippet.text;
  const a = Math.max(0, Math.min(selStart ?? text.length, text.length));
  const b = Math.max(a, Math.min(selEnd ?? a, text.length));
  const selected = text.slice(a, b);
  const i = src.indexOf('|');
  const j = i >= 0 ? src.indexOf('|', i + 1) : -1;
  let ins, s0, s1;
  if (i < 0) { ins = src; s0 = s1 = src.length; } else if (j < 0) {
    ins = src.slice(0, i) + selected + src.slice(i + 1);
    s0 = i; s1 = i + selected.length;
    if (!selected) s1 = s0;
  } else {
    const ph = selected || src.slice(i + 1, j);
    ins = src.slice(0, i) + ph + src.slice(j + 1);
    s0 = i; s1 = i + ph.length;
  }
  return { text: text.slice(0, a) + ins + text.slice(b), selStart: a + s0, selEnd: a + s1 };
}

/** Code tracks + the song as entries of the page's picker. */
export function codeEntries(project) {
  return [{ id: 'song', label: 'Whole song' }, ...project.tracks.filter((t) => t.type === 'code').map((t) => ({ id: t.id, label: t.name }))];
}
