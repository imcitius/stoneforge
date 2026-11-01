/** Both real HTTP routes, temporary SQLite/Git, real SessionManager and inert provider handles. */
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
  let starts = 0, stops = 0, notices = 0;
  let duringSpawn: (() => Promise<void>) | undefined;
  let duringStop: (() => Promise<void>) | undefined;
  const handles = new Map<string, boolean>();
  const spawner = {
    async spawn(agentId: EntityId, agentRole: string) {
      starts++;
      await duringSpawn?.();
      if (['spawn', 'reused'].includes(stage)) throw new Error('fixture: spawn failed');
      const id = `http-${stage}${starts > 1 ? `-${starts}` : ''}`;
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
  return { request, assignment, sessions, registry, handles, spawner, onSpawn(fn: () => Promise<void>) { duringSpawn = fn; }, onStop(fn: () => Promise<void>) { duringStop = fn; },
    stats: () => ({ starts, stops, notices }), retained() {
      expect(prepared).toBeDefined(); expect(existsSync(prepared!)).toBe(true);
      if (reusable) expect(readFileSync(path.join(prepared!, 'existing.txt'), 'utf8')).toBe('preexisting reusable resource');
      expect(readFileSync(path.join(prepared!, 'retained.txt'), 'utf8')).toBe('successor or reusable data');
      expect(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toContain(prepared!);
    } };
}

for (const [label, routes] of [['sdk', sdkRoutes], ['app', appRoutes]] as const) {
  test(`${label}: published session remains assigned after repeated operation log failure`, async () => {
    const h = await harness(routes, 'success');
    const diagnostics = spyOn(console, 'error').mockImplementation(() => {});
    h.sessions.setOperationLog({ write(_level, _category, message) {
      if (message.startsWith('Session started')) throw new Error('fixture: operation log failed');
    }, query() { return []; }, prune() { return 0; } });
    try {
      for (const id of ['http-success', 'http-success-2']) {
        const response = await h.request();
        expect(response.status).toBe(201);
        expect((await response.json()).session.id).toBe(id);
        expect(h.sessions.getActiveSession(successor)?.id).toBe(id);
        expect(h.handles.get(id)).toBe(true);
        expect((await saved()).assignee).toBe(successor);
        expect((await other.getAgent(successor))!.metadata.agent).toMatchObject({ currentSessionId: id, sessionStatus: 'running' });
        expect(diagnostics.mock.calls.some(args => String(args[0]).includes(`Accepted session ${id}`) && String(args[1]).includes('operation log failed'))).toBe(true);
        h.retained();
        await h.sessions.stopSession(id, { graceful: false });
      }
    } finally { diagnostics.mockRestore(); }
  });

  for (const stage of ['persist', 'terminate', 'rollback-persist', 'listeners']) {
    test(`${label}: real startup ${stage} has an exact rollback outcome`, async () => {
      const h = await harness(routes, stage);
      let snapshot: Task | undefined;
      h.onSpawn(async () => { snapshot = await saved(); });
      const response = await h.request(); const body = await response.json();
      expect(response.status).toBe(500); expect(body.success).toBeUndefined();
      expect(body.error.message).toContain(stage === 'listeners' ? 'listener installation failed' : 'persist failed');
      expect(h.stats().stops).toBe(1);
      expect(h.handles.get(`http-${stage}`)).toBe(stage === 'terminate');
      if (stage === 'persist' || stage === 'listeners') {
        expect(body.cleanup.assignment).toBe('released');
        expect((await saved()).assignee).toBeUndefined();
      } else {
        expect(body.cleanup.assignment).toBe('retained-session-cleanup-incomplete');
        expect(body.cleanup.sessionId).toBe(`http-${stage}`);
        expect(body.cleanup.error).toContain(stage === 'terminate' ? 'terminate failed' : 'outcome unknown');
        expect(await saved()).toEqual(snapshot!);
        // An explicit later retry targets the same internal receipt, never an agent lookup.
        const retry = await h.sessions.stopSession(body.cleanup.sessionId, { graceful: false }).then(() => 'ok', e => String(e));
        expect(retry).toContain(stage === 'terminate' ? 'terminate failed' : 'outcome unknown');
        expect(await saved()).toEqual(snapshot!);
      }
      h.retained();
    });
  }

  test(`${label}: pre-publication CAS rejection positively cleans own handle and releases own assignment`, async () => {
    const h = await harness(routes, 'publish');
    h.onSpawn(async () => {
      await other.updateAgentMetadata(successor, { currentSessionId: 'new-internal', sessionStatus: 'running' });
    });
    const response = await h.request(); const body = await response.json();
    expect(response.status).toBe(500); expect(body.cleanup.assignment).toBe('released');
    expect(h.handles.get('http-publish')).toBe(false);
    expect((await other.getAgent(successor))!.metadata.agent).toMatchObject({ currentSessionId: 'new-internal', sessionStatus: 'running' });
    expect((await saved()).assignee).toBeUndefined(); h.retained();
  });

  for (const stage of ['persist', 'terminate']) {
    test(`${label}: ${stage} rollback preserves a real successor and its task/events`, async () => {
      const h = await harness(routes, stage);
      let winner: Task | undefined, winnerEvents: unknown[] = [];
      let newer: ReturnType<typeof createSessionManager>;
      h.onStop(async () => {
        newer = createSessionManager(h.spawner, other, createAgentRegistry(other));
        const next = await newer.startSession(successor, { interactive: false, workingDirectory: repo });
        winner = await other.assignTaskToAgent(task.id, successor, { sessionId: next.session.id, worktree: repo });
      });
      // Snapshot after SessionManager's own cleanup effects, immediately before HTTP release.
      const start = h.sessions.startSession.bind(h.sessions);
      h.sessions.startSession = async (...args) => {
        try { return await start(...args); } finally { winnerEvents = events(); }
      };
      const response = await h.request(); const body = await response.json();
      expect(response.status).toBe(500); expect(body.success).toBeUndefined();
      expect(body.cleanup.assignment).toBe(stage === 'persist' ? 'retained-conflict' : 'retained-session-cleanup-incomplete');
      expect(await saved()).toEqual(winner!); expect(events()).toEqual(winnerEvents);
      expect(h.handles.get(`http-${stage}-2`)).toBe(true);
      expect(newer!.getActiveSession(successor)?.id).toBe(`http-${stage}-2`);
      expect((await other.getAgent(successor))!.metadata.agent).toMatchObject({ currentSessionId: `http-${stage}-2`, sessionStatus: 'running' });
      expect(h.stats().stops).toBe(1); h.retained();
    });
  }
}
