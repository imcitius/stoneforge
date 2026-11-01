/**
 * Adapted from the steward overlap probe (original + no-release control retained
 * in docs/workspace/http-session-start-review-20261101). Real HTTP/API/SQLite/Git/
 * SessionManager; only provider handles and deterministic timing are fixtures.
 */
import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createTask, createEntity, EntityTypeValue, type Task, type EntityId, type Timestamp } from '@stoneforge/core';
import { createOrchestratorAPI, type OrchestratorAPI } from './orchestrator-api.js';
import { createAgentRegistry } from '../services/agent-registry.js';
import { createTaskAssignmentService } from '../services/task-assignment-service.js';
import { getOrchestratorTaskMeta } from '../types/task-meta.js';
import { createSessionManager } from '../runtime/session-manager.js';
import type { SpawnerService, SpawnResult } from '../runtime/spawner.js';
import { createWorktreeManager } from '../git/worktree-manager.js';
import { createSessionRoutes as sdkRoutes } from '../server/routes/sessions.js';
import { createSessionRoutes as appRoutes } from '../../../../apps/smithy-server/src/routes/sessions.js';

let root: string, repo: string, storage: StorageBackend, otherStorage: StorageBackend;
let api: OrchestratorAPI, other: OrchestratorAPI, task: Task, owner: EntityId, successor: EntityId;
const future = '2099-01-01T00:00:00.000Z' as Timestamp;
const meta = (t: Task) => getOrchestratorTaskMeta(t.metadata)!;
const events = () => storage.query('SELECT * FROM events ORDER BY id');
const saved = async () => (await other.get<Task>(task.id))!;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'sf-api-assignment-'));
  mkdirSync(path.join(root, '.stoneforge'));
  repo = path.join(root, 'repo'); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false'); git('commit', '--allow-empty', '-qm', 'initial');
  const db = path.join(root, '.stoneforge/stoneforge.db');
  storage = createStorage({ path: db }); initializeSchema(storage);
  otherStorage = createStorage({ path: db });
  api = createOrchestratorAPI(storage); other = createOrchestratorAPI(otherStorage);
  const raw = await createEntity({ name: 'test-system', entityType: EntityTypeValue.SYSTEM, createdBy: 'system:test' as EntityId });
  const creator = (await api.create(raw as unknown as Parameters<OrchestratorAPI['create']>[0])).id as unknown as EntityId;
  owner = (await api.registerWorker({ name: 'owner', workerMode: 'ephemeral', createdBy: creator })).id as unknown as EntityId;
  successor = (await api.registerWorker({ name: 'successor', workerMode: 'ephemeral', createdBy: creator })).id as unknown as EntityId;
  const rawTask = await createTask({ title: 'Explicit assignment fixture', createdBy: creator });
  task = await api.create<Task>(rawTask as unknown as Parameters<OrchestratorAPI['create']>[0]);
  task = await api.update<Task>(task.id, { assignee: owner, scheduledFor: future, deadline: future, metadata: { retained: 'outer', orchestrator: {
    assignedAgent: owner, branch: 'main', worktree: repo, sessionId: 'internal-old', targetBranch: 'main',
    handoffHistory: [{ sessionId: 'older', message: 'retained', handoffAt: task.createdAt }],
    sessionHistory: [{ sessionId: 'internal-old', agentId: owner, agentName: 'owner', agentRole: 'worker', startedAt: task.createdAt }],
    completionHistory: [{ operationId: 'archived', taskVersion: task.updatedAt, phase: 'finalized', mode: 'worker', agentId: owner, sessionId: 'older', push: false, createMR: false, baseBranch: 'main', title: 'previous completion', body: 'audit' }], retainedExtension: 'inner',
  } } });
});
afterEach(() => { storage.close(); otherStorage.close(); rmSync(root, { recursive: true, force: true }); });

async function harness(routes: typeof sdkRoutes, stage: string) {
  await api.updateAgentMetadata(successor, { workerMode: 'persistent' });
  const registry = createAgentRegistry(api);
  const assignment = createTaskAssignmentService(api);
  const trees = createWorktreeManager({ workspaceRoot: repo, defaultBaseBranch: 'main' });
  await trees.initWorkspace();
  const prepare = () => trees.createWorktree({ agentName: 'http-worker', taskId: task.id, customBranch: 'http-prepared', customPath: '.stoneforge/worktrees/http-prepared' });
  const reusable = stage === 'reused' ? await prepare() : undefined;
  let prepared: string | undefined;
  if (reusable) writeFileSync(path.join(reusable.worktree.path, 'existing.txt'), 'preexisting reusable resource');
  let starts = 0, stops = 0, notices = 0, preparations = 0;
  let duringSpawn: (() => Promise<void>) | undefined;
  let duringStop: (() => Promise<void>) | undefined;
  const handles = new Map<string, boolean>();
  const spawner = {
    async spawn(agentId: EntityId, agentRole: string) {
      const sequence = ++starts;
      await duringSpawn?.();
      if (['spawn', 'reused'].includes(stage)) throw new Error('fixture: spawn failed');
      const id = `http-${stage}${sequence > 1 ? `-${sequence}` : ''}`;
      handles.set(id, true);
      const emitter = new EventEmitter();
      if (stage === 'listeners') emitter.on = () => { throw new Error('fixture: listener installation failed'); };
      return { session: { id, agentId, agentRole, provider: 'fixture', mode: 'headless', status: 'running',
        workingDirectory: prepared, createdAt: task.createdAt, lastActivityAt: task.createdAt, startedAt: task.createdAt }, events: emitter } as SpawnResult;
    },
    getSession(id: string) { return { status: handles.get(id) ? 'running' : 'terminated' }; },
    async terminate(id: string) { stops++; await duringStop?.(); if (stage === 'terminate') throw new Error('fixture: terminate failed'); handles.set(id, false); },
  } as unknown as SpawnerService;
  const sessions = createSessionManager(spawner, api, registry);
  const persist = sessions.persistSession.bind(sessions);
  let persistenceCalls = 0;
  sessions.persistSession = async id => {
    if (++persistenceCalls === 1 && ['persist', 'terminate', 'rollback-persist'].includes(stage)) throw new Error('fixture: persist failed');
    if (stage === 'rollback-persist') throw new Error('fixture: rollback persistence outcome unknown');
    return persist(id);
  };
  const services = { api, orchestratorApi: api, agentRegistry: registry, taskAssignmentService: assignment,
    sessionManager: sessions, sessionInitialPrompts: new Map(),
    sessionMessageService: { saveMessage() { if (stage === 'save') throw new Error('fixture: save failed'); } },
    worktreeManager: { async createWorktree() {
      preparations++;
      const result = reusable ?? await prepare();
      prepared = result.worktree.path;
      writeFileSync(path.join(prepared, 'retained.txt'), 'successor or reusable data');
      if (stage === 'prepare') throw new Error('fixture: prepare failed after creating path');
      return result;
    } },
  } as unknown as Parameters<typeof sdkRoutes>[0];
  const makeRoute = (factory: typeof sdkRoutes) => factory(services, () => {
    notices++; if (stage === 'notify') throw new Error('fixture: notify failed');
  });
  const route = makeRoute(routes);
  const send = (target: ReturnType<typeof sdkRoutes>, agent = successor, taskId: string | undefined = task.id) =>
    target.request(`/api/agents/${agent}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId, interactive: false }) });
  const request = () => send(route);
  // A fresh route factory with the same manager must share admission too.
  const contender = (factory: typeof sdkRoutes, agent = successor, taskId?: string) => send(makeRoute(factory), agent, taskId);

  return { request, contender, setStage(value: string) { stage = value; }, assignment, sessions, registry, handles, spawner, onSpawn(fn: () => Promise<void>) { duringSpawn = fn; }, onStop(fn: () => Promise<void>) { duringStop = fn; },
    stats: () => ({ starts, stops, notices, preparations }), retained() {
      expect(prepared).toBeDefined(); expect(existsSync(prepared!)).toBe(true);
      if (reusable) expect(readFileSync(path.join(prepared!, 'existing.txt'), 'utf8')).toBe('preexisting reusable resource');
      expect(readFileSync(path.join(prepared!, 'retained.txt'), 'utf8')).toBe('successor or reusable data');
      expect(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toContain(prepared!);
    } };
}


for (const [label, routes] of [['sdk', sdkRoutes], ['app', appRoutes]] as const) {
  test(`${label}: independent published-session log rejection keeps exact assignment and events`, async () => {
    const h = await harness(routes, 'success');
    const diagnostics = spyOn(console, 'error').mockImplementation(() => {});
    let beforeLog: unknown, beforeEvents: unknown;
    h.sessions.setOperationLog({ write(_level, _category, message) {
      if (message.startsWith('Session started')) {
        beforeLog = storage.query('SELECT * FROM elements WHERE id = ?', [task.id]);
        beforeEvents = events();
        throw new Error('independent: post-publication logger rejection');
      }
    }, query() { return []; }, prune() { return 0; } });
    try {
      const response = await h.request();
      const body = await response.json();
      expect(response.status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.session.id).toBe('http-success');
      expect(h.handles.get(body.session.id)).toBe(true);
      expect(h.sessions.getActiveSession(successor)?.id).toBe(body.session.id);
      expect((await other.getAgent(successor))!.metadata.agent).toMatchObject({ currentSessionId: body.session.id, sessionStatus: 'running' });
      expect((await saved()).assignee).toBe(successor);
      expect(storage.query('SELECT * FROM elements WHERE id = ?', [task.id])).toEqual(beforeLog);
      expect(events()).toEqual(beforeEvents);
      expect(h.stats().stops).toBe(0);
      expect(diagnostics.mock.calls.some(args => String(args[0]).includes('Accepted session http-success') && String(args[1]).includes('independent: post-publication'))).toBe(true);
      h.retained();
    } finally { diagnostics.mockRestore(); }
  });

  test(`${label}: independent pending rollback retains assignment until exact termination settles`, async () => {
    const h = await harness(routes, 'persist');
    let finish!: () => void, began!: () => void;
    const entered = new Promise<void>(resolve => { began = resolve; });
    const pending = new Promise<void>(resolve => { finish = resolve; });
    h.onStop(async () => { began(); await pending; });
    let settled = false;
    const responsePromise = h.request().then(response => { settled = true; return response; });
    await entered;
    const assigned = await saved(), audit = events();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(assigned.assignee).toBe(successor);
    expect(await saved()).toEqual(assigned);
    expect(events()).toEqual(audit);
    expect(h.handles.get('http-persist')).toBe(true);
    h.retained();
    finish();
    const response = await responsePromise;
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body.cleanup.assignment).toBe('released');
    expect(body.error.message).toContain('persist failed');
    expect(h.handles.get('http-persist')).toBe(false);
    expect((await saved()).assignee).toBeUndefined();
    h.retained();
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const [label, routes] of [['sdk', sdkRoutes], ['app', appRoutes]] as const) {
  for (const [otherLabel, contenderRoutes] of [['sdk', sdkRoutes], ['app', appRoutes]] as const) {
    for (const schedule of ['starting', 'accepted']) {
      test(`${label}/${otherLabel}: overlapping HTTP starts preserve the ${schedule} session`, async () => {
        const h = await harness(routes, 'success');
        const entered = deferred(), waiting = deferred();
        h.onSpawn(async () => { entered.resolve(); await waiting.promise; });
        const first = h.request();
        await entered.promise;
        const assigned = await saved(), audit = events(), stats = h.stats();
        const assign = api.assignTaskToAgent.bind(api);
        api.assignTaskToAgent = async (...args) => {
          const receipt = await assign(...args);
          // Preserve the steward's original failing schedule: on the old source
          // B assigns, then A fully returns201 before B enters SessionManager.
          if (schedule === 'accepted') {
            waiting.resolve();
            expect((await first).status).toBe(201);
          }
          return receipt;
        };
        try {
          const second = await h.contender(contenderRoutes);
          expect(second.status).toBe(409);
          expect((await second.json()).error.code).toBe('SESSION_START_IN_PROGRESS');
          expect(await saved()).toEqual(assigned);
          expect(events()).toEqual(audit);
          expect(h.stats()).toEqual(stats);
          h.retained();
        } finally { waiting.resolve(); await first; }
        const response = await first;
        const accepted = await response.json();
        expect(response.status).toBe(201);
        expect(h.sessions.getActiveSession(successor)?.id).toBe(accepted.session.id);
        expect(h.handles.get(accepted.session.id)).toBe(true);
        expect((await other.getAgent(successor))!.metadata.agent).toMatchObject({ currentSessionId: accepted.session.id, sessionStatus: 'running' });
        expect(await saved()).toEqual(assigned);
        // The reservation ends on acceptance; the normal active-session precheck
        // still rejects a later request without changing task/events/resources.
        const acceptedAudit = events();
        const late = await h.contender(contenderRoutes);
        expect(late.status).toBe(409);
        expect((await late.json()).error.code).toBe('SESSION_EXISTS');
        expect(await saved()).toEqual(assigned);
        expect(events()).toEqual(acceptedAudit);
        expect(h.stats()).toEqual({ starts: 1, stops: 0, notices: 1, preparations: 1 });
        h.retained();
      });
    }
  }

  for (const stage of ['persist', 'release']) {
    test(`${label}: admission stays reserved through pending ${stage} cleanup, then permits retry`, async () => {
      const h = await harness(routes, stage === 'release' ? 'spawn' : 'persist');
      const entered = deferred(), waiting = deferred();
      if (stage === 'persist') h.onStop(async () => { entered.resolve(); await waiting.promise; });
      else {
        const release = h.assignment.unassignTask.bind(h.assignment);
        h.assignment.unassignTask = async (...args) => {
          entered.resolve(); await waiting.promise;
          return release(...args);
        };
      }
      const first = h.request();
      await entered.promise;
      const assigned = await saved(), audit = events(), stats = h.stats();
      try {
        const second = await h.contender(routes);
        expect(second.status).toBe(409);
        expect((await second.json()).error.code).toBe('SESSION_START_IN_PROGRESS');
        expect(await saved()).toEqual(assigned);
        expect(events()).toEqual(audit);
        expect(h.stats()).toEqual(stats);
      } finally { waiting.resolve(); await first; }
      const failed = await first;
      expect(failed.status).toBe(500);
      expect((await failed.json()).cleanup.assignment).toBe('released');
      expect((await saved()).assignee).toBeUndefined();
      h.setStage('success');
      const retry = await h.request();
      expect(retry.status).toBe(201);
      expect(h.handles.get((await retry.json()).session.id)).toBe(true);
      expect((await saved()).assignee).toBe(successor);
      h.retained();
    });
  }

  test(`${label}: early preparation return and notification error both relinquish admission`, async () => {
    const h = await harness(routes, 'prepare');
    const before = await saved();
    expect((await h.request()).status).toBe(400);
    expect(await saved()).toEqual(before);
    h.setStage('notify');
    const failure = await h.request();
    const body = await failure.json();
    expect(failure.status).toBe(500);
    expect(body.cleanup.assignment).toBe('retained-session-started');
    expect(h.handles.get(body.cleanup.sessionId)).toBe(true);
    const audit = events(), accepted = await saved();
    const later = await h.request();
    expect(later.status).toBe(409);
    expect((await later.json()).error.code).toBe('SESSION_EXISTS');
    expect(await saved()).toEqual(accepted);
    expect(events()).toEqual(audit);
    h.retained();
  });

  test(`${label}: an unrelated agent can start while another agent is waiting`, async () => {
    const h = await harness(routes, 'success');
    const entered = deferred(), waiting = deferred();
    let calls = 0;
    h.onSpawn(async () => { if (++calls === 1) { entered.resolve(); await waiting.promise; } });
    const first = h.request();
    await entered.promise;
    const assigned = await saved();
    try {
      const second = await h.contender(routes, owner, '');
      expect(second.status).toBe(201);
      expect(h.sessions.getActiveSession(owner)?.id).toBe((await second.json()).session.id);
      expect(await saved()).toEqual(assigned);
    } finally { waiting.resolve(); await first; }
    expect((await first).status).toBe(201);
    expect((await saved()).assignee).toBe(successor);
  });
}

// Sequential-retry regression adapted from the steward's retained portable probe.
// The original baseline/control (0/2 vs 2/2) remains in the review evidence.
for (const [label, routes, otherRoutes] of [['sdk', sdkRoutes, appRoutes], ['app', appRoutes, sdkRoutes]] as const) {
  for (const stage of ['terminate', 'rollback-persist']) {
    test(`${label}: repeated retry after incomplete ${stage} preserves the exact attempt without new effects`, async () => {
      const h = await harness(routes, stage);
      const first = await h.request();
      const firstBody = await first.json();
      const id = `http-${stage}`;
      expect(first.status).toBe(500);
      expect(firstBody.success).toBeUndefined();
      expect(firstBody.cleanup).toMatchObject({ assignment: 'retained-session-cleanup-incomplete', sessionId: id });
      expect(firstBody.error.message).toContain('persist failed');
      expect(h.handles.get(id)).toBe(stage === 'terminate');
      if (stage === 'terminate') {
        expect((await other.getAgent(successor))!.metadata.agent).toMatchObject({ currentSessionId: id, sessionStatus: 'running' });
      }
      // Neither this missing active mapping nor terminated local status proves cleanup.
      expect(h.sessions.getActiveSession(successor)).toBeUndefined();
      expect((await saved()).assignee).toBe(successor);
      const assigned = await saved(), audit = events(), stats = h.stats();
      const registry = await other.getAgent(successor);
      h.setStage('spawn'); // The baseline retry reaches this failing provider call.
      const lookup = spyOn(h.sessions, 'getActiveSession');
      try {
        // Recreating either factory must retain the same attempt-bound protection.
        for (const factory of [routes, otherRoutes, routes]) {
          const response = await h.contender(factory);
          const body = await response.json();
          expect(response.status).toBe(409);
          expect(body.success).toBeUndefined();
          expect(body.error).toMatchObject({ code: 'SESSION_START_CLEANUP_INCOMPLETE', sessionId: id });
          expect(await saved()).toEqual(assigned);
          expect(events()).toEqual(audit);
          expect(await other.getAgent(successor)).toEqual(registry);
          expect(h.stats()).toEqual(stats);
          expect(h.handles.get(id)).toBe(stage === 'terminate');
          h.retained();
        }
        expect(lookup).not.toHaveBeenCalled();
      } finally { lookup.mockRestore(); }
    });
  }

  test(`${label}: incomplete admission preserves a later successor task/session and unrelated starts still work`, async () => {
    const h = await harness(routes, 'terminate');
    const first = await h.request();
    const failed = await first.json();
    expect(first.status).toBe(500);
    h.setStage('success');
    const newer = createSessionManager(h.spawner, other, createAgentRegistry(other));
    const next = await newer.startSession(successor, { interactive: false, workingDirectory: repo });
    const winner = await other.assignTaskToAgent(task.id, successor, { sessionId: next.session.id, worktree: repo });
    const audit = events(), registry = await other.getAgent(successor), stats = h.stats();
    const retry = await h.contender(otherRoutes);
    expect(retry.status).toBe(409);
    // The conflict identifies the failed attempt, never adopts the newer session.
    expect((await retry.json()).error.sessionId).toBe(failed.cleanup.sessionId);
    expect(await saved()).toEqual(winner);
    expect(events()).toEqual(audit);
    expect(await other.getAgent(successor)).toEqual(registry);
    expect(h.stats()).toEqual(stats);
    expect(h.handles.get(next.session.id)).toBe(true);
    expect(h.handles.get(failed.cleanup.sessionId)).toBe(true);
    h.retained();
    const unrelated = await h.contender(otherRoutes, owner, '');
    expect(unrelated.status).toBe(201);
    expect(await saved()).toEqual(winner);
  });

  test(`${label}: later exact-session stop does not implicitly reset retained HTTP admission`, async () => {
    const h = await harness(routes, 'terminate');
    const first = await h.request();
    const failed = await first.json();
    expect(first.status).toBe(500);
    h.setStage('success');
    await h.sessions.stopSession(failed.cleanup.sessionId, { graceful: false });
    expect(h.handles.get(failed.cleanup.sessionId)).toBe(false);
    const assigned = await saved(), audit = events(), stats = h.stats();
    const retry = await h.contender(otherRoutes);
    expect(retry.status).toBe(409);
    expect((await retry.json()).error).toMatchObject({ code: 'SESSION_START_CLEANUP_INCOMPLETE', sessionId: failed.cleanup.sessionId });
    expect(await saved()).toEqual(assigned);
    expect(events()).toEqual(audit);
    expect(h.stats()).toEqual(stats);
    h.retained();
  });

  test(`${label}: taskless incomplete attempt also fences a later request carrying a task`, async () => {
    const h = await harness(routes, 'terminate');
    const original = await saved();
    const first = await h.contender(routes, successor, '');
    const failed = await first.json();
    expect(first.status).toBe(500);
    expect(failed.cleanup.assignment).toBe('retained-session-cleanup-incomplete');
    expect(await saved()).toEqual(original);
    const audit = events(), stats = h.stats();
    const retry = await h.contender(otherRoutes);
    expect(retry.status).toBe(409);
    expect((await retry.json()).error.sessionId).toBe(failed.cleanup.sessionId);
    expect(await saved()).toEqual(original);
    expect(events()).toEqual(audit);
    expect(h.stats()).toEqual(stats);
    expect(h.handles.get(failed.cleanup.sessionId)).toBe(true);
  });
}
