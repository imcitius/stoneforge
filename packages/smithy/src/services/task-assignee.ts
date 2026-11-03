/**
 * Task Assignee Contract
 *
 * Applies a generic "set the assignee of this task" request (bulk dashboard
 * update, `sf task assign`) through the orchestrator assignment contract
 * (el-4y870m). Writing `task.assignee` alone left
 * `metadata.orchestrator.assignedAgent` unset or stale, so a later
 * `startTask` rejected the task: "assignee and assignedAgent must match".
 *
 * - `null`: administrative unassign (`unassignTask` mode `admin`).
 * - registered agent: `assignToAgent` (assignee, assignedAgent, branch and
 *   worktree together, per ASSIGNMENT_RESET_FIELDS). Re-selecting the
 *   coherent current agent is a no-op; re-selecting it while incoherent
 *   repairs the assignment.
 * - other entity (operator): assignee set and the orchestrator agent
 *   ownership fields released in one write, like an admin unassign.
 * - anything else: ValidationError, nothing written.
 */

import type { ElementId, EntityId, Entity, Task } from '@stoneforge/core';
import {
  ElementType,
  ErrorCode,
  NotFoundError,
  ValidationError,
  asElementId,
  releaseStaleOrchestratorAssignment,
} from '@stoneforge/core';
import type { QuarryAPI } from '@stoneforge/quarry';
import { getOrchestratorTaskMeta } from '../types/task-meta.js';
import { isAgentEntity } from './agent-registry.js';
import type { TaskAssignmentService } from './task-assignment-service.js';

export async function applyTaskAssignee(
  api: QuarryAPI,
  assignmentService: TaskAssignmentService,
  taskId: ElementId,
  assignee: EntityId | string | null | undefined,
  currentTask?: Task
): Promise<Task> {
  const task = currentTask ?? await api.get<Task>(taskId);
  if (!task || task.type !== ElementType.TASK) {
    throw new NotFoundError(`Task not found: ${taskId}`, ErrorCode.NOT_FOUND, { elementId: taskId });
  }
  const meta = getOrchestratorTaskMeta(task.metadata);

  if (!assignee) {
    if (!task.assignee && !meta?.assignedAgent) return task;
    return assignmentService.unassignTask(task.id, { mode: 'admin' });
  }

  const entity = await api.get<Entity>(asElementId(assignee));
  if (!entity || entity.type !== ElementType.ENTITY) {
    throw new ValidationError(`Assignee not found: ${assignee}`, ErrorCode.INVALID_INPUT, { field: 'assignee', value: assignee });
  }

  if (isAgentEntity(entity)) {
    if (task.assignee === assignee && meta?.assignedAgent === assignee) return task;
    return assignmentService.assignToAgent(task.id, assignee as EntityId);
  }

  const metadata = releaseStaleOrchestratorAssignment(task.metadata, assignee);
  if (task.assignee === assignee && metadata === task.metadata) return task;
  return api.update<Task>(
    task.id,
    { assignee: assignee as EntityId, ...(metadata !== task.metadata ? { metadata } : {}) },
    { expectedUpdatedAt: task.updatedAt }
  );
}
