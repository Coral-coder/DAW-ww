// "About sounds" dialog: where daW³'s streamed instrument samples come from and their licenses / credits
// (CC-BY sources must be credited). Opened from the main menu.
import { h } from './dom.js';
import { modal } from './components.js';
import { MS_SETS } from '../audio/library/multisample-data.js';

const SOURCES = [
  { name: 'Salamander Grand Piano V3', by: 'Alexander Holm (mp3 conversion: Yotam Mann, tambien/Piano)', license: 'CC-BY 3.0', url: 'https://github.com/tambien/Piano' },
  { name: 'VS Chamber Orchestra: Community Edition', by: 'Versilian Studios — Sam Gossner, Simon Dalzell', license: 'CC0', url: 'https://github.com/sgossner/VSCO-2-CE' },
  { name: 'Versilian Community Sample Library (VCSL)', by: 'Versilian Studios', license: 'CC0', url: 'https://github.com/sgossner/VCSL' },
  { name: 'tonejs-instruments', by: 'Nicholaus Brosowsky (MIT) — guitars / bass / sax: Karoryfer Samples; steel guitar: University of Iowa MIS; nylon guitar: Freesound “quartertone” (CC-BY 3.0); harmonium: Freesound “donyaquick” (CC-BY 3.0)', license: 'MIT + sample licenses', url: 'https://github.com/nbrosowsky/tonejs-instruments' },
  { name: 'MusyngKite & FluidR3 GM soundfonts', by: 'Musyng Kite / Frank Wen — midi-js conversion by Benjamin Gleitzman', license: 'CC-BY-SA 3.0 / CC-BY 3.0', url: 'https://github.com/gleitz/midi-js-soundfonts' },
  { name: 'Drum machines, Dirt-Samples, dough-samples', by: 'TidalCycles / Strudel community (ritchse, Felix Roos and contributors)', license: 'see repositories', url: 'https://github.com/felixroos/dough-samples' },
];

export function showAboutSounds() {
  const body = h('div.about-sounds',
    h('p', 'Generated songs stream real recorded instruments straight from these open libraries (nothing is bundled; files are cached in your browser). When a library cannot be reached, a General-MIDI soundfont and then a built-in synth take over.'),
    h('ul', SOURCES.map((s) => h('li', h('b', s.name), ` — ${s.by}. `, h('i', s.license), ' · ', h('a', { href: s.url, target: '_blank', rel: 'noopener' }, 'source')))),
    h('p', `${Object.keys(MS_SETS).length} multisampled instruments: ${Object.values(MS_SETS).map((s) => s.name.replace(/ \(.*\)$/, '')).join(', ')}.`));
  return modal({ title: 'About sounds', body, width: 620, actions: [{ label: 'Close', primary: true }] });
}
