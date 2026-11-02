/**
 * Task Bulk Routes Factory
 *
 * Bulk update and bulk delete endpoints for tasks.
 * These are shared across quarry and smithy servers to avoid duplication.
 */

import { Hono } from 'hono';
import type { ElementId, EntityId, Task } from '@stoneforge/core';
import { releaseStaleOrchestratorAssignment } from '@stoneforge/core';
import type { CollaborateServices } from './types.js';

export function createTaskRoutes(services: CollaborateServices) {
  const { api, assignTask } = services;
  const app = new Hono();

  /**
   * PATCH /api/tasks/bulk
   * Bulk update tasks by IDs.
   *
   * IMPORTANT: This route MUST be registered before any PATCH /api/tasks/:id
   * route, otherwise "bulk" gets matched as a task ID parameter.
   *
   * Body:
   * - ids: string[] — Non-empty array of task IDs to update
   * - updates: object — Fields to update (whitelisted). `assignee` (string,
   *   or null/empty to unassign) goes through `services.assignTask` when the
   *   server provides one; otherwise a stale orchestrator assignment is
   *   released in the same write.
   */
  app.patch('/api/tasks/bulk', async (c) => {
    try {
      const body = await c.req.json();

      // Validate request structure
      if (!body.ids || !Array.isArray(body.ids) || body.ids.length === 0) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'ids must be a non-empty array' } }, 400);
      }
      if (!body.updates || typeof body.updates !== 'object') {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'updates must be an object' } }, 400);
      }

      const ids = body.ids as string[];

      // Extract allowed updates
      const updates: Record<string, unknown> = {};
      const allowedFields = [
        'status', 'priority', 'complexity', 'taskType',
        'assignee', 'owner', 'deadline', 'scheduledFor', 'tags',
      ];

      for (const field of allowedFields) {
        if (body.updates[field] !== undefined) {
          updates[field] = body.updates[field];
        }
      }

      if (Object.keys(updates).length === 0) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'No valid fields to update' } }, 400);
      }

      // An assignee change must keep metadata.orchestrator coherent
      // (el-4y870m): a bare `assignee` write left assignedAgent stale, so the
      // orchestrator later rejected the task on start.
      const hasAssignee = 'assignee' in updates;
      const assigneeValue = updates.assignee;
      if (hasAssignee && assigneeValue !== null && typeof assigneeValue !== 'string') {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'assignee must be a string or null' } }, 400);
      }
      const assignee = hasAssignee ? ((assigneeValue as string | null) || null) as EntityId | null : undefined;
      const otherUpdates: Record<string, unknown> = { ...updates };
      delete otherUpdates.assignee;

      // Update each task
      const results: { id: string; success: boolean; error?: string }[] = [];

      for (const id of ids) {
        try {
          const existing = await api.get<Task>(id as ElementId);
          if (!existing || existing.type !== 'task') {
            results.push({ id, success: false, error: 'Task not found' });
            continue;
          }

          if (assignee !== undefined && assignTask) {
            // Owner-specific assignment contract first, then the other fields
            // on top of the task it produced.
            await assignTask(id as ElementId, assignee);
            if (Object.keys(otherUpdates).length > 0) {
              await api.update(id as ElementId, otherUpdates);
            }
          } else if (assignee !== undefined) {
            const metadata = releaseStaleOrchestratorAssignment(existing.metadata, assignee ?? undefined);
            await api.update<Task>(
              id as ElementId,
              {
                ...otherUpdates,
                assignee: assignee ?? undefined,
                ...(metadata !== existing.metadata ? { metadata } : {}),
              },
              // Metadata is derived from this snapshot; never overwrite a newer one.
              metadata !== existing.metadata ? { expectedUpdatedAt: existing.updatedAt } : undefined
            );
          } else {
            await api.update(id as ElementId, updates);
          }
          results.push({ id, success: true });
        } catch (error) {
          results.push({ id, success: false, error: (error as Error).message });
        }
      }

      const successCount = results.filter((r) => r.success).length;
      const failureCount = results.filter((r) => !r.success).length;

      return c.json({
        updated: successCount,
        failed: failureCount,
        results,
      });
    } catch (error) {
      console.error('[stoneforge] Failed to bulk update tasks:', error);
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to bulk update tasks' } }, 500);
    }
  });

  /**
   * POST /api/tasks/bulk-delete
   * Bulk delete tasks by IDs.
   *
   * Uses POST with a body for better proxy compatibility
   * (some proxies strip bodies from DELETE requests).
   *
   * Body:
   * - ids: string[] — Non-empty array of task IDs to delete
   */
  app.post('/api/tasks/bulk-delete', async (c) => {
    try {
      const body = await c.req.json();

      // Validate request structure
      if (!body.ids || !Array.isArray(body.ids) || body.ids.length === 0) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'ids must be a non-empty array' } }, 400);
      }

      const ids = body.ids as string[];

      // Delete each task
      const results: { id: string; success: boolean; error?: string }[] = [];

      for (const id of ids) {
        try {
          const existing = await api.get(id as ElementId);
          if (!existing || existing.type !== 'task') {
            results.push({ id, success: false, error: 'Task not found' });
            continue;
          }

          await api.delete(id as ElementId);
          results.push({ id, success: true });
        } catch (error) {
          results.push({ id, success: false, error: (error as Error).message });
        }
      }

      const successCount = results.filter((r) => r.success).length;
      const failureCount = results.filter((r) => !r.success).length;

      return c.json({
        deleted: successCount,
        failed: failureCount,
        results,
      });
    } catch (error) {
      console.error('[stoneforge] Failed to bulk delete tasks:', error);
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to bulk delete tasks' } }, 500);
    }
  });

  return app;
}
