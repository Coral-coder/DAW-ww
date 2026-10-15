// Custom UI for character effects, keyed by effect type. Each entry is (el, api) => ({ update?(fx), dispose?() }).
// el is the effect card body (generic param knobs are already in it); api = { fx, tgt, engine, app, probe(), edit }.
// Animation loops must stop by themselves once el.isConnected is false (cards are rebuilt without a dispose call).
import { h, fitCanvas } from '../dom.js';
import { correlation } from '../../audio/fx/dsp/character.js';

/**
 * Stereo meter for the M/S tool and the Haas widener (probe = { left, right } analysers on the output): phase
 * correlation (+1 mono … 0 wide … −1 out of phase: cancels in mono), the L/R balance and a mini goniometer.
 */
function stereoMeter(el, api) {
  const canvas = h('canvas', { style: { width: '100%', height: '58px', display: 'block', borderRadius: '6px' } });
  const label = h('div.dv-note', { style: { fontSize: '11px', opacity: 0.8, marginTop: '2px' } }, 'Correlation —');
  el.appendChild(h('div.dv-stereo-meter', { style: { margin: '6px 0 2px' } }, canvas, label));
  let bufL = null, bufR = null, corr = 0, bal = 0, lastText = 0;
  const css = (n, d) => getComputedStyle(canvas).getPropertyValue(n).trim() || d;
  function frame(t) {
    if (!el.isConnected) return; // card rebuilt / closed
    requestAnimationFrame(frame);
    const pr = api.probe();
    const { ctx, w, h: H } = fitCanvas(canvas);
    ctx.clearRect(0, 0, w, H);
    ctx.fillStyle = css('--bg-2', 'rgba(127,127,127,0.08)');
    ctx.fillRect(0, 0, w, H);
    if (!pr?.left) return;
    const n = pr.left.fftSize;
    if (!bufL || bufL.length !== n) { bufL = new Float32Array(n); bufR = new Float32Array(n); }
    pr.left.getFloatTimeDomainData(bufL); pr.right.getFloatTimeDomainData(bufR);
    let eL = 0, eR = 0;
    for (let i = 0; i < n; i++) { eL += bufL[i] * bufL[i]; eR += bufR[i] * bufR[i]; }
    const live = eL + eR > 1e-7;
    corr += 0.2 * ((live ? correlation(bufL, bufR) : 0) - corr);
    bal += 0.2 * ((live ? (Math.sqrt(eR) - Math.sqrt(eL)) / (Math.sqrt(eR) + Math.sqrt(eL)) : 0) - bal);
    // goniometer (left square): M up, S sideways
    const g = H - 6, gx = 3, gy = 3;
    ctx.strokeStyle = css('--line', 'rgba(127,127,127,0.35)');
    ctx.strokeRect(gx + 0.5, gy + 0.5, g, g);
    ctx.fillStyle = css('--accent', '#7c5cff');
    ctx.globalAlpha = 0.55;
    const pk = Math.max(1e-3, Math.sqrt(Math.max(eL, eR) / n) * 3);
    for (let i = 0; i < n; i += 4) {
      const m = (bufL[i] + bufR[i]) / 2 / pk, s = (bufL[i] - bufR[i]) / 2 / pk;
      ctx.fillRect(gx + g / 2 + s * g * 0.5, gy + g / 2 - m * g * 0.5, 1.2, 1.2);
    }
    ctx.globalAlpha = 1;
    // correlation bar
    const x0 = g + 14, bw = w - x0 - 6, cy = 14;
    ctx.fillStyle = css('--line', 'rgba(127,127,127,0.3)');
    ctx.fillRect(x0, cy, bw, 6);
    ctx.fillStyle = corr < 0 ? css('--bad', '#e5484d') : css('--accent', '#7c5cff');
    const cx = x0 + bw / 2;
    ctx.fillRect(Math.min(cx, cx + corr * bw / 2), cy, Math.abs(corr * bw / 2), 6);
    ctx.fillStyle = css('--text', '#ddd');
    ctx.fillRect(cx - 0.5, cy - 3, 1, 12);
    ctx.font = '9px sans-serif';
    ctx.fillText('−1', x0, cy + 18); ctx.fillText('0', cx - 2, cy + 18); ctx.fillText('+1', x0 + bw - 10, cy + 18);
    // balance
    const by = 42;
    ctx.fillStyle = css('--line', 'rgba(127,127,127,0.3)');
    ctx.fillRect(x0, by, bw, 4);
    ctx.fillStyle = css('--text', '#ddd');
    ctx.fillRect(cx + bal * bw / 2 - 2, by - 2, 4, 8);
    ctx.fillText('L', x0 - 8, by + 5); ctx.fillText('R', x0 + bw + 1, by + 5);
    if (t - lastText > 250) {
      lastText = t;
      label.textContent = !live ? 'Correlation — (no signal)' : `Correlation ${corr >= 0 ? '+' : ''}${corr.toFixed(2)} · ${corr < 0 ? 'out of phase: cancels in mono' : corr < 0.3 ? 'very wide — check mono' : corr > 0.95 ? 'mono' : 'mono-compatible'}`;
    }
  }
  requestAnimationFrame(frame);
  return {};
}

export default { msTool: stereoMeter, haas: stereoMeter };
