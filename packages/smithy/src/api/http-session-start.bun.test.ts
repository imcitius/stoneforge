/** Both real HTTP routes, temporary SQLite/Git, real SessionManager and inert provider handles. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
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
import { getOrchestratorTaskMeta, updateOrchestratorTaskMeta } from '../types/task-meta.js';
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

async function change(kind: string) {
  const current = await saved();
  if (kind === 'claim') return other.update<Task>(task.id, { metadata: updateOrchestratorTaskMeta(current.metadata, {
    completionOperation: { operationId: 'competing-claim', taskVersion: current.updatedAt, phase: 'unknown', mode: 'worker', agentId: owner, sessionId: 'internal-old', owner, assignedAgent: owner, push: false, createMR: true, baseBranch: 'main', title: current.title, body: 'retained claim' },
  }) });
  if (kind === 'reassign') return other.update<Task>(task.id, { assignee: successor, metadata: updateOrchestratorTaskMeta(current.metadata, {
    assignedAgent: successor, sessionId: 'internal-new', sessionHistory: [...meta(current).sessionHistory!, { sessionId: 'internal-new', agentId: successor, agentName: 'successor', agentRole: 'worker', startedAt: current.updatedAt }],
  }) });
  if (kind === 'human') return other.update<Task>(task.id, { assignee: 'human:owner' as EntityId });
  return other.update<Task>(task.id, { status: kind as Task['status'], scheduledFor: future, deadline: future,
    ...(kind === 'closed' ? { closedAt: current.updatedAt, closeReason: 'operator decision' } : {}),
  });
}

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
  let starts = 0, stops = 0, notices = 0;
  let duringSpawn: (() => Promise<void>) | undefined;
  const handles = new Map<string, boolean>();
  const spawner = {
    async spawn(agentId: EntityId, agentRole: string) {
      starts++;
      await duringSpawn?.();
      if (['spawn', 'reused'].includes(stage)) throw new Error('fixture: spawn failed');
      const id = `http-${stage}${starts > 1 ? `-${starts}` : ''}`;
      handles.set(id, true);
      return { session: { id, agentId, agentRole, provider: 'fixture', mode: 'headless', status: 'running',
        workingDirectory: prepared, createdAt: task.createdAt, lastActivityAt: task.createdAt, startedAt: task.createdAt }, events: new EventEmitter() } as SpawnResult;
    },
    getSession(id: string) { return { status: handles.get(id) ? 'running' : 'terminated' }; },
    async terminate(id: string) { stops++; if (stage === 'terminate') throw new Error('fixture: terminate failed'); handles.set(id, false); },
  } as unknown as SpawnerService;
  const sessions = createSessionManager(spawner, api, registry);
  const persist = sessions.persistSession.bind(sessions);
  let persistenceCalls = 0;
  sessions.persistSession = async id => {
    if (++persistenceCalls === 1 && ['persist', 'terminate'].includes(stage)) throw new Error('fixture: persist failed');
    return persist(id);
  };
  const route = routes({ api, orchestratorApi: api, agentRegistry: registry, taskAssignmentService: assignment,
    sessionManager: sessions, sessionInitialPrompts: new Map(),
    sessionMessageService: { saveMessage() { if (stage === 'save') throw new Error('fixture: save failed'); } },
    worktreeManager: { async createWorktree() {
      const result = reusable ?? await prepare();
      prepared = result.worktree.path;
      writeFileSync(path.join(prepared, 'retained.txt'), 'successor or reusable data');
      if (stage === 'prepare') throw new Error('fixture: prepare failed after creating path');
      return result;
    } },
  } as unknown as Parameters<typeof sdkRoutes>[0], () => { notices++; if (stage === 'notify') throw new Error('fixture: notify failed'); });
  const request = () => route.request(`/api/agents/${successor}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: task.id, interactive: false }) });
  return { request, assignment, sessions, registry, handles, spawner, onSpawn(fn: () => Promise<void>) { duringSpawn = fn; },
    stats: () => ({ starts, stops, notices }), retained() {
      expect(prepared).toBeDefined(); expect(existsSync(prepared!)).toBe(true);
      if (reusable) expect(readFileSync(path.join(prepared!, 'existing.txt'), 'utf8')).toBe('preexisting reusable resource');
      expect(readFileSync(path.join(prepared!, 'retained.txt'), 'utf8')).toBe('successor or reusable data');
      expect(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toContain(prepared!);
    } };
}

for (const [label, routes] of [['sdk', sdkRoutes], ['app', appRoutes]] as const) {
  for (const stage of ['spawn', 'reused', 'persist', 'terminate', 'save', 'notify', 'success']) {
    test(`${label}: ${stage} keeps exact ownership boundaries and reusable Git resources`, async () => {
      const h = await harness(routes, stage);
      const response = await h.request();
      const body = await response.json();
      expect(response.status).toBe(stage === 'success' ? 201 : 500);
      h.retained();
      const current = await saved();
      expect(current.status).toBe(task.status);
      expect(current.metadata.retained).toBe('outer');
      for (const key of ['sessionHistory', 'completionHistory', 'handoffHistory', 'retainedExtension'] as const) expect(meta(current)[key]).toEqual(meta(task)[key]);
      expect(meta(current).branch).toContain('successor');
      if (stage === 'terminate') {
        expect(current.assignee).toBe(successor);
        expect(body.cleanup.assignment).toBe('retained-session-cleanup-incomplete');
        expect(body.cleanup.sessionId).toBe('http-terminate');
        expect(h.handles.get('http-terminate')).toBe(true);
        expect(body.cleanup.error).toContain('terminate failed');
      } else if (['spawn', 'reused', 'persist'].includes(stage)) {
        expect(current.assignee).toBeUndefined();
        expect(meta(current).assignedAgent).toBeUndefined();
        expect(body.cleanup.assignment).toBe('released');
        expect(body.cleanup.worktree.outcome).toBe('retained');
        expect(body.error.message).toContain(['spawn', 'reused'].includes(stage) ? 'spawn failed' : 'persist failed');
        expect(h.stats().stops).toBe(['spawn', 'reused'].includes(stage) ? 0 : 1);
      } else {
        expect(current.assignee).toBe(successor);
        expect(h.sessions.getActiveSession(successor)?.id).toBe(`http-${stage}`);
        expect(h.stats().stops).toBe(0);
        if (stage !== 'success') expect(body.cleanup.assignment).toBe('retained-session-started');
      }
    });
  }

  test(`${label}: preparation failure cannot report success or acquire assignment`, async () => {
    const h = await harness(routes, 'prepare'); const snapshot = await saved(), log = events();
    const response = await h.request(); const body = await response.json();
    expect(response.status).toBe(400); expect(body.success).toBeUndefined();
    expect(body.error.message).toContain('prepare failed');
    expect(body.cleanup.worktree.outcome).toBe('not-returned');
    expect(await saved()).toEqual(snapshot); expect(events()).toEqual(log);
    expect(h.stats().starts).toBe(0); h.retained();
  });

  test(`${label}: publication CAS failure cleans only the internal startup handle`, async () => {
    const h = await harness(routes, 'publish');
    let winnerTask: Task | undefined;
    h.onSpawn(async () => {
      winnerTask = await change('reassign');
      await other.updateAgentMetadata(successor, { currentSessionId: 'successor-internal', sessionStatus: 'running' });
    });
    const response = await h.request();
    expect(response.status).toBe(500); expect((await response.json()).cleanup.assignment).toBe('retained-conflict');
    expect(await saved()).toEqual(winnerTask!);
    const agent = await other.getAgent(successor);
    expect(agent!.metadata.agent).toMatchObject({ currentSessionId: 'successor-internal', sessionStatus: 'running' });
    expect((agent!.metadata.agent as { sessionHistory: { id: string; status: string }[] }).sessionHistory).toMatchObject([{ id: 'http-publish', status: 'terminated' }]);
    expect(h.stats().stops).toBe(1); expect(h.handles.get('http-publish')).toBe(false); h.retained();
  });


  test(`${label}: accepted and newer sessions survive notification failure`, async () => {
    const h = await harness(routes, 'notify');
    const start = h.sessions.startSession.bind(h.sessions);
    let winner: Task | undefined, log: unknown[] = [];
    h.sessions.startSession = async (...args) => {
      const result = await start(...args);
      const newer = createSessionManager(h.spawner, other, createAgentRegistry(other));
      const next = await newer.startSession(successor, { interactive: false, workingDirectory: repo });
      winner = await other.assignTaskToAgent(task.id, successor, { sessionId: next.session.id, worktree: repo });
      log = events();
      return result;
    };
    const response = await h.request(); expect(response.status).toBe(500);
    expect((await response.json()).cleanup.assignment).toBe('retained-session-started');
    expect(await saved()).toEqual(winner!); expect(events()).toEqual(log);
    expect(h.handles.get('http-notify')).toBe(true); expect(h.handles.get('http-notify-2')).toBe(true);
    expect((await other.getAgent(successor))!.metadata.agent).toMatchObject({ currentSessionId: 'http-notify-2', sessionStatus: 'running' });
    expect(h.stats().stops).toBe(0); h.retained();
  });

  test(`${label}: release transaction failure rolls back task and events`, async () => {
    const h = await harness(routes, 'spawn');
    const release = h.assignment.unassignTask.bind(h.assignment);
    const transaction = storage.transaction.bind(storage);
    let snapshot: Task | undefined, log: unknown[] = [];
    h.assignment.unassignTask = async (...args) => {
      snapshot = await saved(); log = events();
      storage.transaction = (fn, options) => transaction(tx => { fn(tx); throw new Error('fixture: release transaction failed'); }, options);
      try { return await release(...args); } finally { storage.transaction = transaction; }
    };
    const response = await h.request(); const body = await response.json();
    expect(response.status).toBe(500); expect(body.error.message).toContain('spawn failed');
    expect(body.cleanup.assignment).toBe('retained-error');
    expect(await saved()).toEqual(snapshot!); expect(events()).toEqual(log); h.retained();
  });

  for (const boundary of [1, 2]) for (const decision of ['closed', 'deferred', 'human', 'reassign', 'claim']) {
    test(`${label}: cleanup R${boundary} ${decision} preserves winner task and every event`, async () => {
      const h = await harness(routes, 'spawn');
      const release = h.assignment.unassignTask.bind(h.assignment);
      const get = api.get.bind(api);
      let releasing = false, reads = 0;
      let winner: Task | undefined, log: unknown[] = [];
      api.get = async (...args) => {
        const result = await get(...args);
        if (releasing && args[0] === task.id && ++reads === boundary) { winner = await change(decision); log = events(); }
        return result;
      };
      h.assignment.unassignTask = async (...args) => { releasing = true; return release(...args); };
      const response = await h.request();
      expect(response.status).toBe(500);
      expect((await response.json()).cleanup.assignment).toBe('retained-conflict');
      expect(winner).toBeDefined(); expect(await saved()).toEqual(winner!); expect(events()).toEqual(log);
      expect(h.stats().stops).toBe(0); h.retained();
    });
  }

  test(`${label}: failed assignment never acquires a cleanup receipt or starts provider`, async () => {
    const h = await harness(routes, 'spawn');
    const assign = api.assignTaskToAgent.bind(api);
    let winner: Task | undefined, log: unknown[] = [];
    api.assignTaskToAgent = async (...args) => {
      const get = api.get.bind(api); let read = false;
      api.get = async (...getArgs) => { const result = await get(...getArgs); if (!read && getArgs[0] === task.id) { read = true; winner = await change('human'); log = events(); } return result; };
      return assign(...args);
    };
    h.assignment.unassignTask = async () => { throw new Error('must not release without receipt'); };
    const response = await h.request(); expect(response.status).toBe(500);
    expect((await response.json()).cleanup.assignment).toBe('not-assigned');
    expect(await saved()).toEqual(winner!); expect(events()).toEqual(log);
    expect(h.stats().starts).toBe(0); h.retained();
  });

  test(`${label}: cleanup error is diagnostic and does not mask startup failure`, async () => {
    const h = await harness(routes, 'spawn');
    h.assignment.unassignTask = async () => { throw new Error('fixture: release failed'); };
    const response = await h.request(); const body = await response.json();
    expect(response.status).toBe(500); expect(body.success).toBeUndefined();
    expect(body.error.message).toContain('spawn failed');
    expect(body.cleanup.assignment).toBe('retained-error'); expect(body.cleanup.error).toContain('release failed');
    expect((await saved()).assignee).toBe(successor); h.retained();
  });

  test(`${label}: successor between assignment return and startup failure is never adopted`, async () => {
    const h = await harness(routes, 'spawn'); let winner: Task | undefined, log: unknown[] = [];
    h.onSpawn(async () => { winner = await change('reassign'); log = events(); });
    const response = await h.request(); expect(response.status).toBe(500);
    expect(await saved()).toEqual(winner!); expect(events()).toEqual(log); h.retained();
  });
}
