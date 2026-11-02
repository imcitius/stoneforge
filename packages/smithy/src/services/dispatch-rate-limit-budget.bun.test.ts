/**
 * Provider rate limits must not burn the resume/recovery budgets, and a task
 * held by a rate-limited executor is released to free capacity (el-5x4x9v).
 *
 * Incident (2026-11-01): review task el-4htfn was assigned to Codex merge
 * steward m-steward-1 at 15:01Z. The Codex quota reset hourly and was hit
 * again; each reset resumed the steward (16:02, 17:02, 18:02Z) and counted
 * toward stewardRecoveryCount until mergeStatus=failed ("Steward recovery
 * limit reached after 3 attempts") without any review. el-30sfi4 waited for
 * hours on a rate-limited Codex worker while a Claude worker was free.
 *
 * Only temporary SQLite, temporary Git repositories (plus a bare origin), the
 * real SessionManager / WorktreeManager / TaskAssignmentService /
 * DispatchService and an inert provider double whose sessions can report a
 * rate limit through the real `rate_limited` event path. The daemon is never
 * started; poll actions are invoked directly and the system clock is moved.
 */
import { beforeEach, afterEach, test, expect, describe, setSystemTime } from 'bun:test';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createQuarryAPI, createInboxService, type QuarryAPI } from '@stoneforge/quarry';
import {
  createDocument, createEntity, createTask, ContentType, EntityTypeValue, TaskStatus,
  type Document, type DocumentId, type EntityId, type Task,
} from '@stoneforge/core';
import { createAgentRegistry, type AgentEntity } from './agent-registry.js';
import { createTaskAssignmentService } from './task-assignment-service.js';
import { createDispatchService } from './dispatch-service.js';
import { createDispatchDaemon, type DispatchDaemon, type DispatchDaemonConfig } from './dispatch-daemon.js';
import { createSessionManager, type ResumeSessionOptions } from '../runtime/session-manager.js';
import { getProviderRegistry } from '../providers/registry.js';
import type { AgentProvider } from '../providers/types.js';
import type { SpawnerService, SpawnResult } from '../runtime/spawner.js';
import { createWorktreeManager } from '../git/worktree-manager.js';
import type { StewardScheduler } from './steward-scheduler.js';
import {
  getOrchestratorTaskMeta, updateOrchestratorTaskMeta, findRateLimitedPreviousSession, markTaskSessionRateLimited,
  type OrchestratorTaskMeta,
} from '../types/task-meta.js';

const SEC = 1000;
const MIN = 60 * SEC;
const LIMIT_MESSAGE = "You've hit your usage limit. Try again later.";

let t0 = 0;
const at = (ms: number) => setSystemTime(new Date(t0 + ms));

let root: string, origin: string, db: StorageBackend, api: QuarryAPI;
let task: Task, director: AgentEntity, creator: EntityId;
let handles: Map<string, { alive: boolean; events: EventEmitter; agentId: EntityId }>;
let providers: Map<string, string>;
let serial: number;
let spawner: SpawnerService;
let originalCodexProvider: AgentProvider;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=fixture@example.test', '-c', 'user.name=Fixture', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();

beforeEach(async () => {
  const providerRegistry = getProviderRegistry();
  originalCodexProvider = providerRegistry.get('codex')!;
  // SessionManager checks provider availability before reaching the inert spawner.
  // Keep that check inside the fixture so no Codex CLI is needed on PATH.
  providerRegistry.register({
    ...originalCodexProvider,
    isAvailable: async () => true,
    getInstallInstructions: () => originalCodexProvider.getInstallInstructions(),
    listModels: () => originalCodexProvider.listModels(),
  });
  t0 = Date.parse('2026-11-01T15:00:00Z');
  at(0);
  root = mkdtempSync(path.join(tmpdir(), 'sf-ratelimit-'));
  origin = mkdtempSync(path.join(tmpdir(), 'sf-ratelimit-origin-'));
  git(origin, 'init', '--bare', '-b', 'main');
  mkdirSync(path.join(root, '.stoneforge'));
  git(root, 'init', '-b', 'main');
  writeFileSync(path.join(root, 'README.md'), 'Isolated rate-limit fixture\n');
  git(root, 'add', 'README.md'); git(root, 'commit', '-m', 'fixture');
  git(root, 'remote', 'add', 'origin', origin); git(root, 'push', '-q', 'origin', 'main');
  db = createStorage({ path: path.join(root, '.stoneforge/test.db') }); initializeSchema(db);
  api = createQuarryAPI(db);
  creator = (await api.create(await createEntity({ name: 'fixture-system', entityType: EntityTypeValue.SYSTEM, createdBy: 'system:test' as EntityId }) as never)).id as unknown as EntityId;
  const registry = createAgentRegistry(api);
  director = await registry.registerDirector({ name: 'director', createdBy: creator });
  task = await createWorkTask('Review provider rate limits');
  serial = 0; handles = new Map(); providers = new Map();
  const spawn = async (agentId: EntityId, agentRole: string): Promise<SpawnResult> => {
    const id = `internal-${++serial}`;
    const events = new EventEmitter(); handles.set(id, { alive: true, events, agentId });
    const now = new Date().toISOString();
    return { session: { id, agentId, agentRole, provider: providers.get(agentId) ?? 'claude-code', providerSessionId: `provider-${serial}`,
      mode: 'headless', status: 'running', workingDirectory: root, createdAt: now, lastActivityAt: now, startedAt: now }, events } as SpawnResult;
  };
  spawner = {
    spawn, resume: spawn,
    getSession: (id: string) => ({ status: handles.get(id)?.alive ? 'running' : 'terminated' }),
    terminate: async (id: string) => { const handle = handles.get(id); if (handle) handle.alive = false; },
  } as unknown as SpawnerService;
});
afterEach(() => {
  getProviderRegistry().register(originalCodexProvider);
  setSystemTime();
  db.close(); rmSync(root, { recursive: true, force: true }); rmSync(origin, { recursive: true, force: true });
});

async function createWorkTask(title: string): Promise<Task> {
  const description = await api.create<Document>(await createDocument({
    contentType: ContentType.MARKDOWN, content: 'Implement the feature.', createdBy: director.id as unknown as EntityId,
  }) as never);
  return api.create<Task>(await createTask({
    title, createdBy: director.id as unknown as EntityId, descriptionRef: description.id as unknown as DocumentId,
  }) as never);
}

async function services(config: Partial<DispatchDaemonConfig> = {}) {
  const registry = createAgentRegistry(api);
  const assignment = createTaskAssignmentService(api);
  const dispatch = createDispatchService(api, assignment, registry);
  const sessions = createSessionManager(spawner, api, registry);
  const worktrees = createWorktreeManager({ workspaceRoot: root, defaultBaseBranch: 'main' });
  await worktrees.initWorkspace();
  const inbox = createInboxService(db);
  const daemon: DispatchDaemon = createDispatchDaemon(api, registry, sessions, dispatch, worktrees, assignment,
    {} as StewardScheduler, inbox, { projectRoot: root, ...config });
  const internals = daemon as unknown as {
    assignTaskToWorker(w: AgentEntity): Promise<boolean>;
    reapIdleSessions(): Promise<number>;
    settleRateLimitRecords?(): Promise<void>;
  };
  const resumes: Array<{ agentId: EntityId; options: ResumeSessionOptions }> = [];
  const originalResume = sessions.resumeSession.bind(sessions);
  sessions.resumeSession = async (agentId, options) => { resumes.push({ agentId, options }); return originalResume(agentId, options); };
  const worker = async (name: string, provider: string) => {
    const agent = await registry.registerWorker({ name, workerMode: 'ephemeral', provider, createdBy: creator });
    providers.set(agent.id, provider);
    return agent;
  };
  const steward = async (name: string, provider: string) => {
    const agent = await registry.registerSteward({ name, stewardFocus: 'merge', provider, createdBy: creator });
    providers.set(agent.id, provider);
    return agent;
  };
  /** The agent's live session reports a provider limit through the real `rate_limited` event path. */
  const hitLimit = async (agentId: EntityId, resetsInMs = 60 * MIN) => {
    const active = sessions.getActiveSession(agentId);
    expect(active).toBeDefined();
    handles.get(active!.id)!.events.emit('rate_limited', { message: LIMIT_MESSAGE, resetsAt: new Date(Date.now() + resetsInMs) });
    await internals.settleRateLimitRecords?.();
    return active!.id;
  };
  const endSession = async (agentId: EntityId, reason = 'provider exited') => {
    const active = sessions.getActiveSession(agentId);
    expect(active).toBeDefined();
    await sessions.stopSession(active!.id, { graceful: false, reason });
  };
  return {
    registry, assignment, dispatch, sessions, worktrees, daemon, inbox, resumes, worker, steward, hitLimit, endSession,
    claim: (w: AgentEntity) => internals.assignTaskToWorker(w),
    reap: () => internals.reapIdleSessions(),
  };
}

type Services = Awaited<ReturnType<typeof services>>;
const idOf = (agent: AgentEntity) => agent.id as unknown as EntityId;
const metaOf = (t: Task) => getOrchestratorTaskMeta(t.metadata as Record<string, unknown>) as OrchestratorTaskMeta;
const current = async (id = task.id) => (await api.get<Task>(id))!;
const aliveFor = (agentId: EntityId) => [...handles.values()].filter((handle) => handle.alive && handle.agentId === agentId);
const aliveCount = () => [...handles.values()].filter((handle) => handle.alive).length;

/** Worker finishes; the task goes to REVIEW and the given merge steward picks it up. */
async function toReview(s: Services, stewardAgent: AgentEntity): Promise<void> {
  const implementer = await s.worker('implementer', 'claude-code');
  expect(await s.claim(implementer)).toBe(true);
  await s.endSession(idOf(implementer), 'completed');
  await api.update(task.id, {
    status: TaskStatus.REVIEW, assignee: undefined,
    metadata: updateOrchestratorTaskMeta((await current()).metadata as Record<string, unknown>, { mergeStatus: 'pending' }),
  });
  expect((await s.daemon.pollWorkflowTasks()).processed).toBe(1);
  expect((await current()).assignee).toBe(idOf(stewardAgent));
}

// ---------------------------------------------------------------------------
// 1. A limit-caused session end does not burn the budget
// ---------------------------------------------------------------------------

describe('rate-limited session ends are not counted', () => {
  test('incident el-4htfn: Codex steward limited at every hourly reset keeps its recovery budget and is never failed', async () => {
    const s = await services();
    const codex = await s.steward('m-steward-1', 'codex');
    const stewardId = idOf(codex);
    await toReview(s, codex);
    const stewardResumes = () => s.resumes.filter((entry) => entry.agentId === stewardId).length;

    // Each hour: the session hits the limit and exits; while limited nothing
    // is resumed; at the reset the steward is resumed again.
    let clock = 0;
    for (let hour = 1; hour <= 5; hour++) {
      clock += 1 * MIN;
      at(clock);
      const limitedSession = await s.hitLimit(stewardId);
      await s.endSession(stewardId);
      expect(findRateLimitedPreviousSession(metaOf(await current()), stewardId)?.sessionId).toBe(limitedSession);
      clock += 30 * MIN;
      at(clock);
      await s.daemon.recoverOrphanedAssignments();
      expect(stewardResumes()).toBe(hour - 1);
      clock += 31 * MIN; // past the reset
      at(clock);
      await s.daemon.recoverOrphanedAssignments();
      expect(stewardResumes()).toBe(hour);
      const meta = metaOf(await current());
      expect(meta.stewardRecoveryCount ?? 0).toBe(0);
      expect(meta.mergeStatus).not.toBe('failed');
      expect((await current()).assignee).toBe(stewardId);
    }
    // Before the fix the third reset already ended in mergeStatus=failed.
    const meta = metaOf(await current());
    const stewardEntries = meta.sessionHistory!.filter((entry) => entry.agentId === stewardId);
    expect(stewardEntries).toHaveLength(6);
    // Every ended steward session records the reason in session history.
    for (const entry of stewardEntries.slice(0, 5)) {
      expect(entry.endReason).toBe('rate-limited');
      expect(entry.rateLimitedAt).toBeDefined();
      expect(entry.rateLimitResetsAt).toBeDefined();
    }
    expect(stewardEntries[5].endReason).toBeUndefined();

    // A session that ends without a limit still counts, and the cap still applies.
    clock += 2 * MIN; at(clock);
    await s.endSession(stewardId, 'turn ended');
    clock += 10 * MIN; at(clock);
    await s.daemon.recoverOrphanedAssignments();
    expect(metaOf(await current()).stewardRecoveryCount).toBe(1);
  });

  test('worker: a resume after a limited session keeps resumeCount and never escalates to a recovery steward', async () => {
    const s = await services({ maxResumeAttemptsBeforeRecovery: 2 });
    const codex = await s.worker('c-worker-1', 'codex');
    const workerId = idOf(codex);
    expect(await s.claim(codex)).toBe(true);
    let clock = 0;
    for (let round = 1; round <= 4; round++) {
      clock += 2 * MIN; at(clock);
      await s.hitLimit(workerId, 20 * MIN);
      await s.endSession(workerId);
      clock += 5 * MIN; at(clock);
      expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(0); // limited, nobody else free
      clock += 20 * MIN; at(clock);
      expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(1);
      expect(metaOf(await current()).resumeCount ?? 0).toBe(0);
      expect((await current()).assignee).toBe(workerId);
      expect(aliveFor(workerId)).toHaveLength(1);
    }
    // A non-limit end is counted as before.
    clock += 2 * MIN; at(clock);
    await s.endSession(workerId, 'turn ended');
    clock += 10 * MIN; at(clock);
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(1);
    expect(metaOf(await current()).resumeCount).toBe(1);
    expect(metaOf(await current()).lastRateLimitedSession).toBeDefined();
  });

  test('a limited session stopped as hung is not counted toward the no-progress guard, and its resume is free', async () => {
    const s = await services({ sessionIdleTimeoutMs: 30 * MIN });
    const codex = await s.worker('c-worker-1', 'codex');
    const workerId = idOf(codex);
    expect(await s.claim(codex)).toBe(true);
    at(1 * MIN);
    const limited = await s.hitLimit(workerId, 45 * MIN);
    // The provider keeps the process running silently while limited.
    at(40 * MIN);
    expect(await s.reap()).toBe(1);
    let meta = metaOf(await current());
    expect(meta.lastHungSession?.sessionId).toBe(limited);
    expect(meta.noProgress?.count ?? 0).toBe(0);
    at(50 * MIN);
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(1);
    meta = metaOf(await current());
    expect(meta.resumeCount ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Release to another provider with capacity
// ---------------------------------------------------------------------------

describe('task held by a rate-limited executor is released to free capacity', () => {
  test('worker: released with branch and worktree kept, then dispatched to the free Claude worker', async () => {
    const s = await services();
    const codex = await s.worker('c-worker-1', 'codex');
    const claude = await s.worker('e-worker-1', 'claude-code');
    expect(await s.claim(codex)).toBe(true);
    const before = metaOf(await current());
    expect(before.branch).toBeDefined();
    expect(before.worktree).toBeDefined();
    at(1 * MIN);
    const limitedSession = await s.hitLimit(idOf(codex));
    await s.endSession(idOf(codex));

    at(5 * MIN);
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(1);
    const released = await current();
    const releasedMeta = metaOf(released);
    expect(released.assignee).toBeUndefined();
    expect(released.status).toBe(TaskStatus.OPEN);
    expect(releasedMeta.assignedAgent).toBeUndefined();
    expect(releasedMeta.sessionId).toBeUndefined();
    expect(releasedMeta.branch).toBe(before.branch);
    expect(releasedMeta.worktree).toBe(before.worktree);
    expect(releasedMeta.resumeCount ?? 0).toBe(0);
    expect(releasedMeta.lastRateLimitRelease).toMatchObject({
      fromAgentId: idOf(codex), fromAgentRole: 'worker', provider: 'codex', sessionId: limitedSession,
    });
    const codexEntry = releasedMeta.sessionHistory!.find((entry) => entry.sessionId === limitedSession)!;
    expect(codexEntry.endReason).toBe('rate-limited');
    expect(codexEntry.endedAt).toBeDefined();
    expect(s.resumes).toHaveLength(0);

    expect((await s.daemon.pollWorkerAvailability()).processed).toBe(1);
    const reassigned = await current();
    expect(reassigned.assignee).toBe(idOf(claude));
    expect(metaOf(reassigned).branch).toBe(before.branch);
    expect(metaOf(reassigned).worktree).toBe(before.worktree);
    expect(aliveFor(idOf(codex))).toHaveLength(0);
    expect(aliveFor(idOf(claude))).toHaveLength(1);
    expect(aliveCount()).toBe(1);
  });

  test('merge steward: review released from the limited Codex steward and picked up by the free Claude steward', async () => {
    const s = await services();
    const codex = await s.steward('m-steward-1', 'codex');
    await toReview(s, codex);
    const claude = await s.steward('m-steward-2', 'claude-code');
    at(1 * MIN);
    await s.hitLimit(idOf(codex));
    await s.endSession(idOf(codex));
    at(5 * MIN);
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(1);
    const released = await current();
    expect(released.assignee).toBeUndefined();
    expect(released.status).toBe(TaskStatus.REVIEW);
    expect(metaOf(released).mergeStatus).toBe('pending');
    expect(metaOf(released).stewardRecoveryCount ?? 0).toBe(0);
    expect(metaOf(released).lastRateLimitRelease?.fromAgentRole).toBe('steward');

    expect((await s.daemon.pollWorkflowTasks()).processed).toBe(1);
    expect((await current()).assignee).toBe(idOf(claude));
    expect(aliveFor(idOf(codex))).toHaveLength(0);
    expect(aliveFor(idOf(claude))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Never two executors at once; no release without capacity
// ---------------------------------------------------------------------------

describe('release never creates a second executor', () => {
  test('a limited executor whose session is still live keeps the task', async () => {
    const s = await services();
    const codex = await s.worker('c-worker-1', 'codex');
    const claude = await s.worker('e-worker-1', 'claude-code');
    expect(await s.claim(codex)).toBe(true);
    at(1 * MIN);
    await s.hitLimit(idOf(codex)); // the session stays live (e.g. waits inside the provider)
    at(5 * MIN);
    await s.daemon.recoverOrphanedAssignments();
    await s.daemon.pollWorkerAvailability();
    expect((await current()).assignee).toBe(idOf(codex));
    expect(metaOf(await current()).lastRateLimitRelease).toBeUndefined();
    expect(aliveFor(idOf(codex))).toHaveLength(1);
    expect(aliveFor(idOf(claude))).toHaveLength(0);
  });

  test('no release when every other executor is busy or limited; the task waits for the reset', async () => {
    const s = await services();
    const codex = await s.worker('c-worker-1', 'codex');
    const codex2 = await s.worker('c-worker-2', 'codex');
    const claude = await s.worker('e-worker-1', 'claude-code');
    expect(await s.claim(codex)).toBe(true);
    const other = await createWorkTask('Other work');
    expect(await s.claim(claude)).toBe(true); // busy on the other task
    expect((await current(other.id)).assignee).toBe(idOf(claude));
    at(1 * MIN);
    await s.hitLimit(idOf(codex));
    await s.endSession(idOf(codex));
    at(5 * MIN);
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(0);
    expect((await current()).assignee).toBe(idOf(codex));
    // Free Codex worker shares the limited provider and takes nothing.
    expect(aliveFor(idOf(codex2))).toHaveLength(0);
    // After the reset the original executor resumes it (uncounted).
    at(70 * MIN);
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(1);
    expect((await current()).assignee).toBe(idOf(codex));
    expect(metaOf(await current()).resumeCount ?? 0).toBe(0);
  });

  test('releaseRateLimitedTasks: false keeps the task with the limited executor', async () => {
    const s = await services({ releaseRateLimitedTasks: false });
    const codex = await s.worker('c-worker-1', 'codex');
    await s.worker('e-worker-1', 'claude-code');
    expect(await s.claim(codex)).toBe(true);
    at(1 * MIN);
    await s.hitLimit(idOf(codex));
    await s.endSession(idOf(codex));
    at(5 * MIN);
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(0);
    expect((await current()).assignee).toBe(idOf(codex));
  });
});

// ---------------------------------------------------------------------------
// 4. No new work for rate-limited executors
// ---------------------------------------------------------------------------

describe('rate-limited executors receive no new work', () => {
  test('ready task goes to the unlimited worker, never to the limited one', async () => {
    const s = await services();
    const codex = await s.worker('c-worker-1', 'codex');
    const claude = await s.worker('e-worker-1', 'claude-code');
    s.daemon.handleRateLimitDetected('codex', new Date(Date.now() + 60 * MIN), 'codex');
    expect((await s.daemon.pollWorkerAvailability()).processed).toBe(1);
    expect((await current()).assignee).toBe(idOf(claude));
    expect(aliveFor(idOf(codex))).toHaveLength(0);
  });

  test('a limited merge steward does not take the review off the queue; the free steward gets it in the same cycle', async () => {
    const s = await services();
    const codex = await s.steward('m-steward-1', 'codex');
    const claude = await s.steward('m-steward-2', 'claude-code');
    s.daemon.handleRateLimitDetected('codex', new Date(Date.now() + 60 * MIN), 'codex');
    const implementer = await s.worker('implementer', 'claude-code');
    expect(await s.claim(implementer)).toBe(true);
    await s.endSession(idOf(implementer), 'completed');
    await api.update(task.id, {
      status: TaskStatus.REVIEW, assignee: undefined,
      metadata: updateOrchestratorTaskMeta((await current()).metadata as Record<string, unknown>, { mergeStatus: 'pending' }),
    });
    expect((await s.daemon.pollWorkflowTasks()).processed).toBe(1);
    expect((await current()).assignee).toBe(idOf(claude));
    expect(aliveFor(idOf(codex))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('rate-limit metadata helpers', () => {
  const agent = 'el-agent' as EntityId;
  const other = 'el-other' as EntityId;
  const entry = (sessionId: string, agentId = agent) => ({ sessionId, agentId, agentName: 'a', agentRole: 'worker' as const, startedAt: '2026-11-01T00:00:00.000Z' });
  const record = (sessionId: string, agentId = agent) => ({ sessionId, providerSessionId: `p-${sessionId}`, agentId, agentRole: 'worker' as const, detectedAt: '2026-11-01T00:01:00.000Z' });

  test('findRateLimitedPreviousSession matches only the agent\'s latest session', () => {
    expect(findRateLimitedPreviousSession(undefined, agent)).toBeUndefined();
    expect(findRateLimitedPreviousSession({ sessionHistory: [entry('s1')], lastRateLimitedSession: record('s1') }, agent)?.sessionId).toBe('s1');
    // A later session of the agent was not limited.
    expect(findRateLimitedPreviousSession({ sessionHistory: [entry('s1'), entry('s2')], lastRateLimitedSession: record('s1') }, agent)).toBeUndefined();
    // Another agent's later session does not hide this agent's limited one.
    expect(findRateLimitedPreviousSession({ sessionHistory: [entry('s1'), entry('s9', other)], lastRateLimitedSession: record('s1') }, agent)?.sessionId).toBe('s1');
    // The record of another agent never applies.
    expect(findRateLimitedPreviousSession({ sessionHistory: [entry('s1')], lastRateLimitedSession: record('s1', other) }, agent)).toBeUndefined();
    // Without history, the recorded provider session decides.
    expect(findRateLimitedPreviousSession({ sessionId: 'p-s1', lastRateLimitedSession: record('s1') }, agent)?.sessionId).toBe('s1');
    expect(findRateLimitedPreviousSession({ sessionId: 'p-s2', lastRateLimitedSession: record('s1') }, agent)).toBeUndefined();
  });

  test('markTaskSessionRateLimited marks one entry and keeps the first detection time', () => {
    const base = updateOrchestratorTaskMeta({}, { sessionHistory: [entry('s1'), entry('s2')] });
    const once = markTaskSessionRateLimited(base, 's2', '2026-11-01T00:05:00.000Z', '2026-11-01T01:00:00.000Z');
    const twice = markTaskSessionRateLimited(once, 's2', '2026-11-01T00:06:00.000Z', '2026-11-01T02:00:00.000Z');
    const history = getOrchestratorTaskMeta(twice)!.sessionHistory!;
    expect(history[0].endReason).toBeUndefined();
    expect(history[1]).toMatchObject({ endReason: 'rate-limited', rateLimitedAt: '2026-11-01T00:05:00.000Z', rateLimitResetsAt: '2026-11-01T02:00:00.000Z' });
    expect(markTaskSessionRateLimited(base, 'unknown', '2026-11-01T00:05:00.000Z')).toEqual(base);
  });
});
