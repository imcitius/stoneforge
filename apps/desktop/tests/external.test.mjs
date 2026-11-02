import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { ProjectManager } from '../dist/manager.js';
import { findExternalServer } from '../dist/external.js';
import { fixtureEnv } from './fixture-env.mjs';
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../../..');
const node = require.resolve('node/bin/node');
const cli = join(root, 'packages/smithy/dist/bin/sf.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// External-server adoption is macOS-only product behavior: findExternalServer
// (packages/quarry/src/cli/server-discovery.ts) returns undefined on other
// platforms and discovers servers through /usr/sbin/lsof and /bin/ps. Linux CI
// (pnpm check:ci) therefore reports this test as skipped; pnpm check:merge runs
// only on macOS, where it always runs.
const adoptionSkip = process.platform !== 'darwin' && 'external-server adoption is macOS-only (findExternalServer returns undefined elsewhere)';

test('adopts an existing standalone process only for its database, then stops it gracefully', { timeout: 40_000, skip: adoptionSkip }, async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'sf-adopt-')));
  const projectRoot = join(temp, 'Existing'); await mkdir(projectRoot);
  const otherRoot = join(temp, 'Other'); await mkdir(otherRoot);
  const env = fixtureEnv({ STONEFORGE_ROOT: projectRoot, DAEMON_AUTO_START: 'false' });
  execFileSync(node, [cli, 'init', '--preset', 'approve'], { cwd: projectRoot, env, stdio: 'pipe' });
  execFileSync(node, [cli, 'init', '--preset', 'approve'], { cwd: otherRoot, env: { ...env, STONEFORGE_ROOT: otherRoot }, stdio: 'pipe' });
  const child = spawn(node, [cli, 'serve', '--no-open', '--host', '127.0.0.1', '--port', '0'], { cwd: projectRoot, env, stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const manager = new ProjectManager({ dataDir: join(temp, 'registry'), node,
    entry: join(root, 'packages/smithy/dist/server/managed.js'), webRoot: join(root, 'packages/smithy/web'), binDir: join(root, 'apps/desktop/scripts/bin') });
  try {
    let external;
    for (let i = 0; i < 60; i++) { external = await findExternalServer(projectRoot); if (external) break; await pause(100); }
    assert(external, 'Existing server must be discoverable');
    assert.equal(external.pid, child.pid);
    const cliStatus = execFileSync(node, [cli, 'daemon', 'status', '--json'], { cwd: otherRoot, env: { ...env, STONEFORGE_API_URL: 'http://127.0.0.1:1' }, stdio: 'pipe' }).toString();
    assert.match(cliStatus, /success/);
    assert.throws(() => execFileSync(node, [cli, 'daemon', 'status'], { cwd: otherRoot, env: { ...env, STONEFORGE_ROOT: otherRoot }, stdio: 'pipe' }), 'No fallback to another project server');
    assert.equal(await findExternalServer(otherRoot), undefined, 'Never adopt another workspace');
    await manager.load();
    const project = await manager.add(projectRoot);
    const [instance, repeated] = await Promise.all([manager.start(project.id), manager.start(project.id)]);
    assert.equal(instance, repeated);
    assert.equal(instance.child, undefined, 'Adoption must not spawn another backend');
    assert.equal(instance.external.pid, child.pid);
    assert.equal(manager.projects.get(project.id).state, 'ready');
    assert.equal(await manager.isCurrent(project.id, instance), true);
    await manager.stop(project.id); await exited;
    assert.equal(manager.instances.has(project.id), false);
    const restarted = await manager.start(project.id);
    assert(restarted.child, 'After external shutdown, Desktop owns the replacement');
    assert.notEqual(restarted.child.pid, child.pid);
  } finally {
    try { await manager.close(); } finally { if (child.exitCode === null) child.kill('SIGTERM'); }
    await exited;
    await rm(temp, { recursive: true, force: true });
  }
});
