import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ProjectManager, canonicalProjectRoot } from '../dist/manager.js';
import { fixtureEnv } from './fixture-env.mjs';
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../../..');
const node = require.resolve('node/bin/node');
const cli = join(root, 'packages/smithy/dist/bin/sf.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const options = (temp, entry = join(root, 'packages/smithy/dist/server/managed.js')) => ({ dataDir: join(temp, 'registry'), node,
  entry, webRoot: join(root, 'packages/smithy/web'), binDir: join(root, 'apps/desktop/scripts/bin') });
const writeRegistry = async (temp, entries) => {
  await mkdir(join(temp, 'registry'), { recursive: true });
  await writeFile(join(temp, 'registry/projects.json'), JSON.stringify(entries));
};
const settled = async (manager, id) => {
  for (let i = 0; i < 200 && (manager.instances.has(id) || manager.projects.get(id).state === 'stopping'); i++) await pause(50);
  assert(!manager.instances.has(id), 'Failed backend must be stopped');
};

// Minimal managed-backend stand-in: reports a configurable identity so a
// genuine mismatch can be provoked without a second real workspace.
const STUB = `import http from 'node:http';
const mode = process.env.DESKTOP_IDENTITY_STUB;
process.on('disconnect', () => process.exit(0));
process.on('message', (m) => {
  if (m?.type === 'stop') process.exit(0);
  if (m?.type !== 'start') return;
  const other = '/stoneforge-identity-stub/other-project';
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ projectId: m.projectId, instanceId: m.instanceId, projectRoot: mode === 'endpoint' ? other : m.projectRoot }));
  });
  server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', projectId: m.projectId, instanceId: m.instanceId,
    protocolVersion: 1, pid: process.pid, port: server.address().port, projectRoot: mode === 'ready' ? other : m.projectRoot }));
});
`;

test('non-canonical stored roots (/var vs /private/var, symlinks) are migrated without duplicates and start', { timeout: 60_000 }, async () => {
  // Deliberately NOT realpath'd: on macOS tmpdir() is under /var, which the backend reports as /private/var.
  const temp = await mkdtemp(join(tmpdir(), 'stoneforge-canonical-'));
  const canonicalTemp = await realpath(temp);
  let manager;
  try {
    const a = join(canonicalTemp, 'A'); await mkdir(a);
    execFileSync(node, [cli, 'init', '--preset', 'auto', '--name', 'canonical-fixture'], { cwd: a, env: fixtureEnv(), stdio: 'pipe' });
    await symlink(a, join(canonicalTemp, 'alias'));
    const viaTemp = join(temp, 'A'), viaAlias = join(temp, 'alias');
    if (process.platform === 'darwin' && tmpdir().startsWith('/var/')) assert.notEqual(viaTemp, a, 'Fixture must exercise /var vs /private/var');
    const [first, second] = [randomUUID(), randomUUID()];
    await writeRegistry(temp, [{ id: first, name: 'A', root: viaTemp }, { id: second, name: 'alias', root: viaAlias }]);

    manager = new ProjectManager(options(temp));
    await manager.load();
    assert.deepEqual(manager.list().map(p => [p.id, p.root]), [[first, a]], 'Aliases collapse into the first entry with the canonical root');
    const saved = JSON.parse(await readFile(join(temp, 'registry/projects.json'), 'utf8'));
    assert.deepEqual(saved, [{ id: first, name: 'A', root: a }], 'Registry is migrated on load');
    assert.equal(await canonicalProjectRoot(viaAlias), a);
    assert.equal((await manager.add(viaAlias)).id, first, 'Re-adding an alias does not duplicate');

    const instance = await manager.start(first);
    assert.equal(manager.projects.get(first).state, 'ready');
    const identity = await (await fetch(instance.endpoint + '/api/desktop/identity', { headers: manager.headers(instance) })).json();
    assert.equal(identity.projectRoot, a);
    await manager.close(); manager = undefined;

    const reloaded = new ProjectManager(options(temp));
    await reloaded.load();
    assert.deepEqual(reloaded.list().map(p => [p.id, p.root]), [[first, a]], 'Migration is idempotent');
  } finally {
    await manager?.close();
    await rm(temp, { recursive: true, force: true });
  }
});

for (const mode of ['ready', 'endpoint']) {
  test(`genuine ${mode} identity mismatch stops the backend and stays visible as an error`, { timeout: 30_000 }, async () => {
    const temp = await realpath(await mkdtemp(join(tmpdir(), 'stoneforge-identity-')));
    const stub = join(temp, 'stub-backend.mjs'); await writeFile(stub, STUB);
    const project = join(temp, 'P'); await mkdir(join(project, '.stoneforge'), { recursive: true });
    await writeFile(join(project, '.stoneforge/stoneforge.db'), '');
    const manager = new ProjectManager(options(temp, stub));
    const previous = process.env.DESKTOP_IDENTITY_STUB;
    process.env.DESKTOP_IDENTITY_STUB = mode;
    try {
      await manager.load();
      const { id } = await manager.add(project);
      const expected = mode === 'ready' ? /Backend identity mismatch: backend serves "\/stoneforge-identity-stub\/other-project" but the project is / :
        /Endpoint identity mismatch: backend serves "\/stoneforge-identity-stub\/other-project" but the project is /;
      await assert.rejects(manager.start(id), expected);
      await settled(manager, id);
      const state = manager.projects.get(id);
      assert.equal(state.state, 'error', 'A failed identity check is not a silent stop');
      assert.match(state.error, expected);
      assert(state.error.includes(JSON.stringify(project)), 'Error names the expected root');
      assert.match(manager.logs.get(id), /\[desktop\] Startup failed, stopping backend: (Backend|Endpoint) identity mismatch/);
      await manager.close();
      assert.match(await readFile(join(temp, 'registry/logs', id + '.log'), 'utf8'), /Startup failed/);
    } finally {
      if (previous === undefined) delete process.env.DESKTOP_IDENTITY_STUB; else process.env.DESKTOP_IDENTITY_STUB = previous;
      await manager.close();
      await rm(temp, { recursive: true, force: true });
    }
  });
}

test('an unavailable stored root loads and reports a clear error when opened', { timeout: 10_000 }, async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'stoneforge-missing-')));
  try {
    const id = randomUUID(), missing = join(temp, 'gone');
    await writeRegistry(temp, [{ id, name: 'gone', root: missing }]);
    const manager = new ProjectManager(options(temp));
    await manager.load();
    assert.equal(manager.projects.get(id).root, missing);
    await assert.rejects(manager.start(id), /Project folder is unavailable: .*gone \(ENOENT\)/);
    assert.equal(manager.projects.get(id).state, 'error');
    assert.match(manager.projects.get(id).error, /Project folder is unavailable/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
