/**
 * Assignment/spawn lifecycle writers under the CAS start/session contract (el-52oa7i).
 *
 * Two real QuarryAPI connections to one temporary SQLite file, a temporary Git repo
 * and inert provider handles (no timers, processes, daemon loop or live data). The
 * competitor commits through the second connection between the spawn decision and
 * the session record; the spawned session must then be stopped and the winner kept.
 */
import { beforeEach, afterEach, test, expect, describe } from 'bun:test';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createQuarryAPI, createInboxService, type QuarryAPI } from '@stoneforge/quarry';
import { createEntity, createTask, EntityTypeValue, TaskStatus, type Task, type EntityId } from '@stoneforge/core';
import { createAgentRegistry, type AgentEntity } from './agent-registry.js';
import { createTaskAssignmentService, type TaskAssignmentService } from './task-assignment-service.js';
import { createDispatchService, type DispatchService } from './dispatch-service.js';
import { createDispatchDaemon } from './dispatch-daemon.js';
import { createWorkerTaskService } from './worker-task-service.js';
import { createSessionManager } from '../runtime/session-manager.js';
import type { SpawnerService, SpawnResult } from '../runtime/spawner.js';
import { createWorktreeManager } from '../git/worktree-manager.js';
import type { StewardScheduler } from './steward-scheduler.js';
import { createOrchestratorAPI } from '../api/orchestrator-api.js';
import { getOrchestratorTaskMeta, updateOrchestratorTaskMeta, type OrchestratorTaskMeta } from '../types/task-meta.js';

let root: string, db: StorageBackend, db2: StorageBackend, api: QuarryAPI, other: QuarryAPI;
let task: Task, worker: AgentEntity, second: AgentEntity, mergeSteward: AgentEntity, mergeSteward2: AgentEntity, recoverySteward: AgentEntity;
let creator: EntityId;
let afterSpawn: (() => Promise<void>) | undefined;
let handles: Map<string, { alive: boolean }>;
let serial: number;
let spawner: SpawnerService;

const id = (agent: AgentEntity) => agent.id as unknown as EntityId;
const meta = (t: Task | null): OrchestratorTaskMeta => getOrchestratorTaskMeta(t?.metadata as Record<string, unknown>) ?? {};
const read = async () => (await other.get<Task>(task.id))!;
const alive = () => [...handles.entries()].filter(([, h]) => h.alive).map(([sid]) => sid);
const events = () => db.query('SELECT * FROM events WHERE element_id = ? ORDER BY id', [task.id]);

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'sf-spawn-record-'));
  mkdirSync(path.join(root, '.stoneforge'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-b', 'main'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture');
  writeFileSync(path.join(root, 'README.md'), 'Isolated spawn record fixture\n'); git('add', 'README.md'); git('commit', '-m', 'fixture');
  db = createStorage({ path: path.join(root, '.stoneforge/test.db') }); initializeSchema(db);
  db2 = createStorage({ path: path.join(root, '.stoneforge/test.db') });
  api = createQuarryAPI(db); other = createQuarryAPI(db2);
  creator = (await api.create(await createEntity({ name: 'fixture-system', entityType: EntityTypeValue.SYSTEM, createdBy: 'system:test' as EntityId }, api.getIdGeneratorConfig()) as never)).id as unknown as EntityId;
  const registry = createAgentRegistry(api);
  worker = await registry.registerWorker({ name: 'first', workerMode: 'ephemeral', createdBy: creator });
  second = await registry.registerWorker({ name: 'second', workerMode: 'ephemeral', createdBy: creator });
  mergeSteward = await registry.registerSteward({ name: 'merger', stewardFocus: 'merge', createdBy: creator });
  mergeSteward2 = await registry.registerSteward({ name: 'merger-2', stewardFocus: 'merge', createdBy: creator });
  recoverySteward = await registry.registerSteward({ name: 'recoverer', stewardFocus: 'recovery', createdBy: creator });
  task = await api.create<Task>(await createTask({ title: 'spawn record', createdBy: creator }, api.getIdGeneratorConfig()) as never);
  afterSpawn = undefined; serial = 0; handles = new Map();
  const spawn = async (agentId: EntityId, agentRole: string): Promise<SpawnResult> => {
    const sid = `internal-${++serial}`;
    handles.set(sid, { alive: true });
    // The provider handle exists now: the spawn decision has been made.
    const hook = afterSpawn; afterSpawn = undefined;
    await hook?.();
    return { session: { id: sid, agentId, agentRole, provider: 'fixture', providerSessionId: `provider-${serial}`, mode: 'headless',
      status: 'running', workingDirectory: root, createdAt: task.createdAt, lastActivityAt: task.createdAt, startedAt: task.createdAt },
    events: new EventEmitter() } as SpawnResult;
  };
  spawner = {
    spawn, resume: spawn,
    getSession: (sid: string) => ({ status: handles.get(sid)?.alive ? 'running' : 'terminated' }),
    terminate: async (sid: string) => { handles.get(sid)!.alive = false; },
  } as unknown as SpawnerService;
});
afterEach(() => { db.close(); db2.close(); rmSync(root, { recursive: true, force: true }); });

async function services() {
  const registry = createAgentRegistry(api);
  const assignment = createTaskAssignmentService(api);
  const dispatch = createDispatchService(api, assignment, registry);
  const sessions = createSessionManager(spawner, api, registry);
  const worktrees = createWorktreeManager({ workspaceRoot: root, defaultBaseBranch: 'main' });
  await worktrees.initWorkspace();
  const daemon = createDispatchDaemon(api, registry, sessions, dispatch, worktrees, assignment,
    {} as StewardScheduler, createInboxService(db), { projectRoot: root });
  // Deterministic boundaries of the real poll actions; the daemon loop is never started.
  const priv = daemon as unknown as {
    assignTaskToWorker(w: AgentEntity): Promise<boolean>;
    recoverOrphanedTask(w: AgentEntity, t: Task, m: OrchestratorTaskMeta | undefined): Promise<boolean>;
    recoverOrphanedStewardTask(s: AgentEntity, t: Task, m: OrchestratorTaskMeta | undefined): Promise<void>;
    spawnMergeStewardForTask(s: AgentEntity, t: Task): Promise<void>;
    spawnRecoveryStewardForTask(w: AgentEntity, t: Task, m: OrchestratorTaskMeta | undefined, used?: Set<string>): Promise<boolean>;
  };
  const workerTasks = createWorkerTaskService(api, assignment, registry, dispatch, spawner, sessions, worktrees);
  return { registry, assignment, dispatch, sessions, worktrees, daemon: priv, workerTasks };
}
type Services = Awaited<ReturnType<typeof services>>;

/** A worker-owned IN_PROGRESS task with a real worktree whose session is gone (orphan). */
async function orphanedWorkerTask(s: Services): Promise<Task> {
  expect(await s.daemon.assignTaskToWorker(worker)).toBe(true);
  for (const sid of alive()) await s.sessions.stopSession(sid, { graceful: false });
  return (await api.get<Task>(task.id))!;
}

/** A completed REVIEW task awaiting merge, unclaimed (worker's branch/worktree retained). */
async function reviewTask(s: Services): Promise<Task> {
  const t = await orphanedWorkerTask(s);
  return api.update<Task>(task.id, {
    status: TaskStatus.REVIEW, assignee: undefined,
    metadata: updateOrchestratorTaskMeta(t.metadata, { mergeStatus: 'pending' }),
  });
}

/** Competitors, committed through the second connection. */
const competitors = {
  close: async () => { await other.update<Task>(task.id, { status: TaskStatus.CLOSED }); },
  merge: async () => {
    const t = (await other.get<Task>(task.id))!;
    await other.update<Task>(task.id, { status: TaskStatus.CLOSED, assignee: undefined,
      metadata: updateOrchestratorTaskMeta(t.metadata, { mergeStatus: 'merged' }) });
  },
  reject: async () => {
    const t = (await other.get<Task>(task.id))!;
    await other.update<Task>(task.id, { status: TaskStatus.OPEN, assignee: undefined,
      metadata: updateOrchestratorTaskMeta(t.metadata, { mergeStatus: 'test_failed', assignedAgent: undefined, sessionId: undefined }) });
  },
  handoff: async () => {
    const t = (await other.get<Task>(task.id))!;
    await other.update<Task>(task.id, { status: TaskStatus.OPEN, assignee: undefined,
      metadata: updateOrchestratorTaskMeta(t.metadata, { assignedAgent: undefined, sessionId: undefined }) });
  },
  reassign: async () => {
    await createTaskAssignmentService(other).assignToAgent(task.id, id(second), { sessionId: 'successor' });
  },
  complete: async () => {
    const t = (await other.get<Task>(task.id))!;
    await other.update<Task>(task.id, { status: TaskStatus.REVIEW, assignee: undefined,
      metadata: updateOrchestratorTaskMeta(t.metadata, { mergeStatus: 'pending' }) });
  },
  otherSteward: async () => {
    const t = (await other.get<Task>(task.id))!;
    await other.update<Task>(task.id, { assignee: id(mergeSteward2),
      metadata: updateOrchestratorTaskMeta(t.metadata, { assignedAgent: id(mergeSteward2), mergeStatus: 'testing', sessionId: 'steward-2' }) });
  },
} as const;
type Competitor = keyof typeof competitors;

/** Arms the competitor at the spawn boundary; returns the winner snapshot holder. */
function armAtSpawn(name: Competitor) {
  const result: { winner?: Task; events?: unknown } = {};
  afterSpawn = async () => { await competitors[name](); result.winner = await read(); result.events = events(); };
  return result;
}

function expectRefused(result: { winner?: Task; events?: unknown }, spawnedSession: string) {
  return (async () => {
    const now = await read();
    expect(result.winner).toBeDefined();
    expect(now).toEqual(result.winner!);
    expect(events()).toEqual(result.events);
    expect((meta(now).sessionHistory ?? []).some(e => e.sessionId === spawnedSession)).toBe(false);
    expect(handles.get(spawnedSession)?.alive).toBe(false);
  })();
}

// ---------------------------------------------------------------------------
// markAsStarted shares the startTask status rule
// ---------------------------------------------------------------------------

describe('markAsStarted (assignToAgent and OrchestratorAPI.assignTaskToAgent)', () => {
  for (const [label, status] of [['merged/closed', TaskStatus.CLOSED], ['completed/review', TaskStatus.REVIEW], ['deferred', TaskStatus.DEFERRED]] as const) {
    for (const via of ['service', 'orchestrator-api'] as const) {
      test(`REGRESSION: ${via} start after committed ${label} rejects and preserves the winner`, async () => {
        await other.update<Task>(task.id, { status });
        const winner = await read(); const before = events();
        const start = via === 'service'
          ? createTaskAssignmentService(api).assignToAgent(task.id, id(worker), { markAsStarted: true })
          : createOrchestratorAPI(db).assignTaskToAgent(task.id, id(worker), { markAsStarted: true });
        await expect(start).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION', details: { startErrorKind: 'invalid-state' } });
        expect(await read()).toEqual(winner);
        expect(events()).toEqual(before);
      });
    }
  }

  for (const via of ['service', 'orchestrator-api'] as const) {
    test(`POSITIVE: ${via} assigns and starts an open task in one write`, async () => {
      const before = (events() as unknown[]).length;
      const started = via === 'service'
        ? await createTaskAssignmentService(api).assignToAgent(task.id, id(worker), { markAsStarted: true, sessionId: 's-1' })
        : await createOrchestratorAPI(db).assignTaskToAgent(task.id, id(worker), { markAsStarted: true, sessionId: 's-1' });
      expect(started.status).toBe(TaskStatus.IN_PROGRESS);
      expect(started.assignee).toBe(id(worker));
      expect(meta(started)).toMatchObject({ assignedAgent: id(worker), sessionId: 's-1' });
      expect(meta(started).startedAt).toBeDefined();
      expect((events() as unknown[]).length).toBe(before + 1);
    });
  }

  test('without markAsStarted an explicit assignment of a REVIEW task keeps its status', async () => {
    await other.update<Task>(task.id, { status: TaskStatus.REVIEW });
    const assigned = await createTaskAssignmentService(api).assignToAgent(task.id, id(worker));
    expect(assigned.status).toBe(TaskStatus.REVIEW);
  });
});

// ---------------------------------------------------------------------------
// recordSession contract
// ---------------------------------------------------------------------------

describe('TaskAssignmentService.recordSession', () => {
  const entry = (sessionId: string) => ({ sessionId, agentId: id(worker), agentName: 'first', agentRole: 'worker' as const, startedAt: task.createdAt });
  async function assigned(assignment: TaskAssignmentService) {
    const t = await assignment.assignToAgent(task.id, id(worker), { markAsStarted: true, branch: 'b-1', worktree: 'w-1', sessionId: 'old' });
    return { t, decision: { status: t.status, assignee: t.assignee, branch: 'b-1', sessionId: 'old' } };
  }

  test('POSITIVE: appends the history entry and sets the session in one write', async () => {
    const assignment = createTaskAssignmentService(api);
    const { decision } = await assigned(assignment);
    await assignment.recordSession(task.id, { decision, entry: entry('internal-a'), sessionId: 'provider-a' });
    const before = (events() as unknown[]).length;
    const second = await assignment.recordSession(task.id, {
      decision: { ...decision, sessionId: 'provider-a' }, entry: entry('internal-b'), sessionId: 'provider-b',
    });
    expect((events() as unknown[]).length).toBe(before + 1);
    expect(meta(second).sessionId).toBe('provider-b');
    expect(meta(second).sessionHistory!.map(e => e.sessionId)).toEqual(['internal-a', 'internal-b']);
  });

  for (const [field, change] of [
    ['status', { status: TaskStatus.CLOSED }],
    ['assignee', { assignee: 'human:fixture' as EntityId }],
    ['branch', { orchestrator: { branch: 'other-branch' } }],
    ['sessionId', { orchestrator: { sessionId: 'someone-else' } }],
  ] as const) {
    test(`REGRESSION: refuses (no write) when ${field} changed since the decision`, async () => {
      const assignment = createTaskAssignmentService(api);
      const { decision } = await assigned(assignment);
      const current = (await other.get<Task>(task.id))!;
      await other.update<Task>(task.id, 'orchestrator' in change
        ? { metadata: updateOrchestratorTaskMeta(current.metadata, change.orchestrator) }
        : change as Partial<Task>);
      const winner = await read(); const before = events();
      await expect(assignment.recordSession(task.id, { decision, entry: entry('internal-x'), sessionId: 'provider-x' }))
        .rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION', details: { sessionRecordRefused: true, changed: [field] } });
      expect(await read()).toEqual(winner);
      expect(events()).toEqual(before);
    });
  }

  test('unrelated metadata written after the decision does not refuse', async () => {
    const assignment = createTaskAssignmentService(api);
    const { decision } = await assigned(assignment);
    const current = (await other.get<Task>(task.id))!;
    await other.update<Task>(task.id, { metadata: updateOrchestratorTaskMeta(current.metadata, { resumeCount: 2 }) });
    const recorded = await assignment.recordSession(task.id, { decision, entry: entry('internal-y'), sessionId: 'provider-y' });
    expect(meta(recorded)).toMatchObject({ resumeCount: 2, sessionId: 'provider-y' });
  });

  test('REGRESSION: a commit between its read and its write rejects (two connections), winner kept', async () => {
    const assignment = createTaskAssignmentService(api);
    const { decision } = await assigned(assignment);
    const get = api.get.bind(api); let armed = true; let winner: Task | undefined;
    api.get = (async (...args: Parameters<typeof api.get>) => {
      const snapshot = await get(...args);
      if (armed && args[0] === task.id) { armed = false; await competitors.close(); winner = await read(); }
      return snapshot;
    }) as typeof api.get;
    await expect(assignment.recordSession(task.id, { decision, entry: entry('internal-z'), sessionId: 'provider-z' }))
      .rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
    api.get = get;
    expect(await read()).toEqual(winner!);
  });
});

// ---------------------------------------------------------------------------
// Explicit start-worker (WorkerTaskService.startWorkerOnTask)
// ---------------------------------------------------------------------------

describe('startWorkerOnTask session record', () => {
  for (const competitor of ['close', 'handoff', 'reassign'] as const) {
    test(`REGRESSION: ${competitor} after the spawn is not overwritten; spawned session stopped`, async () => {
      const s = await services();
      const armed = armAtSpawn(competitor);
      await expect(s.workerTasks.startWorkerOnTask(task.id, id(worker))).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
      await expectRefused(armed, 'internal-1');
    });
  }

  test('POSITIVE: records session and its history entry', async () => {
    const s = await services();
    const result = await s.workerTasks.startWorkerOnTask(task.id, id(worker));
    const now = await read();
    expect(now.status).toBe(TaskStatus.IN_PROGRESS);
    expect(meta(now).sessionId).toBe(result.session.id);
    expect(meta(now).sessionHistory).toEqual([expect.objectContaining({ sessionId: 'internal-1', providerSessionId: 'provider-1', agentId: id(worker), agentRole: 'worker' })]);
    expect(alive()).toEqual(['internal-1']);
  });
});

// ---------------------------------------------------------------------------
// Daemon worker paths
// ---------------------------------------------------------------------------

describe('daemon automatic worker dispatch record', () => {
  for (const competitor of ['close', 'handoff', 'reassign'] as const) {
    test(`PRESERVATION: ${competitor} after the claim is not overwritten; spawned session stopped`, async () => {
      const s = await services();
      const dispatch = s.dispatch.dispatch.bind(s.dispatch) as DispatchService['dispatch'];
      const armed: { winner?: Task; events?: unknown } = {};
      s.dispatch.dispatch = async (...args) => {
        const result = await dispatch(...args);
        await competitors[competitor](); armed.winner = await read(); armed.events = events();
        return result;
      };
      expect(await s.daemon.assignTaskToWorker(worker)).toBe(false);
      await expectRefused(armed, 'internal-1');
    });
  }

  test('POSITIVE: claim records the session and history entry', async () => {
    const s = await services();
    expect(await s.daemon.assignTaskToWorker(worker)).toBe(true);
    const now = await read();
    expect(meta(now).sessionId).toBe('provider-1');
    expect(meta(now).sessionHistory).toEqual([expect.objectContaining({ sessionId: 'internal-1', agentRole: 'worker' })]);
    expect(alive()).toEqual(['internal-1']);
  });
});

describe('daemon orphan worker recovery record', () => {
  for (const mode of ['resume', 'fresh'] as const) {
    for (const competitor of ['close', 'handoff', 'reassign'] as const) {
      test(`REGRESSION: ${mode} — ${competitor} after the spawn is not overwritten; spawned session stopped`, async () => {
        const s = await services();
        let t = await orphanedWorkerTask(s);
        if (mode === 'fresh') t = await api.update<Task>(task.id, { metadata: updateOrchestratorTaskMeta(t.metadata, { sessionId: undefined }) });
        const armed = armAtSpawn(competitor);
        expect(await s.daemon.recoverOrphanedTask(worker, t, meta(t))).toBe(false);
        await expectRefused(armed, 'internal-2');
      });
    }

    test(`POSITIVE: ${mode} records the history entry${mode === 'fresh' ? ' and new session' : ''}`, async () => {
      const s = await services();
      let t = await orphanedWorkerTask(s);
      if (mode === 'fresh') t = await api.update<Task>(task.id, { metadata: updateOrchestratorTaskMeta(t.metadata, { sessionId: undefined }) });
      expect(await s.daemon.recoverOrphanedTask(worker, t, meta(t))).toBe(true);
      const now = await read();
      expect(meta(now).sessionHistory!.map(e => e.sessionId)).toEqual(['internal-1', 'internal-2']);
      expect(meta(now).sessionId).toBe(mode === 'fresh' ? 'provider-2' : 'provider-1');
      expect(alive()).toEqual(['internal-2']);
    });
  }
});

// ---------------------------------------------------------------------------
// Daemon steward paths
// ---------------------------------------------------------------------------

describe('daemon merge steward spawn record', () => {
  for (const competitor of ['merge', 'reject', 'otherSteward'] as const) {
    test(`REGRESSION: ${competitor} after the spawn is not overwritten; spawned session stopped`, async () => {
      const s = await services();
      const t = await reviewTask(s);
      const armed = armAtSpawn(competitor);
      await s.daemon.spawnMergeStewardForTask(mergeSteward, t);
      await expectRefused(armed, 'internal-2');
    });
  }

  test('POSITIVE: claims the REVIEW task with session and history', async () => {
    const s = await services();
    const t = await reviewTask(s);
    await s.daemon.spawnMergeStewardForTask(mergeSteward, t);
    const now = await read();
    expect(now.status).toBe(TaskStatus.REVIEW);
    expect(now.assignee).toBe(id(mergeSteward));
    expect(meta(now)).toMatchObject({ assignedAgent: id(mergeSteward), mergeStatus: 'testing', sessionId: 'provider-2' });
    expect(meta(now).sessionHistory!.at(-1)).toMatchObject({ sessionId: 'internal-2', agentId: id(mergeSteward), agentRole: 'steward' });
    expect(alive()).toEqual(['internal-2']);
  });

  test('REGRESSION: orphan steward resume — merge after the spawn is not overwritten; session stopped', async () => {
    const s = await services();
    await reviewTask(s);
    await s.daemon.spawnMergeStewardForTask(mergeSteward, (await api.get<Task>(task.id))!);
    await s.sessions.stopSession('internal-2', { graceful: false });
    const t = (await api.get<Task>(task.id))!;
    const armed = armAtSpawn('merge');
    await s.daemon.recoverOrphanedStewardTask(mergeSteward, t, meta(t));
    await expectRefused(armed, 'internal-3');
  });
});

describe('daemon recovery steward spawn record', () => {
  for (const competitor of ['complete', 'handoff', 'close'] as const) {
    test(`REGRESSION: ${competitor} after the spawn is not overwritten; spawned session stopped`, async () => {
      const s = await services();
      const t = await orphanedWorkerTask(s);
      const armed = armAtSpawn(competitor);
      expect(await s.daemon.spawnRecoveryStewardForTask(worker, t, meta(t))).toBe(false);
      await expectRefused(armed, 'internal-2');
    });
  }

  test('POSITIVE: transfers the stuck task to the recovery steward with session and history', async () => {
    const s = await services();
    const t = await orphanedWorkerTask(s);
    expect(await s.daemon.spawnRecoveryStewardForTask(worker, t, meta(t))).toBe(true);
    const now = await read();
    expect(now.assignee).toBe(id(recoverySteward));
    expect(meta(now)).toMatchObject({ assignedAgent: id(recoverySteward), sessionId: 'provider-2' });
    expect(meta(now).sessionHistory!.at(-1)).toMatchObject({ sessionId: 'internal-2', agentId: id(recoverySteward), agentRole: 'steward' });
    expect(alive()).toEqual(['internal-2']);
  });
});
