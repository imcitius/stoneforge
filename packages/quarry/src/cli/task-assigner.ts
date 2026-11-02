/**
 * CLI Task Assigner Registry
 *
 * `sf task assign` (and `sf assign`) is a built-in Quarry command, but an
 * assignment to an orchestrator agent must also record the orchestrator
 * ownership (metadata.orchestrator.assignedAgent, branch, worktree...), which
 * only the orchestrator plugin knows how to do (el-4y870m). A plugin provides
 * that contract through `CLIPlugin.taskAssigner`; without one, Quarry writes
 * the assignee and releases a stale orchestrator assignment.
 */

import type { ElementId, EntityId, Task } from '@stoneforge/core';
import type { GlobalOptions } from './types.js';

/**
 * Applies an assignee change (`null` unassigns) to one task and resolves with
 * the updated task. Rejects for an unknown task or invalid assignee.
 */
export type CliTaskAssigner = (
  taskId: ElementId,
  assignee: EntityId | null,
  options: GlobalOptions
) => Promise<Task>;

let registeredAssigner: { pluginName: string; assigner: CliTaskAssigner } | undefined;

/**
 * Registers the task assigner of a plugin. The first registration wins, like
 * plugin commands; returns false when another plugin already registered one.
 */
export function registerTaskAssigner(pluginName: string, assigner: CliTaskAssigner): boolean {
  if (registeredAssigner && registeredAssigner.assigner !== assigner) {
    return false;
  }
  registeredAssigner = { pluginName, assigner };
  return true;
}

/** The registered plugin task assigner, if any. */
export function getTaskAssigner(): CliTaskAssigner | undefined {
  return registeredAssigner?.assigner;
}

/** Clears the registered task assigner (tests). */
export function clearTaskAssigner(): void {
  registeredAssigner = undefined;
}
