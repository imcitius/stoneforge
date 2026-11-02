import { repoCommand } from './commands/repo.js';
/**
 * Orchestrator CLI Plugin
 *
 * Exports the CLI plugin that registers orchestrator commands
 * with the main `sf` CLI.
 */

import type { CLIPlugin } from '@stoneforge/quarry/cli';
import { agentCommand } from './commands/agent.js';
import { daemonCommand } from './commands/daemon.js';
import { dispatchCommand } from './commands/dispatch.js';
import { mergeCommand } from './commands/merge.js';
import { poolCommand } from './commands/pool.js';
import { taskCommand, cliTaskAssigner } from './commands/task.js';

/**
 * The orchestrator CLI plugin.
 *
 * Provides commands for:
 * - `agent`: Manage orchestrator agents (list, show, register, start, stop, stream)
 * - `daemon`: Manage the dispatch daemon (start, stop, status)
 * - `dispatch`: Dispatch tasks to agents
 * - `merge`: Squash-merge a branch into the default branch
 * - `pool`: Manage agent pools for concurrency limiting
 * - `task`: Task management (handoff, complete)
 *
 * It also provides the task assigner used by the built-in `sf task assign`.
 *
 * Note: `sf serve` is handled by the quarry CLI directly, which auto-detects
 * smithy availability and delegates via `sf serve smithy`.
 */
export const cliPlugin: CLIPlugin = {
  name: 'orchestrator',
  version: '0.1.0',
  commands: [repoCommand, agentCommand, daemonCommand, dispatchCommand, mergeCommand, poolCommand, taskCommand],
  aliases: {
    agents: 'agent list',
    pools: 'pool list',
  },
  // `sf task assign` / `sf assign` assign through the orchestrator contract
  // instead of a bare assignee write (el-4y870m).
  taskAssigner: cliTaskAssigner,
};
