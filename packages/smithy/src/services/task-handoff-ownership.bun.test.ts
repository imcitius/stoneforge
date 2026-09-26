/** Real SQLite/API and CLI regressions; never use a live project or provider. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createQuarryAPI, type QuarryAPI } from '@stoneforge/quarry';
import { createTask, createDocument, createEntity, EntityTypeValue, TaskStatus, type Task, type Document, type EntityId, type Timestamp } from '@stoneforge/core';
import { createTaskAssignmentService } from './task-assignment-service.js';
import { createAgentRegistry } from './agent-registry.js';
import { getOrchestratorTaskMeta } from '../types/task-meta.js';

let root: string, storage: StorageBackend, otherStorage: StorageBackend;
let api: QuarryAPI, other: QuarryAPI, task: Task, owner: EntityId, successor: EntityId;
const cliSource = path.resolve(import.meta.dir, '../bin/sf.ts');
const future = '2099-01-01T00:00:00.000Z' as Timestamp;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'sf-handoff-'));
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
  const raw = await createTask({ title: 'Handoff fixture', createdBy: creator, descriptionRef: savedDoc.id as Task['descriptionRef'] });
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

async function assertUnchanged(snapshot: Task, description: Document, events: unknown[]) {
  expect(await api.get(task.id)).toEqual(snapshot);
  expect(await api.get(task.descriptionRef!)).toEqual(description);
  expect(storage.query('SELECT * FROM events ORDER BY id')).toEqual(events);
  const ready = await api.ready({ includeEphemeral: true });
  expect(ready.filter(t => t.id === task.id && !t.assignee)).toEqual([]);
  if (snapshot.status !== TaskStatus.IN_PROGRESS) expect(ready.some(t => t.id === task.id)).toBe(false);
  // This is the daemon's ready/unassigned worker-dispatch input, not a mock queue.
  expect((await createTaskAssignmentService(api).getUnassignedTasks({ taskStatus: TaskStatus.OPEN })).some(t => t.id === task.id)).toBe(false);
}

for (const kind of ['closed', 'deferred', 'review', 'backlog', 'tombstone', 'reassign', 'human']) {
  test(`late handoff after ${kind} preserves all fields, evidence and dispatch eligibility`, async () => {
    const snapshot = await change(kind);
    const description = (await api.get<Document>(task.descriptionRef!))!;
    const events = storage.query('SELECT * FROM events ORDER BY id');
    await expect(createTaskAssignmentService(api).handoffTask(task.id, {
      sessionId: 'internal-old', agentId: owner, message: 'Stale handoff', branch: 'stale-branch', worktree: 'stale-worktree',
    })).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
    await assertUnchanged(snapshot, description, events);
  });
}

for (const kind of ['closed', 'deferred', 'reassign', 'human']) {
  for (const readNumber of [1, 2]) {
    test(`${kind} wins race at handoff read ${readNumber} (service / API SQL CAS)`, async () => {
      const get = api.get.bind(api);
      let reads = 0;
      let snapshot: Task;
      let events: unknown[];
      const description = (await get<Document>(task.descriptionRef!))!;
      // The second SQLite connection commits after a real read, before the
      // stale snapshot is returned. Read 2 is inside API.update, after which
      // a pre-transaction timestamp check alone cannot detect the race.
      api.get = async (...args) => {
        const result = await get(...args);
        if (args[0] === task.id && ++reads === readNumber) {
          snapshot = await change(kind);
          events = storage.query('SELECT * FROM events ORDER BY id');
        }
        return result;
      };
      await expect(createTaskAssignmentService(api).handoffTask(task.id, {
        sessionId: 'internal-old', message: 'Must not append this note',
      })).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
      api.get = get;
      await assertUnchanged(snapshot!, description, events!);
    });
  }
}

for (const sessionId of ['internal-old', 'provider-old']) {
  test(`current owner can hand off with ${sessionId}, preserving and appending history`, async () => {
    const result = await createTaskAssignmentService(api).handoffTask(task.id, { sessionId, agentId: owner, message: 'Continue here' });
    expect(result.status).toBe(TaskStatus.OPEN);
    expect(result.assignee).toBeUndefined();
    const meta = getOrchestratorTaskMeta(result.metadata)!;
    expect(meta.handoffHistory).toHaveLength(2);
    expect(meta.handoffHistory![0].message).toBe('Retained evidence');
    expect(meta.sessionHistory![0].endedAt).toBeDefined();
    expect(meta.handoffBranch).toBe(getOrchestratorTaskMeta(task.metadata)!.branch);
    expect((await api.get<Document>(task.descriptionRef!))!.content).toContain('Continue here');
    expect((await api.ready()).some(t => t.id === task.id)).toBe(true);
  });
}

test('old internal and ambiguous resumed provider IDs cannot release a new session of the same owner', async () => {
  const meta = getOrchestratorTaskMeta(task.metadata)!;
  task = await api.update<Task>(task.id, { metadata: { ...task.metadata, orchestrator: { ...meta,
    sessionHistory: [...meta.sessionHistory!, { ...meta.sessionHistory![0], sessionId: 'internal-resumed' }],
  } } });
  for (const sessionId of ['internal-old', 'provider-old', 'cli-123', '']) {
    await expect(createTaskAssignmentService(api).handoffTask(task.id, { sessionId })).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
    expect(await api.get(task.id)).toEqual(task);
  }
  const result = await createTaskAssignmentService(api).handoffTask(task.id, { sessionId: 'internal-resumed' });
  expect(getOrchestratorTaskMeta(result.metadata)!.sessionHistory![1].endedAt).toBeDefined();
});

test('mismatching caller and ended sessions are rejected', async () => {
  await expect(createTaskAssignmentService(api).handoffTask(task.id, { sessionId: 'internal-old', agentId: successor })).rejects.toThrow();
  const meta = getOrchestratorTaskMeta(task.metadata)!;
  await api.update<Task>(task.id, { metadata: { ...task.metadata, orchestrator: { ...meta,
    sessionHistory: [{ ...meta.sessionHistory![0], endedAt: task.updatedAt }],
  } } });
  await expect(createTaskAssignmentService(api).handoffTask(task.id, { sessionId: 'internal-old' })).rejects.toThrow();
});

function cli(args: string[], sessionId?: string) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(STONEFORGE_|SF_|ORCHESTRATOR_URL$|ELECTRON_RUN_AS_NODE$)/.test(key)) delete env[key];
  env.STONEFORGE_ROOT = root;
  env.SF_ENTITY_ID = owner;
  if (sessionId !== undefined) env.STONEFORGE_SESSION_ID = sessionId;
  return spawnSync(process.execPath, [cliSource, ...args], { cwd: root, env, encoding: 'utf8' });
}

for (const kind of ['closed', 'deferred', 'reassign', 'human']) {
  test(`real CLI rejects stale ${kind} handoff`, async () => {
    const snapshot = await change(kind);
    const description = (await api.get<Document>(task.descriptionRef!))!;
    const events = storage.query('SELECT * FROM events ORDER BY id');
    const result = cli(['task', 'handoff', task.id, '--message', 'Stale CLI'], 'internal-old');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Cannot hand off');
    await assertUnchanged(snapshot, description, events);
  });
}

test('CLI requires caller session; valid environment session hands off', async () => {
  const missing = cli(['task', 'handoff', task.id]);
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain('requires --sessionId');
  expect(await api.get(task.id)).toEqual(task);
  const valid = cli(['task', 'handoff', task.id, '--message', 'CLI context'], 'internal-old');
  expect(valid.status).toBe(0);
  expect((await api.get<Task>(task.id))!.status).toBe(TaskStatus.OPEN);
});

test('legitimate explicit CLI reopen clears terminal fields and preserves handoff evidence', async () => {
  await change('closed');
  // A scheduled task remains scheduled after reopen; this explicit action only clears closure.
  const result = cli(['task', 'reopen', task.id]);
  expect(result.status).toBe(0);
  const reopened = (await api.get<Task>(task.id))!;
  expect(reopened.status).toBe(TaskStatus.OPEN);
  expect(reopened.closedAt).toBeUndefined();
  expect(reopened.closeReason).toBeUndefined();
  expect(reopened.assignee).toBeUndefined();
  expect(reopened.scheduledFor).toBe(future);
  expect(getOrchestratorTaskMeta(reopened.metadata)!.handoffHistory![0].message).toBe('Retained evidence');
});

test('CLI accepts explicit current session ID for a legacy caller without environment ID', async () => {
  const result = cli(['task', 'handoff', task.id, '--sessionId', 'internal-old']);
  expect(result.status).toBe(0);
  expect((await api.get<Task>(task.id))!.status).toBe(TaskStatus.OPEN);
});
