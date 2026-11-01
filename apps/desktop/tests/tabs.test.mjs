import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInThisContext } from 'node:vm';
import { orderProjects, normalizeOrder, moveProject, projectStatus, tabShortcut, shortcutTarget } from '../dist/tabs.js';

// The shell's layout helpers are a classic browser script; evaluate the built copy as the shell does.
runInThisContext(await readFile(new URL('../dist/tab-layout.js', import.meta.url), 'utf8'));
const { fitTabs, splitTabs, focusTarget, dropOrder } = globalThis.StoneforgeTabLayout;

test('Tab status: running, stopped, starting/stopping, error and needs-input', () => {
  assert.deepEqual(projectStatus({ state: 'ready' }), { kind: 'running', label: 'Running', symbol: '●' });
  assert.deepEqual(projectStatus({ state: 'stopped' }), { kind: 'stopped', label: 'Stopped', symbol: '○' });
  assert.equal(projectStatus({ state: 'starting' }).kind, 'busy');
  assert.equal(projectStatus({ state: 'stopping' }).label, 'Stopping…');
  assert.deepEqual(projectStatus({ state: 'error', error: 'Backend exited' }), { kind: 'error', label: 'Error: Backend exited', symbol: '✕' });
  assert.equal(projectStatus({ state: 'error' }).label, 'Error');
  // The existing attention state outranks the backend state.
  assert.deepEqual(projectStatus({ state: 'ready', needsInput: true }), { kind: 'attention', label: 'Needs your input', symbol: '!' });
});

test('Saved tab order applies first; new projects keep registry order; removed IDs are ignored', () => {
  const projects = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  assert.deepEqual(orderProjects(projects, []).map((p) => p.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(orderProjects(projects, ['c', 'gone', 'a']).map((p) => p.id), ['c', 'a', 'b', 'd']);
  assert.deepEqual(orderProjects(projects, ['d', 'c', 'b', 'a', 'd']).map((p) => p.id), ['d', 'c', 'b', 'a']);
  assert.deepEqual(projects.map((p) => p.id), ['a', 'b', 'c', 'd'], 'Input is not mutated');
});

test('Renderer order requests are validated and completed', () => {
  const known = ['a', 'b', 'c'];
  assert.deepEqual(normalizeOrder(['c', 'a', 'b'], known), ['c', 'a', 'b']);
  assert.deepEqual(normalizeOrder(['c', 'x', 'c'], known), ['c', 'a', 'b'], 'Unknown and duplicate IDs are dropped, missing appended');
  assert.deepEqual(normalizeOrder([], known), known);
  for (const invalid of [undefined, null, 'a', { 0: 'a' }, ['a', 1]]) assert.equal(normalizeOrder(invalid, known), undefined);
});

test('Per-tab Move Left/Right clamps at the ends', () => {
  assert.deepEqual(moveProject(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(moveProject(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b']);
  assert.deepEqual(moveProject(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
  assert.deepEqual(moveProject(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c']);
  assert.deepEqual(moveProject(['a', 'b'], 'x', 1), ['a', 'b']);
});

test('Keyboard shortcuts: ⌘1…⌘8 select the Nth tab, ⌘9 the last, ⌃Tab/⌃⇧Tab cycle', () => {
  const key = (key, modifiers = {}, code) => ({ type: 'keyDown', key, code, ...modifiers });
  assert.deepEqual(tabShortcut(key('1', { meta: true }, 'Digit1')), { kind: 'index', index: 0 });
  assert.deepEqual(tabShortcut(key('8', { meta: true })), { kind: 'index', index: 7 });
  assert.deepEqual(tabShortcut(key('9', { meta: true }, 'Digit9')), { kind: 'last' });
  // Physical digit keys work on layouts where the unshifted character is not a digit (e.g. AZERTY).
  assert.deepEqual(tabShortcut(key('&', { meta: true }, 'Digit1')), { kind: 'index', index: 0 });
  assert.deepEqual(tabShortcut(key('Tab', { control: true }, 'Tab')), { kind: 'next' });
  assert.deepEqual(tabShortcut(key('Tab', { control: true, shift: true }, 'Tab')), { kind: 'previous' });
  // Not tab shortcuts: other modifiers, plain keys, ⌘0, ⌘Tab (app switcher), key-up events.
  for (const input of [key('1', { meta: true, shift: true }), key('1', { meta: true, alt: true }), key('1', { control: true }),
    key('1'), key('0', { meta: true }, 'Digit0'), key('Tab', { meta: true }), key('Tab'), key('Tab', { control: true, alt: true }),
    { ...key('1', { meta: true }), type: 'keyUp' }, key('s', { meta: true, control: true })]) {
    assert.equal(tabShortcut(input), undefined, JSON.stringify(input));
  }
});

test('Shortcut targets: Nth/last tab, wrap-around cycling, no target past the end', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(shortcutTarget({ kind: 'index', index: 1 }, ids, 'a'), 'b');
  assert.equal(shortcutTarget({ kind: 'index', index: 5 }, ids, 'a'), undefined);
  assert.equal(shortcutTarget({ kind: 'last' }, ids, 'a'), 'c');
  assert.equal(shortcutTarget({ kind: 'next' }, ids, 'c'), 'a');
  assert.equal(shortcutTarget({ kind: 'previous' }, ids, 'a'), 'c');
  assert.equal(shortcutTarget({ kind: 'next' }, ids, 'b'), 'c');
  assert.equal(shortcutTarget({ kind: 'next' }, ids, undefined), 'a');
  assert.equal(shortcutTarget({ kind: 'previous' }, ids, 'gone'), 'c');
  assert.equal(shortcutTarget({ kind: 'last' }, [], undefined), undefined);
});

test('Tabs share the width, shrink to the minimum, then overflow', () => {
  const size = { min: 96, max: 200, overflow: 32 };
  assert.deepEqual(fitTabs({ ...size, count: 0, available: 800 }), { visible: 0, width: 200 });
  assert.deepEqual(fitTabs({ ...size, count: 3, available: 1200 }), { visible: 3, width: 200 });
  assert.deepEqual(fitTabs({ ...size, count: 6, available: 900 }), { visible: 6, width: 150 });
  assert.deepEqual(fitTabs({ ...size, count: 10, available: 960 }), { visible: 10, width: 96 });
  // 11 tabs × 96 > 960: the » button takes 32px and 9 tabs remain visible.
  assert.deepEqual(fitTabs({ ...size, count: 11, available: 960 }), { visible: 9, width: 103 });
  assert.deepEqual(fitTabs({ ...size, count: 4, available: 50 }), { visible: 1, width: 96 }, 'Always one visible tab');
  for (let available = 0; available <= 2000; available += 37) {
    for (let count = 1; count <= 20; count++) {
      const { visible, width } = fitTabs({ ...size, count, available });
      assert(visible >= 1 && visible <= count && width >= size.min && width <= size.max);
      if (visible < count && visible > 1) assert(visible * width + size.overflow <= available, `${count}@${available}`);
      if (visible === count && count * size.min <= available) assert(count * width <= available);
    }
  }
});

test('Overflow keeps order and the active tab visible', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(splitTabs(ids, 'b', 5), { shown: ids, hidden: [] });
  assert.deepEqual(splitTabs(ids, 'b', 3), { shown: ['a', 'b', 'c'], hidden: ['d', 'e'] });
  assert.deepEqual(splitTabs(ids, 'e', 3), { shown: ['a', 'b', 'e'], hidden: ['c', 'd'] });
  assert.deepEqual(splitTabs(ids, 'd', 1), { shown: ['d'], hidden: ['a', 'b', 'c', 'e'] });
  assert.deepEqual(splitTabs(ids, undefined, 2), { shown: ['a', 'b'], hidden: ['c', 'd', 'e'] });
  assert.deepEqual(splitTabs([], 'a', 3), { shown: [], hidden: [] });
});

test('Tablist arrow navigation wraps; Home/End jump; other keys are ignored', () => {
  assert.equal(focusTarget('ArrowRight', 0, 3), 1);
  assert.equal(focusTarget('ArrowRight', 2, 3), 0);
  assert.equal(focusTarget('ArrowLeft', 0, 3), 2);
  assert.equal(focusTarget('Home', 2, 3), 0);
  assert.equal(focusTarget('End', 0, 3), 2);
  assert.equal(focusTarget('Enter', 0, 3), undefined);
  assert.equal(focusTarget('ArrowRight', 0, 0), undefined);
});

test('Drag-to-reorder drop positions', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepEqual(dropOrder(ids, 'a', 'c', true), ['b', 'c', 'a', 'd']);
  assert.deepEqual(dropOrder(ids, 'a', 'c', false), ['b', 'a', 'c', 'd']);
  assert.deepEqual(dropOrder(ids, 'd', 'a', false), ['d', 'a', 'b', 'c']);
  assert.deepEqual(dropOrder(ids, 'b', 'b', true), ids);
  assert.deepEqual(dropOrder(ids, 'x', 'a', true), ids);
});
