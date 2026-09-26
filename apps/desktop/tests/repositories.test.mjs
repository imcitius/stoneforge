import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ProjectManager } from '../dist/manager.js';
const require = createRequire(import.meta.url);
const source = resolve(import.meta.dirname, '../../..');
const node = require.resolve('node/bin/node');
const cli = join(source, 'packages/smithy/dist/bin/sf.js');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('non-Git Desktop project registers two repositories; real CLI uses shared project data and merges only the bound repository after restart', { timeout: 90000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'stoneforge-multirepo-desktop-'));
  const manager = new ProjectManager({ dataDir: join(temp, 'registry'), node, entry: join(source, 'packages/smithy/dist/server/managed.js'), webRoot: join(source, 'packages/smithy/web'), binDir: join(source, 'apps/desktop/scripts/bin') });
  try {
    await manager.load();
    const root = join(temp, 'Project'); await mkdir(root);
    const project = await manager.initialize(root, 'auto');
    let instance = await manager.start(project.id);
    const request = async (endpoint, method = 'GET', body) => {
      const response = await fetch(instance.endpoint + endpoint, { method, headers: { ...manager.headers(instance), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const result = await response.json();
      assert(response.ok, JSON.stringify(result)); return result;
    };
    await request('/api/daemon/stop', 'POST');
    assert.deepEqual((await request('/api/repositories')).repositories, []);
    const repos = [];
    for (const name of ['a', 'b']) {
      const repo = join(root, name); await mkdir(repo); repos.push(repo);
      git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.com');
      await writeFile(join(repo, 'README'), name); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'initial');
    }
    const env = () => ({ ...process.env, STONEFORGE_ROOT: project.root, STONEFORGE_DESKTOP_INSTANCE_ID: instance.instanceId });
    // Deliberately execute from B even for operations on A.
    const sf = (...args) => execFileSync(node, [cli, ...args], { cwd: repos[1], env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
    sf('repo', 'add', 'a', repos[0], '--target-branch', 'main'); sf('repo', 'add', 'b', repos[1], '--target-branch', 'main');
    assert.equal((await request('/api/repositories')).repositories.length, 2);
    sf('task', 'create', '--title', 'Only A', '--repository', 'a');
    let task = (await request('/api/tasks')).tasks.find(t => t.title === 'Only A');
    assert.equal(task.repositoryId, 'a');
    const worktree = await request('/api/worktrees', 'POST', { agentName: 'fixture', taskId: task.id, customBranch: 'feature/task' });
    await writeFile(join(worktree.path, 'A_ONLY'), 'done'); git(worktree.path, 'add', '.'); git(worktree.path, 'commit', '-qm', 'A change');
    sf('task', 'update', task.id, '--metadata', JSON.stringify({ orchestrator: { repositoryId: 'a', repositoryLocked: true, branch: worktree.branch, worktree: worktree.path, targetBranch: 'main' } }));
    sf('task', 'update', task.id, '--status', 'in_progress'); sf('task', 'update', task.id, '--status', 'review');
    assert.throws(() => sf('task', 'update', task.id, '--repository', 'b'));
    const beforeB = git(repos[1], 'rev-parse', 'HEAD');
    await manager.stop(project.id); instance = await manager.start(project.id); await request('/api/daemon/stop', 'POST');
    sf('task', 'merge', task.id);
    assert.equal(git(repos[0], 'show', 'main:A_ONLY'), 'done'); assert.equal(git(repos[1], 'rev-parse', 'HEAD'), beforeB);
    task = (await request('/api/tasks')).tasks.find(t => t.id === task.id);
    assert.equal(task.status, 'closed'); assert.equal(task.repositoryId, 'a');
    assert.equal((await request('/api/repositories')).repositories.length, 2);
  } finally { await manager.close(); await rm(temp, { recursive: true, force: true }); }
});
