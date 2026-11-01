/**
 * Local-only delivery (`delivery: local` in .stoneforge/repositories.json).
 * Real repositories with a bare `origin`: no completion, merge, cleanup or
 * review-branch path may add, update or delete any ref on the remote, while the
 * default (`remote`) delivery keeps publishing task branches.
 */
import { beforeEach, afterEach, expect, test, setDefaultTimeout } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createQuarryAPI, type QuarryAPI } from '@stoneforge/quarry';
import { createTask, createEntity, EntityTypeValue, TaskStatus, type Task, type EntityId } from '@stoneforge/core';
import { ProjectRepositories } from './project-repositories.js';
import { deliveryForDirectory, hasDeliveryRemote } from './delivery.js';
import { ensureTargetBranchExists, mergeBranch } from './merge.js';
import { createTaskAssignmentService } from '../services/task-assignment-service.js';
import { createMergeStewardService } from '../services/merge-steward-service.js';
import type { TaskAssignmentService } from '../services/task-assignment-service.js';
import type { DispatchService } from '../services/dispatch-service.js';
import type { AgentRegistry } from '../services/agent-registry.js';
import { createLocalMergeProvider } from '../services/merge-request-provider.js';
import { getOrchestratorTaskMeta } from '../types/task-meta.js';
import { applyDeliveryBlocks, loadRolePrompt, renderPromptTemplate } from '../prompts/index.js';

setDefaultTimeout(30_000);
const cliSource = path.resolve(import.meta.dir, '../bin/sf.ts');
let root: string, repo: string, remote: string, initial: string;
let storage: StorageBackend, api: QuarryAPI, repositories: ProjectRepositories, owner: EntityId;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const remoteRefs = () => git(remote, 'for-each-ref', '--format=%(refname) %(objectname)');
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
/** A task with a real worktree/branch, owned by a live worker session. */
async function workerTask(status: TaskStatus = TaskStatus.IN_PROGRESS) {
  const raw = await createTask({ title: 'Local delivery', createdBy: owner, metadata: { orchestrator: { repositoryId: 'core', targetBranch: 'master' } } });
  let task = await api.create<Task>(raw as unknown as Parameters<QuarryAPI['create']>[0]);
  const manager = await repositories.forTask(task);
  const worktree = await manager.createWorktree({ agentName: 'worker', taskId: task.id, customBranch: `agent/worker/${task.id}`, baseBranch: 'master' });
  task = (await api.get<Task>(task.id))!;
  task = await api.update<Task>(task.id, {
    status, assignee: owner,
    metadata: { ...task.metadata, orchestrator: {
      ...getOrchestratorTaskMeta(task.metadata), branch: worktree.branch, worktree: worktree.path,
      assignedAgent: owner, sessionId: 'internal',
      ...(status === TaskStatus.REVIEW ? { mergeStatus: 'pending' } : {}),
      sessionHistory: [{ sessionId: 'internal', agentId: owner, agentName: 'worker', agentRole: 'worker', startedAt: task.createdAt }],
    } },
  });
  return { task, worktree };
}
async function setDelivery(delivery: 'local' | 'remote') {
  await repositories.setDelivery('core', delivery);
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sf-local-delivery-')));
  repo = path.join(root, 'core'); remote = path.join(root, 'remote.git'); mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master'); git(repo, 'config', 'user.email', 'test@example.com'); git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  initial = commit(repo, 'README');
  git(root, 'clone', '-q', '--bare', repo, remote); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'fetch', '-q', 'origin');
  mkdirSync(path.join(root, '.stoneforge'));
  storage = createStorage({ path: path.join(root, '.stoneforge/stoneforge.db') }); initializeSchema(storage); api = createQuarryAPI(storage);
  const entity = await createEntity({ name: 'worker', entityType: EntityTypeValue.AGENT, createdBy: 'system:test' as EntityId });
  owner = (await api.create(entity as unknown as Parameters<QuarryAPI['create']>[0])).id as unknown as EntityId;
  repositories = new ProjectRepositories(root, api);
  await repositories.add({ id: 'core', path: repo, targetBranch: 'master', delivery: 'local' });
});
afterEach(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });

// --------------------------------------------------------------------------
// Registry
// --------------------------------------------------------------------------

test('registry stores, validates and resolves the delivery mode for checkouts and worktrees', async () => {
  const manifest = JSON.parse(readFileSync(path.join(root, '.stoneforge/repositories.json'), 'utf8'));
  expect(manifest.repositories[0].delivery).toBe('local');
  const { worktree } = await workerTask();
  expect(await deliveryForDirectory(repo)).toBe('local');
  expect(await deliveryForDirectory(worktree.path)).toBe('local');
  expect(await deliveryForDirectory(root)).toBe('local'); // project root: every repository local
  expect(await hasDeliveryRemote(repo)).toBe(false);

  await setDelivery('remote');
  // `remote` is the default and is stored by omission.
  expect(JSON.parse(readFileSync(path.join(root, '.stoneforge/repositories.json'), 'utf8')).repositories[0].delivery).toBeUndefined();
  expect(await deliveryForDirectory(worktree.path)).toBe('remote');
  expect(await hasDeliveryRemote(repo)).toBe(true);

  await expect(repositories.setDelivery('core', 'public' as never)).rejects.toThrow("'remote' or 'local'");
  const raw = JSON.parse(readFileSync(path.join(root, '.stoneforge/repositories.json'), 'utf8'));
  raw.repositories[0].delivery = 'sometimes';
  writeFileSync(path.join(root, '.stoneforge/repositories.json'), JSON.stringify(raw));
  await expect(repositories.list()).rejects.toThrow('Invalid repository entry');
});

test('unregistered repositories keep the default remote delivery', async () => {
  const other = path.join(root, 'other'); mkdirSync(other);
  git(other, 'init', '-q', '-b', 'main');
  expect(await deliveryForDirectory(other)).toBe('remote');
  expect(await deliveryForDirectory(path.join(root, 'missing'))).toBe('remote');
});

// --------------------------------------------------------------------------
// Task completion
// --------------------------------------------------------------------------

test('completion with local delivery performs no push and creates no merge request', async () => {
  const { task, worktree } = await workerTask();
  const source = commit(worktree.path, 'TASK');
  const before = remoteRefs();
  const result = await createTaskAssignmentService(api, createLocalMergeProvider(), root)
    .completeTask(task.id, { agentId: owner, sessionId: 'internal', summary: 'Done' });
  expect(result.task.status).toBe(TaskStatus.REVIEW);
  const op = getOrchestratorTaskMeta(result.task.metadata)!.completionOperation!;
  expect(op.push).toBe(false);
  expect(op.createMR).toBe(false);
  expect(op.commitOid).toBe(source);
  expect(remoteRefs()).toBe(before);
  expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/master');
});

test('completion resolves local delivery from the worktree when no project root is known', async () => {
  const { task, worktree } = await workerTask();
  commit(worktree.path, 'TASK');
  const before = remoteRefs();
  const result = await createTaskAssignmentService(api).completeTask(task.id, { agentId: owner, sessionId: 'internal', createMergeRequest: false });
  expect(result.task.status).toBe(TaskStatus.REVIEW);
  expect(remoteRefs()).toBe(before);
});

test('default remote delivery still pushes the task branch on completion', async () => {
  await setDelivery('remote');
  const { task, worktree } = await workerTask();
  const source = commit(worktree.path, 'TASK');
  await createTaskAssignmentService(api, undefined, root).completeTask(task.id, { agentId: owner, sessionId: 'internal', createMergeRequest: false });
  expect(git(remote, 'rev-parse', '--verify', `refs/heads/${worktree.branch}`)).toBe(source);
});

// --------------------------------------------------------------------------
// Merge, cleanup and review branches
// --------------------------------------------------------------------------

test('sf task merge delivers locally without --local and never touches the remote', async () => {
  const { task, worktree } = await workerTask(TaskStatus.REVIEW);
  commit(worktree.path, 'TASK');
  const before = remoteRefs();
  const result = cli('task', 'merge', task.id);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(readFileSync(path.join(repo, 'TASK'), 'utf8')).toBe('TASK');
  expect(git(repo, 'rev-list', '--count', `${initial}..master`)).toBe('1');
  expect(remoteRefs()).toBe(before);
  const closed = (await api.get<Task>(task.id))!;
  expect(closed.status).toBe('closed');
  expect(closed.metadata.orchestrator).toMatchObject({ mergeStatus: 'merged', mergeCommitHash: git(repo, 'rev-parse', 'master') });
});

test('sf merge delivers locally, even with unpublished local target history', async () => {
  const desktop = commit(repo, 'DESKTOP');
  const { worktree } = await workerTask();
  commit(worktree.path, 'TASK');
  const before = remoteRefs();
  const result = cli('merge', '--repository', 'core', '--branch', worktree.branch, '--cleanup');
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(git(repo, 'merge-base', '--is-ancestor', desktop, 'master')).toBe('');
  expect(readFileSync(path.join(repo, 'TASK'), 'utf8')).toBe('TASK');
  expect(remoteRefs()).toBe(before);
});

test('merge steward merges, cleans up and deletes the branch without remote pushes or deletes', async () => {
  const { task, worktree } = await workerTask(TaskStatus.REVIEW);
  commit(worktree.path, 'TASK');
  // Simulate a branch published before local delivery was enabled: it must survive cleanup.
  git(repo, 'push', '-q', 'origin', `${worktree.branch}:refs/heads/${worktree.branch}`);
  const before = remoteRefs();
  const service = createMergeStewardService(api, {} as TaskAssignmentService, {} as DispatchService, {} as AgentRegistry,
    { workspaceRoot: root, autoCleanup: true, deleteBranchAfterMerge: true }, repositories);
  const result = await service.processTask(task.id, { skipTests: true });
  expect(result.merged, result.error).toBe(true);
  expect(readFileSync(path.join(repo, 'TASK'), 'utf8')).toBe('TASK');
  expect(remoteRefs()).toBe(before);
  expect(existsSync(worktree.path)).toBe(false);
});

test('approval mode with local delivery leaves the task pending instead of pushing for a hosted PR', async () => {
  const { task, worktree } = await workerTask(TaskStatus.REVIEW);
  commit(worktree.path, 'TASK');
  const before = remoteRefs();
  const service = createMergeStewardService(api, {} as TaskAssignmentService, {} as DispatchService, {} as AgentRegistry,
    { workspaceRoot: root, autoCleanup: false, requireApproval: true, mergeRequestProvider: createLocalMergeProvider() }, repositories);
  const result = await service.processTask(task.id, { skipTests: true });
  expect(result.merged).toBe(false);
  expect(result.error).toContain('local-only delivery');
  expect(remoteRefs()).toBe(before);
});

test('worktree cleanup with deleteRemoteBranch keeps remote refs under local delivery', async () => {
  const { worktree } = await workerTask();
  git(repo, 'push', '-q', 'origin', `${worktree.branch}:refs/heads/${worktree.branch}`);
  const before = remoteRefs();
  await repositories.removeWorktree(worktree.path, { deleteBranch: true, deleteRemoteBranch: true, force: true, forceBranchDelete: true });
  expect(remoteRefs()).toBe(before);
  expect(() => git(repo, 'rev-parse', '--verify', `refs/heads/${worktree.branch}`)).toThrow();
});

test('default delivery still deletes the remote branch on cleanup', async () => {
  await setDelivery('remote');
  const { worktree } = await workerTask();
  git(repo, 'push', '-q', 'origin', `${worktree.branch}:refs/heads/${worktree.branch}`);
  await repositories.removeWorktree(worktree.path, { deleteBranch: true, deleteRemoteBranch: true, force: true, forceBranchDelete: true });
  expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/master');
});

test('mergeBranch auto-detects local delivery despite an origin remote', async () => {
  git(repo, 'switch', '-q', '-c', 'topic'); const source = commit(repo, 'TOPIC'); git(repo, 'switch', '-q', 'master');
  const before = remoteRefs();
  const result = await mergeBranch({ workspaceRoot: repo, sourceBranch: 'topic', targetBranch: 'master', commitMessage: 'topic' });
  expect(result.success, result.error).toBe(true);
  expect(git(repo, 'rev-parse', 'master')).toBe(result.commitHash!);
  expect(git(repo, 'show', 'master:TOPIC')).toBe('TOPIC');
  expect(source).not.toBe(result.commitHash);
  expect(remoteRefs()).toBe(before);
});

test('review target branches are created locally only', async () => {
  const before = remoteRefs();
  await ensureTargetBranchExists(repo, 'stoneforge/review');
  expect(git(repo, 'rev-parse', 'stoneforge/review')).toBe(initial);
  expect(remoteRefs()).toBe(before);
});

// --------------------------------------------------------------------------
// Prompts
// --------------------------------------------------------------------------

test('delivery blocks select remote or local instructions and never leak markers', () => {
  const template = 'a\n{{#delivery remote}}\ngit push origin <branch>\n{{/delivery}}\n{{#delivery local}}\nnever push\n{{/delivery}}\nb {{baseRef}}';
  expect(applyDeliveryBlocks(template)).toBe('a\ngit push origin <branch>\nb origin/{{baseBranch}}');
  expect(applyDeliveryBlocks(template, 'local')).toBe('a\nnever push\nb {{baseBranch}}');
  expect(renderPromptTemplate(applyDeliveryBlocks(template, 'local'), { baseBranch: 'master' })).toBe('a\nnever push\nb master');
});

for (const [role, focus, workerMode] of [['worker', undefined, 'ephemeral'], ['worker', undefined, 'persistent'], ['steward', 'merge', undefined], ['steward', 'recovery', undefined]] as const) {
  test(`built-in ${role}${focus ? `/${focus}` : `/${workerMode}`} prompt: no push instruction with local delivery`, () => {
    const local = loadRolePrompt(role, focus, { builtInOnly: true, workerMode, delivery: 'local' })!.prompt;
    const remoteDefault = loadRolePrompt(role, focus, { builtInOnly: true, workerMode })!.prompt;
    for (const prompt of [local, remoteDefault]) {
      expect(prompt).not.toContain('{{#delivery');
      expect(prompt).not.toContain('{{/delivery');
      expect(prompt).not.toContain('{{baseRef}}');
    }
    expect(local).not.toContain('git push origin');
    expect(local.toLowerCase()).toContain('local-only delivery');
    if (role === 'steward') expect(local).not.toContain('origin/{{baseBranch}}..HEAD');
    if (role === 'worker' || focus === 'recovery') expect(remoteDefault).toContain('git push origin <branch>');
    if (focus === 'merge') expect(remoteDefault).toContain('git diff origin/{{baseBranch}}..HEAD');
  });
}

test('workspace steward-merge override resolves delivery blocks like the built-in', () => {
  const override = readFileSync(path.resolve(import.meta.dir, '../../../../docs/workspace/steward-merge.md'), 'utf8');
  const local = applyDeliveryBlocks(override, 'local');
  expect(local).not.toContain('{{#delivery');
  expect(local).not.toContain('git push origin');
  expect(local).toContain('Local-only delivery');
  expect(applyDeliveryBlocks(override)).toContain('origin/{{baseBranch}}..HEAD');
});
