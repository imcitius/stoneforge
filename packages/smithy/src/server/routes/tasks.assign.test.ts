/**
 * Task assignment routes delegate to TaskAssignmentService (el-5s9l15).
 * Real-storage Start coverage: tasks.assign.bun.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConflictError, ConflictErrorCode, TaskStatus } from '@stoneforge/core';
import type { Task, EntityId, ElementId } from '@stoneforge/core';
import type { Services } from '../services.js';
import { createTaskRoutes } from './tasks.js';

const agent = 'el-agent' as EntityId;
const taskId = 'el-task' as ElementId;

function fixture(overrides: Partial<Task> = {}): Task {
  return {
    id: taskId, type: 'task', title: 'Assign fixture', status: TaskStatus.OPEN,
    priority: 3, complexity: 3, tags: [], createdBy: agent,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    metadata: {}, ...overrides,
  } as Task;
}

function setup() {
  const assigned = fixture({ assignee: agent, metadata: { orchestrator: { assignedAgent: agent } } });
  const api = { get: vi.fn().mockResolvedValue(fixture()), update: vi.fn() };
  const assignToAgent = vi.fn().mockResolvedValue(assigned);
  const unassignTask = vi.fn().mockResolvedValue(fixture());
  const getAgent = vi.fn().mockResolvedValue({ id: agent });
  const services = {
    api,
    agentRegistry: { getAgent },
    taskAssignmentService: { assignToAgent, unassignTask },
  } as unknown as Services;
  const app = createTaskRoutes(services);
  const send = (method: 'PATCH' | 'POST', body: unknown) => app.request(
    method === 'PATCH' ? `/api/tasks/${taskId}` : `/api/tasks/${taskId}/assign`,
    { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );
  return { api, assignToAgent, unassignTask, getAgent, send, assigned };
}

describe('task assignment routes', () => {
  for (const method of ['PATCH', 'POST'] as const) {
    it(`${method} assigns an agent through assignToAgent, not an assignee-only write`, async () => {
      const { api, assignToAgent, send } = setup();
      const response = await send(method, { assignee: agent });
      expect(response.status).toBe(200);
      expect(assignToAgent).toHaveBeenCalledWith(taskId, agent);
      expect(api.update).not.toHaveBeenCalled();
      expect((await response.json()).task.assignee).toBe(agent);
    });

    it(`${method} null unassigns through unassignTask admin mode`, async () => {
      const { api, unassignTask, send, assigned } = setup();
      api.get.mockResolvedValue(assigned);
      const response = await send(method, { assignee: null });
      expect(response.status).toBe(200);
      expect(unassignTask).toHaveBeenCalledWith(taskId, { mode: 'admin' });
      expect(api.update).not.toHaveBeenCalled();
    });

    it(`${method} returns 409 on a concurrent assignment conflict`, async () => {
      const { assignToAgent, send } = setup();
      assignToAgent.mockRejectedValue(new ConflictError('changed', ConflictErrorCode.CONCURRENT_MODIFICATION, { taskId }));
      const response = await send(method, { assignee: agent });
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe(ConflictErrorCode.CONCURRENT_MODIFICATION);
    });
  }

  it('PATCH applies remaining fields to the assigned task metadata', async () => {
    const { api, send, assigned } = setup();
    api.update.mockImplementation(async (_id: ElementId, updates: Partial<Task>) => ({ ...assigned, ...updates }));
    const response = await send('PATCH', { assignee: agent, mergeStatus: 'pending' });
    expect(response.status).toBe(200);
    const updates = api.update.mock.calls[0][1] as Task;
    expect(updates.metadata).toEqual({ orchestrator: { assignedAgent: agent, mergeStatus: 'pending' } });
  });

  it('POST /assign requires an assignee field', async () => {
    const { assignToAgent, send } = setup();
    expect((await send('POST', {})).status).toBe(400);
    expect(assignToAgent).not.toHaveBeenCalled();
  });
});
