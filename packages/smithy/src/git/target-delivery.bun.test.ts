/** Real repositories + CLI processes: target ancestry and delivery before bookkeeping. */
import { beforeEach, afterEach, expect, test, setDefaultTimeout } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createQuarryAPI, type QuarryAPI } from '@stoneforge/quarry';
import { createTask, type Task, type EntityId } from '@stoneforge/core';
import { ProjectRepositories } from './project-repositories.js';
import { resolveTarget } from './target.js';
import { mergeBranch, syncLocalBranchFromCommit } from './merge.js';
import { createMergeStewardService } from '../services/merge-steward-service.js';
import type { TaskAssignmentService } from '../services/task-assignment-service.js';
import type { DispatchService } from '../services/dispatch-service.js';
import { createLocalMergeProvider } from '../services/merge-request-provider.js';
import type { AgentRegistry } from '../services/agent-registry.js';

setDefaultTimeout(30_000);
const cliSource = path.resolve(import.meta.dir, '../bin/sf.ts');
let root: string, repo: string, remote: string, initial: string;
let storage: StorageBackend, api: QuarryAPI, repositories: ProjectRepositories;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commit(cwd: string, file: string, content = file) {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file); git(cwd, 'commit', '-qm', file);
  return git(cwd, 'rev-parse', 'HEAD');
}
function cli(...args: string[]) {
  const executable = process.env.SF_TEST_CLI ?? process.execPath;
  return spawnSync(executable, [...(process.env.SF_TEST_CLI ? [] : [cliSource]), ...args, '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, STONEFORGE_ROOT: root }, timeout: 20_000,
  });
}
async function taskBranch(base = 'master') {
  const raw = await createTask({ title: 'Target delivery', createdBy: 'user:test' as EntityId, metadata: { orchestrator: { repositoryId: 'core', targetBranch: base } } });
  let task = await api.create<Task>(raw as unknown as Parameters<QuarryAPI['create']>[0]);
  const manager = await repositories.forTask(task);
  const worktree = await manager.createWorktree({ agentName: 'worker', taskId: task.id, customBranch: `feature/${task.id}`, baseBranch: base });
  task = await api.update<Task>(task.id, { status: 'in_progress' });
  task = await api.update<Task>(task.id, { status: 'review', metadata: { ...task.metadata, orchestrator: { ...(task.metadata.orchestrator as object), branch: worktree.branch, worktree: worktree.path, mergeStatus: 'pending' } } });
  return { task, worktree, manager };
}
beforeEach(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sf-target-')));
  repo = path.join(root, 'core'); remote = path.join(root, 'remote.git'); mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master'); git(repo, 'config', 'user.email', 'test@example.com'); git(repo, 'config', 'user.name', 'Test');
  initial = commit(repo, 'README');
  git(root, 'clone', '--bare', repo, remote); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'fetch', 'origin');
  mkdirSync(path.join(root, '.stoneforge'));
  storage = createStorage({ path: path.join(root, '.stoneforge/stoneforge.db') }); initializeSchema(storage); api = createQuarryAPI(storage);
  repositories = new ProjectRepositories(root, api);
  await repositories.add({ id: 'core', path: repo, targetBranch: 'master' });
});
afterEach(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });

for (const state of ['equal', 'local-ahead', 'remote-ahead', 'offline', 'no-remote', 'explicit-target'] as const) {
  test(`worktree + read-only worktree use complete target: ${state}`, async () => {
    let target = 'master', expected = initial;
    if (state === 'local-ahead' || state === 'offline' || state === 'no-remote') expected = commit(repo, 'DESKTOP');
    if (state === 'offline') git(repo, 'remote', 'set-url', 'origin', path.join(root, 'unreachable.git'));
    if (state === 'no-remote') git(repo, 'remote', 'remove', 'origin');
    if (state === 'remote-ahead') {
      const other = path.join(root, 'other'); git(root, 'clone', repo, other);
      git(other, 'config', 'user.email', 'test@example.com'); git(other, 'config', 'user.name', 'Test');
      expected = commit(other, 'REMOTE'); git(other, 'push', remote, 'HEAD:master');
    }
    if (state === 'explicit-target') {
      target = 'release'; git(repo, 'switch', '-c', target); expected = commit(repo, 'RELEASE'); git(repo, 'switch', 'master');
    }
    const originalHead = git(repo, 'rev-parse', 'HEAD');
    const { worktree, manager } = await taskBranch(target);
    expect(git(worktree.path, 'rev-parse', 'HEAD')).toBe(expected);
    // Triage uses the registered default, explicit task target only affects task worktrees.
    const triage = await manager.createReadOnlyWorktree({ agentName: 'triage', purpose: 'review' });
    expect(git(triage.path, 'rev-parse', 'HEAD')).toBe(state === 'explicit-target' ? initial : expected);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(originalHead);
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('master');
  });
}

test('divergent target refuses worktree, sync and merge without changing either history', async () => {
  const { task, worktree, manager } = await taskBranch();
  const local = commit(repo, 'LOCAL');
  const other = path.join(root, 'other'); git(root, 'clone', remote, other);
  git(other, 'config', 'user.email', 'test@example.com'); git(other, 'config', 'user.name', 'Test');
  const upstream = commit(other, 'UPSTREAM'); git(other, 'push', 'origin', 'master');
  await expect(resolveTarget(repo, 'master')).rejects.toThrow('diverged');
  await expect(manager.createWorktree({ agentName: 'second', taskId: 'el-second' as Task['id'] })).rejects.toThrow('diverged');
  await expect(manager.createReadOnlyWorktree({ agentName: 'triage', purpose: 'diverged' })).rejects.toThrow('diverged');
  expect(cli('task', 'sync', task.id).status).not.toBe(0);
  expect(cli('task', 'merge', task.id, '--local').status).not.toBe(0);
  expect(git(repo, 'rev-parse', 'master')).toBe(local);
  expect(git(remote, 'rev-parse', 'master')).toBe(upstream);
  expect(git(worktree.path, 'rev-parse', 'HEAD')).toBe(initial);
  expect((await api.get<Task>(task.id))?.status).toBe('review');
});

for (const state of ['local-ahead', 'remote-ahead', 'offline', 'no-remote', 'explicit-target'] as const) {
  test(`task sync incorporates actual target: ${state}`, async () => {
    const target = state === 'explicit-target' ? 'release' : 'master';
    if (target === 'release') git(repo, 'branch', target);
    const { task, worktree } = await taskBranch(target);
    const source = commit(worktree.path, 'TASK');
    if (target === 'release') git(repo, 'switch', target);
    const targetCommit = commit(repo, 'TARGET');
    if (state === 'remote-ahead') {
      git(repo, 'push', 'origin', 'master');
      git(repo, 'switch', '--detach', initial);
      git(repo, 'update-ref', 'refs/heads/master', initial, targetCommit);
      git(repo, 'switch', 'master');
    }
    if (state === 'offline') git(repo, 'remote', 'set-url', 'origin', path.join(root, 'offline.git'));
    if (state === 'no-remote') git(repo, 'remote', 'remove', 'origin');
    const result = cli('task', 'sync', task.id);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.success).toBe(true);
    expect(git(worktree.path, 'merge-base', '--is-ancestor', targetCommit, 'HEAD')).toBe('');
    expect(git(worktree.path, 'merge-base', '--is-ancestor', source, 'HEAD')).toBe('');
  });
}

test('remote merge refuses unpublished target history; --local preserves it and closes only after delivery', async () => {
  const local = commit(repo, 'DESKTOP');
  const { task, worktree } = await taskBranch(); commit(worktree.path, 'TASK');
  git(worktree.path, 'push', 'origin', worktree.branch); // remote source must survive local cleanup
  const refused = cli('task', 'merge', task.id);
  expect(refused.status).not.toBe(0); expect(refused.stdout + refused.stderr).toContain('Refusing to publish');
  expect((await api.get<Task>(task.id))?.status).toBe('review'); expect(existsSync(worktree.path)).toBe(true);
  const result = cli('task', 'merge', task.id, '--local');
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(git(repo, 'merge-base', '--is-ancestor', local, 'master')).toBe('');
  expect(readFileSync(path.join(repo, 'DESKTOP'), 'utf8')).toBe('DESKTOP');
  expect(readFileSync(path.join(repo, 'TASK'), 'utf8')).toBe('TASK');
  expect(git(repo, 'rev-list', '--count', `${local}..master`)).toBe('1');
  expect(git(remote, 'rev-parse', 'master')).toBe(initial);
  expect(git(remote, 'rev-parse', worktree.branch)).toBeTruthy();
  const closed = (await api.get<Task>(task.id))!;
  expect(closed.status).toBe('closed');
  expect(closed.metadata.orchestrator).toMatchObject({ mergeStatus: 'merged', mergeCommitHash: git(repo, 'rev-parse', 'master') });
  expect(existsSync(worktree.path)).toBe(false);
});

test('failed local delivery keeps task in review, branch/worktree and target contents intact', async () => {
  const local = commit(repo, 'DESKTOP'); const { task, worktree } = await taskBranch(); commit(worktree.path, 'TASK');
  writeFileSync(path.join(repo, 'README'), 'user work');
  const result = cli('task', 'merge', task.id, '--local');
  expect(result.status).not.toBe(0); expect(result.stdout + result.stderr).toContain('Local delivery');
  expect(git(repo, 'rev-parse', 'master')).toBe(local); expect(git(remote, 'rev-parse', 'master')).toBe(initial);
  expect(readFileSync(path.join(repo, 'README'), 'utf8')).toBe('user work');
  expect((await api.get<Task>(task.id))?.status).toBe('review');
  expect((await api.get<Task>(task.id))?.metadata.orchestrator).not.toMatchObject({ mergeStatus: 'merged' });
  expect(existsSync(worktree.path)).toBe(true); expect(git(repo, 'rev-parse', worktree.branch)).toBeTruthy();
  expect(git(repo, 'worktree', 'list', '--porcelain')).toContain('_merge-');
});

test('local delivery refuses non-fast-forward even when target is not checked out', async () => {
  const { worktree } = await taskBranch(); const source = commit(worktree.path, 'TASK');
  const target = commit(repo, 'TARGET'); git(repo, 'switch', '--detach');
  await expect(syncLocalBranchFromCommit(repo, 'master', source)).rejects.toThrow();
  expect(git(repo, 'rev-parse', 'master')).toBe(target);
});

test('local delivery updates a target checked out in another worktree without switching main checkout', async () => {
  const { worktree } = await taskBranch(); commit(worktree.path, 'TASK');
  git(repo, 'switch', '--detach'); const targetCheckout = path.join(root, 'target'); git(repo, 'worktree', 'add', targetCheckout, 'master');
  const result = await mergeBranch({ workspaceRoot: repo, sourceBranch: worktree.branch, targetBranch: 'master', localOnly: true });
  expect(result.success, result.error).toBe(true);
  expect(readFileSync(path.join(targetCheckout, 'TASK'), 'utf8')).toBe('TASK');
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(initial);
  expect(git(repo, 'rev-parse', 'master')).toBe(result.commitHash!);
});

for (const mode of ['equal', 'remote-ahead', 'no-remote', 'explicit-target', 'stale-source'] as const) {
  test(`CLI merge preserves target and delivers in ${mode} scenario`, async () => {
    const target = mode === 'explicit-target' ? 'release' : 'master';
    if (target === 'release') git(repo, 'branch', target);
    const { task, worktree } = await taskBranch(target); commit(worktree.path, 'TASK');
    let targetCommit = initial;
    if (mode === 'remote-ahead' || mode === 'stale-source') {
      targetCommit = commit(repo, 'README', 'new target content');
      if (mode === 'remote-ahead') {
        git(repo, 'push', 'origin', 'master'); git(repo, 'switch', '--detach', initial);
        git(repo, 'update-ref', 'refs/heads/master', initial, targetCommit);
        git(repo, 'switch', 'master');
      }
    }
    if (mode === 'no-remote') git(repo, 'remote', 'remove', 'origin');
    const localMode = mode === 'stale-source' || mode === 'explicit-target';
    const result = cli('task', 'merge', task.id, ...(localMode ? ['--local'] : []));
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(git(repo, 'merge-base', '--is-ancestor', targetCommit, target)).toBe('');
    expect(git(repo, 'show', `${target}:TASK`)).toBe('TASK');
    if (targetCommit !== initial) expect(git(repo, 'show', `${target}:README`)).toBe('new target content');
    expect((await api.get<Task>(task.id))?.status).toBe('closed');
    if (localMode || mode === 'no-remote') expect(git(remote, 'rev-parse', 'master')).toBe(initial);
    else expect(git(remote, 'show', 'master:TASK')).toBe('TASK');
  });
}

test('untracked collision fails local delivery without losing user file or closing task', async () => {
  const { task, worktree } = await taskBranch(); commit(worktree.path, 'TASK');
  writeFileSync(path.join(repo, 'TASK'), 'user untracked file');
  const result = cli('task', 'merge', task.id, '--local');
  expect(result.status).not.toBe(0);
  expect(readFileSync(path.join(repo, 'TASK'), 'utf8')).toBe('user untracked file');
  expect(git(repo, 'rev-parse', 'master')).toBe(initial);
  expect((await api.get<Task>(task.id))?.status).toBe('review');
  expect(existsSync(worktree.path)).toBe(true);
});

for (const approval of [false, true]) {
  test(`steward refuses local-ahead before ${approval ? 'PR creation' : 'remote merge'}`, async () => {
    commit(repo, 'DESKTOP'); const { task, worktree } = await taskBranch(); commit(worktree.path, 'TASK');
    const service = createMergeStewardService(api, {} as TaskAssignmentService, {} as DispatchService, {} as AgentRegistry,
      { workspaceRoot: root, autoCleanup: false, requireApproval: approval, mergeRequestProvider: createLocalMergeProvider() }, repositories);
    const result = await service.processTask(task.id, { skipTests: true });
    expect(result.merged).toBe(false);
    expect(result.error).toContain('Refusing to publish');
    expect((await api.get<Task>(task.id))?.status).not.toBe('closed');
    expect(git(remote, 'rev-parse', 'master')).toBe(initial);
    expect(existsSync(worktree.path)).toBe(true);
  });
}

test('steward checks unpushed local source commits before declaring already merged', async () => {
  const { task, worktree } = await taskBranch(); git(worktree.path, 'push', 'origin', worktree.branch);
  commit(worktree.path, 'UNPUSHED');
  const service = createMergeStewardService(api, {} as TaskAssignmentService, {} as DispatchService, {} as AgentRegistry,
    { workspaceRoot: root, autoCleanup: false }, repositories);
  const result = await service.processTask(task.id, { skipTests: true });
  expect(result.merged, result.error).toBe(true);
  expect(git(remote, 'show', 'master:UNPUSHED')).toBe('UNPUSHED');
});

test('standalone sf merge refuses to publish local target commits', async () => {
  commit(repo, 'DESKTOP'); const { worktree } = await taskBranch(); commit(worktree.path, 'TASK');
  const result = cli('merge', '--repository', 'core', '--branch', worktree.branch);
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('Refusing to publish');
  expect(git(remote, 'rev-parse', 'master')).toBe(initial);
});
