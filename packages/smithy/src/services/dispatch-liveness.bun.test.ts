/**
 * Session liveness, accurate resume prompts and workspace-check consistency
 * (el-4dcv06, split from el-5jwe6q).
 *
 * Incidents: e-worker-1/2 stayed 'running' without output for ~10h after an
 * orphan resume (2026-10-31 23:39Z / 00:30Z); finished worker/steward sessions
 * stayed 'running' with no task (2026-11-01 10:05–10:14Z).
 *
 * Only temporary SQLite, temporary Git repositories (plus a bare origin), the
 * real SessionManager / WorktreeManager / TaskAssignmentService /
 * DispatchService and an inert provider double. The daemon is never started;
 * poll actions are invoked directly and the daemon clock (Date.now) is mocked.
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
  createDocument, createEntity, createTask, ContentType, EntityTypeValue, TaskStatus, Priority,
  type Document, type DocumentId, type EntityId, type Task,
} from '@stoneforge/core';
import { createAgentRegistry, type AgentEntity } from './agent-registry.js';
import { createTaskAssignmentService } from './task-assignment-service.js';
import { createDispatchService } from './dispatch-service.js';
import { createDispatchDaemon, type DispatchDaemon, type DispatchDaemonConfig } from './dispatch-daemon.js';
import { createSessionManager, type ResumeSessionOptions } from '../runtime/session-manager.js';
import type { SpawnerService, SpawnResult } from '../runtime/spawner.js';
import { createWorktreeManager } from '../git/worktree-manager.js';
import type { StewardScheduler } from './steward-scheduler.js';
import { getOrchestratorTaskMeta, updateOrchestratorTaskMeta, type OrchestratorTaskMeta } from '../types/task-meta.js';
import { computeProgressFingerprint, evaluateHungSession } from './no-progress-guard.js';
import { buildInterruptedResumePrompt, classifyIdleSession, watchdogSignature, orphanResumeBackoffMs, orphanResumeWaitMs } from './session-liveness.js';

const MIN = 60_000;
const realNow = Date.now;
let offset = 0;

let root: string, origin: string, db: StorageBackend, api: QuarryAPI;
let task: Task, worker: AgentEntity, director: AgentEntity, creator: EntityId;
let handles: Map<string, { alive: boolean; events: EventEmitter }>;
let serial: number;
let spawner: SpawnerService;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=fixture@example.test', '-c', 'user.name=Fixture', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();

beforeEach(async () => {
  offset = 0;
  Date.now = () => realNow() + offset;
  root = mkdtempSync(path.join(tmpdir(), 'sf-liveness-'));
  origin = mkdtempSync(path.join(tmpdir(), 'sf-liveness-origin-'));
  git(origin, 'init', '--bare', '-b', 'main');
  mkdirSync(path.join(root, '.stoneforge'));
  git(root, 'init', '-b', 'main');
  writeFileSync(path.join(root, 'README.md'), 'Isolated liveness fixture\n');
  git(root, 'add', 'README.md'); git(root, 'commit', '-m', 'fixture');
  git(root, 'remote', 'add', 'origin', origin); git(root, 'push', '-q', 'origin', 'main');
  db = createStorage({ path: path.join(root, '.stoneforge/test.db') }); initializeSchema(db);
  api = createQuarryAPI(db);
  creator = (await api.create(await createEntity({ name: 'fixture-system', entityType: EntityTypeValue.SYSTEM, createdBy: 'system:test' as EntityId }) as never)).id as unknown as EntityId;
  const registry = createAgentRegistry(api);
  director = await registry.registerDirector({ name: 'director', createdBy: creator });
  worker = await registry.registerWorker({ name: 'e-worker-1', workerMode: 'ephemeral', createdBy: creator });
  task = await createWorkTask('Desktop getting started', 'Implement the feature.');
  serial = 0; handles = new Map();
  const spawn = async (agentId: EntityId, agentRole: string): Promise<SpawnResult> => {
    const id = `internal-${++serial}`;
    const events = new EventEmitter(); handles.set(id, { alive: true, events });
    const at = new Date().toISOString();
    return { session: { id, agentId, agentRole, provider: 'fixture', providerSessionId: `provider-${serial}`, mode: 'headless',
      status: 'running', workingDirectory: root, createdAt: at, lastActivityAt: at, startedAt: at }, events } as SpawnResult;
  };
  spawner = {
    spawn, resume: spawn,
    getSession: (id: string) => ({ status: handles.get(id)?.alive ? 'running' : 'terminated' }),
    terminate: async (id: string) => { const handle = handles.get(id); if (handle) handle.alive = false; },
  } as unknown as SpawnerService;
});
afterEach(() => {
  Date.now = realNow;
  db.close(); rmSync(root, { recursive: true, force: true }); rmSync(origin, { recursive: true, force: true });
});

async function createWorkTask(title: string, content: string, priority?: Priority): Promise<Task> {
  const description = await api.create<Document>(await createDocument({
    contentType: ContentType.MARKDOWN, content, createdBy: director.id as unknown as EntityId,
  }) as never);
  return api.create<Task>(await createTask({
    title, createdBy: director.id as unknown as EntityId, descriptionRef: description.id as unknown as DocumentId, ...(priority ? { priority } : {}),
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
  const claim = (w: AgentEntity = worker) => (daemon as unknown as { assignTaskToWorker(w: AgentEntity): Promise<boolean> }).assignTaskToWorker(w);
  const reap = () => (daemon as unknown as { reapIdleSessions(): Promise<number> }).reapIdleSessions();
  const resumes: Array<{ agentId: EntityId; options: ResumeSessionOptions }> = [];
  const originalResume = sessions.resumeSession.bind(sessions);
  sessions.resumeSession = async (agentId, options) => { resumes.push({ agentId, options }); return originalResume(agentId, options); };
  return { registry, assignment, dispatch, sessions, worktrees, daemon, inbox, claim, reap, resumes };
}

const metaOf = (t: Task) => getOrchestratorTaskMeta(t.metadata as Record<string, unknown>) as OrchestratorTaskMeta;
const current = async (id = task.id) => (await api.get<Task>(id))!;
const aliveHandles = () => [...handles.values()].filter((handle) => handle.alive);
const holdMessages = () => db.query<{ id: string }>(
  "SELECT e.id FROM elements e JOIN tags t ON t.element_id = e.id WHERE e.type = 'message' AND t.tag = 'dispatch-hold' ORDER BY e.id"
);
const commitIn = (worktree: string, file: string) => {
  writeFileSync(path.join(worktree, file), `${file}\n`);
  git(worktree, 'add', file); git(worktree, 'commit', '-q', '-m', `work ${file}`);
  return git(worktree, 'rev-parse', 'HEAD');
};

// ---------------------------------------------------------------------------
// 1. Hung sessions with an assigned task
// ---------------------------------------------------------------------------

describe('hung running session with an assigned task', () => {
  test('incident: no output past the limit → stopped, recorded, counted, resumed by orphan recovery with an accurate prompt', async () => {
    const s = await services();
    expect(await s.claim()).toBe(true);
    const dispatched = metaOf(await current());
    expect(aliveHandles()).toHaveLength(1);

    offset = 31 * MIN; // default limit 30 min
    expect(await s.reap()).toBe(1);
    expect(aliveHandles()).toHaveLength(0);
    expect(s.sessions.getActiveSession(worker.id as unknown as EntityId)).toBeUndefined();

    const afterStop = await current();
    const meta = metaOf(afterStop);
    expect(afterStop.status).toBe(TaskStatus.IN_PROGRESS);
    expect(afterStop.assignee).toBe(worker.id);
    expect(meta.lastHungSession).toMatchObject({ sessionId: 'internal-1', providerSessionId: 'provider-1', agentId: worker.id, agentRole: 'worker' });
    expect(meta.lastHungSession!.idleMs).toBeGreaterThanOrEqual(30 * MIN);
    // Counted toward the el-5jwe6q no-progress guard (no commit since dispatch).
    expect(meta.noProgress?.count).toBe(1);
    expect(meta.noProgress?.evaluatedHandoffAt).toBe(dispatched.noProgress?.evaluatedHandoffAt);
    expect(meta.dispatchHold).toBeUndefined();

    // A second liveness pass does not count the same hang again.
    expect(await s.reap()).toBe(0);
    expect(metaOf(await current()).noProgress?.count).toBe(1);

    // Existing orphan path resumes the same branch, increments resumeCount.
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(1);
    const recovered = metaOf(await current());
    expect(recovered.resumeCount).toBe(1);
    expect(recovered.branch).toBe(dispatched.branch);
    expect(s.resumes).toHaveLength(1);
    const prompt = s.resumes[0].options.resumePrompt!;
    expect(prompt).not.toContain('server restart');
    expect(prompt).toContain('stopped by the dispatch daemon');
    expect(prompt).toContain('without any provider output for 31 min');
    expect(prompt).toContain(`branch ${dispatched.branch} at `);
    expect(prompt).toContain('Automatic resume attempt 1 of 3');
    expect(prompt).toContain(`You are still assigned to task ${task.id}`);
  });

  test('below the limit, after fresh activity, or with the check disabled the session keeps running', async () => {
    const s = await services();
    expect(await s.claim()).toBe(true);
    offset = 29 * MIN;
    expect(await s.reap()).toBe(0);
    // Provider output resets the idle clock (SessionManager updates lastActivityAt).
    offset = 0;
    aliveHandles()[0].events.emit('event', { type: 'assistant', message: 'running the gate' });
    offset = 29 * MIN;
    expect(await s.reap()).toBe(0);
    s.daemon.updateConfig({ sessionIdleTimeoutMs: 0 });
    offset = 600 * MIN;
    expect(await s.reap()).toBe(0);
    expect(aliveHandles()).toHaveLength(1);
    expect(metaOf(await current()).lastHungSession).toBeUndefined();
    // Configurable limit.
    s.daemon.updateConfig({ sessionIdleTimeoutMs: 5 * MIN });
    offset = 6 * MIN;
    expect(await s.reap()).toBe(1);
  });

  test('repeated hangs without progress hold the task (DEFERRED, unassigned) with exactly one Director message; a commit resets the count', async () => {
    // Raise the resume cap so the recovery steward does not take over first
    // (with defaults, three hangs without progress hold before resumeCount hits 3).
    const s = await services({ maxResumeAttemptsBeforeRecovery: 10 });
    expect(await s.claim()).toBe(true);
    const hang = async () => {
      offset += 31 * MIN;
      expect(await s.reap()).toBe(1);
    };
    await hang();
    expect(metaOf(await current()).noProgress?.count).toBe(1);
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(1);
    // Progress: a commit on the task branch resets the count at the next hang.
    commitIn(metaOf(await current()).worktree!, 'progress.txt');
    await hang();
    expect(metaOf(await current()).noProgress?.count).toBe(0);
    for (const expected of [1, 2]) {
      expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(1);
      await hang();
      expect(metaOf(await current()).noProgress?.count).toBe(expected);
    }
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(1);
    await hang();
    const held = await current();
    const meta = metaOf(held);
    expect(held.status).toBe(TaskStatus.DEFERRED);
    expect(held.assignee).toBeUndefined();
    expect(meta.assignedAgent).toBeUndefined();
    expect(meta.dispatchHold).toMatchObject({ trigger: 'hung-session', count: 3, limit: 3, directorId: director.id });
    expect(meta.dispatchHold?.notificationMessageId).toBeDefined();
    expect(meta.lastHungSession).toBeDefined();
    expect(meta.branch).toBeDefined();
    expect(holdMessages()).toHaveLength(1);
    // Held work is neither resumed nor redispatched.
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(0);
    expect(await s.claim()).toBe(false);
    expect(holdMessages()).toHaveLength(1);

    // Director undefers: normal branch-preserving dispatch with a reset counter.
    await api.update(task.id, { status: TaskStatus.OPEN });
    expect(await s.claim()).toBe(true);
    const redispatched = metaOf(await current());
    expect(redispatched.branch).toBe(meta.branch);
    expect(redispatched.noProgress?.count).toBe(0);
    expect(redispatched.dispatchHold).toBeUndefined();
  });

  test('defaults: three hangs without progress hold the task before the resume cap spawns a recovery steward', async () => {
    const s = await services();
    expect(await s.claim()).toBe(true);
    for (let hang = 1; hang <= 3; hang++) {
      if (hang > 1) expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(1);
      offset += 31 * MIN;
      expect(await s.reap()).toBe(1);
    }
    const held = await current();
    expect(held.status).toBe(TaskStatus.DEFERRED);
    expect(metaOf(held).resumeCount).toBe(2);
    expect(metaOf(held).dispatchHold?.trigger).toBe('hung-session');
    expect(holdMessages()).toHaveLength(1);
  });

  test('a hung merge steward is stopped and resumed by steward orphan recovery with an accurate prompt; the worker counter is untouched', async () => {
    const s = await services();
    expect(await s.claim()).toBe(true);
    const workerMeta = metaOf(await current());
    const workerSession = workerMeta.sessionHistory![0].sessionId;
    await s.sessions.stopSession(workerSession, { graceful: false, reason: 'completed' });
    const steward = await s.registry.registerSteward({ name: 'm-steward-1', stewardFocus: 'merge', createdBy: creator });
    const stewardId = steward.id as unknown as EntityId;
    const { session } = await s.sessions.startSession(stewardId, { workingDirectory: workerMeta.worktree, worktree: workerMeta.worktree });
    await api.update(task.id, {
      status: TaskStatus.REVIEW, assignee: stewardId,
      metadata: updateOrchestratorTaskMeta((await current()).metadata as Record<string, unknown>, {
        assignedAgent: stewardId, mergeStatus: 'pending', sessionId: session.providerSessionId,
      }),
    });
    offset = 31 * MIN;
    expect(await s.reap()).toBe(1);
    const meta = metaOf(await current());
    expect(meta.lastHungSession).toMatchObject({ sessionId: session.id, agentRole: 'steward' });
    expect(meta.noProgress).toEqual(workerMeta.noProgress);
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(1);
    const resume = s.resumes.find((entry) => entry.agentId === stewardId)!;
    expect(resume.options.resumePrompt).not.toContain('server restart');
    expect(resume.options.resumePrompt).toContain('stopped by the dispatch daemon');
    expect(resume.options.resumePrompt).toContain('merge status pending');
    expect(resume.options.resumePrompt).toContain(`You are still assigned to review/merge task ${task.id}`);
  });
});

// ---------------------------------------------------------------------------
// 2. Finished / lingering sessions without a task
// ---------------------------------------------------------------------------

describe('idle running session without an assigned task', () => {
  test('incident: worker/steward sessions that finished their final turn but stay running are ended after the idle limit', async () => {
    const s = await services();
    const steward = await s.registry.registerSteward({ name: 'r-steward-1', stewardFocus: 'recovery', createdBy: creator });
    await s.sessions.startSession(worker.id as unknown as EntityId, { workingDirectory: root });
    await s.sessions.startSession(steward.id as unknown as EntityId, { workingDirectory: root });
    offset = 9 * MIN;
    expect(await s.reap()).toBe(0);
    offset = 11 * MIN; // default 10 min
    expect(await s.reap()).toBe(2);
    expect(aliveHandles()).toHaveLength(0);
    expect(s.sessions.getActiveSession(worker.id as unknown as EntityId)).toBeUndefined();
    expect(s.sessions.getActiveSession(steward.id as unknown as EntityId)).toBeUndefined();
  });

  test('directors and persistent workers are never stopped; 0 disables the check', async () => {
    const s = await services();
    const persistent = await s.registry.registerWorker({ name: 'p-worker', workerMode: 'persistent', createdBy: creator });
    await s.sessions.startSession(director.id as unknown as EntityId, { workingDirectory: root });
    await s.sessions.startSession(persistent.id as unknown as EntityId, { workingDirectory: root });
    await s.sessions.startSession(worker.id as unknown as EntityId, { workingDirectory: root });
    s.daemon.updateConfig({ idleSessionWithoutTaskMs: 0 });
    offset = 24 * 60 * MIN;
    expect(await s.reap()).toBe(0);
    expect(aliveHandles()).toHaveLength(3);
    s.daemon.updateConfig({ idleSessionWithoutTaskMs: 10 * MIN });
    expect(await s.reap()).toBe(1);
    expect(aliveHandles()).toHaveLength(2);
    expect(s.sessions.getActiveSession(worker.id as unknown as EntityId)).toBeUndefined();
    expect(s.sessions.getActiveSession(director.id as unknown as EntityId)).toBeDefined();
    expect(s.sessions.getActiveSession(persistent.id as unknown as EntityId)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Accurate resume prompt after a crash (no hang)
// ---------------------------------------------------------------------------

describe('resume prompt', () => {
  test('crash + orphan resume states that the session ended, its recorded end state and the task state — not a server restart', async () => {
    const s = await services();
    expect(await s.claim()).toBe(true);
    const meta = metaOf(await current());
    const head = commitIn(meta.worktree!, 'partial.txt');
    await s.sessions.stopSession(meta.sessionHistory![0].sessionId, { graceful: false, reason: 'provider stream closed' });
    // The session crashed right after it started: the first resume waits for
    // the orphan back-off (default 1 min after the session start, el-55qcdj).
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(0);
    offset = 2 * MIN;
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(1);
    const prompt = s.resumes[0].options.resumePrompt!;
    expect(prompt).not.toContain('server restart.');
    expect(prompt).toContain('ended before it ran `sf task complete` or `sf task handoff`');
    expect(prompt).toContain('Previous session internal-1');
    expect(prompt).toContain('reason: provider stream closed');
    expect(prompt).toContain(`Task ${task.id}: status in_progress; branch ${meta.branch} at ${head.slice(0, 12)}.`);
    expect(prompt).toContain('Automatic resume attempt 1 of 3');
    expect(prompt).not.toContain('stopped by the dispatch daemon');
  });

  test('builder: unknown end state is stated as unknown', () => {
    const prompt = buildInterruptedResumePrompt({ role: 'worker', taskId: 'el-x', taskTitle: 'T' });
    expect(prompt).toContain('No end record is available for the previous session.');
    expect(prompt).toContain('You are still assigned to task el-x: "T".');
  });
});

// ---------------------------------------------------------------------------
// 4. recordedBranchAvailable ↔ resolveTaskWorkspace consistency (m-steward-2)
// ---------------------------------------------------------------------------

describe('candidate workspace check matches workspace resolution', () => {
  test('recorded worktree exists on another branch and the recorded branch is gone: candidate skipped, next task dispatched (no throw after selection)', async () => {
    const s = await services();
    const other = path.join(root, '.stoneforge/.worktrees/other');
    git(root, 'worktree', 'add', '-q', '-b', 'agent/other/unrelated', other, 'main');
    const urgent = await createWorkTask('Urgent with stale metadata', 'x', Priority.CRITICAL);
    await api.update(urgent.id, {
      // Prior work evidence (el-2q3e2y): a never-materialized name would be created instead.
      metadata: updateOrchestratorTaskMeta(undefined, { branch: 'agent/e-worker-2/gone-branch', worktree: other, lastCommitHash: 'abc1234' }),
    });
    expect(await s.claim()).toBe(true);
    expect((await current(urgent.id)).assignee).toBeUndefined();
    expect(metaOf(await current(urgent.id)).branch).toBe('agent/e-worker-2/gone-branch');
    expect((await current()).assignee).toBe(worker.id);
  });

  test('recorded worktree on another branch while the recorded branch still exists: reattached, not skipped', async () => {
    const s = await services();
    git(root, 'branch', 'agent/e-worker-2/kept-branch', 'main');
    const other = path.join(root, '.stoneforge/.worktrees/other');
    git(root, 'worktree', 'add', '-q', '-b', 'agent/other/unrelated', other, 'main');
    await api.update(task.id, { metadata: updateOrchestratorTaskMeta(task.metadata as Record<string, unknown>, { branch: 'agent/e-worker-2/kept-branch', worktree: other }) });
    expect(await s.claim()).toBe(true);
    const meta = metaOf(await current());
    expect(meta.branch).toBe('agent/e-worker-2/kept-branch');
    expect(meta.worktree).not.toBe(other);
  });
});

// ---------------------------------------------------------------------------
// 5. Rapid successive orphan resumes back off (el-55qcdj)
// ---------------------------------------------------------------------------

const SEC = 1000;

describe('rapid successive orphan resumes back off', () => {
  // Session history timestamps use `new Date()`, so these tests move the whole
  // system clock (Date.now and new Date) instead of the Date.now offset.
  let t0 = 0;
  const at = (seconds: number) => setSystemTime(new Date(t0 + seconds * SEC));
  beforeEach(() => { t0 = realNow(); at(0); });
  afterEach(() => { setSystemTime(); });
  /** Ends the agent's current session the way a provider turn end does (no merge outcome / no sf command). */
  const endTurn = async (s: Awaited<ReturnType<typeof services>>, agentId: EntityId) => {
    const active = s.sessions.getActiveSession(agentId);
    expect(active).toBeDefined();
    await s.sessions.stopSession(active!.id, { graceful: false, reason: 'turn ended' });
  };

  async function reviewWithMergeSteward(s: Awaited<ReturnType<typeof services>>): Promise<EntityId> {
    expect(await s.claim()).toBe(true);
    const workerMeta = metaOf(await current());
    await s.sessions.stopSession(workerMeta.sessionHistory![0].sessionId, { graceful: false, reason: 'completed' });
    const steward = await s.registry.registerSteward({ name: 'm-steward-2', stewardFocus: 'merge', createdBy: creator });
    await api.update(task.id, {
      status: TaskStatus.REVIEW, assignee: undefined,
      metadata: updateOrchestratorTaskMeta((await current()).metadata as Record<string, unknown>, { mergeStatus: 'pending' }),
    });
    expect((await s.daemon.pollWorkflowTasks()).processed).toBe(1);
    const stewardId = steward.id as unknown as EntityId;
    expect((await current()).assignee).toBe(stewardId);
    expect(s.sessions.getActiveSession(stewardId)).toBeDefined();
    return stewardId;
  }

  test('incident el-55qcdj: steward turn ends every few seconds no longer burn the recovery cap within seconds', async () => {
    const s = await services();
    const stewardId = await reviewWithMergeSteward(s);
    const stewardResumes = () => s.resumes.filter((entry) => entry.agentId === stewardId).length;
    // Before the fix: three resumes in ~25 s, then mergeStatus=failed
    // ("Steward recovery limit reached after 3 attempts").
    for (const at_ of [4, 8, 12, 16, 20, 25, 30]) {
      at(at_);
      if (s.sessions.getActiveSession(stewardId)) await endTurn(s, stewardId);
      await s.daemon.recoverOrphanedAssignments();
    }
    const meta = metaOf(await current());
    expect(stewardResumes()).toBe(0);
    expect(meta.stewardRecoveryCount ?? 0).toBe(0);
    expect(meta.mergeStatus).not.toBe('failed');
    expect((await current()).assignee).toBe(stewardId);
  });

  test('steward: exponential delay after each quick session (60 s, 120 s, 240 s by default); the cap of 3 still applies over time', async () => {
    const s = await services();
    const stewardId = await reviewWithMergeSteward(s);
    const stewardResumes = () => s.resumes.filter((entry) => entry.agentId === stewardId).length;
    at(4);
    await endTurn(s, stewardId);
    // Each step: [time of recovery check (s), expected resumes after it].
    // Session starts: 0 → resume 1 at 65 → resume 2 at 190 → resume 3 at 435.
    const steps: Array<[number, number]> = [
      [50, 0], [65, 1],
      [70, 1], [180, 1], [190, 2],
      [195, 2], [420, 2], [435, 3],
    ];
    for (const [at_, expected] of steps) {
      at(at_);
      if (s.sessions.getActiveSession(stewardId) && stewardResumes() < expected) throw new Error('unexpected live session');
      if (s.sessions.getActiveSession(stewardId)) await endTurn(s, stewardId);
      await s.daemon.recoverOrphanedAssignments();
      expect(stewardResumes()).toBe(expected);
      expect(metaOf(await current()).stewardRecoveryCount ?? 0).toBe(expected);
    }
    expect(metaOf(await current()).mergeStatus).not.toBe('failed');
    // The third resumed session also ends quickly: the cap is reached (not bypassed by the backoff).
    at(440);
    await endTurn(s, stewardId);
    await s.daemon.recoverOrphanedAssignments();
    const failed = metaOf(await current());
    expect(failed.mergeStatus).toBe('failed');
    expect(failed.mergeFailureReason).toBe('Steward recovery limit reached after 3 attempts');
    expect(stewardResumes()).toBe(3);
  });

  test('worker: quick session ends are resumed only after the backoff, resumeCount counts real resumes; 0 disables', async () => {
    const s = await services();
    const workerId = worker.id as unknown as EntityId;
    expect(await s.claim()).toBe(true);
    at(5);
    await endTurn(s, workerId);
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(0);
    at(30);
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(0);
    expect(metaOf(await current()).resumeCount ?? 0).toBe(0);
    expect(s.resumes).toHaveLength(0);
    at(65);
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(1);
    expect(metaOf(await current()).resumeCount).toBe(1);
    // Second quick end: 120 s after the resumed session started.
    at(70);
    await endTurn(s, workerId);
    at(180);
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(0);
    at(190);
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(1);
    expect(metaOf(await current()).resumeCount).toBe(2);
    // Disabled: immediate resume, the previous behavior.
    s.daemon.updateConfig({ orphanResumeBackoffMs: 0 });
    at(195);
    await endTurn(s, workerId);
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(1);
    expect(metaOf(await current()).resumeCount).toBe(3);
  });

  test('a manual daemon wake after the quick session lifts the delay', async () => {
    const s = await services();
    const workerId = worker.id as unknown as EntityId;
    expect(await s.claim()).toBe(true);
    at(5);
    await endTurn(s, workerId);
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(0);
    at(10);
    s.daemon.wake();
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(1);
    expect(metaOf(await current()).resumeCount).toBe(1);
  });

  test('a session that ran longer than the delay (e.g. stopped as hung, or a long run before a crash) is resumed immediately', async () => {
    const s = await services();
    const workerId = worker.id as unknown as EntityId;
    expect(await s.claim()).toBe(true);
    at(600);
    await endTurn(s, workerId);
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(1);
    expect(metaOf(await current()).resumeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pure helper contracts
// ---------------------------------------------------------------------------

describe('liveness helpers', () => {
  test('orphan resume back-off: base * 2^attempts, capped at 30 min, 0 disables; long sessions wait 0', () => {
    expect([0, 1, 2, 3].map((n) => orphanResumeBackoffMs(n, MIN))).toEqual([MIN, 2 * MIN, 4 * MIN, 8 * MIN]);
    expect(orphanResumeBackoffMs(10, MIN)).toBe(30 * MIN);
    expect(orphanResumeBackoffMs(2, 0)).toBe(0);
    expect(orphanResumeWaitMs({ now: 10_000, lastSessionStartedAt: 5_000, previousAttempts: 0, baseMs: MIN })).toBe(55_000);
    expect(orphanResumeWaitMs({ now: 2 * MIN, lastSessionStartedAt: 0, previousAttempts: 0, baseMs: MIN })).toBe(0);
    expect(orphanResumeWaitMs({ now: 1, previousAttempts: 5, baseMs: MIN })).toBe(0);
  });

  test('classifyIdleSession uses the task-dependent threshold; 0 disables', () => {
    const base = { sessionIdleTimeoutMs: 30 * MIN, idleSessionWithoutTaskMs: 10 * MIN };
    expect(classifyIdleSession({ ...base, idleMs: 29 * MIN, hasAssignedTask: true })).toBe('active');
    expect(classifyIdleSession({ ...base, idleMs: 30 * MIN, hasAssignedTask: true })).toBe('hung');
    expect(classifyIdleSession({ ...base, idleMs: 10 * MIN, hasAssignedTask: false })).toBe('idle-without-task');
    expect(classifyIdleSession({ ...base, idleMs: 9 * MIN, hasAssignedTask: false })).toBe('active');
    expect(classifyIdleSession({ ...base, sessionIdleTimeoutMs: 0, idleMs: 1e9, hasAssignedTask: true })).toBe('active');
    expect(classifyIdleSession({ ...base, idleMs: Number.NaN, hasAssignedTask: true })).toBe('active');
  });

  test('evaluateHungSession: unchanged fingerprint increments, change resets, no baseline gives 0, released hold restarts', () => {
    const fp = computeProgressFingerprint({ title: 't', description: 'd', dependencies: [], commit: 'abc' });
    const moved = { ...fp, commit: 'def' };
    const at = '2026-11-01T00:00:00.000Z' as OrchestratorTaskMeta['handoffAt'];
    expect(evaluateHungSession(undefined, fp, 3).state.count).toBe(0);
    const one = evaluateHungSession({ noProgress: { count: 0, fingerprint: fp, evaluatedHandoffAt: at } }, fp, 3);
    expect(one.state).toEqual({ count: 1, fingerprint: fp, evaluatedHandoffAt: at });
    expect(evaluateHungSession({ noProgress: { count: 2, fingerprint: fp } }, fp, 3).hold).toBe(true);
    expect(evaluateHungSession({ noProgress: { count: 2, fingerprint: fp } }, fp, 0).hold).toBe(false);
    expect(evaluateHungSession({ noProgress: { count: 2, fingerprint: fp } }, moved, 3).state.count).toBe(0);
    const released = evaluateHungSession({ noProgress: { count: 3, fingerprint: fp }, dispatchHold: {} as never }, fp, 3);
    expect(released).toMatchObject({ holdReleased: true, hold: false, state: { count: 1 } });
  });

  test('watchdogSignature ignores order and duplicates', () => {
    expect(watchdogSignature(['b', 'a', 'a'], ['x@1'])).toBe(watchdogSignature(['a', 'b'], ['x@1']));
    expect(watchdogSignature(['a'], ['x@1'])).not.toBe(watchdogSignature(['a'], ['x@2']));
  });
});
