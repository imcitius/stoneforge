/**
 * Dashboard assignment → Start (el-5s9l15).
 *
 * Real SQLite, real OrchestratorAPI, AgentRegistry and TaskAssignmentService
 * behind the served task routes. Assigning through PATCH /api/tasks/:id
 * {assignee} or POST /api/tasks/:id/assign must write assignee and
 * metadata.orchestrator.assignedAgent together, so POST /api/tasks/:id/start
 * succeeds for the assigned agent.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createEntity, createTask, EntityTypeValue, TaskStatus, type EntityId, type Task } from '@stoneforge/core';
import { createOrchestratorAPI, type OrchestratorAPI } from '../../api/orchestrator-api.js';
import { createAgentRegistry } from '../../services/agent-registry.js';
import { createTaskAssignmentService } from '../../services/task-assignment-service.js';
import { getOrchestratorTaskMeta, updateOrchestratorTaskMeta } from '../../types/task-meta.js';
import type { Services } from '../services.js';
import { createTaskRoutes } from './tasks.js';

let root: string;
let storage: StorageBackend;
let api: OrchestratorAPI;
let app: ReturnType<typeof createTaskRoutes>;
let task: Task;
let workerA: EntityId;
let workerB: EntityId;
let operator: EntityId;

const meta = (t: Task) => getOrchestratorTaskMeta(t.metadata);
const saved = async () => (await api.get<Task>(task.id))!;

function call(method: string, url: string, body?: unknown) {
  return app.request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const patch = (body: unknown) => call('PATCH', `/api/tasks/${task.id}`, body);
const assign = (body: unknown) => call('POST', `/api/tasks/${task.id}/assign`, body);
const start = (agentId: EntityId) => call('POST', `/api/tasks/${task.id}/start`, { agentId });

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'sf-task-assign-'));
  storage = createStorage({ path: path.join(root, 'stoneforge.db') });
  initializeSchema(storage);
  api = createOrchestratorAPI(storage);
  const system = await createEntity({ name: 'test-system', entityType: EntityTypeValue.SYSTEM, createdBy: 'system:test' as EntityId });
  const creator = (await api.create(system as unknown as Parameters<OrchestratorAPI['create']>[0])).id as unknown as EntityId;
  workerA = (await api.registerWorker({ name: 'worker-a', workerMode: 'ephemeral', createdBy: creator })).id as unknown as EntityId;
  workerB = (await api.registerWorker({ name: 'worker-b', workerMode: 'ephemeral', createdBy: creator })).id as unknown as EntityId;
  const human = await createEntity({ name: 'operator', entityType: EntityTypeValue.HUMAN, createdBy: creator });
  operator = (await api.create(human as unknown as Parameters<OrchestratorAPI['create']>[0])).id as unknown as EntityId;
  const rawTask = await createTask({ title: 'Dashboard assignment fixture', createdBy: creator });
  task = await api.create<Task>(rawTask as unknown as Parameters<OrchestratorAPI['create']>[0]);
  const services = {
    api,
    agentRegistry: createAgentRegistry(api),
    taskAssignmentService: createTaskAssignmentService(api),
    storageBackend: storage,
  } as unknown as Services;
  app = createTaskRoutes(services);
});

afterEach(() => {
  storage.close();
  rmSync(root, { recursive: true, force: true });
});

describe('dashboard assignment keeps the task startable', () => {
  test('negative control: an assignee-only write is rejected by Start (the reported 422)', async () => {
    await api.update<Task>(task.id, { assignee: workerA });
    const response = await start(workerA);
    expect(response.status).toBe(422);
    expect((await response.json()).error.message).toContain('assignee and assignedAgent must match');
  });

  test('PATCH {assignee: agent} writes assignedAgent, then Start succeeds', async () => {
    const response = await patch({ assignee: workerA });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.task.assignee).toBe(workerA);
    expect(meta(await saved())?.assignedAgent).toBe(workerA);

    const started = await start(workerA);
    expect(started.status).toBe(200);
    expect((await started.json()).task.status).toBe(TaskStatus.IN_PROGRESS);
  });

  test('POST /assign {assignee: agent} writes assignedAgent, then Start succeeds', async () => {
    const response = await assign({ assignee: workerA });
    expect(response.status).toBe(200);
    const current = await saved();
    expect(current.assignee).toBe(workerA);
    expect(meta(current)?.assignedAgent).toBe(workerA);
    expect(meta(current)?.branch).toBeString();

    expect((await start(workerA)).status).toBe(200);
  });

  test('reassignment moves ownership: previous agent cannot start, new agent can', async () => {
    expect((await assign({ assignee: workerA })).status).toBe(200);
    const branch = meta(await saved())?.branch;
    expect((await patch({ assignee: workerB })).status).toBe(200);
    const current = await saved();
    expect(current.assignee).toBe(workerB);
    expect(meta(current)?.assignedAgent).toBe(workerB);
    // The recorded task branch is continued (assignToAgent contract).
    expect(meta(current)?.branch).toBe(branch);

    expect((await start(workerA)).status).toBe(422);
    expect((await start(workerB)).status).toBe(200);
  });

  test('re-selecting the agent of an incoherent assignment repairs it', async () => {
    await api.update<Task>(task.id, { assignee: workerA });
    expect((await assign({ assignee: workerA })).status).toBe(200);
    expect(meta(await saved())?.assignedAgent).toBe(workerA);
    expect((await start(workerA)).status).toBe(200);
  });

  test('re-selecting the coherent current agent is a no-op (session kept)', async () => {
    expect((await assign({ assignee: workerA })).status).toBe(200);
    const before = await saved();
    await api.update<Task>(task.id, { metadata: updateOrchestratorTaskMeta(before.metadata, { sessionId: 'live-session' }) });
    const snapshot = await saved();
    expect((await assign({ assignee: workerA })).status).toBe(200);
    const after = await saved();
    expect(after.updatedAt).toBe(snapshot.updatedAt);
    expect(meta(after)?.sessionId).toBe('live-session');
  });

  test('assigning an operator clears the agent ownership fields', async () => {
    expect((await assign({ assignee: workerA })).status).toBe(200);
    const response = await patch({ assignee: operator });
    expect(response.status).toBe(200);
    const current = await saved();
    expect(current.assignee).toBe(operator);
    expect(meta(current)?.assignedAgent).toBeUndefined();
    expect(meta(current)?.branch).toBeString();
    // An operator is not an agent; Start stays rejected for the old agent.
    expect((await start(workerA)).status).toBe(422);
  });

  test('null unassigns assignee and assignedAgent together', async () => {
    expect((await assign({ assignee: workerA })).status).toBe(200);
    const response = await assign({ assignee: null });
    expect(response.status).toBe(200);
    const current = await saved();
    expect(current.assignee).toBeUndefined();
    expect(meta(current)?.assignedAgent).toBeUndefined();
    expect(current.status).toBe(TaskStatus.OPEN);
  });

  test('PATCH with assignee and other fields keeps the assignment metadata', async () => {
    const response = await patch({ assignee: workerA, title: 'Renamed', mergeStatus: 'pending', priority: 1 });
    expect(response.status).toBe(200);
    const current = await saved();
    expect(current.title).toBe('Renamed');
    expect(current.priority).toBe(1);
    expect(meta(current)?.assignedAgent).toBe(workerA);
    expect((await start(workerA)).status).toBe(200);
  });

  test('unknown assignee is rejected without a write', async () => {
    const before = await saved();
    const response = await patch({ assignee: 'el-missing', title: 'Must not apply' });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_INPUT');
    expect((await saved()).updatedAt).toBe(before.updatedAt);
  });

  test('invalid input is rejected before any write', async () => {
    const before = await saved();
    expect((await assign({})).status).toBe(400);
    expect((await assign({ assignee: 42 })).status).toBe(400);
    expect((await patch({ assignee: workerA, status: 'bogus' })).status).toBe(400);
    expect((await patch({ assignee: workerA, mergeStatus: 'bogus' })).status).toBe(400);
    expect((await saved()).updatedAt).toBe(before.updatedAt);
  });

  test('unknown task returns 404', async () => {
    const response = await call('POST', '/api/tasks/el-nope/assign', { assignee: workerA });
    expect(response.status).toBe(404);
  });
});
