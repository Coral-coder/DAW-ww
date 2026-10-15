// Custom UI for analysis effects, keyed by effect type. Each entry is (el, api) => ({ update?(fx), dispose?() }).
// el is the effect card body (generic param knobs are already in it); api = { fx, tgt, engine, app, probe(), edit }.
// Animation loops must stop by themselves once el.isConnected is false (cards are rebuilt without a dispose call).
//
// The analyzer display (src/ui/scopes) goes beside the knobs; ⧉ opens it in a large floating window that keeps
// following the effect (its probe and latest params are looked up by effect id) after the card is rebuilt.
import { h } from '../dom.js';
import { EFFECT_DEFS, resolveEffectParams } from '../../audio/effect-defs.js';
import { mountAnalyzer } from '../scopes/index.js';

const latest = new Map(); // fxId -> latest Effect def (pop-outs outlive the card that opened them)
const SIZE = { vectorscope: '.an-sq', tuner: '.an-tn' };

function analyzerCard(kind) {
  return (el, api) => {
    const id = api.fx.id;
    latest.set(id, api.fx);
    const getParams = () => resolveEffectParams(latest.get(id) || api.fx);
    const owner = api.tgt?.name || 'Master';
    const view = mountAnalyzer(kind, {
      getProbe: api.probe,
      getParams,
      popout: { key: `fx:${id}`, title: `${EFFECT_DEFS[kind].name} — ${owner}` },
    });
    const side = h('div.an-card-side', ...el.children);
    el.classList.add('an-body');
    el.appendChild(h('div.an-card', h(`div.an-card-viz${SIZE[kind] || ''}`, view.el), side));
    return { update(fx) { latest.set(id, fx); } };
  };
}

export default {
  oscilloscope: analyzerCard('oscilloscope'),
  vectorscope: analyzerCard('vectorscope'),
  spectrum: analyzerCard('spectrum'),
  spectrogram: analyzerCard('spectrogram'),
  tuner: analyzerCard('tuner'),
};
