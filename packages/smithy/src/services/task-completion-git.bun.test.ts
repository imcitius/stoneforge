/** Real temporary Git/SQLite fixtures only; never execute the vulnerable shell path. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createQuarryAPI, type QuarryAPI } from '@stoneforge/quarry';
import { createTask, createEntity, EntityTypeValue, TaskStatus, type Task, type EntityId } from '@stoneforge/core';
import { createTaskAssignmentService } from './task-assignment-service.js';
import { getOrchestratorTaskMeta } from '../types/task-meta.js';

let root: string, repo: string, remote: string, storage: StorageBackend, api: QuarryAPI, task: Task;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ref = (cwd: string, branch: string) => git(cwd, 'rev-parse', '--verify', '--end-of-options', `refs/heads/${branch}`);
beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'sf-complete-argv-'));
  repo = path.join(root, 'repo'); remote = path.join(root, 'remote.git'); mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'commit', '--allow-empty', '-qm', 'initial');
  git(root, 'clone', '--bare', '--', repo, remote);
  git(repo, 'remote', 'add', 'origin', remote);
  storage = createStorage({ path: path.join(root, 'test.db') }); initializeSchema(storage); api = createQuarryAPI(storage);
  const entity = await createEntity({ name: 'fixture', entityType: EntityTypeValue.SYSTEM, createdBy: 'system:test' as EntityId });
  const owner = (await api.create(entity as unknown as Parameters<QuarryAPI['create']>[0])).id as unknown as EntityId;
  const raw = await createTask({ title: 'Complete fixture', createdBy: owner, status: TaskStatus.IN_PROGRESS });
  task = await api.create<Task>(raw as unknown as Parameters<QuarryAPI['create']>[0]);
  task = await api.update<Task>(task.id, { assignee: owner, metadata: { orchestrator: {
    branch: 'main', worktree: repo, assignedAgent: owner, sessionId: 'internal',
    sessionHistory: [{ sessionId: 'internal', agentId: owner, agentName: 'fixture', agentRole: 'worker', startedAt: task.createdAt }],
  } } });
});
afterEach(() => {
  storage.close(); rmSync(root, { recursive: true, force: true });
});
async function branch(name: string, create = true) {
  if (create) git(repo, 'branch', '--', name);
  task = await api.update<Task>(task.id, { metadata: { ...task.metadata, orchestrator: { ...getOrchestratorTaskMeta(task.metadata), branch: name } } });
}
async function complete() {
  const result = await createTaskAssignmentService(api).completeTask(task.id, { agentId: task.assignee, sessionId: 'internal', createMergeRequest: false, summary: 'Done' });
  expect(result.task.status).toBe(TaskStatus.REVIEW);
  expect(result.task.assignee).toBeUndefined();
  expect(getOrchestratorTaskMeta(result.task.metadata)?.sessionHistory?.[0].endedAt).toBeDefined();
  expect(getOrchestratorTaskMeta(result.task.metadata)?.completionSummary).toBe('Done');
}
function rejectPush() {
  writeFileSync(path.join(remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
}
for (const name of ['topic/ordinary', 'topic/$(touch${IFS}marker)', 'topic/`touch${IFS}marker`', 'topic/semi;colon&quote\'"$HOME']) {
  test(`pushes literal ref ${name}`, async () => {
    await branch(name);
    await complete();
    expect(ref(remote, name)).toBe(ref(repo, name));
    expect(existsSync(path.join(repo, 'marker'))).toBe(false);
    // A finalized operation can be replayed without a second push (same receipt).
    const completed = (await api.get<Task>(task.id))!;
    const operationId = getOrchestratorTaskMeta(completed.metadata)!.completionOperation!.operationId;
    git(repo, 'remote', 'set-url', '--push', 'origin', path.join(root, 'must-not-push.git'));
    const replay = await createTaskAssignmentService(api).completeTask(task.id, { agentId: task.assignee, sessionId: 'internal', operationId });
    expect(replay.task).toEqual(completed);
    expect(existsSync(path.join(repo, 'marker'))).toBe(false);
  });
}
for (const name of ['--all', '-f', 'bad..name', 'main:other', 'main^{commit}', '@{-1}', 'bad name', 'bad\nname', 'main;touch marker']) {
  test(`rejects invalid/option input and preserves task: ${JSON.stringify(name)}`, async () => {
    await branch(name, false);
    await expect(createTaskAssignmentService(api).completeTask(task.id, { agentId: task.assignee, sessionId: 'internal' })).rejects.toThrow();
    expect(await api.get(task.id)).toEqual(task);
    expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
    expect(existsSync(path.join(repo, 'marker'))).toBe(false);
  });
}
test('missing local branch rejects without completing', async () => {
  await branch('missing', false);
  await expect(createTaskAssignmentService(api).completeTask(task.id, { agentId: task.assignee, sessionId: 'internal' })).rejects.toThrow();
  expect(await api.get(task.id)).toEqual(task);
});
test('pushes commits ahead of remote even with an ambiguous tag', async () => {
  git(repo, 'tag', 'main'); git(repo, 'commit', '--allow-empty', '-qm', 'ahead');
  await complete(); expect(ref(remote, 'main')).toBe(ref(repo, 'main'));
});
test('rejected push preserves lifecycle and history, retaining operation failure audit', async () => {
  git(repo, 'commit', '--allow-empty', '-qm', 'ahead'); rejectPush();
  const before = ref(remote, 'main');
  await expect(createTaskAssignmentService(api).completeTask(task.id, { agentId: task.assignee, sessionId: 'internal' })).rejects.toThrow('push to origin failed');
  await expectFailedPush(); expect(ref(remote, 'main')).toBe(before);
});
test('unreachable origin rejects despite cached tracking ref, retaining audit', async () => {
  git(repo, 'fetch', 'origin'); git(repo, 'remote', 'set-url', 'origin', path.join(root, 'missing.git'));
  await expect(createTaskAssignmentService(api).completeTask(task.id, { agentId: task.assignee, sessionId: 'internal' })).rejects.toThrow('push to origin failed');
  await expectFailedPush();
});
test('unreachable origin requiring push rejects and retains failure audit', async () => {
  git(repo, 'remote', 'set-url', 'origin', path.join(root, 'missing.git'));
  await expect(createTaskAssignmentService(api).completeTask(task.id, { agentId: task.assignee, sessionId: 'internal' })).rejects.toThrow('push to origin failed');
  await expectFailedPush();
});
async function expectFailedPush() {
  const saved = (await api.get<Task>(task.id))!;
  expect(saved.status).toBe(task.status);
  expect(saved.assignee).toBe(task.assignee);
  const meta = getOrchestratorTaskMeta(saved.metadata)!;
  expect(meta.sessionHistory).toEqual(getOrchestratorTaskMeta(task.metadata)!.sessionHistory);
  expect(meta.completionOperation?.phase).toBe('push_failed');
  expect(meta.mergeStatus).toBeUndefined();
  expect(meta.completionOperation?.error).toContain('git push');
}
test('no origin keeps local completion semantics', async () => {
  git(repo, 'remote', 'remove', 'origin'); await complete();
});

test('push uses claimed OID even if local branch moves before the push', async () => {
  await branch('topic/pinned');
  const oid = ref(repo, 'topic/pinned');
  const update = api.update.bind(api);
  api.update = async (...args) => {
    const result = await update(...args);
    if (getOrchestratorTaskMeta((result as Task).metadata)?.completionOperation?.phase === 'claimed') {
      git(repo, 'commit', '--allow-empty', '-qm', 'new local work');
      git(repo, 'branch', '-f', 'topic/pinned', 'HEAD');
    }
    return result;
  };
  await complete();
  expect(ref(remote, 'topic/pinned')).toBe(oid);
  expect(ref(repo, 'topic/pinned')).not.toBe(oid);
});

test('losing claim performs no remote push', async () => {
  await branch('topic/loser');
  const get = api.get.bind(api);
  let injected = false;
  let winner: Task | undefined;
  api.get = async (...args) => {
    const result = await get(...args);
    if (args[0] === task.id && !injected) {
      injected = true;
      winner = await api.update<Task>(task.id, { status: TaskStatus.DEFERRED });
    }
    return result;
  };
  await expect(createTaskAssignmentService(api).completeTask(task.id, { agentId: task.assignee, sessionId: 'internal' })).rejects.toThrow();
  expect(await api.get(task.id)).toEqual(winner!);
  expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
});

test('push failure explicit recovery retries only the pinned OID', async () => {
  git(repo, 'commit', '--allow-empty', '-qm', 'claimed');
  const oid = ref(repo, 'main'); rejectPush();
  const service = createTaskAssignmentService(api);
  await expect(service.completeTask(task.id, { agentId: task.assignee, sessionId: 'internal' })).rejects.toThrow('push to origin failed');
  const failed = (await api.get<Task>(task.id))!;
  await expect(service.completeTask(task.id, { agentId: task.assignee, sessionId: 'internal' })).rejects.toThrow('reconcile');
  expect(await api.get(task.id)).toEqual(failed);
  rmSync(path.join(remote, 'hooks/pre-receive'));
  git(repo, 'commit', '--allow-empty', '-qm', 'later');
  const recovered = await createTaskAssignmentService(api).reconcileCompletion(task.id, {
    operationId: getOrchestratorTaskMeta(failed.metadata)!.completionOperation!.operationId,
    operatorId: task.assignee!, reason: 'Removed fixture reject hook; retry same OID',
  });
  expect(recovered.task.status).toBe(TaskStatus.REVIEW);
  expect(ref(remote, 'main')).toBe(oid);
  expect(ref(repo, 'main')).not.toBe(oid);
});

test('owner change after successful push preserves successor and forbids MR/final write', async () => {
  await branch('topic/network-limit');
  let calls = 0;
  const provider = { name: 'fixture', async createMergeRequest() { ++calls; return { provider: 'fixture' }; } };
  const update = api.update.bind(api);
  let winner: Task | undefined;
  api.update = async (...args) => {
    if (getOrchestratorTaskMeta((args[1] as Partial<Task>).metadata)?.completionOperation?.phase === 'pushed') {
      winner = await update<Task>(task.id, { assignee: 'human:successor' as EntityId });
    }
    return update(...args);
  };
  await expect(createTaskAssignmentService(api, provider).completeTask(task.id, { agentId: task.assignee, sessionId: 'internal' })).rejects.toThrow();
  expect(ref(remote, 'topic/network-limit')).toBe(ref(repo, 'topic/network-limit'));
  expect(await api.get(task.id)).toEqual(winner!);
  expect(calls).toBe(0);
  expect(getOrchestratorTaskMeta(winner!.metadata)!.sessionHistory![0].endedAt).toBeUndefined();
});
