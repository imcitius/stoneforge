import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createQuarryAPI, type QuarryAPI } from '@stoneforge/quarry';
import { createTask, createDocument, createEntity, EntityTypeValue, TaskStatus, type Task, type Document, type EntityId, type Timestamp } from '@stoneforge/core';
import { createTaskAssignmentService } from './task-assignment-service.js';
import { createWorkerTaskService } from './worker-task-service.js';
import { createTaskRoutes as sdkRoutes } from '../server/routes/tasks.js';
import { createTaskRoutes as appRoutes } from '../../../../apps/smithy-server/src/routes/tasks.js';
import type { MergeRequestProvider, MergeRequestEvidence } from './merge-request-provider.js';
import { createAgentRegistry } from './agent-registry.js';
import { getOrchestratorTaskMeta } from '../types/task-meta.js';

let repo: string, root: string, storage: StorageBackend, otherStorage: StorageBackend;
let api: QuarryAPI, other: QuarryAPI, task: Task, owner: EntityId, successor: EntityId;
const cliSource = path.resolve(import.meta.dir, '../bin/sf.ts');
const future = '2099-01-01T00:00:00.000Z' as Timestamp;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'sf-lifecycle-evidence-'));
  mkdirSync(path.join(root, '.stoneforge'));
  repo = path.join(root, 'repo'); mkdirSync(repo);
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false'); git('commit', '--allow-empty', '-qm', 'initial');
  const db = path.join(root, '.stoneforge/stoneforge.db');
  storage = createStorage({ path: db }); initializeSchema(storage);
  otherStorage = createStorage({ path: db });
  api = createQuarryAPI(storage); other = createQuarryAPI(otherStorage);
  const registry = createAgentRegistry(api);
  const system = await createEntity({ name: 'test-system', entityType: EntityTypeValue.SYSTEM, createdBy: 'system:test' as EntityId });
  const creator = (await api.create(system as unknown as Parameters<QuarryAPI['create']>[0])).id as unknown as EntityId;
  owner = (await registry.registerWorker({ name: 'owner', workerMode: 'ephemeral', createdBy: creator })).id as unknown as EntityId;
  successor = (await registry.registerWorker({ name: 'successor', workerMode: 'ephemeral', createdBy: creator })).id as unknown as EntityId;
  const doc = await createDocument({ content: 'Original evidence', createdBy: creator, contentType: 'markdown' });
  const savedDoc = await api.create<Document>(doc as unknown as Parameters<QuarryAPI['create']>[0]);
  const raw = await createTask({ title: 'Lifecycle evidence fixture', createdBy: creator, descriptionRef: savedDoc.id as Task['descriptionRef'] });
  task = await api.create<Task>(raw as unknown as Parameters<QuarryAPI['create']>[0]);
  task = await createTaskAssignmentService(api).assignToAgent(task.id, owner, { markAsStarted: true, sessionId: 'provider-old' });
  task = await api.update<Task>(task.id, { metadata: { ...task.metadata, orchestrator: {
    ...getOrchestratorTaskMeta(task.metadata), branch: 'main', worktree: repo,
    handoffHistory: [{ sessionId: 'older-session', message: 'Retained evidence', handoffAt: task.createdAt }],
    sessionHistory: [{ sessionId: 'internal-old', providerSessionId: 'provider-old', agentId: owner, agentName: 'owner', agentRole: 'worker', startedAt: task.createdAt }],
  } } });
});
afterEach(() => { storage.close(); otherStorage.close(); rmSync(root, { recursive: true, force: true }); });

async function change(kind: string) {
  const current = (await other.get<Task>(task.id))!;
  if (kind === 'reassign') {
    return other.update<Task>(task.id, { assignee: successor, metadata: { ...current.metadata, orchestrator: {
      ...getOrchestratorTaskMeta(current.metadata), assignedAgent: successor, sessionId: 'provider-new',
      sessionHistory: [...(getOrchestratorTaskMeta(current.metadata)!.sessionHistory ?? []), {
        sessionId: 'internal-new', providerSessionId: 'provider-new', agentId: successor, agentName: 'successor', agentRole: 'worker', startedAt: current.updatedAt,
      }],
    } } });
  }
  if (kind === 'human') return other.update<Task>(task.id, { assignee: 'human:owner' as EntityId });
  return other.update<Task>(task.id, {
    status: kind as Task['status'], scheduledFor: future, deadline: future,
    ...(kind === TaskStatus.CLOSED ? { closedAt: current.updatedAt, closeReason: 'Human completed maintenance' } : {}),
  });
}


const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const caller = () => ({ agentId: owner, sessionId: 'internal-old', createMergeRequest: false });
const meta = (t: Task) => getOrchestratorTaskMeta(t.metadata)!;
const saved = async () => (await other.get<Task>(task.id))!;
const events = () => storage.query('SELECT * FROM events ORDER BY id');
async function preserves(action: () => Promise<unknown>) {
  const snapshot = await saved(), description = await other.get(task.descriptionRef!), log = events();
  await expect(action()).rejects.toThrow();
  expect(await saved()).toEqual(snapshot);
  expect(await other.get(task.descriptionRef!)).toEqual(description);
  expect(events()).toEqual(log);
}
async function updateMeta(patch: Record<string, unknown>) {
  task = await api.update<Task>(task.id, { metadata: { ...task.metadata, orchestrator: { ...meta(task), ...patch } } });
}
function cli(args: string[], identity = true) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(STONEFORGE_|SF_|ORCHESTRATOR_URL$|ELECTRON_RUN_AS_NODE$)/.test(key)) delete env[key];
  env.STONEFORGE_ROOT = root;
  if (identity) { env.SF_ENTITY_ID = owner; env.STONEFORGE_SESSION_ID = 'internal-old'; }
  return spawnSync(process.execPath, [cliSource, ...args], { cwd: root, env, encoding: 'utf8' });
}

for (const defect of ['missing-agent', 'missing-session', 'wrong-agent', 'provider-caller', 'old-resume', 'duplicate-internal', 'missing-history', 'ended-current', 'mismatched-metadata']) {
  test(`identity rejection preserves everything: ${defect}`, async () => {
    let options = caller();
    const entry = meta(task).sessionHistory![0];
    if (defect === 'missing-agent') options.agentId = undefined as never;
    if (defect === 'missing-session') options.sessionId = undefined as never;
    if (defect === 'wrong-agent') options.agentId = successor;
    if (defect === 'provider-caller') options.sessionId = 'provider-old';
    if (defect === 'old-resume') await updateMeta({ sessionHistory: [entry, { ...entry, sessionId: 'internal-resumed' }] });
    if (defect === 'duplicate-internal') await updateMeta({ sessionHistory: [entry, entry] });
    if (defect === 'missing-history') await updateMeta({ sessionHistory: [] });
    if (defect === 'ended-current') await updateMeta({ sessionHistory: [{ ...entry, endedAt: task.updatedAt }] });
    if (defect === 'mismatched-metadata') await updateMeta({ sessionId: 'unrelated' });
    await preserves(() => createTaskAssignmentService(api).completeTask(task.id, options));
  });
}
test('current internal resumed ID closes only latest entry despite reused provider ID', async () => {
  const entry = meta(task).sessionHistory![0];
  await updateMeta({ sessionHistory: [entry, { ...entry, sessionId: 'internal-resumed' }] });
  const result = await createTaskAssignmentService(api).completeTask(task.id, { ...caller(), sessionId: 'internal-resumed' });
  expect(meta(result.task).sessionHistory![0]).toEqual(entry);
  expect(meta(result.task).sessionHistory![1].endedAt).toBeDefined();
  expect(meta(result.task).handoffHistory).toEqual(meta(task).handoffHistory);
});

test('CLI current completion and explicit idempotent replay', async () => {
  expect(cli(['task', 'complete', task.id, '--no-mr']).status).toBe(0);
  const completed = await saved(), log = events();
  expect(completed.status).toBe(TaskStatus.REVIEW);
  expect(meta(completed).sessionHistory![0].endedAt).toBeDefined();
  expect(cli(['task', 'complete', task.id, '--no-mr', '--operationId', meta(completed).completionOperation!.operationId]).status).toBe(0);
  expect(await saved()).toEqual(completed); expect(events()).toEqual(log);
});
test('CLI never infers identity from owner; admin requires explicit actor instead of SF environment', async () => {
  const snapshot = await saved(), log = events();
  expect(cli(['task', 'complete', task.id, '--no-mr'], false).status).not.toBe(0);
  expect(cli(['task', 'complete', task.id, '--no-mr', '--admin']).status).not.toBe(0);
  expect(await saved()).toEqual(snapshot); expect(events()).toEqual(log);
  expect(cli(['task', 'complete', task.id, '--no-mr', '--admin', '--agentId', successor]).status).toBe(0);
});
test('explicit CLI reopen preserves unknown operation; completion cannot bypass it', async () => {
  const p = provider(); p.fail = true;
  await expect(createTaskAssignmentService(api, p).completeTask(task.id, { ...caller(), createMergeRequest: true })).rejects.toThrow();
  const unknown = meta(await saved()).completionOperation;
  await change('closed');
  expect(cli(['task', 'reopen', task.id]).status).toBe(0);
  expect(meta(await saved()).completionOperation).toEqual(unknown);
  const snapshot = await saved(), log = events();
  expect(cli(['task', 'complete', task.id, '--no-mr']).status).not.toBe(0);
  expect(await saved()).toEqual(snapshot); expect(events()).toEqual(log); expect(p.calls).toBe(1);
});

for (const [label, routes] of [['sdk', sdkRoutes], ['app', appRoutes]] as const) {
  for (const kind of ['closed', 'deferred', 'human', 'reassign', 'current', 'missing-identity', 'resumed-provider', 'admin']) {
    test(`${label} real HTTP completion: ${kind}`, async () => {
      if (['closed', 'deferred', 'human', 'reassign'].includes(kind)) await change(kind);
      const assignment = createTaskAssignmentService(api);
      // Only completion is reachable. Unused spawn/session dependencies are absent;
      // API, worker service, assignment service and HTTP route are production code.
      const worker = createWorkerTaskService(api, assignment, undefined as never, undefined as never, undefined as never, undefined as never);
      const app = routes({ api, workerTaskService: worker, taskAssignmentService: assignment, storageBackend: storage } as never);
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
      const snapshot = await saved(), description = await other.get(task.descriptionRef!), log = events();
      try {
        const body = kind === 'missing-identity' ? {} : kind === 'admin' ? { mode: 'admin', performedBy: successor } :
          { performedBy: owner, sessionId: kind === 'resumed-provider' ? 'provider-old' : 'internal-old' };
        const response = await fetch(`http://127.0.0.1:${server.port}/api/tasks/${task.id}/complete`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        expect(response.status).toBe(kind === 'current' || kind === 'admin' ? 200 : 409);
        if (response.status === 200) {
          expect((await saved()).status).toBe(TaskStatus.REVIEW);
          expect(meta(await saved()).sessionHistory![0].endedAt).toBeDefined();
        } else { expect(await saved()).toEqual(snapshot); expect(events()).toEqual(log); }
        expect(await other.get(task.descriptionRef!)).toEqual(description);
      } finally { await server.stop(true); }
    });
  }
}

function provider() {
  return {
    name: 'fixture', calls: 0, fail: false, evidence: undefined as MergeRequestEvidence | undefined,
    async createMergeRequest(_task: Task, opts: { body: string; sourceBranch: string; targetBranch: string }) {
      ++this.calls;
      this.evidence = { id: 42, url: 'https://fixture.invalid/42', provider: this.name, state: 'open' as const,
        body: opts.body, sourceBranch: opts.sourceBranch, targetBranch: opts.targetBranch, commitOid: git('rev-parse', 'HEAD') };
      if (this.fail) throw new Error('fixture: response lost');
      return { id: 42, url: 'https://fixture.invalid/42', provider: this.name };
    },
    async getMergeRequestEvidence(_id: number) { return this.evidence; },
  } satisfies MergeRequestProvider & Record<string, unknown>;
}
const recovery = (t: Task) => ({ operationId: meta(t).completionOperation!.operationId, operatorId: successor, reason: 'Fixture operator verified operation and provider evidence' });

test('double call before claim has one winner and one MR effect', async () => {
  const p = provider(), service = createTaskAssignmentService(api, p);
  const results = await Promise.allSettled([service.completeTask(task.id, { ...caller(), createMergeRequest: true }), service.completeTask(task.id, { ...caller(), createMergeRequest: true })]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  expect(p.calls).toBe(1);
});

test('lost MR response persists unknown across service restart; explicit matching evidence recovers once', async () => {
  const p = provider(); p.fail = true;
  await expect(createTaskAssignmentService(api, p).completeTask(task.id, { ...caller(), createMergeRequest: true })).rejects.toThrow('response lost');
  const unknown = await saved();
  expect(meta(unknown).completionOperation!.phase).toBe('unknown');
  expect(meta(unknown).sessionHistory).toEqual(meta(task).sessionHistory);
  const restarted = createTaskAssignmentService(other, p);
  await preserves(() => restarted.completeTask(task.id, caller()));
  await preserves(() => restarted.reconcileCompletion(task.id, recovery(unknown)));
  const result = await restarted.reconcileCompletion(task.id, { ...recovery(unknown), mergeRequestId: 42 });
  expect(result.task.status).toBe(TaskStatus.REVIEW); expect(result.mergeRequestId).toBe(42); expect(p.calls).toBe(1);
  expect(meta(result.task).completionOperation!.reconciliations).toHaveLength(1);
  const log = events();
  expect((await restarted.reconcileCompletion(task.id, recovery(result.task))).task).toEqual(result.task);
  expect(events()).toEqual(log); expect(p.calls).toBe(1);
});
for (const field of ['sourceBranch', 'targetBranch', 'commitOid', 'body', 'provider', 'state', 'missing', 'lookup-unavailable']) {
  test(`unknown MR reconciliation rejects insufficient evidence: ${field}`, async () => {
    const p = provider(); p.fail = true;
    const service = createTaskAssignmentService(api, p);
    await expect(service.completeTask(task.id, { ...caller(), createMergeRequest: true })).rejects.toThrow();
    const unknown = await saved();
    if (field === 'missing') p.evidence = undefined;
    else if (field === 'lookup-unavailable') p.getMergeRequestEvidence = undefined as never;
    else (p.evidence as unknown as Record<string, string>)[field] = 'wrong';
    await preserves(() => service.reconcileCompletion(task.id, { ...recovery(unknown), mergeRequestId: 42 }));
    expect(p.calls).toBe(1);
  });
}

for (const boundary of ['claimed', 'push_started', 'pushed', 'mr_started', 'after-mr', 'receipt']) {
  for (const kind of ['closed', 'deferred', 'human', 'reassign']) {
    test(`${kind} at ${boundary} fences subsequent effects/finalization and preserves winner`, async () => {
      const p = provider();
      let winner: Task | undefined, log: unknown[] = [];
      const win = async () => { winner = await change(kind); log = events(); };
      if (boundary === 'after-mr') {
        const create = p.createMergeRequest.bind(p);
        p.createMergeRequest = async (...args) => { const result = await create(...args); await win(); return result; };
      } else {
        const update = api.update.bind(api);
        api.update = async (...args) => {
          const result = await update(...args);
          if (args[0] === task.id && meta(result as Task).completionOperation?.phase === boundary && !winner) await win();
          return result;
        };
      }
      await expect(createTaskAssignmentService(api, p).completeTask(task.id, { ...caller(), createMergeRequest: true })).rejects.toThrow();
      expect(winner).toBeDefined(); expect(await saved()).toEqual(winner!); expect(events()).toEqual(log);
      expect(meta(await saved()).sessionHistory!.every(e => !e.endedAt)).toBe(true);
      expect(p.calls).toBe(boundary === 'after-mr' || boundary === 'receipt' ? 1 : 0);
    });
  }
}

test('durable receipt survives final-write failure and recovery does not create a second MR', async () => {
  const p = provider(), update = api.update.bind(api);
  api.update = async (...args) => {
    if ((args[1] as Partial<Task>).status === TaskStatus.REVIEW) throw new Error('fixture final failure');
    return update(...args);
  };
  await expect(createTaskAssignmentService(api, p).completeTask(task.id, { ...caller(), createMergeRequest: true })).rejects.toThrow('final failure');
  const pending = await saved(); expect(meta(pending).completionOperation!.phase).toBe('receipt');
  api.update = update;
  const result = await createTaskAssignmentService(api, p).reconcileCompletion(task.id, recovery(pending));
  expect(result.task.status).toBe(TaskStatus.REVIEW); expect(p.calls).toBe(1);
});

test('process loss after mr_started is unknown and cannot trigger an automatic create', async () => {
  const p = provider(), update = api.update.bind(api);
  api.update = async (...args) => {
    const result = await update(...args);
    if (meta(result as Task)?.completionOperation?.phase === 'mr_started') throw new Error('fixture process loss');
    return result;
  };
  await expect(createTaskAssignmentService(api, p).completeTask(task.id, { ...caller(), createMergeRequest: true })).rejects.toThrow('process loss');
  api.update = update;
  expect(meta(await saved()).completionOperation!.phase).toBe('mr_started');
  await preserves(() => createTaskAssignmentService(api, p).completeTask(task.id, caller()));
  await preserves(async () => createTaskAssignmentService(api, p).reconcileCompletion(task.id, { ...recovery(await saved()), mergeRequestId: 42 }));
  expect(p.calls).toBe(0);
});

test('explicit reopen plus a fresh internal session permits new completion and archives prior operation', async () => {
  const first = (await createTaskAssignmentService(api).completeTask(task.id, caller())).task;
  const firstOp = meta(first).completionOperation!;
  await change('closed');
  expect(cli(['task', 'reopen', task.id]).status).toBe(0);
  task = await saved();
  task = await api.update<Task>(task.id, { assignee: owner });
  await updateMeta({ assignedAgent: owner, sessionId: 'new-internal', sessionHistory: [...meta(task).sessionHistory!, {
    ...meta(task).sessionHistory![0], sessionId: 'new-internal', endedAt: undefined,
  }] });
  const second = await createTaskAssignmentService(api).completeTask(task.id, { ...caller(), sessionId: 'new-internal' });
  expect(meta(second.task).completionHistory).toEqual([firstOp]);
  expect(meta(second.task).sessionHistory).toHaveLength(2);
  expect(meta(second.task).sessionHistory!.every(e => !!e.endedAt)).toBe(true);
});

test('real reassignment after reopen retains unknown claim and full history, denying a second MR', async () => {
  const p = provider(); p.fail = true;
  const service = createTaskAssignmentService(api, p);
  await expect(service.completeTask(task.id, { ...caller(), createMergeRequest: true })).rejects.toThrow();
  const unknown = await saved();
  await change('closed');
  expect(cli(['task', 'reopen', task.id]).status).toBe(0);
  task = await service.assignToAgent(task.id, successor, { sessionId: 'new-internal', markAsStarted: true, branch: 'main', worktree: repo });
  expect(meta(task).completionOperation).toEqual(meta(unknown).completionOperation);
  expect(meta(task).sessionHistory).toEqual(meta(unknown).sessionHistory);
  await updateMeta({ sessionHistory: [...meta(task).sessionHistory!, { ...meta(task).sessionHistory![0], agentId: successor, sessionId: 'new-internal' }] });
  await preserves(() => service.completeTask(task.id, { agentId: successor, sessionId: 'new-internal' }));
  await preserves(() => service.reconcileCompletion(task.id, { ...recovery(task), mergeRequestId: 42 }));
  expect(p.calls).toBe(1);
});

for (const worktree of ['missing', 'undefined']) {
  test(`branch with ${worktree} worktree rejects before claim even without MR`, async () => {
    await updateMeta({ worktree: worktree === 'missing' ? path.join(root, 'gone') : undefined });
    await preserves(() => createTaskAssignmentService(api).completeTask(task.id, caller()));
  });
}
