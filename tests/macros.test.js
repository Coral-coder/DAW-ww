// Action macros (src/control/macros.js): model, serialisation, merging, cycle checks, recorder and runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMacro, normalizeMacro, serializeMacros, parseMacros, mergeMacros, createsCycle, runMacro, MacroRecorder,
  macroCommandId, MACROS_FORMAT, MAX_DEPTH,
} from '../src/control/macros.js';
import { CommandRegistry, ShortcutMap } from '../src/control/shortcuts.js';

test('serialize -> parse round trip keeps names, steps, waits and shortcuts', () => {
  const a = createMacro('Mix check', [{ cmd: 'view.mixer', label: 'Show Mixer' }, { cmd: 'transport.play', label: 'Play', wait: 250 }], ['mod+alt+m']);
  const b = createMacro('Export stems', [{ cmd: 'menu:Menu › Export › Stems', label: 'Menu › Export › Stems' }]);
  const text = serializeMacros([a, b]);
  const j = JSON.parse(text);
  assert.equal(j.format, MACROS_FORMAT);
  assert.equal(j.version, 1);
  const back = parseMacros(text);
  assert.deepEqual(back, [a, b]);
  // a bare array and a single macro object are accepted too
  assert.deepEqual(parseMacros(JSON.stringify([a])), [a]);
  assert.deepEqual(parseMacros(a), [a]);
});

test('parse validates: junk rejected, invalid steps / names dropped, waits clamped, duplicate ids renamed', () => {
  assert.throws(() => parseMacros('{"format":"something-else"}'));
  assert.throws(() => parseMacros('not json'));
  const list = parseMacros({ format: MACROS_FORMAT, macros: [
    { id: 'x', name: '  A  ', steps: [{ cmd: 'transport.play' }, { cmd: '' }, null, { cmd: 'edit.undo', wait: 999999 }], keys: ['shift+1', 'shift+1', 5] },
    { id: 'x', name: 'B', steps: [] },
    { name: '', steps: [{ cmd: 'transport.play' }] },
    { id: 'bad id!', name: 'C', steps: [] },
  ] });
  assert.equal(list.length, 3);
  assert.equal(list[0].name, 'A');
  assert.deepEqual(list[0].steps, [{ cmd: 'transport.play', label: 'transport.play' }, { cmd: 'edit.undo', label: 'edit.undo', wait: 10000 }]);
  assert.deepEqual(list[0].keys, ['shift+1']);
  assert.notEqual(list[1].id, 'x');
  assert.match(list[2].id, /^[A-Za-z0-9_-]+$/);
  assert.equal(normalizeMacro({ name: 'x', steps: 'nope' }).steps.length, 0);
});

test('merge: same id replaces only when asked; name clashes get a suffix', () => {
  const a = { ...createMacro('A', [{ cmd: 'transport.play' }]), id: 'a' };
  const a2 = { ...createMacro('A', [{ cmd: 'transport.stop' }]), id: 'a' };
  const kept = mergeMacros([a], [a2]);
  assert.equal(kept.length, 2);
  assert.equal(kept[1].name, 'A (2)');
  assert.notEqual(kept[1].id, 'a');
  const replaced = mergeMacros([a], [a2], { replace: true });
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].steps[0].cmd, 'transport.stop');
});

test('cycles: a macro may not call itself directly or through another macro', () => {
  const a = { id: 'a', name: 'A', steps: [{ cmd: 'macro.b', label: 'B' }], keys: [] };
  const b = { id: 'b', name: 'B', steps: [{ cmd: 'transport.play', label: 'Play' }], keys: [] };
  const byId = (id) => ({ a, b })[id];
  assert.equal(createsCycle(a, 'macro.a', byId), true);
  assert.equal(createsCycle(b, 'macro.a', byId), true); // b -> a -> b
  assert.equal(createsCycle(a, 'transport.stop', byId), false);
  assert.equal(macroCommandId(a), 'macro.a');
});

test('runMacro: steps run in order, async steps are awaited, missing steps reported, errors stop the run', async () => {
  const log = [];
  const cmds = {
    one: () => log.push(1),
    two: () => new Promise((r) => setTimeout(() => { log.push(2); r(); }, 5)),
    three: () => log.push(3),
    boom: () => { throw new Error('x'); },
  };
  const resolve = (c) => cmds[c] || null;
  const m = createMacro('M', [{ cmd: 'one' }, { cmd: 'two' }, { cmd: 'gone' }, { cmd: 'three', wait: 1 }]);
  const waits = [];
  const r = await runMacro(m, resolve, { sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(log, [1, 2, 3]);
  assert.deepEqual(waits, [1]);
  assert.equal(r.ran, 3);
  assert.deepEqual(r.missing, ['gone']);
  const r2 = await runMacro(createMacro('E', [{ cmd: 'boom' }, { cmd: 'one' }]), resolve);
  assert.equal(r2.errors.length, 1);
  assert.equal(r2.ran, 0);
  // nesting depth is bounded
  const deep = await runMacro(m, resolve, { depth: MAX_DEPTH + 1 });
  assert.equal(deep.ran, 0);
  assert.equal(deep.errors.length, 1);
});

test('recorder: records while active, skips palette / recorder commands and paused (playback) commands', () => {
  const rec = new MacroRecorder();
  assert.equal(rec.record('transport.play', 'Play'), false);
  rec.start();
  rec.record('view.mixer', 'Show Mixer');
  rec.record('palette.open', 'Command palette');
  rec.suspend(() => rec.record('transport.stop', 'Stop'));
  rec.record('menu:Menu › Export › Stems', 'Menu › Export › Stems');
  assert.deepEqual(rec.stop(), [{ cmd: 'view.mixer', label: 'Show Mixer' }, { cmd: 'menu:Menu › Export › Stems', label: 'Menu › Export › Stems' }]);
  assert.equal(rec.active, false);
});

test('macros register as commands: their keys bind through the shortcut map like any command', () => {
  const reg = new CommandRegistry();
  reg.register({ id: 'transport.play', label: 'Play', keys: ['space'], run() {} });
  const m = createMacro('Go', [{ cmd: 'transport.play' }], ['mod+alt+g']);
  reg.register({ id: macroCommandId(m), label: m.name, category: 'Macros', keys: m.keys, run() {} });
  const map = new ShortcutMap(reg, {}, { isMac: false });
  assert.equal(map.match('mod+alt+g')?.id, macroCommandId(m));
  assert.equal(map.label(macroCommandId(m)), 'Ctrl+Alt+G');
});
