// Every tune of the Strudel compatibility corpus (tests/fixtures/strudel-tunes/) evaluates and queries
// 4 cycles without errors through daW³'s facade with the vendored real Strudel engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCompat } from './strudel-compat.mjs';

test('Strudel compatibility corpus: 100% evaluate + query without errors', async () => {
  const log = console.log;
  console.log = () => {}; // some reference examples log their haps
  let report;
  try { report = await runCompat(); } finally { console.log = log; }
  for (const [name, r] of Object.entries(report)) {
    assert.ok(r.total > 0, `${name} corpus is empty`);
    assert.deepEqual(r.failures, [], `${name}: ${r.failures.length} of ${r.total} tunes failed`);
  }
});
