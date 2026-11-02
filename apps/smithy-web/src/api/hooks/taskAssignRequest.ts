/**
 * Request for assigning a task from the dashboard (el-5s9l15).
 *
 * The server's POST /api/tasks/:id/assign routes agent assignment through the
 * orchestrator assignment contract, writing assignee and
 * metadata.orchestrator.assignedAgent together; `null` unassigns.
 */
export function taskAssignRequest(taskId: string, assignee: string | null): { path: string; init: RequestInit } {
  return {
    path: `/tasks/${encodeURIComponent(taskId)}/assign`,
    init: { method: 'POST', body: JSON.stringify({ assignee }) },
  };
}
