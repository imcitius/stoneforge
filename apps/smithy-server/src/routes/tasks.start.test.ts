import { describe, expect, it, vi } from 'vitest';
import { ConflictError, ConflictErrorCode, TaskStatus } from '@stoneforge/core';
import type { Task, EntityId, ElementId } from '@stoneforge/core';
import type { Services } from '../services.js';
import { createTaskRoutes } from './tasks.js';

const owner = 'el-owner' as EntityId;
const other = 'el-other' as EntityId;
const taskId = 'el-task' as ElementId;

function fixture(status: Task['status'] = TaskStatus.OPEN): Task {
  return {
    id: taskId, type: 'task', title: 'Start fixture', status, assignee: owner,
    priority: 3, complexity: 3, tags: [], createdBy: owner,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    metadata: { orchestrator: { assignedAgent: owner, sessionId: 'session-1' } },
  } as Task;
}

function setup() {
  const api = { get: vi.fn().mockResolvedValue(fixture()), update: vi.fn().mockResolvedValue(fixture(TaskStatus.IN_PROGRESS)) };
  const startTask = vi.fn().mockResolvedValue(fixture(TaskStatus.IN_PROGRESS));
  const services = { api, taskAssignmentService: { startTask } } as unknown as Services;
  const app = createTaskRoutes(services);
  const request = (agentId: string, sessionId = 'session-1') => app.request(`/api/tasks/${taskId}/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId, sessionId }),
  });
  return { api, startTask, request, app };
}

function rejection(kind: 'invalid-state' | 'invalid-assignee' | 'conflict') {
  return new ConflictError('Start rejected', ConflictErrorCode.CONCURRENT_MODIFICATION, { startErrorKind: kind });
}

describe('POST /api/tasks/:id/start', () => {
  for (const status of [TaskStatus.REVIEW, TaskStatus.CLOSED]) {
    it(`rejects ${status} without a route write`, async () => {
      const { api, startTask, request } = setup();
      api.get.mockResolvedValue(fixture(status));
      startTask.mockRejectedValue(rejection('invalid-state'));
      const response = await request(owner);
      expect(response.status).toBe(422);
      expect(startTask).toHaveBeenCalledWith(taskId, { agentId: owner, sessionId: 'session-1' });
      expect(api.update).not.toHaveBeenCalled();
    });
  }

  it('rejects a non-assignee caller', async () => {
    const { api, startTask, request } = setup();
    startTask.mockRejectedValue(rejection('invalid-assignee'));
    const response = await request(other);
    expect(response.status).toBe(422);
    expect(startTask).toHaveBeenCalledWith(taskId, { agentId: other, sessionId: 'session-1' });
    expect(api.update).not.toHaveBeenCalled();
  });

  it('starts for the current assignee through the service', async () => {
    const { api, startTask, request } = setup();
    const response = await request(owner);
    expect(response.status).toBe(200);
    expect((await response.json()).task.status).toBe(TaskStatus.IN_PROGRESS);
    expect(startTask).toHaveBeenCalledWith(taskId, { agentId: owner, sessionId: 'session-1' });
    expect(api.update).not.toHaveBeenCalled();
  });

  it('returns conflict on a concurrent update without a route overwrite', async () => {
    const { api, startTask, request } = setup();
    startTask.mockRejectedValue(rejection('conflict'));
    const response = await request(owner);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe(ConflictErrorCode.CONCURRENT_MODIFICATION);
    expect(api.update).not.toHaveBeenCalled();
  });

  it('requires a caller assertion in the request', async () => {
    const { api, startTask, app } = setup();
    const response = await app.request(`/api/tasks/${taskId}/start`, { method: 'POST' });
    expect(response.status).toBe(400);
    expect(startTask).not.toHaveBeenCalled();
    expect(api.update).not.toHaveBeenCalled();
  });
});
