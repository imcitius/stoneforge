import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPreferences, savePreferences, projectBounds, preferencesFile } from '../dist/preferences.js';

test('Sidebar preference defaults to visible and survives reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stoneforge-preferences-'));
  try {
    assert.deepEqual(await loadPreferences(dir), { sidebarCollapsed: false });
    for (const invalid of ['{', 'null', '[]', '{"sidebarCollapsed":"yes"}']) {
      await writeFile(preferencesFile(dir), invalid);
      assert.deepEqual(await loadPreferences(dir), { sidebarCollapsed: false }, invalid);
    }
    // Rapid toggles are serialized; the last requested state wins and no temporary file remains.
    await Promise.all([true, false, true, false, true].map((sidebarCollapsed) => savePreferences(dir, { sidebarCollapsed })));
    assert.deepEqual(await loadPreferences(dir), { sidebarCollapsed: true });
    assert.deepEqual(JSON.parse(await readFile(preferencesFile(dir), 'utf8')), { sidebarCollapsed: true });
    assert.deepEqual(await readdir(dir), ['preferences.json']);
    assert.equal((await stat(preferencesFile(dir))).mode & 0o777, 0o600);
    await savePreferences(dir, { sidebarCollapsed: false });
    assert.deepEqual(await loadPreferences(dir), { sidebarCollapsed: false });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Project view fills the width released by a collapsed sidebar', () => {
  assert.deepEqual(projectBounds(1024, 700, false), { x: 240, y: 64, width: 784, height: 636 });
  assert.deepEqual(projectBounds(1024, 700, true), { x: 0, y: 64, width: 1024, height: 636 });
  assert.deepEqual(projectBounds(100, 10, false), { x: 240, y: 64, width: 0, height: 0 });
});
