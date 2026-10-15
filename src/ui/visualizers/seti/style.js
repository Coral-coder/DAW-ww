// SETI Scope stylesheet, injected once (keeps the scope self-contained: no index.html / styles edits).
const CSS = `
.seti-host { color: #d8e6ff; font: 12px/1.35 "MS Sans Serif", "Microsoft Sans Serif", Tahoma, Geneva, Verdana, sans-serif;
  user-select: none; -webkit-user-select: none; touch-action: none; overflow: hidden; display: flex; align-items: center; justify-content: center; cursor: default; }
.seti-host:focus { outline: none; }
.seti-stage { position: relative; width: 100%; height: 100%; overflow: hidden; background: #000; }
.seti-stage.retro { width: min(100vw, 133.333vh); height: min(100vh, 75vw); font-size: 10px; }
.seti-stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.seti-stage.retro canvas.seti-gl, .seti-stage.retro canvas.seti-bloom { image-rendering: pixelated; image-rendering: crisp-edges; }
.seti-bloom { filter: blur(7px) brightness(1.5) saturate(1.3); mix-blend-mode: screen; opacity: .65; pointer-events: none; display: none; }
.seti-stage.crt .seti-bloom { display: block; }
.seti-crt { position: absolute; inset: 0; pointer-events: none; display: none;
  background: repeating-linear-gradient(to bottom, rgba(0,0,0,0) 0, rgba(0,0,0,0) 2px, rgba(0,0,0,.28) 3px),
    radial-gradient(ellipse at center, rgba(0,0,0,0) 58%, rgba(0,0,0,.55) 100%); animation: seti-flicker 6s infinite steps(60); }
.seti-stage.crt .seti-crt { display: block; }
@keyframes seti-flicker { 0%, 100% { opacity: .9; } 50% { opacity: 1; } 51% { opacity: .86; } }
.seti-panel { position: absolute; background: rgba(0, 8, 36, .74); border: 1px solid #2c62d6; box-shadow: inset 0 0 0 1px #071c55, 0 0 12px rgba(40,110,255,.18);
  padding: 0 0 4px; min-width: 0; pointer-events: none; }
.seti-ptitle { background: linear-gradient(#123a9a, #0a2366); color: #6fe3ff; font-weight: bold; letter-spacing: .04em; padding: 2px 8px; border-bottom: 1px solid #2c62d6; white-space: nowrap; }
.seti-rows { border-collapse: collapse; margin: 3px 8px 0; }
.seti-rows th { color: #7fa8ff; font-weight: normal; text-align: right; padding: 0 6px 0 0; white-space: nowrap; vertical-align: top; }
.seti-rows td { color: #f2f7ff; font-family: "Lucida Console", Monaco, "Courier New", monospace; font-size: .95em; white-space: nowrap; }
.seti-rows td.hot { color: #ffe066; }
.seti-analysis { left: 14px; top: 14px; }
.seti-info { right: 14px; top: 14px; max-width: 46%; }
.seti-info td { white-space: normal; overflow-wrap: anywhere; }
.seti-user { left: 14px; bottom: 34px; width: 330px; }
.seti-graphs { right: 14px; bottom: 34px; width: 280px; }
.seti-graphs canvas { position: static; display: block; width: calc(100% - 16px); margin: 4px 8px 0; border: 1px solid #1b3f94; background: #000615; }
.seti-gauss { height: 92px; }
.seti-power { height: 38px; }
.seti-glabel { margin: 3px 8px 0; color: #7fa8ff; display: flex; justify-content: space-between; font-family: "Lucida Console", Monaco, "Courier New", monospace; font-size: .9em; }
.seti-glabel b { color: #f2f7ff; font-weight: normal; }
.seti-bar { margin: 5px 8px 0; height: 12px; border: 1px solid #2c62d6; background: #000a2a; position: relative; }
.seti-bar > i { position: absolute; left: 0; top: 0; bottom: 0; background: linear-gradient(90deg, #1846c8, #3fa8ff 70%, #8ff0ff); }
.seti-strip { position: absolute; left: 0; right: 0; bottom: 0; height: 22px; background: #000a2a; border-top: 1px solid #2c62d6; display: flex; align-items: center; gap: 10px; padding: 0 10px; pointer-events: none;
  font-family: "Lucida Console", Monaco, "Courier New", monospace; font-size: 11px; color: #9fc0ff; }
.seti-strip .seti-bar { flex: 1; margin: 0; height: 10px; }
.seti-title { position: absolute; left: 50%; top: 10px; transform: translateX(-50%); text-align: center; pointer-events: none; }
.seti-title h1 { margin: 0; font: bold 20px/1.1 "Arial Black", "MS Sans Serif", Tahoma, sans-serif; letter-spacing: .12em; color: #6fe3ff; text-shadow: 0 0 10px rgba(80,180,255,.7); }
.seti-title div { color: #7fa8ff; font-size: 11px; margin-top: 2px; }
.seti-toolbar { position: absolute; left: 50%; top: 56px; transform: translateX(-50%); display: flex; flex-wrap: wrap; justify-content: center; gap: 4px; opacity: .0; transition: opacity .3s; max-width: 60%; }
.seti-stage.show-ui .seti-toolbar, .seti-toolbar:focus-within { opacity: 1; }
.seti-toolbar button { font: inherit; font-size: 11px; color: #d8e6ff; background: #0a2366; border: 1px solid #2c62d6; padding: 3px 8px; cursor: pointer; border-radius: 0; }
.seti-toolbar button:hover, .seti-toolbar button.on { background: #1846c8; color: #fff; }
.seti-msg { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); color: #7fa8ff; background: rgba(0,8,36,.8); border: 1px solid #2c62d6; padding: 8px 14px; pointer-events: none; display: none; text-align: center; }
.seti-msg.on { display: block; }
.seti-stage.saver .seti-toolbar { display: none; }
.seti-stage.retro .seti-panel, .seti-stage.retro .seti-strip, .seti-stage.retro .seti-title { font-family: "Courier New", Courier, monospace; -webkit-font-smoothing: none; }
.seti-stage.retro .seti-user { width: 250px; }
.seti-stage.retro .seti-graphs { width: 210px; }
@media (max-width: 760px), (max-height: 520px) {
  .seti-host { font-size: 9.5px; }
  .seti-analysis, .seti-info { top: 6px; max-width: calc(50% - 9px); }
  .seti-analysis { left: 6px; } .seti-info { right: 6px; }
  .seti-rows { margin: 2px 4px 0; } .seti-rows th { padding-right: 3px; }
  .seti-rows td { white-space: normal; overflow-wrap: anywhere; }
  .seti-user { left: 6px; bottom: 26px; width: calc(50% - 9px); }
  .seti-graphs { right: 6px; bottom: 26px; width: calc(50% - 9px); }
  .seti-gauss { height: 56px; } .seti-power { height: 26px; }
  .seti-title { top: auto; bottom: 30px; display: none; }
  .seti-toolbar { top: auto; bottom: 150px; max-width: 94%; }
  .seti-strip { height: 18px; font-size: 9px; }
}
`;

export function injectSetiStyle() {
  if (typeof document === 'undefined' || document.getElementById('seti-scope-style')) return;
  const st = document.createElement('style');
  st.id = 'seti-scope-style';
  st.textContent = CSS;
  document.head.appendChild(st);
}
