/** Real SQLite regressions for the explicit SDK assignment path and its callers. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createTask, createEntity, EntityTypeValue, type Task, type EntityId, type Timestamp } from '@stoneforge/core';
import { createOrchestratorAPI, type OrchestratorAPI } from './orchestrator-api.js';
import { createAgentRegistry } from '../services/agent-registry.js';
import { createTaskAssignmentService } from '../services/task-assignment-service.js';
import { getOrchestratorTaskMeta, updateOrchestratorTaskMeta } from '../types/task-meta.js';
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
const assign = () => api.assignTaskToAgent(task.id, successor, { markAsStarted: true, branch: 'explicit-branch', worktree: repo, sessionId: 'explicit-session' });

for (const kind of ['closed', 'deferred', 'reassign', 'human', 'claim']) {
  for (const boundary of [1, 2]) {
    test(`R${boundary}: concurrent ${kind} rejects assignment and preserves task/events`, async () => {
      const get = api.get.bind(api); let reads = 0; let winner: Task | undefined; let log: unknown[] = [];
      api.get = async (...args) => {
        const result = await get(...args);
        if (args[0] === task.id && ++reads === boundary) { winner = await change(kind); log = events(); }
        return result;
      };
      await expect(assign()).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
      expect(winner).toBeDefined(); expect(await saved()).toEqual(winner!); expect(events()).toEqual(log);
    });
  }
}

for (const kind of ['closed', 'deferred', 'reassign', 'human', 'claim']) {
 test(`W1: coherent assignment and preservation of subsequent ${kind}`, async () => {
  const update = api.update.bind(api); let writes = 0; let winner: Task | undefined; let log: unknown[] = [];
  api.update = async (...args) => {
    if (args[0] === task.id && ++writes > 1) throw new Error('unexpected second write');
    const result = await update(...args);
    if (args[0] === task.id) {
      expect(await saved()).toEqual(result); expect(result.assignee).toBe(successor);
      expect(meta(result).assignedAgent).toBe(successor); expect(meta(result).sessionId).toBe('explicit-session');
      expect(result.status).toBe('in_progress'); winner = await change(kind); log = events();
    }
    return result;
  };
  await assign(); expect(writes).toBe(1); expect(await saved()).toEqual(winner!); expect(events()).toEqual(log);
 });
}

test('failure after real SQL metadata mutations rolls back ownership, status, history and events', async () => {
  const log = events(), snapshot = await saved();
  const transaction = storage.transaction.bind(storage), update = api.update.bind(api);
  let fail = false, injected = false;
  api.update = async (...args) => {
    fail = args[0] === task.id && args[1].metadata !== undefined;
    try { return await update(...args); } finally { fail = false; }
  };
  storage.transaction = (fn, options) => transaction(tx => {
    const result = fn(tx); if (fail) { injected = true; throw new Error('fixture: rollback'); } return result;
  }, options);
  await expect(assign()).rejects.toThrow('fixture: rollback');
  expect(injected).toBe(true); expect(await saved()).toEqual(snapshot); expect(events()).toEqual(log);
});

for (const markAsStarted of [false, true]) {
  test(`explicit reassignment with future schedule remains supported; markAsStarted=${markAsStarted}`, async () => {
    const result = await api.assignTaskToAgent(task.id, successor, { markAsStarted, sessionId: 'new', branch: 'chosen', worktree: repo });
    expect(result.assignee).toBe(successor); expect(result.status).toBe(markAsStarted ? 'in_progress' : task.status);
    expect(result.scheduledFor).toBe(future); expect(result.deadline).toBe(future);
    expect(meta(result)).toMatchObject({ ...meta(task), assignedAgent: successor, sessionId: 'new', branch: 'chosen', worktree: repo });
    expect(meta(result).startedAt).toBeDefined(); expect(result.metadata.retained).toBe('outer');
  });
}

test('default branch/worktree generation and omitted session retain legacy explicit API behavior', async () => {
  const result = await api.assignTaskToAgent(task.id, successor);
  expect(meta(result).branch).toContain('successor'); expect(meta(result).worktree).toContain('successor');
  expect(meta(result).sessionId).toBeUndefined(); expect(meta(result).sessionHistory).toEqual(meta(task).sessionHistory);
  expect(result.status).toBe(task.status); expect(meta(result).startedAt).toBeDefined();
});

function cli(args: string[], preload = false, race = false) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(STONEFORGE_|SF_|ORCHESTRATOR_URL$|ELECTRON_RUN_AS_NODE$)/.test(key)) delete env[key];
  Object.assign(env, { STONEFORGE_ROOT: root, ASSIGNMENT_FIXTURE_ROOT: root, ASSIGNMENT_FIXTURE_TASK: task.id, ASSIGNMENT_FIXTURE_RACE: String(race) });
  return spawnSync(process.execPath, [
    ...(preload ? ['--preload', path.resolve(import.meta.dir, '../../tests/fixtures/assignment-cli-preload.ts')] : []),
    path.resolve(import.meta.dir, '../bin/sf.ts'), ...args,
  ], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
}
for (const race of [false, true]) {
  test(`real isolated CLI agent start: ${race ? 'CAS rejection after spawn' : 'explicit reassignment'}`, async () => {
    const result = cli(['agent', 'start', successor, '--taskId', task.id, '--json'], true, race);
    expect(result.error).toBeUndefined();
    const effects = JSON.parse(readFileSync(path.join(root, 'spawn.json'), 'utf8'));
    expect(effects.spawns).toBe(1); expect(effects.terminations).toBe(race ? 1 : 0);
    if (race) {
      expect(result.status).not.toBe(0); expect(result.stderr + result.stdout).toContain('modified');
      const expected = JSON.parse(readFileSync(path.join(root, 'winner.json'), 'utf8'));
      expect(await saved()).toEqual(expected.task); expect(events()).toEqual(expected.events);
    } else {
      expect(result.status).toBe(0); expect((await saved()).assignee).toBe(successor);
      expect(meta(await saved()).sessionId).toBe('fixture-spawn'); expect(meta(await saved()).sessionHistory).toEqual(meta(task).sessionHistory);
    }
  });
}

for (const [label, routes] of [['sdk', sdkRoutes], ['app', appRoutes]] as const) {
  for (const scenario of ['success', 'race', 'persistent-race', 'spawn-failure']) {
    test(`${label} real HTTP start: ${scenario}`, async () => {
      let starts = 0, notifications = 0, worktrees = 0; let winner: Task | undefined; let log: unknown[] = [];
      const racing = scenario === 'race' || scenario === 'persistent-race';
      if (scenario === 'persistent-race') await api.updateAgentMetadata(successor, { workerMode: 'persistent' });
      if (racing) {
        const get = api.get.bind(api); let reads = 0;
        api.get = async (...args) => {
          const result = await get(...args);
          // Persistent worktree preparation adds one earlier task read.
          if (args[0] === task.id && ++reads === (scenario === 'persistent-race' ? 3 : 2)) { winner = await change('claim'); log = events(); }
          return result;
        };
      }
      const route = routes({ api, orchestratorApi: api, agentRegistry: createAgentRegistry(api),
        worktreeManager: scenario === 'persistent-race' ? { async createWorktree() { ++worktrees; return { worktree: { path: repo } }; } } : undefined,
        sessionInitialPrompts: new Map(), sessionMessageService: { saveMessage() {} },
        sessionManager: { getActiveSession: () => undefined, startSession: async () => {
          ++starts;
          // Start runs only after the complete assignment is visible to another connection.
          expect((await saved()).assignee).toBe(successor); expect(meta(await saved()).assignedAgent).toBe(successor);
          if (scenario === 'spawn-failure') throw new Error('fixture: spawn failed');
          return { session: { id: 'http-fixture', agentId: successor, agentRole: 'worker', mode: 'headless', status: 'running', createdAt: task.createdAt }, events: new EventEmitter() };
        } },
      } as unknown as Parameters<typeof sdkRoutes>[0], () => { ++notifications; });
      const response = await route.request(`/api/agents/${successor}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: task.id }) });
      expect(response.status).toBe(scenario === 'success' ? 201 : 500);
      expect(starts).toBe(racing ? 0 : 1);
      expect(worktrees).toBe(scenario === 'persistent-race' ? 1 : 0); expect(notifications).toBe(scenario === 'success' ? 1 : 0);
      if (racing) { expect(winner).toBeDefined(); expect(await saved()).toEqual(winner!); expect(events()).toEqual(log); }
      else { expect((await saved()).assignee).toBe(successor); expect(meta(await saved()).sessionHistory).toEqual(meta(task).sessionHistory); }
    });
  }
}

test('real unknown MR outcome survives CLI reopen and API reassignment; new owner cannot bypass recovery', async () => {
  let calls = 0;
  const provider = { name: 'fixture', async createMergeRequest() { ++calls; throw new Error('fixture: response lost'); } };
  const service = createTaskAssignmentService(api, provider);
  await expect(service.completeTask(task.id, { agentId: owner, sessionId: 'internal-old' })).rejects.toThrow('response lost');
  const unknown = meta(await saved()).completionOperation!; expect(unknown.phase).toBe('unknown');
  await change('closed'); expect(cli(['task', 'reopen', task.id]).status).toBe(0);
  const assigned = await api.assignTaskToAgent(task.id, successor, { sessionId: 'internal-new', branch: 'main', worktree: repo, markAsStarted: true });
  expect(meta(assigned).completionOperation).toEqual(unknown);
  expect(meta(assigned).completionHistory).toEqual(meta(task).completionHistory); expect(meta(assigned).sessionHistory).toEqual(meta(task).sessionHistory);
  // Supply a valid new identity so rejection specifically exercises the retained claim.
  await other.update<Task>(task.id, { metadata: updateOrchestratorTaskMeta(assigned.metadata, { sessionHistory: [...meta(assigned).sessionHistory!, { sessionId: 'internal-new', agentId: successor, agentName: 'successor', agentRole: 'worker', startedAt: assigned.updatedAt }] }) });
  const snapshot = await saved(), log = events();
  await expect(createTaskAssignmentService(api, provider).completeTask(task.id, { agentId: successor, sessionId: 'internal-new' })).rejects.toThrow('reconcile explicitly');
  await expect(service.reconcileCompletion(task.id, { operationId: unknown.operationId, operatorId: successor, reason: 'fixture review' })).rejects.toThrow();
  expect(await saved()).toEqual(snapshot); expect(events()).toEqual(log); expect(calls).toBe(1);
});
