/**
 * Shared start-transition contract (el-2htch, el-52oa7i).
 *
 * `TaskAssignmentService.startTask`, `assignToAgent(..., { markAsStarted })` and
 * `OrchestratorAPI.assignTaskToAgent(..., { markAsStarted })` all move a task to
 * IN_PROGRESS. They share one status rule so no start path can resurrect work
 * that moved on (REVIEW, CLOSED, DEFERRED, ...). This module only depends on
 * core so both the service and the API layer can import it without a cycle.
 *
 * @module
 */

import type { ElementId, Task } from '@stoneforge/core';
import { ConflictError, ConflictErrorCode, TaskStatus } from '@stoneforge/core';

/** Statuses from which a task may be started. */
export const STARTABLE_TASK_STATUSES: readonly Task['status'][] = [TaskStatus.OPEN, TaskStatus.IN_PROGRESS];

/** True when the task's status permits a start transition. */
export function isStartableTaskStatus(status: Task['status']): boolean {
  return STARTABLE_TASK_STATUSES.includes(status);
}

/** Message shared by every start path for a non-startable status. */
export function nonStartableStatusMessage(taskId: ElementId, status: Task['status']): string {
  return `Cannot start task ${taskId}: task is in '${status}' status; only open or in_progress work can be started.`;
}

/**
 * Rejects (no write) when `task` cannot be started. Used by the assignment
 * `markAsStarted` paths, which commit assignment and start in one CAS write.
 */
export function assertTaskStartable(task: Pick<Task, 'id' | 'status' | 'assignee'>): void {
  if (!isStartableTaskStatus(task.status)) {
    throw new ConflictError(
      nonStartableStatusMessage(task.id, task.status),
      ConflictErrorCode.CONCURRENT_MODIFICATION,
      { taskId: task.id, status: task.status, assignee: task.assignee, startErrorKind: 'invalid-state' }
    );
  }
}
