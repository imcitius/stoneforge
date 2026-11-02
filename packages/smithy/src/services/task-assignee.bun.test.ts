/**
 * Bulk / CLI assignee changes keep the task startable (el-4y870m).
 *
 * Real SQLite, OrchestratorAPI and TaskAssignmentService behind the shared
 * PATCH /api/tasks/bulk route. An assignee change must write task.assignee
 * and metadata.orchestrator.assignedAgent together (agent), or release the
 * agent ownership (operator/unassign), so startTask accepts the assigned
 * agent instead of rejecting "assignee and assignedAgent must match".
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createEntity, createTask, EntityTypeValue, TaskStatus, ValidationError, type ElementId, type EntityId, type Task } from '@stoneforge/core';
import { createTaskRoutes as createSharedTaskRoutes, type CollaborateServices } from '@stoneforge/shared-routes';
import { isValidCLIPlugin } from '@stoneforge/quarry/cli';
import { createOrchestratorAPI, type OrchestratorAPI } from '../api/orchestrator-api.js';
import { cliPlugin } from '../cli/plugin.js';
import { cliTaskAssigner } from '../cli/commands/task.js';
import { getOrchestratorTaskMeta, updateOrchestratorTaskMeta } from '../types/task-meta.js';
import { createTaskAssignmentService, type TaskAssignmentService } from './task-assignment-service.js';
import { applyTaskAssignee } from './task-assignee.js';

let root: string;
let storage: StorageBackend;
let api: OrchestratorAPI;
let service: TaskAssignmentService;
let task: Task;
let workerA: EntityId;
let workerB: EntityId;
let operator: EntityId;

const meta = (t: Task) => getOrchestratorTaskMeta(t.metadata);
const saved = async () => (await api.get<Task>(task.id))!;

function bulkApp(withAssigner: boolean) {
  return createSharedTaskRoutes({
    api,
    storageBackend: storage,
    ...(withAssigner ? { assignTask: (id: ElementId, assignee: EntityId | null) => applyTaskAssignee(api, service, id, assignee) } : {}),
  } as unknown as CollaborateServices);
}
async function bulk(updates: Record<string, unknown>, withAssigner = true) {
  const response = await bulkApp(withAssigner).request('/api/tasks/bulk', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [task.id], updates }),
  });
  return { status: response.status, body: await response.json() as { updated: number; failed: number; results: Array<{ success: boolean; error?: string }> } };
}
const start = (agentId: EntityId) => service.startTask(task.id, { agentId });

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'sf-task-assignee-'));
  storage = createStorage({ path: path.join(root, 'stoneforge.db') });
  initializeSchema(storage);
  api = createOrchestratorAPI(storage);
  service = createTaskAssignmentService(api);
  const system = await createEntity({ name: 'test-system', entityType: EntityTypeValue.SYSTEM, createdBy: 'system:test' as EntityId });
  const creator = (await api.create(system as unknown as Parameters<OrchestratorAPI['create']>[0])).id as unknown as EntityId;
  workerA = (await api.registerWorker({ name: 'worker-a', workerMode: 'ephemeral', createdBy: creator })).id as unknown as EntityId;
  workerB = (await api.registerWorker({ name: 'worker-b', workerMode: 'ephemeral', createdBy: creator })).id as unknown as EntityId;
  const human = await createEntity({ name: 'operator', entityType: EntityTypeValue.HUMAN, createdBy: creator });
  operator = (await api.create(human as unknown as Parameters<OrchestratorAPI['create']>[0])).id as unknown as EntityId;
  const rawTask = await createTask({ title: 'Bulk assignment fixture', createdBy: creator });
  task = await api.create<Task>(rawTask as unknown as Parameters<OrchestratorAPI['create']>[0]);
});

afterEach(() => {
  storage.close();
  rmSync(root, { recursive: true, force: true });
});

describe('PATCH /api/tasks/bulk {assignee} through the assignment contract', () => {
  test('negative control: the previous bare write leaves Start rejecting the task', async () => {
    await api.update<Task>(task.id, { assignee: workerA });
    await expect(start(workerA)).rejects.toThrow('assignee and assignedAgent must match');
  });

  test('assigning an agent records assignedAgent and branch, and Start succeeds', async () => {
    const { status, body } = await bulk({ assignee: workerA, priority: 1 });
    expect(status).toBe(200);
    expect(body).toMatchObject({ updated: 1, failed: 0 });

    const assigned = await saved();
    expect(assigned.assignee).toBe(workerA);
    expect(meta(assigned)?.assignedAgent).toBe(workerA);
    expect(meta(assigned)?.branch).toBeTruthy();
    expect(assigned.priority).toBe(1);

    const started = await start(workerA);
    expect(started.status).toBe(TaskStatus.IN_PROGRESS);
  });

  test('reassigning from a stale agent to another agent makes the new agent startable', async () => {
    await service.assignToAgent(task.id, workerA);
    await api.update<Task>(task.id, { metadata: updateOrchestratorTaskMeta((await saved()).metadata, { sessionId: 'session-a' }) });

    expect((await bulk({ assignee: workerB })).body.updated).toBe(1);
    const reassigned = await saved();
    expect(reassigned.assignee).toBe(workerB);
    expect(meta(reassigned)?.assignedAgent).toBe(workerB);
    expect(meta(reassigned)?.sessionId).toBeUndefined();
    await expect(start(workerA)).rejects.toThrow('caller is not the current assigned agent');
    expect((await start(workerB)).status).toBe(TaskStatus.IN_PROGRESS);
  });

  test('re-selecting an incoherent agent assignee repairs it', async () => {
    await api.update<Task>(task.id, { assignee: workerA });
    expect((await bulk({ assignee: workerA })).body.updated).toBe(1);
    expect(meta(await saved())?.assignedAgent).toBe(workerA);
    expect((await start(workerA)).status).toBe(TaskStatus.IN_PROGRESS);
  });

  test('an operator assignee and unassign release the agent ownership', async () => {
    await service.assignToAgent(task.id, workerA);

    expect((await bulk({ assignee: operator })).body.updated).toBe(1);
    let current = await saved();
    expect(current.assignee).toBe(operator);
    expect(meta(current)?.assignedAgent).toBeUndefined();
    expect(meta(current)?.branch).toBeTruthy();

    await service.assignToAgent(task.id, workerA);
    expect((await bulk({ assignee: null })).body.updated).toBe(1);
    current = await saved();
    expect(current.assignee).toBeUndefined();
    expect(meta(current)?.assignedAgent).toBeUndefined();
  });

  test('an unknown assignee fails the task without writing it', async () => {
    const before = await saved();
    const { status, body } = await bulk({ assignee: 'el-nobody', priority: 1 });
    expect(status).toBe(200);
    expect(body).toMatchObject({ updated: 0, failed: 1 });
    expect(body.results[0].error).toContain('Assignee not found: el-nobody');
    expect((await saved()).updatedAt).toBe(before.updatedAt);
  });

  test('a non-string assignee is rejected', async () => {
    expect((await bulk({ assignee: 42 })).status).toBe(400);
  });

  test('applyTaskAssignee rejects a non-entity assignee with ValidationError', async () => {
    await expect(applyTaskAssignee(api, service, task.id, task.id)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('PATCH /api/tasks/bulk {assignee} without an assigner (Quarry server)', () => {
  test('a reassignment releases the stale assignedAgent in the same write', async () => {
    await service.assignToAgent(task.id, workerA);
    expect((await bulk({ assignee: operator }, false)).body.updated).toBe(1);
    const current = await saved();
    expect(current.assignee).toBe(operator);
    expect(meta(current)?.assignedAgent).toBeUndefined();
    expect(meta(current)?.branch).toBeTruthy();
  });

  test('unassign releases it too', async () => {
    await service.assignToAgent(task.id, workerA);
    expect((await bulk({ assignee: '' }, false)).body.updated).toBe(1);
    const current = await saved();
    expect(current.assignee).toBeUndefined();
    expect(meta(current)?.assignedAgent).toBeUndefined();
  });
});

describe('orchestrator CLI plugin', () => {
  test('provides the task assigner used by sf task assign', () => {
    expect(cliPlugin.taskAssigner).toBe(cliTaskAssigner);
    expect(isValidCLIPlugin(cliPlugin)).toBe(true);
  });
});
