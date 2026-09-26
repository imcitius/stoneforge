/** Automatic dispatch boundaries. Only temporary SQLite/Git and inert process handles. */
import { beforeEach, afterEach, test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createQuarryAPI, createInboxService, type QuarryAPI } from '@stoneforge/quarry';
import { createEntity, createTask, createPlan, EntityTypeValue, PlanStatus, TaskStatus, type Task, type EntityId, type Plan } from '@stoneforge/core';
import { createAgentRegistry, type AgentEntity } from './agent-registry.js';
import { createTaskAssignmentService } from './task-assignment-service.js';
import { createDispatchService } from './dispatch-service.js';
import { createDispatchDaemon } from './dispatch-daemon.js';
import { createSessionManager } from '../runtime/session-manager.js';
import type { SpawnerService, SpawnResult } from '../runtime/spawner.js';
import { createWorktreeManager } from '../git/worktree-manager.js';
import type { StewardScheduler } from './steward-scheduler.js';
import { createWorkerTaskService } from './worker-task-service.js';

let root: string, db: StorageBackend, db2: StorageBackend, api: QuarryAPI, other: QuarryAPI;
let task: Task, worker: AgentEntity, second: AgentEntity, creator: EntityId;
let beforeSpawn: (() => Promise<void>) | undefined;
let beforeTerminate: (() => Promise<void>) | undefined;
let handles: Map<string, { alive: boolean; events: EventEmitter }>;
let serial: number;
let spawner: SpawnerService;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'sf-claim-'));
  mkdirSync(path.join(root, '.stoneforge'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-b', 'main'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture');
  writeFileSync(path.join(root, 'README.md'), 'Isolated claim fixture\n'); git('add', 'README.md'); git('commit', '-m', 'fixture');
  db = createStorage({ path: path.join(root, '.stoneforge/test.db') }); initializeSchema(db);
  db2 = createStorage({ path: path.join(root, '.stoneforge/test.db') });
  api = createQuarryAPI(db); other = createQuarryAPI(db2);
  creator = (await api.create(await createEntity({ name: 'fixture-system', entityType: EntityTypeValue.SYSTEM, createdBy: 'system:test' as EntityId }) as never)).id as unknown as EntityId;
  const registry = createAgentRegistry(api);
  worker = await registry.registerWorker({ name: 'first', workerMode: 'ephemeral', createdBy: creator });
  second = await registry.registerWorker({ name: 'second', workerMode: 'ephemeral', createdBy: creator });
  task = await api.create<Task>(await createTask({ title: 'claim', createdBy: creator }) as never);
  beforeSpawn = undefined; beforeTerminate = undefined; serial = 0; handles = new Map();
  const spawn = async (agentId: EntityId, agentRole: string): Promise<SpawnResult> => {
    const id = `internal-${++serial}`;
    await beforeSpawn?.();
    const events = new EventEmitter(); handles.set(id, { alive: true, events });
    return { session: { id, agentId, agentRole, provider: 'fixture', providerSessionId: 'reused-provider', mode: 'headless',
      status: 'running', workingDirectory: root, createdAt: task.createdAt, lastActivityAt: task.createdAt, startedAt: task.createdAt }, events } as SpawnResult;
  };
  spawner = {
    spawn, resume: spawn,
    getSession: (id: string) => ({ status: handles.get(id)?.alive ? 'running' : 'terminated' }),
    terminate: async (id: string) => { handles.get(id)!.alive = false; await beforeTerminate?.(); },
  } as unknown as SpawnerService;
});
afterEach(() => { db.close(); db2.close(); rmSync(root, { recursive: true, force: true }); });

async function services(connection = api) {
  const registry = createAgentRegistry(connection);
  const assignment = createTaskAssignmentService(connection);
  const dispatch = createDispatchService(connection, assignment, registry);
  const sessions = createSessionManager(spawner, connection, registry);
  const worktrees = createWorktreeManager({ workspaceRoot: root, defaultBaseBranch: 'main' });
  await worktrees.initWorkspace();
  const daemon = createDispatchDaemon(connection, registry, sessions, dispatch, worktrees, assignment,
    {} as StewardScheduler, createInboxService(connection === api ? db : db2), { projectRoot: root });
  // Invoke the actual poll action at its deterministic boundary, never start a daemon.
  const claim = (agent = worker) => (daemon as unknown as { assignTaskToWorker(w: AgentEntity): Promise<boolean> }).assignTaskToWorker(agent);
  return { registry, assignment, dispatch, sessions, worktrees, claim };
}
const messages = () => db.query("SELECT * FROM elements WHERE type = 'message' ORDER BY id");

for (const competitor of ['closed', 'deferred', 'human', 'worker', 'draft', 'blocked-parent', 'future']) {
  test(`daemon rejects ${competitor} between candidate read and claim; no notification`, async () => {
    const s = await services();
    let plan: Plan | undefined;
    if (competitor === 'draft' || competitor === 'blocked-parent') {
      plan = await api.create<Plan>(await createPlan({ title: 'Parent', createdBy: creator, status: PlanStatus.ACTIVE }) as never);
      await api.addDependency({ blockedId: task.id, blockerId: plan.id, type: 'parent-child', createdBy: creator });
    }
    let winner: Task | null = null; let eventSnapshot: unknown;
    const beforeMessages = messages();
    beforeSpawn = async () => {
      if (competitor === 'draft') await other.update(plan!.id, { status: PlanStatus.DRAFT } as never);
      else if (competitor === 'blocked-parent') {
        const blocker = await other.create<Task>(await createTask({ title: 'Blocker', createdBy: creator }) as never);
        await other.addDependency({ blockedId: plan!.id, blockerId: blocker.id, type: 'blocks', createdBy: creator });
      } else if (competitor === 'worker') await createTaskAssignmentService(other).assignToAgent(task.id, second.id as unknown as EntityId, { sessionId: 'successor' });
      else await other.update<Task>(task.id, competitor === 'human' ? { assignee: 'human:fixture' as EntityId }
        : competitor === 'future' ? { scheduledFor: '2099-01-01T00:00:00.000Z' as Task['scheduledFor'] }
        : { status: competitor as Task['status'] });
      winner = await other.get<Task>(task.id);
      eventSnapshot = db.query('SELECT * FROM events WHERE element_id = ? ORDER BY id', [task.id]);
    };
    expect(await s.claim()).toBe(false);
    expect(await api.get(task.id)).toEqual(winner);
    expect(db.query('SELECT * FROM events WHERE element_id = ? ORDER BY id', [task.id])).toEqual(eventSnapshot);
    expect(messages()).toEqual(beforeMessages);
    expect([...handles.values()].every(h => !h.alive)).toBe(true);
  });
}

test('two SQLite connections and simultaneous daemon claimants: exactly one claim and notification', async () => {
  const a = await services(), b = await services(other);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let arrivals = 0;
  beforeSpawn = async () => { if (++arrivals === 2) release(); await barrier; };
  const initialMessages = messages().length;
  const results = await Promise.all([a.claim(worker), b.claim(second)]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(messages()).toHaveLength(initialMessages + 1);
  expect([...handles.values()].filter(h => h.alive)).toHaveLength(1);
  const winner = (await api.get<Task>(task.id))!;
  expect([worker.id, second.id]).toContain(winner.assignee!);
  expect(existsSync((winner.metadata.orchestrator as { worktree: string }).worktree)).toBe(true);
});

test('automatic success uses a real Git worktree and records the internal/provider pair', async () => {
  const s = await services();
  expect(await s.claim()).toBe(true);
  const result = (await api.get<Task>(task.id))!;
  expect(result.status).toBe(TaskStatus.IN_PROGRESS);
  const meta = result.metadata.orchestrator as { worktree: string; sessionHistory: { sessionId: string; providerSessionId: string }[] };
  expect(existsSync(path.join(meta.worktree, '.git'))).toBe(true);
  expect(meta.sessionHistory[0]).toMatchObject({ sessionId: 'internal-1', providerSessionId: 'reused-provider' });
});

test('explicit start-worker retains deliberate reassignment', async () => {
  const s = await services();
  await s.assignment.assignToAgent(task.id, second.id as unknown as EntityId);
  const service = createWorkerTaskService(api, s.assignment, s.registry, s.dispatch, spawner, s.sessions, s.worktrees);
  const result = await service.startWorkerOnTask(task.id, worker.id as unknown as EntityId);
  expect(result.session.id).toBe('internal-1');
  expect((await api.get<Task>(task.id))!.assignee).toBe(worker.id as unknown as EntityId);
  expect(existsSync(path.join(result.worktree!.path, '.git'))).toBe(true);
});

test('provider startup failure leaves candidate and notifications unchanged', async () => {
  const s = await services(), snapshot = await api.get(task.id), initialMessages = messages();
  beforeSpawn = async () => { throw new Error('fixture startup failure'); };
  await expect(s.claim()).rejects.toThrow('fixture startup failure');
  expect(await api.get(task.id)).toEqual(snapshot); expect(messages()).toEqual(initialMessages);
  expect(handles.size).toBe(0);
});

for (const successor of [false, true]) {
  test(`notification failure conditionally releases only own assignment (successor=${successor})`, async () => {
    const s = await services(); let winner: Task | undefined;
    const create = api.create.bind(api);
    api.create = async (...args) => {
      if (args[0].type !== 'message') return create(...args);
      if (successor) winner = await createTaskAssignmentService(other).assignToAgent(task.id, second.id as unknown as EntityId, { sessionId: 'successor' });
      throw new Error('fixture notification failure');
    };
    await expect(s.claim()).rejects.toThrow('fixture notification failure');
    if (successor) expect(await api.get(task.id)).toEqual(winner!);
    else expect((await api.get<Task>(task.id))!.assignee).toBeUndefined();
    expect([...handles.values()].every(h => !h.alive)).toBe(true);
  });
}

const currentFields = (agent: AgentEntity) => {
  const { sessionHistory: _history, ...current } = agent.metadata.agent as Record<string, unknown>;
  return current;
};

for (const boundary of ['stop', 'exit', 'resume']) {
  test(`old ${boundary} preserves successor internal identity with reused provider ID`, async () => {
    const s = await services(); const agentId = worker.id as unknown as EntityId;
    const old = await s.sessions.startSession(agentId, { workingDirectory: root });
    let winner: AgentEntity | undefined; let successorId: string | undefined;
    const startSuccessor = async () => {
      const successor = boundary === 'resume'
        ? await s.sessions.resumeSession(agentId, { providerSessionId: 'reused-provider', workingDirectory: root })
        : await s.sessions.startSession(agentId, { workingDirectory: root });
      successorId = successor.session.id; winner = (await s.registry.getAgent(agentId))!;
    };
    if (boundary === 'exit') {
      const get = s.registry.getAgent.bind(s.registry); let armed = true;
      s.registry.getAgent = async id => {
        const snapshot = await get(id);
        if (armed) { armed = false; await startSuccessor(); }
        return snapshot;
      };
      // Await the real async callback, without sleeps or a real process.
      await handles.get(old.session.id)!.events.listeners('exit')[0](0, null);
    } else {
      beforeTerminate = startSuccessor;
      await s.sessions.stopSession(old.session.id, { graceful: false });
      beforeTerminate = undefined;
      await s.sessions.stopSession(old.session.id, { graceful: false }); // idempotent
    }
    const result = (await s.registry.getAgent(agentId))!;
    expect(currentFields(result)).toEqual(currentFields(winner!));
    expect(s.sessions.getActiveSession(agentId)!.id).toBe(successorId!);
    expect(handles.get(successorId!)!.alive).toBe(true);
    const history = (result.metadata.agent as { sessionHistory: { id: string }[] }).sessionHistory;
    expect(history.some(entry => entry.id === old.session.id)).toBe(true);
  });
}

for (const identity of [undefined, 'ambiguous-other']) {
  test(`legacy/unproven identity ${identity}: stop known process, preserve registry and neighboring history`, async () => {
    const s = await services(); const agentId = worker.id as unknown as EntityId;
    const old = await s.sessions.startSession(agentId, { workingDirectory: root });
    const agent = (await s.registry.getAgent(agentId))!;
    const winner = await other.update<AgentEntity>(worker.id, { metadata: { ...agent.metadata, agent: {
      ...agent.metadata.agent as object, currentSessionId: identity, sessionStatus: 'running',
      sessionHistory: [{ id: 'neighbor', status: 'terminated', workingDirectory: root }],
    } } });
    await s.sessions.stopSession(old.session.id, { graceful: false });
    const result = (await s.registry.getAgent(agentId))!;
    expect(currentFields(result)).toEqual(currentFields(winner));
    expect(handles.get(old.session.id)!.alive).toBe(false);
    expect((result.metadata.agent as { sessionHistory: { id: string }[] }).sessionHistory.map(e => e.id)).toContain('neighbor');
  });
}

test('same-session positive cleanup publishes idle and retains unique identity/history', async () => {
  const s = await services(); const id = worker.id as unknown as EntityId;
  const own = await s.sessions.startSession(id, { workingDirectory: root });
  await s.sessions.stopSession(own.session.id, { graceful: false });
  expect((await s.registry.getAgent(id))!.metadata.agent).toMatchObject({ currentSessionId: own.session.id, sessionStatus: 'idle' });
  expect(s.sessions.getActiveSession(id)).toBeUndefined();
});

test('two managers publishing for one agent: CAS loser terminates only its own process', async () => {
  const a = await services(), b = await services(other); const agentId = worker.id as unknown as EntityId;
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; }); let count = 0;
  beforeSpawn = async () => { if (++count === 2) release(); await barrier; };
  const outcomes = await Promise.allSettled([a.sessions.startSession(agentId), b.sessions.startSession(agentId)]);
  expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter(o => o.status === 'rejected')).toHaveLength(1);
  const current = (await a.registry.getAgent(agentId))!.metadata.agent as { currentSessionId: string; sessionStatus: string };
  expect(current.sessionStatus).toBe('running'); expect(handles.get(current.currentSessionId)!.alive).toBe(true);
  expect([...handles.values()].filter(h => h.alive)).toHaveLength(1);
});

test('claim rejects authoritative blocked parent even before writer publishes blocked_cache', async () => {
  const s = await services();
  const plan = await api.create<Plan>(await createPlan({ title: 'Parent', createdBy: creator, status: PlanStatus.ACTIVE }) as never);
  await api.addDependency({ blockedId: task.id, blockerId: plan.id, type: 'parent-child', createdBy: creator });
  const blocker = await api.create<Task>(await createTask({ title: 'Blocker', createdBy: creator }) as never);
  // Hold precisely the cache-publication boundary of the real dependency writer.
  const cache = (other as unknown as { blockedCache: { onDependencyAdded: (...args: unknown[]) => void } }).blockedCache;
  const publish = cache.onDependencyAdded.bind(cache); let pending: unknown[] | undefined;
  cache.onDependencyAdded = (...args) => { pending = args; };
  await other.addDependency({ blockedId: plan.id, blockerId: blocker.id, type: 'blocks', createdBy: creator });
  expect((await api.get<Task>(task.id))!.updatedAt).toBe(task.updatedAt);
  const events = db.query('SELECT * FROM events ORDER BY id');
  await expect(s.dispatch.dispatch(task.id, worker.id as unknown as EntityId, { claim: { expectedUpdatedAt: task.updatedAt } })).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
  expect(db.query('SELECT * FROM events ORDER BY id')).toEqual(events);
  cache.onDependencyAdded = publish; publish(...pending!);
});

test('startup persistence error terminates the exact newly published process', async () => {
  const s = await services(); const update = api.update.bind(api); let writes = 0;
  api.update = async (...args) => {
    if (args[0] === worker.id && ++writes === 2) throw new Error('fixture startup persistence failure');
    return update(...args);
  };
  await expect(s.sessions.startSession(worker.id as unknown as EntityId)).rejects.toThrow('fixture startup persistence failure');
  expect([...handles.values()].every(h => !h.alive)).toBe(true);
  expect((await s.registry.getAgent(worker.id as unknown as EntityId))!.metadata.agent).toMatchObject({ sessionStatus: 'idle' });
});

test('parent DRAFT after Quarry update snapshot is rejected inside the write transaction', async () => {
  const s = await services();
  const plan = await api.create<Plan>(await createPlan({ title: 'Parent', createdBy: creator, status: PlanStatus.ACTIVE }) as never);
  await api.addDependency({ blockedId: task.id, blockerId: plan.id, type: 'parent-child', createdBy: creator });
  const update = api.update.bind(api); const get = api.get.bind(api); let armed = false;
  api.update = async (...args) => { if (args[0] === task.id) armed = true; return update(...args); };
  let eventSnapshot: unknown;
  api.get = async (...args) => {
    const snapshot = await get(...args);
    if (armed && args[0] === task.id) {
      armed = false;
      await other.update<Plan>(plan.id, { status: PlanStatus.DRAFT });
      eventSnapshot = db.query('SELECT * FROM events ORDER BY id');
    }
    return snapshot;
  };
  await expect(s.dispatch.dispatch(task.id, worker.id as unknown as EntityId, { claim: { expectedUpdatedAt: task.updatedAt } })).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
  expect(await other.get(task.id)).toEqual(task);
  expect(db.query('SELECT * FROM events ORDER BY id')).toEqual(eventSnapshot);
});

test('due and unassigned candidate remains eligible for automatic claim', async () => {
  const s = await services();
  task = await api.update<Task>(task.id, { scheduledFor: '2000-01-01T00:00:00.000Z' as Task['scheduledFor'] });
  expect(await s.claim()).toBe(true);
  expect((await api.get<Task>(task.id))!.assignee).toBe(worker.id as unknown as EntityId);
});

test('repeated stop retries failed persistence for its own session', async () => {
  const s = await services(); const agentId = worker.id as unknown as EntityId;
  const own = await s.sessions.startSession(agentId, { workingDirectory: root });
  const update = api.update.bind(api); let fail = true;
  api.update = async (...args) => {
    if (args[0] === worker.id && fail) { fail = false; throw new Error('fixture transient persistence failure'); }
    return update(...args);
  };
  await expect(s.sessions.stopSession(own.session.id, { graceful: false })).rejects.toThrow('fixture transient persistence failure');
  await s.sessions.stopSession(own.session.id, { graceful: false });
  expect((await s.registry.getAgent(agentId))!.metadata.agent).toMatchObject({ currentSessionId: own.session.id, sessionStatus: 'idle' });
  expect(((await s.registry.getAgent(agentId))!.metadata.agent as { sessionHistory: {id: string}[] }).sessionHistory.some(e => e.id === own.session.id)).toBe(true);
});

for (const failure of ['persistence', 'termination']) {
  test(`concurrent stops share ${failure} failure and retry only own cleanup after successor starts`, async () => {
    const s = await services(); const agentId = worker.id as unknown as EntityId;
    const own = await s.sessions.startSession(agentId, { workingDirectory: root });
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const terminate = spawner.terminate.bind(spawner);
    let terminations = 0, fail = true;
    spawner.terminate = async (...args) => {
      expect(args[0]).toBe(own.session.id);
      terminations++;
      if (failure === 'termination' && fail) {
        fail = false; entered(); await blocked;
        throw new Error('fixture stop failure');
      }
      return terminate(...args);
    };
    const update = api.update.bind(api);
    api.update = async (...args) => {
      if (failure === 'persistence' && args[0] === worker.id && fail) {
        fail = false; entered(); await blocked;
        throw new Error('fixture stop failure');
      }
      return update(...args);
    };
    const first = s.sessions.stopSession(own.session.id, { graceful: false });
    await reached;
    let secondSettled = false;
    const secondStop = s.sessions.stopSession(own.session.id, { graceful: false });
    void secondStop.then(() => { secondSettled = true; }, () => { secondSettled = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(secondSettled).toBe(false);
    const outcomesPromise = Promise.allSettled([first, secondStop]);
    release();
    const outcomes = await outcomesPromise;
    expect(outcomes.map(o => o.status)).toEqual(['rejected', 'rejected']);
    expect(terminations).toBe(1);
    expect(handles.get(own.session.id)!.alive).toBe(failure === 'termination');
    const successor = await s.sessions.resumeSession(agentId, { providerSessionId: 'reused-provider', workingDirectory: root });
    const winner = (await s.registry.getAgent(agentId))!;
    await s.sessions.stopSession(own.session.id, { graceful: false });
    await s.sessions.stopSession(own.session.id, { graceful: false });
    expect(terminations).toBe(failure === 'termination' ? 2 : 1);
    const result = (await s.registry.getAgent(agentId))!;
    expect(currentFields(result)).toEqual(currentFields(winner));
    expect(handles.get(own.session.id)!.alive).toBe(false);
    expect(handles.get(successor.session.id)!.alive).toBe(true);
    expect(s.sessions.getActiveSession(agentId)!.id).toBe(successor.session.id);
    const history = (result.metadata.agent as { sessionHistory: { id: string }[] }).sessionHistory;
    expect(history.filter(entry => entry.id === own.session.id)).toHaveLength(1);
  });
}

test('concurrent successful stops await one termination and one persisted history entry', async () => {
  const s = await services(); const agentId = worker.id as unknown as EntityId;
  const own = await s.sessions.startSession(agentId, { workingDirectory: root });
  let release!: () => void, entered!: () => void, calls = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  beforeTerminate = async () => { calls++; entered(); await blocked; };
  const first = s.sessions.stopSession(own.session.id, { graceful: false });
  await reached;
  const secondStop = s.sessions.stopSession(own.session.id, { graceful: false });
  release(); await Promise.all([first, secondStop]);
  await s.sessions.stopSession(own.session.id, { graceful: false });
  expect(calls).toBe(1);
  const meta = (await s.registry.getAgent(agentId))!.metadata.agent as { sessionStatus: string; sessionHistory: { id: string }[] };
  expect(meta.sessionStatus).toBe('idle');
  expect(meta.sessionHistory.filter(entry => entry.id === own.session.id)).toHaveLength(1);
});
