import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { ProjectManager } from '../dist/manager.js';
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../../..');

test('initialize new and partial workspaces with bundled CLI; preserve files and existing configuration', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'stoneforge-init-'));
  const manager = new ProjectManager({ dataDir: join(temp, 'registry'), node: require.resolve('node/bin/node'),
    entry: join(root, 'packages/smithy/dist/server/managed.js'), webRoot: join(root, 'packages/smithy/web'), binDir: join(root, 'apps/desktop/scripts/bin') });
  const oldRoot = process.env.STONEFORGE_ROOT;
  try {
    await manager.load();
    const fresh = join(temp, 'New проект with spaces'); await mkdir(fresh);
    await writeFile(join(fresh, 'AGENTS.md'), 'Existing instructions\n');
    await writeFile(join(fresh, 'keep.txt'), 'User file');
    assert.equal((await manager.inspect(fresh)).initialized, false);
    assert.equal(manager.list().length, 0, 'Inspection/cancel does not register projects');
    process.env.STONEFORGE_ROOT = '/missing/inherited/project';
    const project = await manager.initialize(fresh, 'review');
    assert.equal((await manager.inspect(fresh)).initialized, true);
    assert.equal(await readFile(join(fresh, 'AGENTS.md'), 'utf8'), 'Existing instructions\n');
    assert.equal(await readFile(join(fresh, 'keep.txt'), 'utf8'), 'User file');
    assert.match(await readFile(join(fresh, '.stoneforge/config.yaml'), 'utf8'), /preset: review/);
    assert.equal((await manager.initialize(fresh, 'auto')).id, project.id);
    assert.match(await readFile(join(fresh, '.stoneforge/config.yaml'), 'utf8'), /preset: review/, 'Re-add must not reset configuration');
    const partial = join(temp, 'Partial'); await mkdir(join(partial, '.stoneforge'), { recursive: true });
    const config = 'name: keep-me\nworkflow:\n  preset: approve\n';
    await writeFile(join(partial, '.stoneforge/config.yaml'), config);
    await manager.initialize(partial);
    assert.equal(await readFile(join(partial, '.stoneforge/config.yaml'), 'utf8'), config);
    const broken = join(temp, 'Broken'); await mkdir(broken);
    await symlink(join(temp, 'missing'), join(broken, '.stoneforge'));
    await assert.rejects(manager.inspect(broken), /ENOENT/);
    assert.equal(manager.list().length, 2);
    const bad = new ProjectManager({ ...manager.options, node: join(temp, 'missing-node') });
    await bad.load();
    const failed = join(temp, 'Failed'); await mkdir(failed);
    await assert.rejects(bad.initialize(failed), /Could not initialize/);
    assert.equal((await manager.inspect(failed)).initialized, false);
  } finally {
    if (oldRoot === undefined) delete process.env.STONEFORGE_ROOT; else process.env.STONEFORGE_ROOT = oldRoot;
    await manager.close(); await rm(temp, { recursive: true, force: true });
  }
});
