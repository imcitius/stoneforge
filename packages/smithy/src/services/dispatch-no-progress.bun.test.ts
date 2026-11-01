/**
 * Handoff/redispatch loop regressions (incident 2026-11-01, el-5jwe6q).
 *
 * Only temporary SQLite, temporary Git repositories (plus a bare origin) and an
 * inert provider double. The daemon is never started; its poll actions are
 * invoked at their deterministic boundaries.
 *
 * (a) Redispatch reuses the task's recorded branch/worktree, including after the
 *     failed-dispatch cleanup that cleared metadata.worktree in the incident.
 * (b) Consecutive no-progress handoffs stop automatic redispatch after the limit
 *     with exactly one Director notification; Director/Human changes reset it.
 * (c) Rate-limit and crash/resume paths neither increment nor reset the counter.
 * (d) el-2q3e2y: explicit start (WorkerTaskService.startWorkerOnTask) follows the
 *     same branch contract; an assignment that only recorded a generated branch
 *     name is materialized under that name (explicit start and orphan recovery).
 * (e) el-2q3e2y: assignToAgent merges orchestrator metadata and replaces only
 *     the documented assignment fields.
 */
import { beforeEach, afterEach, test, expect, describe } from 'bun:test';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createQuarryAPI, createInboxService, type QuarryAPI } from '@stoneforge/quarry';
import {
  createDocument, createEntity, createTask, ContentType, EntityTypeValue, TaskStatus,
  type Document, type DocumentId, type ElementId, type EntityId, type Task,
} from '@stoneforge/core';
import { createAgentRegistry, type AgentEntity } from './agent-registry.js';
import { createTaskAssignmentService } from './task-assignment-service.js';
import { createDispatchService } from './dispatch-service.js';
import { createDispatchDaemon, type DispatchDaemon } from './dispatch-daemon.js';
import { createWorkerTaskService } from './worker-task-service.js';
import { createSessionManager } from '../runtime/session-manager.js';
import type { SpawnerService, SpawnResult } from '../runtime/spawner.js';
import { createWorktreeManager } from '../git/worktree-manager.js';
import type { StewardScheduler } from './steward-scheduler.js';
import { getOrchestratorTaskMeta, updateOrchestratorTaskMeta, type OrchestratorTaskMeta } from '../types/task-meta.js';
import { stripHandoffNotes, evaluateNoProgress, computeProgressFingerprint } from './no-progress-guard.js';

let root: string, origin: string, db: StorageBackend, api: QuarryAPI;
let task: Task, worker: AgentEntity, director: AgentEntity, creator: EntityId, descriptionId: ElementId;
let handles: Map<string, { alive: boolean; events: EventEmitter }>;
let serial: number;
let spawner: SpawnerService;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=fixture@example.test', '-c', 'user.name=Fixture', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'sf-no-progress-'));
  origin = mkdtempSync(path.join(tmpdir(), 'sf-no-progress-origin-'));
  git(origin, 'init', '--bare', '-b', 'main');
  mkdirSync(path.join(root, '.stoneforge'));
  git(root, 'init', '-b', 'main');
  writeFileSync(path.join(root, 'README.md'), 'Isolated no-progress fixture\n');
  git(root, 'add', 'README.md'); git(root, 'commit', '-m', 'fixture');
  git(root, 'remote', 'add', 'origin', origin); git(root, 'push', '-q', 'origin', 'main');
  db = createStorage({ path: path.join(root, '.stoneforge/test.db') }); initializeSchema(db);
  api = createQuarryAPI(db);
  creator = (await api.create(await createEntity({ name: 'fixture-system', entityType: EntityTypeValue.SYSTEM, createdBy: 'system:test' as EntityId }) as never)).id as unknown as EntityId;
  const registry = createAgentRegistry(api);
  director = await registry.registerDirector({ name: 'director', createdBy: creator });
  worker = await registry.registerWorker({ name: 'c-worker-1', workerMode: 'ephemeral', createdBy: creator });
  const description = await api.create<Document>(await createDocument({
    contentType: ContentType.MARKDOWN, content: 'GUI acceptance needs an unlocked screen.', createdBy: director.id as unknown as EntityId,
  }) as never);
  descriptionId = description.id;
  task = await api.create<Task>(await createTask({
    title: 'Desktop getting started', createdBy: director.id as unknown as EntityId, descriptionRef: description.id as unknown as DocumentId,
  }) as never);
  serial = 0; handles = new Map();
  const spawn = async (agentId: EntityId, agentRole: string): Promise<SpawnResult> => {
    const id = `internal-${++serial}`;
    const events = new EventEmitter(); handles.set(id, { alive: true, events });
    return { session: { id, agentId, agentRole, provider: 'fixture', providerSessionId: `provider-${serial}`, mode: 'headless',
      status: 'running', workingDirectory: root, createdAt: task.createdAt, lastActivityAt: task.createdAt, startedAt: task.createdAt }, events } as SpawnResult;
  };
  spawner = {
    spawn, resume: spawn,
    getSession: (id: string) => ({ status: handles.get(id)?.alive ? 'running' : 'terminated' }),
    terminate: async (id: string) => { const handle = handles.get(id); if (handle) handle.alive = false; },
  } as unknown as SpawnerService;
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); rmSync(origin, { recursive: true, force: true }); });

async function services(config: { noProgressHandoffLimit?: number; orphanResumeBackoffMs?: number } = {}) {
  const registry = createAgentRegistry(api);
  const assignment = createTaskAssignmentService(api);
  const dispatch = createDispatchService(api, assignment, registry);
  const sessions = createSessionManager(spawner, api, registry);
  const worktrees = createWorktreeManager({ workspaceRoot: root, defaultBaseBranch: 'main' });
  await worktrees.initWorkspace();
  const inbox = createInboxService(db);
  const daemon: DispatchDaemon = createDispatchDaemon(api, registry, sessions, dispatch, worktrees, assignment,
    {} as StewardScheduler, inbox, { projectRoot: root, ...config });
  const claim = () => (daemon as unknown as { assignTaskToWorker(w: AgentEntity): Promise<boolean> }).assignTaskToWorker(worker);
  const release = () => (daemon as unknown as { releaseNoProgressHolds(): Promise<number> }).releaseNoProgressHolds();
  /** Worker hands off through the real ownership-checked service, then its session ends. */
  const handoff = async (message = 'Blocked: IOConsoleLocked=Yes; needs an unlocked GUI. Director notified.') => {
    const meta = metaOf((await api.get<Task>(task.id))!);
    const sessionId = meta.sessionHistory![meta.sessionHistory!.length - 1].sessionId;
    await assignment.handoffTask(task.id, { sessionId, message });
    await sessions.stopSession(sessionId, { graceful: false, reason: 'handoff' }).catch(() => undefined);
  };
  const workerTasks = createWorkerTaskService(api, assignment, registry, dispatch, spawner, sessions, worktrees);
  /** Explicit start (HTTP start-worker / API) for the fixture worker. */
  const start = (options?: Parameters<typeof workerTasks.startWorkerOnTask>[2]) =>
    workerTasks.startWorkerOnTask(task.id, worker.id as unknown as EntityId, options);
  return { registry, assignment, dispatch, sessions, worktrees, daemon, inbox, claim, release, handoff, start };
}

const metaOf = (t: Task) => getOrchestratorTaskMeta(t.metadata as Record<string, unknown>) as OrchestratorTaskMeta;
const current = async () => (await api.get<Task>(task.id))!;
const holdMessages = () => db.query<{ id: string }>(
  "SELECT e.id FROM elements e JOIN tags t ON t.element_id = e.id WHERE e.type = 'message' AND t.tag = 'dispatch-hold' ORDER BY e.id"
);
const taskBranches = () => git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter((b) => b.includes(task.id));
const commitIn = (worktree: string, file: string) => {
  writeFileSync(path.join(worktree, file), `${file}\n`);
  git(worktree, 'add', file); git(worktree, 'commit', '-q', '-m', `work ${file}`);
  return git(worktree, 'rev-parse', 'HEAD');
};

// ---------------------------------------------------------------------------
// (a) Branch/worktree reuse
// ---------------------------------------------------------------------------

describe('(a) redispatch preserves the task branch', () => {
  test('incident sequence: failed-dispatch cleanup after handoff redispatch keeps the reviewed branch', async () => {
    const s = await services();
    expect(await s.claim()).toBe(true);
    const first = metaOf(await current());
    const reviewed = commitIn(first.worktree!, 'reviewed.txt');
    await s.handoff();

    // Redispatch whose notification fails after the assignment committed: the
    // exact incident event pair (assign drops handoffBranch; cleanup clears worktree).
    const originalCreate = api.create.bind(api);
    let failNextMessage = true;
    (api as unknown as { create: typeof api.create }).create = (async (element: Record<string, unknown>) => {
      if (failNextMessage && element.type === 'message') {
        failNextMessage = false;
        throw new Error('UNIQUE constraint failed: elements.id');
      }
      return originalCreate(element as never);
    }) as typeof api.create;
    await expect(s.claim()).rejects.toThrow('UNIQUE constraint failed');
    (api as unknown as { create: typeof api.create }).create = originalCreate;
    const afterCleanup = metaOf(await current());
    expect((await current()).assignee).toBeUndefined();
    expect(afterCleanup.branch).toBe(first.branch);
    expect(afterCleanup.worktree).toBeUndefined();
    expect(afterCleanup.handoffBranch).toBeUndefined();
    for (const [id, handle] of handles) if (handle.alive) await s.sessions.stopSession(id, { graceful: false }).catch(() => undefined);

    // Next dispatch: previously created agent/c-worker-1-<uuid>/... from main.
    expect(await s.claim()).toBe(true);
    const redispatched = metaOf(await current());
    expect(redispatched.branch).toBe(first.branch);
    expect(realpathSync(redispatched.worktree!)).toBe(realpathSync(first.worktree!));
    expect(git(redispatched.worktree!, 'rev-parse', 'HEAD')).toBe(reviewed);
    expect(taskBranches()).toEqual([first.branch!]);
  });

  test('handoff worktree removed from disk: a new worktree attaches the same branch and commits', async () => {
    const s = await services();
    expect(await s.claim()).toBe(true);
    const first = metaOf(await current());
    const work = commitIn(first.worktree!, 'work.txt');
    await s.handoff('Context full; continue from work.txt');
    git(root, 'worktree', 'remove', '--force', first.worktree!);
    expect(existsSync(first.worktree!)).toBe(false);

    expect(await s.claim()).toBe(true);
    const next = metaOf(await current());
    expect(next.branch).toBe(first.branch);
    expect(next.worktree).not.toBe(first.worktree);
    expect(git(next.worktree!, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(first.branch);
    expect(git(next.worktree!, 'rev-parse', 'HEAD')).toBe(work);
    expect(taskBranches()).toEqual([first.branch!]);
  });

  test('branch only on origin: recreated from the origin tip, never from main', async () => {
    const s = await services();
    expect(await s.claim()).toBe(true);
    const first = metaOf(await current());
    const pushed = commitIn(first.worktree!, 'pushed.txt');
    git(first.worktree!, 'push', '-q', 'origin', first.branch!);
    await s.handoff('Pushed; continue');
    git(root, 'worktree', 'remove', '--force', first.worktree!);
    git(root, 'branch', '-D', first.branch!);

    expect(await s.claim()).toBe(true);
    const next = metaOf(await current());
    expect(next.branch).toBe(first.branch);
    expect(git(next.worktree!, 'rev-parse', 'HEAD')).toBe(pushed);
  });

  test('recorded branch missing everywhere: candidate skipped, metadata and refs unchanged', async () => {
    const s = await services();
    expect(await s.claim()).toBe(true);
    const first = metaOf(await current());
    await s.handoff('Stopping');
    git(root, 'worktree', 'remove', '--force', first.worktree!);
    git(root, 'branch', '-D', first.branch!);
    const before = await current();

    expect(await s.claim()).toBe(false);
    expect(await current()).toEqual(before);
    expect(taskBranches()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (b) No-progress backoff
// ---------------------------------------------------------------------------

describe('(b) no-progress handoff loop stops', () => {
  test('stops after N=3 no-progress handoffs with exactly one Director notification', async () => {
    const s = await services();
    for (let i = 1; i <= 3; i++) {
      expect(await s.claim()).toBe(true);
      await s.handoff();
    }
    // 4th automatic redispatch is refused and the task deferred with a flag.
    expect(await s.claim()).toBe(false);
    const held = await current();
    const meta = metaOf(held);
    expect(held.status).toBe(TaskStatus.DEFERRED);
    expect(held.assignee).toBeUndefined();
    expect(meta.noProgress?.count).toBe(3);
    expect(meta.dispatchHold).toMatchObject({ count: 3, limit: 3, directorId: director.id });
    expect(meta.dispatchHold?.reason).toContain('3 consecutive handoffs without progress');
    expect(meta.dispatchHold?.notificationMessageId).toBe(holdMessages()[0].id);
    // Branch preserved throughout.
    expect(taskBranches()).toHaveLength(1);

    // Repeated polls never redispatch or notify again.
    for (let i = 0; i < 5; i++) {
      expect(await s.claim()).toBe(false);
      await s.daemon.pollWorkerAvailability();
      expect(await s.release()).toBe(0);
    }
    expect(holdMessages()).toHaveLength(1);
    const inbox = s.inbox.getInbox(director.id as unknown as EntityId, {});
    expect(inbox.filter((item) => item.messageId === holdMessages()[0].id)).toHaveLength(1);
    const content = await api.get<Document>((await api.get<{ contentRef: ElementId } & Task>(holdMessages()[0].id as ElementId))!.contentRef);
    expect(content!.content).toContain(`Task ID: ${task.id}`);
    expect(content!.content).toContain('c-worker-1');
    expect(content!.content).toContain(`sf task undefer ${task.id}`);
  });

  test('a new commit on the task branch between handoffs resets the count', async () => {
    const s = await services();
    for (let i = 1; i <= 5; i++) {
      expect(await s.claim()).toBe(true);
      if (i % 2 === 0) commitIn(metaOf(await current()).worktree!, `progress-${i}.txt`);
      await s.handoff(`Handoff ${i}`);
    }
    expect(await s.claim()).toBe(true);
    expect(metaOf(await current()).noProgress?.count).toBeLessThan(3);
    expect(holdMessages()).toHaveLength(0);
  });

  test('limit 0 disables the guard (legacy behavior)', async () => {
    const s = await services({ noProgressHandoffLimit: 0 });
    for (let i = 1; i <= 4; i++) {
      expect(await s.claim()).toBe(true);
      await s.handoff();
    }
    expect(await s.claim()).toBe(true);
    expect(holdMessages()).toHaveLength(0);
  });

  async function holdTask(s: Awaited<ReturnType<typeof services>>) {
    for (let i = 1; i <= 3; i++) { expect(await s.claim()).toBe(true); await s.handoff(); }
    expect(await s.claim()).toBe(false);
    expect((await current()).status).toBe(TaskStatus.DEFERRED);
  }

  test('Director undefer resets: redispatch resumes and only a new hold notifies again', async () => {
    const s = await services();
    await holdTask(s);
    const held = await current();
    await api.update<Task>(task.id, { status: TaskStatus.OPEN }, { expectedUpdatedAt: held.updatedAt, actor: director.id as unknown as EntityId });

    expect(await s.claim()).toBe(true);
    const resumed = metaOf(await current());
    expect(resumed.noProgress?.count).toBe(0);
    expect(resumed.dispatchHold).toBeUndefined();
    await s.handoff();
    expect(await s.claim()).toBe(true);
    await s.handoff();
    expect(await s.claim()).toBe(true);
    expect(holdMessages()).toHaveLength(1);
    await s.handoff();
    expect(await s.claim()).toBe(false);
    expect(holdMessages()).toHaveLength(2);
  });

  test('Director description append while deferred releases the hold and resets', async () => {
    const s = await services();
    await holdTask(s);
    expect(await s.release()).toBe(0);
    const doc = (await api.get<Document>(descriptionId))!;
    await api.update<Document>(descriptionId, { content: `${doc.content}\n\nDirector: GUI is unlocked now; run check-app once.` } as Partial<Document>,
      { expectedUpdatedAt: doc.updatedAt, actor: director.id as unknown as EntityId });
    expect(await s.release()).toBe(1);
    const released = await current();
    expect(released.status).toBe(TaskStatus.OPEN);
    expect(metaOf(released).dispatchHold).toBeUndefined();
    expect(metaOf(released).noProgress?.count).toBe(0);
    expect(await s.claim()).toBe(true);
    expect(holdMessages()).toHaveLength(1);
  });

  test('Director dependency change while deferred releases the hold', async () => {
    const s = await services();
    await holdTask(s);
    const blocker = await api.create<Task>(await createTask({ title: 'Unlock GUI (Human)', createdBy: director.id as unknown as EntityId }) as never);
    await api.addDependency({ blockedId: task.id, blockerId: blocker.id, type: 'blocks', createdBy: director.id as unknown as EntityId });
    expect(await s.release()).toBe(1);
    expect((await current()).status).toBe(TaskStatus.OPEN);
    // Blocked by the new dependency: not dispatchable until the blocker closes.
    expect((await api.ready()).map((t) => t.id)).not.toContain(task.id);
    expect(metaOf(await current()).noProgress?.count).toBe(0);
  });

  test('explicit Director assignment resets the counter and clears the hold', async () => {
    const s = await services();
    await holdTask(s);
    await s.assignment.assignToAgent(task.id, worker.id as unknown as EntityId, { markAsStarted: true });
    const assigned = metaOf(await current());
    expect(assigned.noProgress).toBeUndefined();
    expect(assigned.dispatchHold).toBeUndefined();
    expect(assigned.branch).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// (c) Rate-limit / crash paths unchanged
// ---------------------------------------------------------------------------

describe('(c) rate-limit and crash paths do not touch the counter', () => {
  test('all executables rate-limited: no dispatch, counter and status unchanged, no notification', async () => {
    const s = await services();
    for (let i = 1; i <= 2; i++) { expect(await s.claim()).toBe(true); await s.handoff(); }
    const before = await current();
    s.daemon.handleRateLimitDetected('claude', new Date(Date.now() + 60 * 60 * 1000));
    for (let i = 0; i < 3; i++) expect(await s.claim()).toBe(false);
    const after = await current();
    expect(after.status).toBe(before.status);
    expect(metaOf(after).noProgress).toEqual(metaOf(before).noProgress);
    expect(metaOf(after).dispatchHold).toBeUndefined();
    expect(holdMessages()).toHaveLength(0);
  });

  test('crash + orphan resume (no handoff) keeps the counter; resumeCount logic unchanged', async () => {
    // Counter semantics only: the session crashes right after it started, which the
    // orphan resume back-off (el-4dcv06, covered in dispatch-liveness) would delay.
    const s = await services({ orphanResumeBackoffMs: 0 });
    expect(await s.claim()).toBe(true); await s.handoff();
    expect(await s.claim()).toBe(true);
    const beforeCrash = metaOf(await current());
    expect(beforeCrash.noProgress?.count).toBe(1);
    // Session crashes without complete/handoff.
    const sessionId = beforeCrash.sessionHistory![beforeCrash.sessionHistory!.length - 1].sessionId;
    await s.sessions.stopSession(sessionId, { graceful: false, reason: 'crash' });
    const recovered = await s.daemon.recoverOrphanedAssignments();
    expect(recovered.processed).toBe(1);
    const afterRecovery = metaOf(await current());
    expect(afterRecovery.resumeCount).toBe(1);
    expect(afterRecovery.noProgress).toEqual(beforeCrash.noProgress);
    expect(afterRecovery.branch).toBe(beforeCrash.branch);
    expect(holdMessages()).toHaveLength(0);
  });

  test('rapid exit with an explicit limit message rolls back resumeCount only; counter untouched', async () => {
    // Counter semantics only: the session crashes right after it started, which the
    // orphan resume back-off (el-4dcv06, covered in dispatch-liveness) would delay.
    const s = await services({ orphanResumeBackoffMs: 0 });
    expect(await s.claim()).toBe(true); await s.handoff();
    expect(await s.claim()).toBe(true);
    const beforeCrash = metaOf(await current());
    const sessionId = beforeCrash.sessionHistory![beforeCrash.sessionHistory!.length - 1].sessionId;
    await s.sessions.stopSession(sessionId, { graceful: false, reason: 'crash' });
    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(1);
    expect(metaOf(await current()).resumeCount).toBe(1);
    const resumed = [...handles.entries()].filter(([, handle]) => handle.alive).map(([, handle]) => handle);
    expect(resumed).toHaveLength(1);
    resumed[0].events.emit('event', { type: 'assistant', message: "You've hit your usage limit · resets 3pm" });
    resumed[0].events.emit('exit', 1, null);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = metaOf(await current());
    expect(after.resumeCount).toBe(0);
    expect(after.noProgress).toEqual(beforeCrash.noProgress);
    expect(s.daemon.getRateLimitStatus().limits.length).toBeGreaterThan(0);
    expect(holdMessages()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (d) Explicit start keeps the recorded branch (el-2q3e2y)
// ---------------------------------------------------------------------------

const stopAll = async (s: Awaited<ReturnType<typeof services>>) => {
  for (const [id, handle] of handles) if (handle.alive) await s.sessions.stopSession(id, { graceful: false }).catch(() => undefined);
};

describe('(d) explicit start keeps the recorded task branch', () => {
  test('after a handoff: reuses the recorded worktree and branch with its commits', async () => {
    const s = await services();
    expect(await s.claim()).toBe(true);
    const first = metaOf(await current());
    const work = commitIn(first.worktree!, 'work.txt');
    await s.handoff('Context full; continue from work.txt');

    const result = await s.start();
    const meta = metaOf(await current());
    expect(meta.branch).toBe(first.branch);
    expect(realpathSync(meta.worktree!)).toBe(realpathSync(first.worktree!));
    expect(result.worktree?.branchCreated).toBe(false);
    expect(git(meta.worktree!, 'rev-parse', 'HEAD')).toBe(work);
    expect(taskBranches()).toEqual([first.branch!]);
  });

  test('worktree gone and cleared from metadata by unassign: a new worktree attaches the same branch', async () => {
    const s = await services();
    expect(await s.claim()).toBe(true);
    const first = metaOf(await current());
    const work = commitIn(first.worktree!, 'work.txt');
    await stopAll(s);
    // The incident state: worktree cleared from metadata, directory removed.
    await s.assignment.unassignTask(task.id, { mode: 'admin' });
    git(root, 'worktree', 'remove', '--force', first.worktree!);
    expect(metaOf(await current()).worktree).toBeUndefined();

    await s.start();
    const meta = metaOf(await current());
    expect(meta.branch).toBe(first.branch);
    expect(meta.worktree).not.toBe(first.worktree);
    expect(git(meta.worktree!, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(first.branch);
    expect(git(meta.worktree!, 'rev-parse', 'HEAD')).toBe(work);
    expect(taskBranches()).toEqual([first.branch!]);
  });

  test('branch only on origin: attached from the origin tip, never from main', async () => {
    const s = await services();
    expect(await s.claim()).toBe(true);
    const first = metaOf(await current());
    const pushed = commitIn(first.worktree!, 'pushed.txt');
    git(first.worktree!, 'push', '-q', 'origin', first.branch!);
    await s.handoff('Pushed; continue');
    git(root, 'worktree', 'remove', '--force', first.worktree!);
    git(root, 'branch', '-D', first.branch!);

    await s.start();
    const meta = metaOf(await current());
    expect(meta.branch).toBe(first.branch);
    expect(git(meta.worktree!, 'rev-parse', 'HEAD')).toBe(pushed);
  });

  test('recorded branch with prior work missing everywhere: refused, nothing assigned or created', async () => {
    const s = await services();
    expect(await s.claim()).toBe(true);
    const first = metaOf(await current());
    await s.handoff('Stopping');
    git(root, 'worktree', 'remove', '--force', first.worktree!);
    git(root, 'branch', '-D', first.branch!);
    const before = await current();

    await expect(s.start()).rejects.toThrow('no longer exists locally or on origin');
    const after = await current();
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.assignee).toBeUndefined();
    expect(taskBranches()).toEqual([]);
  });

  test('an explicitly requested different branch is honoured as an override', async () => {
    const s = await services();
    expect(await s.claim()).toBe(true);
    const first = metaOf(await current());
    await s.handoff('Restart on a new branch');
    await s.start({ branch: 'agent/explicit/override' });
    expect(metaOf(await current()).branch).toBe('agent/explicit/override');
    expect(taskBranches()).toEqual([first.branch!]);
  });

  test('assignment that only recorded a generated name: explicit start creates that branch', async () => {
    const s = await services();
    await s.assignment.assignToAgent(task.id, worker.id as unknown as EntityId);
    const recorded = metaOf(await current()).branch!;
    expect(taskBranches()).toEqual([]);

    const result = await s.start();
    expect(result.worktree?.branch).toBe(recorded);
    expect(metaOf(await current()).branch).toBe(recorded);
    expect(git(result.worktree!.path, 'rev-parse', 'HEAD')).toBe(git(root, 'rev-parse', 'main'));
  });

  test('manual dispatch without a worktree: orphan recovery creates the recorded branch name', async () => {
    const s = await services();
    await s.dispatch.dispatch(task.id, worker.id as unknown as EntityId, { markAsStarted: true });
    const recorded = metaOf(await current()).branch!;
    expect(taskBranches()).toEqual([]);

    expect((await s.daemon.recoverOrphanedAssignments()).processed).toBe(1);
    const meta = metaOf(await current());
    expect(meta.branch).toBe(recorded);
    expect(git(meta.worktree!, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(recorded);
  });
});

// ---------------------------------------------------------------------------
// (e) assignToAgent merges orchestrator metadata (el-2q3e2y)
// ---------------------------------------------------------------------------

/** Documented assignment-owned fields; every other field must survive. */
const ASSIGNMENT_RESETS = [
  'assignedAgent', 'branch', 'worktree', 'sessionId', 'mergeStatus', 'startedAt',
  'handoffBranch', 'handoffWorktree', 'noProgress', 'dispatchHold',
].sort();

const unrelated = {
  resumeCount: 2,
  reportedIssues: ['test_failure'],
  lastCommitHash: 'abc1234',
  completedAt: '2026-11-01T01:00:00.000Z',
  completionSummary: 'first attempt',
  mergeRequestUrl: 'https://example.test/pr/7',
  mergeRequestId: 7,
  mergeRequestProvider: 'github',
  mergeFailureReason: 'Tests failed',
  stewardRecoveryCount: 1,
  reconciliationCount: 1,
  stuckMergeRecoveryCount: 1,
  testRunCount: 3,
  lastTestResult: { passed: false, completedAt: '2026-11-01T01:05:00.000Z' },
  lastSyncResult: { success: true, conflicts: [], message: 'synced', syncedAt: '2026-11-01T01:06:00.000Z' },
  owningDirector: 'el-director',
  targetBranch: 'main',
  handoffAt: '2026-11-01T02:00:00.000Z',
  handoffFrom: 'el-previous',
  lastSessionId: 'previous-provider',
  handoffHistory: [{ sessionId: 'previous-provider', message: 'note', handoffAt: '2026-11-01T02:00:00.000Z' }],
} as unknown as Partial<OrchestratorTaskMeta>;

async function seedMetadata(extra: Partial<OrchestratorTaskMeta>) {
  const t = await current();
  await api.update<Task>(task.id, { metadata: updateOrchestratorTaskMeta(t.metadata as Record<string, unknown>, { ...unrelated, ...extra }) });
}

const changedKeys = (before: OrchestratorTaskMeta, after: OrchestratorTaskMeta) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => JSON.stringify((before as Record<string, unknown>)[key]) !== JSON.stringify((after as Record<string, unknown>)[key]))
    .sort();

describe('(e) assignToAgent merges orchestrator metadata', () => {
  test('explicit assignment keeps unrelated fields and replaces only the documented ones', async () => {
    const s = await services();
    await seedMetadata({
      branch: 'agent/old/el-x-task', worktree: '/old/worktree', sessionId: 'old-session', mergeStatus: 'test_failed',
      startedAt: '2026-11-01T00:00:00.000Z' as OrchestratorTaskMeta['startedAt'],
      handoffBranch: 'agent/old/el-x-task', handoffWorktree: '/old/worktree',
      noProgress: { count: 1 }, dispatchHold: { reason: 'held' },
    } as unknown as Partial<OrchestratorTaskMeta>);
    const before = metaOf(await current());

    await s.assignment.assignToAgent(task.id, worker.id as unknown as EntityId);
    const after = metaOf(await current());
    for (const [key, value] of Object.entries(unrelated)) expect((after as Record<string, unknown>)[key]).toEqual(value);
    expect(changedKeys(before, after).every((key) => ASSIGNMENT_RESETS.includes(key))).toBe(true);
    expect(after).toMatchObject({ assignedAgent: worker.id, branch: 'agent/old/el-x-task', worktree: '/old/worktree', mergeStatus: 'pending' });
    for (const key of ['sessionId', 'startedAt', 'handoffBranch', 'handoffWorktree', 'noProgress', 'dispatchHold']) {
      expect((after as Record<string, unknown>)[key]).toBeUndefined();
    }
  });

  test('automatic claim keeps unrelated fields', async () => {
    const s = await services();
    await seedMetadata({});
    expect(await s.claim()).toBe(true);
    const after = metaOf(await current());
    for (const [key, value] of Object.entries(unrelated)) expect((after as Record<string, unknown>)[key]).toEqual(value);
  });

  test('a recorded branch without a pending handoff is kept on reassignment', async () => {
    const s = await services();
    expect(await s.claim()).toBe(true);
    const first = metaOf(await current());
    await stopAll(s);
    await s.assignment.unassignTask(task.id, { mode: 'admin' });
    await s.assignment.assignToAgent(task.id, director.id as unknown as EntityId);
    expect(metaOf(await current()).branch).toBe(first.branch);
  });

  test('the service exports exactly the documented reset list', async () => {
    const module = await import('./task-assignment-service.js') as { ASSIGNMENT_RESET_FIELDS?: readonly string[] };
    expect([...(module.ASSIGNMENT_RESET_FIELDS ?? [])].sort()).toEqual(ASSIGNMENT_RESETS);
  });
});

// ---------------------------------------------------------------------------
// Pure helper contracts
// ---------------------------------------------------------------------------

describe('no-progress helpers', () => {
  test('stripHandoffNotes removes exact multi-line notes and single-line leftovers only', () => {
    const base = 'Original description';
    const multi = 'Line one\nLine two';
    const content = `${base}\n\n[AGENT HANDOFF NOTE]: ${multi}\n\n[AGENT HANDOFF NOTE]: legacy note\n\nDirector: new instruction`;
    expect(stripHandoffNotes(content, [{ message: multi }])).toBe(`${base}\n\nDirector: new instruction`);
  });

  test('evaluateNoProgress counts each handoff once and needs a baseline', () => {
    const fp = computeProgressFingerprint({ title: 't', description: 'd', dependencies: [], commit: 'abc' });
    const at = '2026-11-01T00:00:00.000Z' as OrchestratorTaskMeta['handoffAt'];
    expect(evaluateNoProgress({ handoffAt: at }, fp, 3).state.count).toBe(0);
    const once = evaluateNoProgress({ handoffAt: at, noProgress: { count: 1, fingerprint: fp } }, fp, 3);
    expect(once.state.count).toBe(2);
    const again = evaluateNoProgress({ handoffAt: at, noProgress: once.state }, fp, 3);
    expect(again.state.count).toBe(2);
    const moved = computeProgressFingerprint({ title: 't', description: 'd', dependencies: [], commit: 'def' });
    expect(evaluateNoProgress({ handoffAt: '2026-11-01T00:01:00.000Z' as typeof at, noProgress: once.state }, moved, 3).state.count).toBe(0);
    expect(evaluateNoProgress({ handoffAt: '2026-11-01T00:01:00.000Z' as typeof at, noProgress: once.state }, fp, 3).hold).toBe(true);
  });
});

