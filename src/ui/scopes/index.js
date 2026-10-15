// Analyzer views shared by the effect cards (src/ui/fx-ui/analysis.js), their pop-out windows, the Scopes dock panel
// (src/ui/panels/scopes.js) and Pocket. mountAnalyzer(kind, opts) -> { el, stop() }.
//
//   opts = { getProbe(): probe | null   (src/audio/scope-tap.js),
//            getParams(): resolved params of the analyzer type (EFFECT_DEFS[kind]),
//            compact?: smaller fonts / fewer labels (Pocket), popout?: {key, title} adds a pop-out button,
//            fps?: frame rate (default 40) }
import { h } from '../dom.js';
import { animate, readTheme, TapReader, toolButton, openPopout } from './common.js';
import { createOscilloscope } from './oscilloscope.js';
import { createVectorscope } from './vectorscope.js';
import { createSpectrum } from './spectrum.js';
import { createSpectrogram } from './spectrogram.js';
import { createTuner } from './tuner.js';

export const SCOPE_VIEWS = {
  oscilloscope: createOscilloscope,
  vectorscope: createVectorscope,
  spectrum: createSpectrum,
  spectrogram: createSpectrogram,
  tuner: createTuner,
};
export const SCOPE_KINDS = Object.keys(SCOPE_VIEWS);

export function loadStyles() {
  if (typeof document === 'undefined' || document.querySelector('link[data-scopes]')) return;
  document.head.appendChild(h('link', { rel: 'stylesheet', href: new URL('../../../styles/scopes.css', import.meta.url).href, dataset: { scopes: '1' } }));
}

export function mountAnalyzer(kind, { getProbe, getParams, compact = false, popout = null, fps = 40 } = {}) {
  loadStyles();
  const make = SCOPE_VIEWS[kind];
  if (!make) throw new Error(`Unknown analyzer "${kind}"`);
  const view = make({ getParams, compact });
  const tools = [...(view.tools || [])];
  if (popout) {
    tools.push(toolButton('⧉', 'Pop out: open this analyzer in a large floating window', () => openPopout({
      key: popout.key, title: popout.title,
      width: kind === 'tuner' ? 460 : kind === 'vectorscope' ? 480 : 820, height: kind === 'vectorscope' ? 560 : kind === 'tuner' ? 380 : 460,
      build: (host) => host.appendChild(mountAnalyzer(kind, { getProbe, getParams, fps: 60 }).el),
    })));
  }
  const el = h(`div.an-view.an-${kind}${compact ? '.compact' : ''}`, view.el, tools.length ? h('div.an-tools', tools) : null);
  const reader = new TapReader(getProbe);
  const stop = animate(el, (dt) => view.frame(reader, dt, readTheme(el)), fps);
  return { el, stop: () => { stop(); view.dispose?.(); } };
}
