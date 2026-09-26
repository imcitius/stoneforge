import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, symlink, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { ProjectManager } from '../dist/manager.js';
const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const smithyRequire = createRequire(join(root, 'packages/smithy/package.json'));
const WebSocket = smithyRequire('ws');
const node = require.resolve('node/bin/node');
const cli = join(root, 'packages/smithy/dist/bin/sf.js');

test('three real backends isolate identical agent IDs, credentials and events; restart changes identity', { timeout: 90_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'stoneforge-desktop-test-'));
  const manager = new ProjectManager({ dataDir: join(temp, 'registry'), node,
    entry: join(root, 'packages/smithy/dist/server/managed.js'),
    webRoot: join(root, 'packages/smithy/web'), binDir: join(root, 'apps/desktop/scripts/bin') });
  const sockets = [];
  try {
    await manager.load();
    const a = join(temp, 'A'); await mkdir(a);
    const fixtureEnv = { ...process.env }; delete fixtureEnv.STONEFORGE_ROOT;
    execFileSync(node, [cli, 'init', '--preset', 'auto', '--name', 'isolation-fixture'], { cwd: a, env: fixtureEnv, stdio: 'pipe' });
    execFileSync(node, [cli, 'agent', 'register', 'fixture-worker', '--role', 'worker', '--mode', 'ephemeral'], { cwd: a, env: fixtureEnv, stdio: 'pipe' });
    execFileSync(node, [cli, 'task', 'create', '--title', 'isolation-task'], { cwd: a, env: fixtureEnv, stdio: 'pipe' });
    // Clone initialized data so each project deliberately contains the same local IDs.
    for (const name of ['B', 'C']) await cp(a, join(temp, name), { recursive: true });
    const projects = await Promise.all(['A', 'B', 'C'].map((name) => manager.add(join(temp, name))));
    await symlink(a, join(temp, 'alias'));
    assert.equal((await manager.add(join(temp, 'alias'))).id, projects[0].id);
    const instances = await Promise.all(projects.map((p) => manager.start(p.id)));
    assert.equal(new Set(instances.map((i) => i.endpoint)).size, 3);
    assert(instances.every((i) => !i.endpoint.endsWith(':0')));
    const read = async (instance, path, headers = manager.headers(instance)) => {
      const response = await fetch(instance.endpoint + path, { headers, signal: AbortSignal.timeout(5000) });
      assert(response.ok, `${path}: ${response.status}`); return response.json();
    };
    const agents = await Promise.all(instances.map((i) => read(i, '/api/agents')));
    const workers = agents.map((data) => data.agents.find((a) => a.name === 'fixture-worker').id);
    assert.equal(new Set(workers).size, 1);
    const taskLists = await Promise.all(instances.map((i) => read(i, '/api/tasks')));
    const taskIds = taskLists.map((data) => data.tasks.find((t) => t.title === 'isolation-task').id);
    assert.equal(new Set(taskIds).size, 1);
    const ids = agents.map((data) => data.agents.find((a) => a.name === 'director').id);
    assert.equal(new Set(ids).size, 1);
    const cliEnv = { ...fixtureEnv, STONEFORGE_ROOT: projects[0].root, STONEFORGE_DESKTOP_INSTANCE_ID: instances[0].instanceId,
      ORCHESTRATOR_URL: instances[1].endpoint, STONEFORGE_API_URL: instances[1].endpoint };
    // Deliberately use another project's cwd and legacy URL variables. The
    // Desktop context must select A's database AND authenticated HTTP endpoint.
    const runCli = (...args) => execFileSync(node, [cli, ...args], { cwd: projects[1].root, env: cliEnv, stdio: 'pipe', timeout: 15_000 }).toString();
    runCli('daemon', 'status', '--json');
    runCli('agent', 'disable', ids[0]);
    assert.equal((await read(instances[0], '/api/agents')).agents.find((a) => a.id === ids[0]).metadata.agent.disabled, true);
    assert.notEqual((await read(instances[1], '/api/agents')).agents.find((a) => a.id === ids[0]).metadata.agent.disabled, true);
    runCli('agent', 'enable', ids[0]);
    runCli('task', 'create', '--title', 'cli-project-A-only');
    assert((await read(instances[0], '/api/tasks')).tasks.some((t) => t.title === 'cli-project-A-only'));
    assert(!(await read(instances[1], '/api/tasks')).tasks.some((t) => t.title === 'cli-project-A-only'));
    assert.throws(() => runCli('daemon', 'stop', '--server', instances[1].endpoint));
    for (let i = 0; i < 3; i++) {
      const instance = instances[i], other = instances[(i + 1) % 3];
      assert.equal((await fetch(instance.endpoint + '/api/agents')).status, 401);
      assert.equal((await fetch(instance.endpoint + '/api/agents', { headers: manager.headers(other) })).status, 401);
      const wrongInstance = { ...manager.headers(instance), 'x-stoneforge-instance': other.instanceId };
      assert.equal((await fetch(instance.endpoint + '/api/agents', { headers: wrongInstance })).status, 401);
      const ws = new WebSocket(instance.endpoint.replace('http:', 'ws:') + '/ws/events', { headers: manager.headers(instance) });
      sockets.push(ws); await once(ws, 'open'); ws.close();
      const denied = new WebSocket(instance.endpoint.replace('http:', 'ws:') + '/ws', { headers: manager.headers(other) });
      denied.on('error', () => {});
      const [, response] = await once(denied, 'unexpected-response');
      assert.equal(response.statusCode, 401); response.resume(); denied.terminate();
      const identity = await read(instance, '/api/desktop/identity');
      assert.equal(identity.projectRoot, projects[i].root);
      // Mutate the same local agent independently and verify each database via its own API.
      const patched = await fetch(instance.endpoint + `/api/agents/${ids[i]}`, {
        method: 'PATCH', headers: { ...manager.headers(instance), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `director-${i}` }),
      });
      assert(patched.ok, await patched.text());
      const dispatch = await fetch(instance.endpoint + `/api/tasks/${taskIds[i]}/dispatch`, {
        method: 'POST', headers: { ...manager.headers(instance), 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: workers[i], notificationMessage: `project-${i}-only` }),
      });
      assert(dispatch.ok, await dispatch.text());
      if (i === 0) {
        // B has the same local IDs, but dispatch in A must not assign its task.
        const untouched = await read(instances[1], `/api/tasks/${taskIds[1]}`);
        assert(!untouched.task.assignee);
      }
    }
    for (let i = 0; i < 3; i++) {
      const current = await read(instances[i], '/api/agents');
      assert(current.agents.some((a) => a.id === ids[i] && a.name === `director-${i}`));
      const events = await read(instances[i], '/api/events');
      const serialized = JSON.stringify(events);
      assert(!serialized.includes(`director-${(i + 1) % 3}`));
      const task = await read(instances[i], `/api/tasks/${taskIds[i]}`);
      assert.equal(task.task.assignee, workers[i]);
    }
    // The same lock also blocks a separate sf serve from touching the active database.
    let failure;
    try { execFileSync(node, [cli, 'serve', '--no-open'], { cwd: projects[0].root, env: fixtureEnv, timeout: 5000, stdio: 'pipe' }); }
    catch (error) { failure = error; }
    assert(failure && failure.status !== 0, 'Concurrent standalone server must fail');
    assert.match(String(failure.stderr) + String(failure.stdout), /already served|server.lock/);
    await manager.stop(projects[0].id);
    const restarted = await manager.start(projects[0].id);
    assert.notEqual(restarted.instanceId, instances[0].instanceId);
    assert.throws(() => runCli('daemon', 'status'), 'Old agent context must not silently attach to a restarted instance');
    assert.equal((await fetch(restarted.endpoint + '/api/health', { headers: manager.headers(instances[0]) })).status, 401);
    assert.equal(manager.projects.get(projects[1].id).state, 'ready');
    // Parent IPC loss performs shutdown and releases the workspace lock.
    restarted.child.disconnect(); await restarted.exited;
    await manager.start(projects[0].id);
  } finally {
    for (const ws of sockets) ws.terminate();
    await manager.close();
    if (manager.list().some((p) => p.error)) console.log([...manager.logs.entries()]);
    await rm(temp, { recursive: true, force: true });
  }
});
