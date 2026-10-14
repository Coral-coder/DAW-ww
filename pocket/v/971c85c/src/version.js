// daW³'s version, shown in About, the main menu (desktop + Pocket) and the desktop app's About panel.
// VERSION follows package.json (tests/version.test.js keeps them equal).
import { BUILD_SHA } from './build-info.js';

export const VERSION = '1.0.0';

/** The build's commit: stamped by CI (build-info.js), else the GitHub Pages path /v/<sha>/, else 'dev'. */
export function buildSha(base = (typeof document !== 'undefined' && document.baseURI) || '') {
  if (BUILD_SHA && BUILD_SHA !== 'dev') return BUILD_SHA.slice(0, 7);
  const m = /\/v\/([0-9a-f]{7,40})\//i.exec(String(base));
  return m ? m[1].slice(0, 7) : 'dev';
}

/** "daW³ 1.0.0 (abc1234)" */
export function versionLabel(base) {
  return `daW³ ${VERSION} (${buildSha(base)})`;
}
