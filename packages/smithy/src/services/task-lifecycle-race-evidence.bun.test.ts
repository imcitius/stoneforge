/**
 * el-191a6 research characterization with el-3oeut atomic assignment regressions.
 * Remaining DEFECT evidence is NOT desired lifecycle policy.
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
import { createDispatchService, DispatchAssignmentError } from './dispatch-service.js';
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

function cleanupOptions() {
  return { mode: 'failed-dispatch' as const, expectedAssignment: {
    agentId: owner, sessionId: 'provider-old', updatedAt: task.updatedAt,
  } };
}

type Operation = 'assign' | 'start' | 'complete' | 'unassign';
async function run(operation: Operation) {
  const service = createTaskAssignmentService(api);
  switch (operation) {
    case 'assign': return service.assignToAgent(task.id, owner, { markAsStarted: true, sessionId: 'stale-session' });
    case 'start': return service.startTask(task.id, 'stale-session');
    case 'complete': return (await service.completeTask(task.id, { createMergeRequest: false })).task;
    case 'unassign': return service.unassignTask(task.id, cleanupOptions());
  }
}

for (const operation of ['assign', 'start', 'complete', 'unassign'] as const) {
  for (const kind of ['closed', 'deferred', 'reassign', 'human']) {
    for (const readNumber of [1, 2]) {
      test(operation === 'assign' || operation === 'unassign'
        ? `REGRESSION: ${operation} rejects and preserves ${kind} at read ${readNumber}`
        : `DEFECT evidence: ${operation} overwrites ${kind} at read ${readNumber}`, async () => {
        const get = api.get.bind(api);
        let reads = 0;
        let winner: Task | undefined;
        let events: unknown[] = [];
        api.get = async (...args) => {
          const result = await get(...args);
          if (args[0] === task.id && ++reads === readNumber) {
            winner = await change(kind);
            events = storage.query('SELECT * FROM events ORDER BY id');
          }
          return result;
        };
        if (operation === 'assign' || operation === 'unassign') {
          const update = api.update.bind(api);
          let attempts = 0;
          api.update = async (...args) => {
            if (args[0] === task.id) ++attempts;
            return update(...args);
          };
          await expect(run(operation)).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
          api.get = get;
          expect(attempts).toBe(1);
          expect(winner).toBeDefined();
          // Full equality includes both histories, schedule, closure and version.
          expect(await other.get(task.id)).toEqual(winner!);
          expect(storage.query('SELECT * FROM events ORDER BY id')).toEqual(events);
          expect((await other.ready()).filter(t => t.id === task.id && !t.assignee)).toHaveLength(0);
          return;
        }
        const result = await run(operation);
        api.get = get;
        expect(winner).toBeDefined();
        expect(await api.get(task.id)).toEqual(result);
        expect(result).not.toEqual(winner!);
        expect(result.status).toBe(operation === 'complete' ? TaskStatus.REVIEW : TaskStatus.IN_PROGRESS);
        expect(result.assignee).toBe(operation === 'complete' ? undefined : readNumber === 2 ? owner : winner!.assignee);
        const meta = getOrchestratorTaskMeta(result.metadata)!;
        expect(meta.assignedAgent).toBe(owner);
        expect(meta.sessionId).toBe(operation === 'complete' ? 'provider-old' : 'stale-session');
        if (kind === 'closed' || kind === 'deferred') {
          expect(result.scheduledFor).toBe(readNumber === 1 ? future : undefined);
          expect(result.deadline).toBe(readNumber === 1 ? future : undefined);
        }
        if (kind === 'closed') expect(result.closedAt).toBe(readNumber === 1 ? winner!.closedAt : undefined);
        if (kind === 'reassign') {
          expect(meta.sessionHistory?.some(s => s.sessionId === 'internal-new')).toBe(false);
        }
      });
    }
  }
}

// Former unassign W1/second-write DEFECT evidence: no second write remains.
test('REGRESSION: unassign commits coherent release before W1 and preserves successor/events', async () => {
  const update = api.update.bind(api);
  let writes = 0;
  let winner: Task | undefined;
  let events: unknown[] = [];
  api.update = async (...args) => {
    if (args[0] === task.id && ++writes > 1) throw new Error('fixture: second write failed');
    const result = await update(...args);
    if (args[0] === task.id) {
      expect(await other.get(task.id)).toEqual(result);
      expect(result.assignee).toBeUndefined();
      expect(getOrchestratorTaskMeta(result.metadata)!.assignedAgent).toBeUndefined();
      expect(getOrchestratorTaskMeta(result.metadata)!.sessionId).toBeUndefined();
      winner = await change('reassign');
      events = storage.query('SELECT * FROM events ORDER BY id');
    }
    return result;
  };
  const result = await run('unassign');
  expect(writes).toBe(1);
  expect(result.assignee).toBeUndefined();
  expect(await other.get(task.id)).toEqual(winner!);
  expect(storage.query('SELECT * FROM events ORDER BY id')).toEqual(events);
  expect((await other.ready()).filter(t => t.id === task.id && !t.assignee)).toHaveLength(0);
});

for (const boundary of ['first-write', 'metadata-transaction'] as const) {
  test(`REGRESSION: unassign ${boundary} failure preserves full assignment/events and ready pool`, async () => {
    const events = storage.query('SELECT * FROM events ORDER BY id');
    const update = api.update.bind(api);
    const transaction = storage.transaction.bind(storage);
    let fail = false;
    let injected = false;
    api.update = async (...args) => {
      fail = args[0] === task.id;
      if (fail && boundary === 'first-write') {
        injected = true;
        throw new Error('fixture: release failed');
      }
      try { return await update(...args); }
      finally { fail = false; }
    };
    storage.transaction = (fn, options) => transaction(tx => {
      const result = fn(tx);
      if (fail) {
        injected = true;
        throw new Error('fixture: release failed');
      }
      return result;
    }, options);
    await expect(run('unassign')).rejects.toThrow('fixture: release failed');
    expect(injected).toBe(true);
    expect(await other.get(task.id)).toEqual(task);
    expect(storage.query('SELECT * FROM events ORDER BY id')).toEqual(events);
    expect((await other.ready()).filter(t => t.id === task.id && !t.assignee)).toHaveLength(0);
  });
}

// Converted assignment W1/failure evidence: the old second write is gone.
test('REGRESSION: assign commits coherent ownership before W1 and preserves a subsequent winner', async () => {
  const update = api.update.bind(api);
  let writes = 0;
  let winner: Task | undefined;
  let events: unknown[] = [];
  api.update = async (...args) => {
    if (args[0] === task.id) {
      ++writes;
      if (writes > 1) throw new Error('fixture: second write failed');
    }
    const result = await update(...args);
    if (args[0] === task.id) {
      // Observe the first commit through a separate SQLite connection.
      expect(await other.get(task.id)).toEqual(result);
      expect(result.assignee).toBe(owner);
      const meta = getOrchestratorTaskMeta(result.metadata)!;
      expect(meta.assignedAgent).toBe(owner);
      expect(meta.sessionId).toBe('stale-session');
      winner = await change('reassign');
      events = storage.query('SELECT * FROM events ORDER BY id');
    }
    return result;
  };
  const result = await run('assign');
  expect(writes).toBe(1);
  expect(result.assignee).toBe(owner);
  expect(getOrchestratorTaskMeta(result.metadata)!.sessionId).toBe('stale-session');
  expect(await other.get(task.id)).toEqual(winner!);
  expect(storage.query('SELECT * FROM events ORDER BY id')).toEqual(events);
});

test('REGRESSION: assignment metadata transaction failure leaves no partial owner/status/events', async () => {
  // Start OPEN so rollback must preserve status as well as both ownership fields.
  const snapshot = await other.update<Task>(task.id, { status: TaskStatus.OPEN });
  const events = storage.query('SELECT * FROM events ORDER BY id');
  const update = api.update.bind(api);
  const transaction = storage.transaction.bind(storage);
  let failMetadataWrite = false;
  let injected = false;
  api.update = async (...args) => {
    failMetadataWrite = args[0] === task.id && args[1].metadata !== undefined;
    try { return await update(...args); }
    finally { failMetadataWrite = false; }
  };
  storage.transaction = (fn, options) => transaction(tx => {
    const result = fn(tx);
    if (failMetadataWrite) {
      injected = true;
      // Fail after the real SQL mutations, before COMMIT. No direct fixture writes.
      throw new Error('fixture: metadata transaction failed');
    }
    return result;
  }, options);
  await expect(createTaskAssignmentService(api).assignToAgent(task.id, successor, {
    sessionId: 'provider-new', markAsStarted: true,
  })).rejects.toThrow('fixture: metadata transaction failed');
  expect(injected).toBe(true);
  expect(await other.get(task.id)).toEqual(snapshot);
  expect(storage.query('SELECT * FROM events ORDER BY id')).toEqual(events);
});

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
  test(`REGRESSION: stale automatic-dispatch candidate rejects ${kind} without notification`, async () => {
    await createTaskAssignmentService(api).unassignTask(task.id, { mode: 'admin' });
    const candidates = (await api.ready()).filter(t => t.id === task.id && !t.assignee);
    expect(candidates).toHaveLength(1);
    const get = api.get.bind(api);
    let winner: Task | undefined;
    let events: unknown[] = [];
    api.get = async (...args) => {
      const result = await get(...args);
      if (args[0] === task.id && !winner) {
        winner = await change(kind);
        events = storage.query('SELECT * FROM events WHERE element_id = ? ORDER BY id', [task.id]);
      }
      return result;
    };
    const messages = await other.list({ type: 'message' });
    const dispatch = createDispatchService(api, createTaskAssignmentService(api), createAgentRegistry(api));
    await expect(dispatch.dispatch(task.id, owner, {
      claim: { expectedUpdatedAt: candidates[0].updatedAt },
      markAsStarted: true, sessionId: 'late-dispatch',
    })).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
    expect(winner).toBeDefined();
    expect(await other.get(task.id)).toEqual(winner!);
    expect(await other.list({ type: 'message' })).toEqual(messages);
    expect(storage.query('SELECT * FROM events WHERE element_id = ? ORDER BY id', [task.id])).toEqual(events);
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


test('CONTROL: own cleanup preserves branch/status/histories and atomically releases assignment', async () => {
  const result = await run('unassign');
  expect(result.assignee).toBeUndefined();
  expect(result.status).toBe(task.status);
  const before = getOrchestratorTaskMeta(task.metadata)!;
  const after = getOrchestratorTaskMeta(result.metadata)!;
  expect(after).toEqual({ ...before, assignedAgent: undefined, sessionId: undefined, worktree: undefined, startedAt: undefined });
  expect((await other.ready()).filter(t => t.id === task.id && !t.assignee)).toHaveLength(1);
});

for (const kind of ['closed', 'deferred', 'reassign', 'human', 'same-owner-new-session', 'same-owner-new-version']) {
  test(`REGRESSION: delayed cleanup preserves already committed ${kind}`, async () => {
    const winner = kind.startsWith('same-owner')
      ? await other.update<Task>(task.id, kind === 'same-owner-new-session'
        ? { metadata: { ...task.metadata, orchestrator: { ...getOrchestratorTaskMeta(task.metadata), sessionId: 'new-session' } } }
        : { title: 'New decision with same owner/session' })
      : await change(kind);
    const events = storage.query('SELECT * FROM events ORDER BY id');
    await expect(run('unassign')).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
    expect(await other.get(task.id)).toEqual(winner);
    expect(storage.query('SELECT * FROM events ORDER BY id')).toEqual(events);
    expect((await other.ready()).filter(t => t.id === task.id && !t.assignee)).toHaveLength(0);
  });
}

for (const options of [undefined, { mode: 'failed-dispatch' }, { mode: 'failed-dispatch', expectedAssignment: { agentId: 'missing-version' } }]) {
  test('REGRESSION: missing cleanup identity never implicitly becomes admin', async () => {
    const events = storage.query('SELECT * FROM events ORDER BY id');
    // Simulate a JavaScript/legacy caller outside the typed contract.
    await expect(createTaskAssignmentService(api).unassignTask(task.id, options as any)).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
    expect(await other.get(task.id)).toEqual(task);
    expect(storage.query('SELECT * FROM events ORDER BY id')).toEqual(events);
  });
}

for (const kind of ['human', 'closed']) {
  test(`CONTROL: explicit admin releases current ${kind} without reopening`, async () => {
    const winner = await change(kind);
    const result = await createTaskAssignmentService(api).unassignTask(task.id, { mode: 'admin' });
    expect(result.assignee).toBeUndefined();
    expect(result.status).toBe(winner.status);
    expect(result.closedAt).toBe(winner.closedAt);
    expect(result.scheduledFor).toBe(winner.scheduledFor);
    expect(getOrchestratorTaskMeta(result.metadata)!.branch).toBe(getOrchestratorTaskMeta(winner.metadata)!.branch);
  });
}

for (const readNumber of [1, 2]) {
  test(`REGRESSION: explicit admin also preserves concurrent Human at read ${readNumber}`, async () => {
    const get = api.get.bind(api);
    let reads = 0;
    let winner: Task | undefined;
    let events: unknown[] = [];
    api.get = async (...args) => {
      const result = await get(...args);
      if (args[0] === task.id && ++reads === readNumber) {
        winner = await change('human');
        events = storage.query('SELECT * FROM events ORDER BY id');
      }
      return result;
    };
    await expect(createTaskAssignmentService(api).unassignTask(task.id, { mode: 'admin' })).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
    expect(await other.get(task.id)).toEqual(winner!);
    expect(storage.query('SELECT * FROM events ORDER BY id')).toEqual(events);
  });
}

for (const kind of ['own', 'human', 'reassign', 'closed', 'deferred']) {
  test(`REGRESSION: asynchronous notification failure carries only failed assignment receipt (${kind})`, async () => {
    const registry = createAgentRegistry(api);
    const service = createTaskAssignmentService(api);
    const dispatch = createDispatchService(api, service, registry);
    const create = api.create.bind(api);
    let winner: Task | undefined;
    let events: unknown[] = [];
    // Real notification document creation is the deterministic async failure boundary.
    api.create = async (...args) => {
      if (args[0].type === 'document') {
        if (kind !== 'own') winner = await change(kind);
        events = storage.query('SELECT * FROM events ORDER BY id');
        throw new Error('Agent channel not found: fixture notification failure');
      }
      return create(...args);
    };
    let failure: DispatchAssignmentError | undefined;
    try { await dispatch.dispatch(task.id, owner, { sessionId: 'failed-session', markAsStarted: true }); }
    catch (error) {
      expect(error).toBeInstanceOf(DispatchAssignmentError);
      failure = error as DispatchAssignmentError;
    }
    expect(failure).toBeDefined();
    expect(failure!.assignment.agentId).toBe(owner);
    expect(failure!.assignment.sessionId).toBe('failed-session');
    const cleanup = service.unassignTask(task.id, { mode: 'failed-dispatch', expectedAssignment: failure!.assignment });
    if (kind === 'own') {
      expect((await cleanup).assignee).toBeUndefined();
    } else {
      await expect(cleanup).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
      expect(await other.get(task.id)).toEqual(winner!);
      expect(storage.query('SELECT * FROM events ORDER BY id')).toEqual(events);
      expect((await other.ready()).filter(t => t.id === task.id && !t.assignee)).toHaveLength(0);
    }
  });
}
