import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPreferences, savePreferences, projectBounds, preferencesFile, SHELL_TOP } from '../dist/preferences.js';

test('Tab order preference defaults to registry order and survives reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stoneforge-preferences-'));
  try {
    assert.deepEqual(await loadPreferences(dir), { projectOrder: [] });
    for (const invalid of ['{', 'null', '[]', '{"projectOrder":"a"}', '{"projectOrder":{"0":"a"}}']) {
      await writeFile(preferencesFile(dir), invalid);
      assert.deepEqual(await loadPreferences(dir), { projectOrder: [] }, invalid);
    }
    // Non-string and duplicate entries are dropped, valid IDs keep their order.
    await writeFile(preferencesFile(dir), '{"projectOrder":["b",1,"a","b",null,""]}');
    assert.deepEqual(await loadPreferences(dir), { projectOrder: ['b', 'a'] });
    // Rapid reorders are serialized; the last requested order wins and no temporary file remains.
    await Promise.all([['a', 'b'], ['b', 'a'], ['c', 'a', 'b']].map((projectOrder) => savePreferences(dir, { projectOrder })));
    assert.deepEqual(await loadPreferences(dir), { projectOrder: ['c', 'a', 'b'] });
    assert.deepEqual(await readdir(dir), ['preferences.json']);
    assert.equal((await stat(preferencesFile(dir))).mode & 0o777, 0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Preferences from the removed project sidebar are ignored and dropped on save', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stoneforge-preferences-'));
  try {
    await writeFile(preferencesFile(dir), '{"sidebarCollapsed":true}\n');
    assert.deepEqual(await loadPreferences(dir), { projectOrder: [] });
    await savePreferences(dir, { projectOrder: ['x'] });
    assert.deepEqual(JSON.parse(await readFile(preferencesFile(dir), 'utf8')), { projectOrder: ['x'] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Project view takes the full window width beneath the tab bar and toolbar', () => {
  assert.equal(SHELL_TOP, 76);
  assert.deepEqual(projectBounds(1024, 700), { x: 0, y: 76, width: 1024, height: 624 });
  assert.deepEqual(projectBounds(100, 10), { x: 0, y: 76, width: 100, height: 0 });
});
