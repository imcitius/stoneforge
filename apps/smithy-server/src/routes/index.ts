/**
 * Routes Index
 *
 * Re-exports all route factories.
 */

export { createHealthRoutes } from './health.js';
export { createTaskRoutes } from './tasks.js';
export { createAgentRoutes } from './agents.js';
export { createSessionRoutes } from './sessions.js';
export { createWorktreeRoutes } from './worktrees.js';
export { createSchedulerRoutes } from './scheduler.js';
export { createPluginRoutes } from './plugins.js';
export { createEventRoutes, notifySSEClientsOfNewSession } from './events.js';
export { createUploadRoutes } from './upload.js';
// Daemon HTTP routes live in @stoneforge/smithy/server (the dev entry point uses it).
export { createWorkflowRoutes } from './workflows.js';
export { createPoolRoutes } from './pools.js';
export { createLspRoutes } from './lsp.js';
export { createWorkspaceFilesRoutes } from './workspace-files.js';
export { createExtensionsRoutes } from './extensions.js';
