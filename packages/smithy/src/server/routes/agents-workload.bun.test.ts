import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createEntity, createTask, EntityTypeValue, TaskStatus, type EntityId } from '@stoneforge/core';
import { createQuarryAPI, type QuarryAPI } from '@stoneforge/quarry';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createAgentRegistry } from '../../services/agent-registry.js';
import { createTaskAssignmentService } from '../../services/task-assignment-service.js';
import type { Services } from '../services.js';
import { createAgentRoutes } from './agents.js';

describe('GET /api/agents/:id/workload', () => {
  let storage: StorageBackend;
  let api: QuarryAPI;
  let app: ReturnType<typeof createAgentRoutes>;
  const createdBy = 'system:test' as EntityId;

  beforeEach(() => {
    storage = createStorage(':memory:');
    initializeSchema(storage);
    api = createQuarryAPI(storage);
    app = createAgentRoutes({
      agentRegistry: createAgentRegistry(api),
      taskAssignmentService: createTaskAssignmentService(api),
    } as Services);
  });

  afterEach(() => storage.close());

  test.each([
    { name: 'explicit single-task limit', metadata: { maxConcurrentTasks: 1 }, limit: 1, hasCapacity: false },
    { name: 'custom limit', metadata: { maxConcurrentTasks: 4 }, limit: 4, hasCapacity: true },
    { name: 'missing limit defaults to one', metadata: {}, limit: 1, hasCapacity: false },
    {
      name: 'canonical limit overrides conflicting capabilities',
      metadata: { maxConcurrentTasks: 1, capabilities: { maxConcurrentTasks: 9 } },
      limit: 1,
      hasCapacity: false,
    },
    {
      name: 'capabilities alone does not override the default',
      metadata: { capabilities: { maxConcurrentTasks: 9 } },
      limit: 1,
      hasCapacity: false,
    },
  ])('$name', async ({ metadata, limit, hasCapacity }) => {
    const agent = await api.create(await createEntity({
      name: 'workload-worker',
      entityType: EntityTypeValue.AGENT,
      createdBy,
      metadata: { agent: { agentRole: 'worker', workerMode: 'ephemeral', ...metadata } },
    }));
    const agentId = agent.id as unknown as EntityId;
    await api.create(await createTask({
      title: 'Active task',
      createdBy,
      assignee: agentId,
      status: TaskStatus.IN_PROGRESS,
      metadata: { orchestrator: { assignedAgent: agentId, startedAt: agent.createdAt } },
    }));

    // Exercise the real assignment service so the reported limit and effective
    // capacity are checked against the same persisted agent and active task.
    const response = await app.request(`/api/agents/${agentId}/workload`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      agentId,
      agentName: 'workload-worker',
      maxConcurrentTasks: limit,
      hasCapacity,
      workload: {
        agentId,
        totalTasks: 1,
        byStatus: { open: 0, in_progress: 1, blocked: 0, deferred: 0, backlog: 0, review: 0, closed: 0, tombstone: 0 },
        inProgressCount: 1,
        awaitingMergeCount: 0,
      },
    });
  });

  test('returns 404 for an unknown agent', async () => {
    const response = await app.request('/api/agents/el-missing/workload');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });
  });
});
