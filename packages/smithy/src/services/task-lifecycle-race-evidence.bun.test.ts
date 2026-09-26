/**
 * el-191a6 research characterization, NOT desired lifecycle policy.
 * Passing defect cases prove the documented unsafe result on the audited revision.
 * Convert those assertions to rejection/preservation regressions with each approved fix.
 * Real isolated SQLite connections; deterministic boundaries, no timers or providers.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createQuarryAPI, type QuarryAPI } from '@stoneforge/quarry';
import { createTask, createDocument, createEntity, EntityTypeValue, TaskStatus, type Task, type Document, type EntityId, type Timestamp } from '@stoneforge/core';
import { createTaskAssignmentService } from './task-assignment-service.js';
import { createDispatchService } from './dispatch-service.js';
import { createAgentRegistry } from './agent-registry.js';
import { getOrchestratorTaskMeta } from '../types/task-meta.js';

let root: string, storage: StorageBackend, otherStorage: StorageBackend;
let api: QuarryAPI, other: QuarryAPI, task: Task, owner: EntityId, successor: EntityId;
const cliSource = path.resolve(import.meta.dir, '../bin/sf.ts');
const future = '2099-01-01T00:00:00.000Z' as Timestamp;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'sf-lifecycle-evidence-'));
  mkdirSync(path.join(root, '.stoneforge'));
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
    ...getOrchestratorTaskMeta(task.metadata),
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
      sessionHistory: [...getOrchestratorTaskMeta(current.metadata)!.sessionHistory!, {
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

type Operation = 'assign' | 'start' | 'complete' | 'unassign';
async function run(operation: Operation) {
  const service = createTaskAssignmentService(api);
  switch (operation) {
    case 'assign': return service.assignToAgent(task.id, owner, { markAsStarted: true, sessionId: 'stale-session' });
    case 'start': return service.startTask(task.id, 'stale-session');
    case 'complete': return (await service.completeTask(task.id, { createMergeRequest: false })).task;
    case 'unassign': return service.unassignTask(task.id);
  }
}

for (const operation of ['assign', 'start', 'complete', 'unassign'] as const) {
  for (const kind of ['closed', 'deferred', 'reassign', 'human']) {
    for (const readNumber of [1, 2]) {
      test(`DEFECT evidence: ${operation} overwrites ${kind} at read ${readNumber}`, async () => {
        const get = api.get.bind(api);
        let reads = 0;
        let winner: Task | undefined;
        api.get = async (...args) => {
          const result = await get(...args);
          if (args[0] === task.id && ++reads === readNumber) winner = await change(kind);
          return result;
        };
        const result = await run(operation);
        api.get = get;
        expect(winner).toBeDefined();
        expect(await api.get(task.id)).toEqual(result);
        expect(result).not.toEqual(winner!);
        expect(result.status).toBe(operation === 'complete' ? TaskStatus.REVIEW : operation === 'unassign' && readNumber === 1 ? winner!.status : TaskStatus.IN_PROGRESS);
        expect(result.assignee).toBe(operation === 'complete' || operation === 'unassign' ? undefined : operation === 'assign' || readNumber === 2 ? owner : winner!.assignee);
        const meta = getOrchestratorTaskMeta(result.metadata)!;
        expect(meta.assignedAgent).toBe(operation === 'unassign' ? undefined : owner);
        expect(meta.sessionId).toBe(operation === 'unassign' ? undefined : operation === 'complete' ? 'provider-old' : 'stale-session');
        if (kind === 'closed' || kind === 'deferred') {
          expect(result.scheduledFor).toBe(readNumber === 1 ? future : undefined);
          expect(result.deadline).toBe(readNumber === 1 ? future : undefined);
        }
        if (kind === 'closed') expect(result.closedAt).toBe(readNumber === 1 ? winner!.closedAt : undefined);
        if (kind === 'reassign' && operation !== 'assign') {
          expect(meta.sessionHistory?.some(s => s.sessionId === 'internal-new')).toBe(false);
        }
      });
    }
  }
}

for (const operation of ['assign', 'unassign'] as const) {
  test(`DEFECT evidence: ${operation} exposes split ownership and leaves partial state on second-write failure`, async () => {
    const update = api.update.bind(api);
    let writes = 0;
    let intermediate: Task | undefined;
    api.update = async (...args) => {
      if (args[0] === task.id && ++writes === 2) {
        intermediate = (await other.get<Task>(task.id))!;
        throw new Error('fixture: second write failed');
      }
      return update(...args);
    };
    const service = createTaskAssignmentService(api);
    await expect(operation === 'assign'
      ? service.assignToAgent(task.id, successor, { sessionId: 'provider-new' })
      : service.unassignTask(task.id)).rejects.toThrow('fixture: second write failed');
    expect(intermediate!.assignee).toBe(operation === 'assign' ? successor : undefined);
    expect(getOrchestratorTaskMeta(intermediate!.metadata)!.assignedAgent).toBe(owner);
    expect(await other.get(task.id)).toEqual(intermediate!);
    expect((await other.ready()).filter(t => t.id === task.id && !t.assignee)).toHaveLength(operation === 'unassign' ? 1 : 0);
  });

  test(`DEFECT evidence: ${operation} races a full reassignment between its writes`, async () => {
    const update = api.update.bind(api);
    let writes = 0;
    api.update = async (...args) => {
      const result = await update(...args);
      if (args[0] === task.id && ++writes === 1) await change('reassign');
      return result;
    };
    const result = await run(operation);
    expect(result.assignee).toBe(successor);
    expect(getOrchestratorTaskMeta(result.metadata)!.assignedAgent).toBe(operation === 'assign' ? owner : undefined);
    expect(getOrchestratorTaskMeta(result.metadata)!.sessionId).toBe(operation === 'assign' ? 'stale-session' : undefined);
  });
}

test('CONTROL: explicit sequential reassignment is supported and yields consistent ownership', async () => {
  const result = await createTaskAssignmentService(api).assignToAgent(task.id, successor, { sessionId: 'provider-new', markAsStarted: true });
  expect(result.assignee).toBe(successor);
  expect(result.status).toBe(TaskStatus.IN_PROGRESS);
  expect(getOrchestratorTaskMeta(result.metadata)!.assignedAgent).toBe(successor);
  expect(getOrchestratorTaskMeta(result.metadata)!.sessionId).toBe('provider-new');
});

for (const status of [TaskStatus.CLOSED, TaskStatus.REVIEW]) {
  test(`CONTROL: complete rejects already ${status} without writes`, async () => {
    const snapshot = await change(status);
    const events = storage.query('SELECT * FROM events ORDER BY id');
    await expect(run('complete')).rejects.toThrow('already');
    expect(await api.get(task.id)).toEqual(snapshot);
    expect(storage.query('SELECT * FROM events ORDER BY id')).toEqual(events);
  });
}

test('CONTROL: current worker completion enters review, clears owner and ends session', async () => {
  await api.update<Task>(task.id, { metadata: { ...task.metadata, orchestrator: { ...getOrchestratorTaskMeta(task.metadata), sessionId: 'internal-old' } } });
  const result = await run('complete');
  expect(result.status).toBe(TaskStatus.REVIEW);
  expect(result.assignee).toBeUndefined();
  expect(getOrchestratorTaskMeta(result.metadata)!.sessionHistory![0].endedAt).toBeDefined();
  expect((await api.ready()).some(t => t.id === task.id)).toBe(false);
});

for (const kind of ['closed', 'deferred', 'human', 'reassign']) {
  test(`DEFECT evidence: stale automatic-dispatch candidate wins over ${kind} and sends notification`, async () => {
    await createTaskAssignmentService(api).unassignTask(task.id);
    expect((await api.ready()).filter(t => t.id === task.id && !t.assignee)).toHaveLength(1);
    const get = api.get.bind(api);
    let injected = false;
    api.get = async (...args) => {
      const result = await get(...args);
      if (args[0] === task.id && !injected) {
        injected = true;
        await change(kind);
      }
      return result;
    };
    const dispatch = createDispatchService(api, createTaskAssignmentService(api), createAgentRegistry(api));
    const result = await dispatch.dispatch(task.id, owner, { markAsStarted: true, sessionId: 'late-dispatch' });
    expect(result.task.status).toBe(TaskStatus.IN_PROGRESS);
    expect(result.task.assignee).toBe(owner);
    expect(result.isNewAssignment).toBe(true);
    expect(await other.get(result.notification.id)).toBeDefined();
    expect(getOrchestratorTaskMeta(result.task.metadata)!.sessionId).toBe('late-dispatch');
  });
}

for (const kind of ['deferred', 'human', 'reassign']) {
  test(`DEFECT evidence: actual stale-session CLI complete accepts ${kind}`, async () => {
    await change(kind);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(STONEFORGE_|SF_|ORCHESTRATOR_URL$|ELECTRON_RUN_AS_NODE$)/.test(key)) delete env[key];
    env.STONEFORGE_ROOT = root;
    env.SF_ENTITY_ID = owner;
    env.STONEFORGE_SESSION_ID = 'internal-old';
    const result = spawnSync(process.execPath, [cliSource, 'task', 'complete', task.id, '--no-mr'], { cwd: root, env, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const saved = (await other.get<Task>(task.id))!;
    expect(saved.status).toBe(TaskStatus.REVIEW);
    expect(saved.assignee).toBeUndefined();
    if (kind === 'reassign') {
      expect(getOrchestratorTaskMeta(saved.metadata)!.sessionHistory![1].endedAt).toBeUndefined();
    }
  });
}

test('DEFECT evidence: provider session ID completion leaves the current internal history entry open', async () => {
  const result = await run('complete');
  expect(result.status).toBe(TaskStatus.REVIEW);
  expect(getOrchestratorTaskMeta(result.metadata)!.sessionHistory![0].endedAt).toBeUndefined();
});

for (const readNumber of [1, 2]) {
  test(`CONTROL: delivered CAS preserves winner at read ${readNumber}`, async () => {
    const get = api.get.bind(api);
    let reads = 0;
    let winner: Task | undefined;
    let events: unknown[] = [];
    api.get = async (...args) => {
      const result = await get(...args);
      if (args[0] === task.id && ++reads === readNumber) {
        winner = await change('closed');
        events = storage.query('SELECT * FROM events ORDER BY id');
      }
      return result;
    };
    const snapshot = (await api.get<Task>(task.id))!;
    await expect(api.update<Task>(task.id, { status: TaskStatus.IN_PROGRESS }, { expectedUpdatedAt: snapshot.updatedAt }))
      .rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
    expect(await other.get(task.id)).toEqual(winner!);
    expect(storage.query('SELECT * FROM events ORDER BY id')).toEqual(events);
    expect((await other.ready()).filter(t => t.id === task.id && !t.assignee)).toHaveLength(0);
  });
}
