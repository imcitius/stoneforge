import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createQuarryAPI, type QuarryAPI } from '@stoneforge/quarry';
import { createTask, type Task, type EntityId } from '@stoneforge/core';
import { ProjectRepositories } from './project-repositories.js';
import { createMergeStewardService } from '../services/merge-steward-service.js';
import type { TaskAssignmentService } from '../services/task-assignment-service.js';
import type { DispatchService } from '../services/dispatch-service.js';
import type { AgentRegistry } from '../services/agent-registry.js';
let root: string;
let api: QuarryAPI;
let storage: StorageBackend;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
function repo(name: string, branch: string) {
  const directory = path.join(root, name); mkdirSync(directory);
  git(directory, 'init', '-q', '-b', branch);
  git(directory, 'config', 'user.name', 'Test'); git(directory, 'config', 'user.email', 'test@example.com');
  writeFileSync(path.join(directory, 'README'), name);
  git(directory, 'add', '.'); git(directory, 'commit', '-qm', 'initial');
  return directory;
}
async function task(repositoryId?: string): Promise<Task> {
  const value = await createTask({ title: 'Change', createdBy: 'user:test' as EntityId, metadata: repositoryId ? { orchestrator: { repositoryId } } : {} });
  return api.create<Task>(value as unknown as Parameters<QuarryAPI['create']>[0]);
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'stoneforge-repositories-')));
  storage = createStorage({ path: ':memory:' }); initializeSchema(storage); api = createQuarryAPI(storage);
});
afterEach(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });

test('a project without Git dispatches and merges equal branch names into the correct independent repositories', async () => {
  const a = repo('a', 'main'); const b = repo('b', 'release');
  const repositories = new ProjectRepositories(root, api);
  await repositories.initWorkspace(); expect(await repositories.list()).toEqual([]);
  await repositories.add({ id: 'a', path: a, targetBranch: 'main', testCommand: 'test -f ONLY_A && test ! -f ONLY_B' });
  await repositories.add({ id: 'b', path: b, targetBranch: 'release', testCommand: 'test -f ONLY_B && test ! -f ONLY_A' });
  expect(existsSync(path.join(root, '.git'))).toBe(false);
  const ta = await task('a'), tb = await task('b');
  const [wa, wb] = await Promise.all([ta, tb].map(async t => {
    const manager = await repositories.forTask(t);
    const worktree = await manager.createWorktree({ agentName: 'worker', taskId: t.id, customBranch: 'feature/same' });
    const id = t.metadata.orchestrator as { repositoryId: string };
    writeFileSync(path.join(worktree.path, 'ONLY_' + id.repositoryId.toUpperCase()), 'changed');
    git(worktree.path, 'add', '.'); git(worktree.path, 'commit', '-qm', 'change');
    await api.update(t.id, { status: 'in_progress' });
    await api.update(t.id, { status: 'review', metadata: { orchestrator: { repositoryId: id.repositoryId, repositoryLocked: true, branch: worktree.branch, worktree: worktree.path, mergeStatus: 'pending' } } });
    return worktree;
  }));
  expect(wa.path).toContain('/.stoneforge/.worktrees/a/'); expect(wb.path).toContain('/.stoneforge/.worktrees/b/');
  const restarted = new ProjectRepositories(root, api);
  const service = createMergeStewardService(api, {} as TaskAssignmentService, {} as DispatchService, {} as AgentRegistry, { workspaceRoot: root, autoPushAfterMerge: false, autoCleanup: false }, restarted);
  expect((await service.runTests(ta.id)).passed).toBe(true); expect((await service.runTests(tb.id)).passed).toBe(true);
  const originalA = git(a, 'rev-parse', 'main');
  const mergedB = await service.processTask(tb.id); expect(mergedB.merged).toBe(true);
  expect(git(a, 'rev-parse', 'main')).toBe(originalA);
  expect(git(b, 'show', 'release:ONLY_B')).toBe('changed');
  expect((await service.attemptMerge(ta.id, 'A only')).success).toBe(true);
  expect(git(a, 'show', 'main:ONLY_A')).toBe('changed');
  await service.cleanupAfterMerge(ta.id, false);
  expect(existsSync(wa.path)).toBe(false); expect(existsSync(wb.path)).toBe(true);
}, 30000);

test('ambiguity and duplicate linked worktrees are rejected, and selection survives restart', async () => {
  const a = repo('a', 'main'); const b = repo('b', 'main');
  const repositories = new ProjectRepositories(root, api);
  await repositories.add({ id: 'a', path: a });
  const t = await task(); await repositories.forTask(t);
  expect((await api.get<Task>(t.id))?.metadata.orchestrator).toMatchObject({ repositoryId: 'a', repositoryLocked: true });
  await repositories.add({ id: 'b', path: b });
  await expect(repositories.forTask(await task())).rejects.toThrow('Choose a repository');
  const linked = path.join(root, 'linked-a'); git(a, 'worktree', 'add', '-q', '-b', 'linked', linked);
  await expect(repositories.add({ id: 'alias', path: linked })).rejects.toThrow('already registered');
  const recovered = await new ProjectRepositories(root, api).forTask((await api.get<Task>(t.id))!);
  expect(recovered.getRepositoryRoot!()).toBe(a);
  await expect(repositories.remove('a')).rejects.toThrow('referenced by tasks');
});

test('an assigned task cannot switch repositories or resume a foreign worktree', async () => {
  const a = repo('a', 'main'), b = repo('b', 'main');
  const repositories = new ProjectRepositories(root, api);
  await repositories.add({ id: 'a', path: a }); await repositories.add({ id: 'b', path: b });
  const created = await task('a');
  // forTask pins the repository using this snapshot's updatedAt and metadata.
  const t = await api.update<Task>(created.id, { metadata: { orchestrator: { repositoryId: 'a', branch: 'feature/test' } } });
  await expect(api.update(t.id, { metadata: { orchestrator: { repositoryId: 'b', branch: 'feature/test' } } })).rejects.toThrow('Cannot change repository');
  await expect(api.update(t.id, { metadata: {} })).rejects.toThrow('Cannot change repository');
  const bad = { ...t, metadata: { orchestrator: { repositoryId: 'a', worktree: b } } };
  await expect(repositories.forTask(bad)).rejects.toThrow('another repository');
  const manager = await repositories.forTask(t);
  expect((await api.get<Task>(t.id))?.metadata.orchestrator).toMatchObject({ repositoryId: 'a', repositoryLocked: true, branch: 'feature/test' });
  await expect(manager.createWorktree({ agentName: 'worker', taskId: t.id, customPath: '../outside' })).rejects.toThrow('managed directory');
});

test('existing single-repository projects remain automatic', async () => {
  const a = repo('a', 'main');
  const repositories = new ProjectRepositories(a, api);
  expect((await repositories.resolve()).id).toBe('default');
  const t = await task(); const worktree = await repositories.createWorktree({ agentName: 'worker', taskId: t.id });
  expect(worktree.path).toContain('/a/.stoneforge/.worktrees/worker');
  expect(existsSync(repositories.manifest)).toBe(false);
});

test('a missing repository is reported without preventing other repositories from working', async () => {
  const a = repo('a', 'main'), b = repo('b', 'main');
  const repositories = new ProjectRepositories(root, api);
  await repositories.add({ id: 'a', path: a }); await repositories.add({ id: 'b', path: b });
  rmSync(b, { recursive: true, force: true });
  const restarted = new ProjectRepositories(root, api); await restarted.initWorkspace();
  const descriptions = await restarted.describe();
  expect(descriptions.find(r => r.id === 'b')?.error).toContain('No Git checkout');
  const t = await task('a');
  const worktree = await (await restarted.forTask(t)).createWorktree({ agentName: 'healthy', taskId: t.id });
  expect(existsSync(worktree.path)).toBe(true);
  await expect(restarted.forTask(await task('b'))).rejects.toThrow('No Git checkout');
});
