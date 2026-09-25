/**
 * Stoneforge Smithy Server
 *
 * HTTP and WebSocket server for agent orchestration.
 * Exports startSmithyServer() for programmatic usage.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { EntityId } from '@stoneforge/core';
import { getAgentMetadata } from '../index.js';
import type { AgentEntity } from '../api/orchestrator-api.js';
import { createLogger, getLogLevel } from '../utils/logger.js';
import { CORS_ORIGINS as DEFAULT_CORS_ORIGINS, PORT as DEFAULT_PORT, HOST as DEFAULT_HOST, PROJECT_ROOT as DEFAULT_PROJECT_ROOT, DB_PATH as DEFAULT_DB_PATH } from './config.js';
import { initializeServices, type Services } from './services.js';
import {
  createHealthRoutes,
  createTaskRoutes,
  createAgentRoutes,
  createSessionRoutes,
  createWorktreeRoutes,
  createSchedulerRoutes,
  createPluginRoutes,
  createEventRoutes,
  createUploadRoutes,
  createDaemonRoutes,
  createWorkflowRoutes,
  createPoolRoutes,
  createWorkspaceFilesRoutes,
  createExtensionsRoutes,
  createSettingsRoutes,
  createAssetRoutes,
  createMetricsRoutes,
  createDiagnosticsRoutes,
  createExternalSyncRoutes,
  createApprovalRoutes,
  markDaemonAsServerManaged,
} from './routes/index.js';
// Shared collaborate routes
import {
  createElementsRoutes,
  createEntityRoutes,
  createChannelRoutes,
  createMessageRoutes,
  createLibraryRoutes,
  createDocumentRoutes,
  createInboxRoutes,
  createPlanRoutes,
  createTaskRoutes as createSharedTaskRoutes,
} from '@stoneforge/shared-routes';
import { notifyClientsOfNewSession } from './websocket.js';
import { attachSessionEventSaver } from './routes/sessions.js';
import { notifySSEClientsOfNewSession } from './routes/events.js';
import { startServer } from './server.js';
import { shouldDaemonAutoStart, saveDaemonState } from './daemon-state.js';
import { createLspManager } from './services/lsp-manager.js';
import { createLspRoutes } from './routes/lsp.js';
import { initializeBroadcaster } from '@stoneforge/shared-routes';
import { registerStaticMiddleware } from './static.js';
import { getEventsClientCount } from './events-websocket.js';
import type { ServerStartOptions } from './server.js';
import { resolve } from 'node:path';
import { acquireWorkspaceLock } from './workspace-lock.js';

const logger = createLogger('orchestrator');

export interface SmithyServerOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  projectRoot?: string;
  webRoot?: string;
  corsOrigins?: string[];
  /** Desktop supplies its transport guard before opening the listener. */
  authorize?: ServerStartOptions['authorize'];
  identity?: { projectId: string; instanceId: string; protocolVersion: number };
  autoResume?: boolean;
  autoStartDaemon?: boolean;
}

export interface SmithyServerResult {
  services: Services;
  port: number;
  /** Number of agents loaded in the registry */
  agentCount: number;
  /** Status of the dispatch daemon */
  daemonStatus: 'running' | 'disabled' | 'no-git' | 'stopped-by-user';
  /** Check if any dashboard clients are connected via WebSocket */
  hasConnectedClients: () => boolean;
  close: () => Promise<void>;
}

async function startUnlockedSmithyServer(options: SmithyServerOptions = {}): Promise<SmithyServerResult> {
  logger.info('Log level: ' + getLogLevel());
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;
  const corsOrigins = options.corsOrigins ?? [
    ...DEFAULT_CORS_ORIGINS,
    `http://${host}:${port}`,
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ];
  const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
  const projectRoot = options.projectRoot ?? DEFAULT_PROJECT_ROOT;

  const services = await initializeServices({ dbPath, projectRoot });

  // Before reconciliation, capture all directors' session info if they were running
  // This allows us to auto-resume all directors after server restart
  const directorResumes: Array<{ agent: AgentEntity; sessionId: string }> = [];
  const directors = await services.agentRegistry.getDirectors();
  for (const dir of directors) {
    const meta = getAgentMetadata(dir);
    if (options.autoResume !== false && meta?.sessionStatus === 'running' && meta?.sessionId) {
      directorResumes.push({ agent: dir, sessionId: meta.sessionId });
      logger.debug(`Director ${dir.name} was running with session ${meta.sessionId} before restart`);
    }
  }

  // Reconcile stale sessions: reset agents marked 'running' to 'idle' if process is dead
  const reconcileResult = await services.sessionManager.reconcileOnStartup();
  if (reconcileResult.reconciled > 0) {
    logger.info(`Reconciled ${reconcileResult.reconciled} stale agent session(s)`);
  }
  if (reconcileResult.errors.length > 0) {
    logger.warn('Reconciliation errors:', reconcileResult.errors);
  }

  const app = new Hono();
  if (options.identity) {
    app.get('/api/desktop/identity', (c) => c.json({ ...options.identity, projectRoot, pid: process.pid }));
  }

  app.use(
    '*',
    cors({
      origin: corsOrigins,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'Last-Event-ID'],
      credentials: true,
    })
  );

  // Register shared collaborate routes
  // NOTE: createSharedTaskRoutes registers PATCH /api/tasks/bulk and POST /api/tasks/bulk-delete
  // and MUST be registered before createTaskRoutes to avoid "bulk" matching as :id
  const collaborateServices = {
    api: services.api,
    inboxService: services.inboxService,
    storageBackend: services.storageBackend,
  };
  app.route('/', createSharedTaskRoutes(collaborateServices));

  app.route('/', createHealthRoutes(services));
  app.route('/', createTaskRoutes(services));
  app.route('/', createAgentRoutes(services));
  app.route('/', createSessionRoutes(services, notifyClientsOfNewSession));
  app.route('/', createWorktreeRoutes(services));
  app.route('/', createSchedulerRoutes(services));
  app.route('/', createPluginRoutes(services));
  app.route('/', createEventRoutes(services));
  app.route('/', createUploadRoutes());
  app.route('/', createDaemonRoutes(services));
  app.route('/', createWorkflowRoutes(services));
  app.route('/', createPoolRoutes(services));
  app.route('/', createWorkspaceFilesRoutes());
  app.route('/', createExtensionsRoutes());
  app.route('/', createSettingsRoutes(services));
  app.route('/', createAssetRoutes());
  app.route('/', createMetricsRoutes(services));
  app.route('/', createDiagnosticsRoutes(services));
  app.route('/', createExternalSyncRoutes(services));
  app.route('/', createApprovalRoutes(services));

  app.route('/', createElementsRoutes(collaborateServices));
  app.route('/', createEntityRoutes(collaborateServices));
  app.route('/', createChannelRoutes(collaborateServices));
  app.route('/', createMessageRoutes(collaborateServices));
  app.route('/', createLibraryRoutes(collaborateServices));
  app.route('/', createDocumentRoutes(collaborateServices));
  app.route('/', createInboxRoutes(collaborateServices));
  app.route('/', createPlanRoutes(collaborateServices));

  // Initialize LSP manager and routes
  const lspManager = createLspManager(projectRoot);
  await lspManager.checkAvailability();
  app.route('/', createLspRoutes(lspManager));

  // Serve pre-built web UI if webRoot is provided and exists
  if (options.webRoot) {
    registerStaticMiddleware(app, options.webRoot);
  }

  // Initialize and start the event broadcaster for real-time WebSocket events
  const broadcaster = initializeBroadcaster(services.api);
  await broadcaster.start();

  let closeTransport: (() => Promise<void>) | undefined;
  const actualPort = await startServer(app, services, lspManager, {
    port, host, authorize: options.authorize,
    onListening: (handle) => { closeTransport = handle.close; },
  });

  // If the server bound to a different port, update CORS origins dynamically.
  // Hono's cors middleware evaluates the origin list at request time, so mutating
  // the array after startup works correctly.
  if (actualPort !== port) {
    corsOrigins.push(
      `http://${host}:${actualPort}`,
      `http://127.0.0.1:${actualPort}`,
      `http://localhost:${actualPort}`,
    );
  }

  // Auto-resume all director sessions that were running before server restart
  // This must happen after startServer() so HTTP/WS infrastructure is ready for clients
  // Resume sequentially to avoid overwhelming the spawner
  for (const { agent: director, sessionId } of directorResumes) {
    const directorId = director.id as unknown as EntityId;
    logger.debug(`Attempting to auto-resume director ${director.name} session ${sessionId}`);
    try {
      const { session, events } = await services.sessionManager.resumeSession(directorId, {
        providerSessionId: sessionId,
        resumePrompt: 'Server restarted. You have been automatically reconnected to your previous session. Check your inbox for any pending messages.',
      });

      // Attach event saver to capture all agent events
      attachSessionEventSaver(events, session.id, directorId, services.sessionMessageService);

      // Notify WebSocket clients of the resumed session
      notifyClientsOfNewSession(directorId, session, events);

      // Notify SSE stream clients of the resumed session
      notifySSEClientsOfNewSession({
        sessionId: session.id,
        agentId: directorId,
        agentRole: session.agentRole || 'director',
        events,
      });

      logger.info(`Director ${director.name} session auto-resumed successfully (session: ${session.id})`);
    } catch (error) {
      // Resume failed - director will stay idle and can be started manually via UI
      logger.warn(`Failed to auto-resume director ${director.name}:`, error instanceof Error ? error.message : String(error));
    }
  }

  // Auto-start dispatch daemon based on persisted state and environment variable
  // Priority: DAEMON_AUTO_START=false disables auto-start entirely
  // Otherwise, check persisted state (remembers if user stopped it via UI/API)
  const envDisabled = options.autoStartDaemon === false || process.env.DAEMON_AUTO_START === 'false';
  const persistedShouldRun = shouldDaemonAutoStart();

  let daemonStatus: SmithyServerResult['daemonStatus'];
  if (!services.dispatchDaemon) {
    logger.info('Dispatch daemon not available (no git repository)');
    daemonStatus = 'no-git';
  } else if (envDisabled) {
    logger.info('Dispatch daemon auto-start disabled (DAEMON_AUTO_START=false)');
    daemonStatus = 'disabled';
  } else if (!persistedShouldRun) {
    logger.info('Dispatch daemon not started (was stopped by user, state persisted)');
    daemonStatus = 'stopped-by-user';
  } else {
    services.dispatchDaemon.start();
    saveDaemonState(true, 'server-startup');
    markDaemonAsServerManaged();
    logger.info('Dispatch daemon auto-started');
    daemonStatus = 'running';
  }

  // Conditionally start external sync daemon
  // The daemon is only created when externalSync.enabled AND a provider has a token.
  // If the daemon object exists, start it.
  if (services.externalSyncDaemon && options.autoStartDaemon !== false) {
    services.externalSyncDaemon.start().catch((err: Error) => {
      logger.error('Failed to start external sync daemon:', err);
    });
    logger.info('External sync daemon auto-started');
  }

  // Count loaded agents for the startup summary
  const allAgents = await services.agentRegistry.listAgents();
  const agentCount = allAgents.length;

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    const failures: unknown[] = [];
    const attempt = async (operation: () => unknown) => {
      try { await operation(); } catch (error) { failures.push(error); }
    };
    // Every cleanup runs even when another service fails to shut down.
    await attempt(() => closeTransport?.());
    await attempt(() => services.dispatchDaemon?.stop());
    await attempt(() => services.stewardScheduler.stop());
    await attempt(() => services.externalSyncDaemon?.stop());
    for (const session of services.sessionManager.listSessions()) {
      if (session.status === 'running' || session.status === 'starting' || session.status === 'suspended') {
        await attempt(() => services.sessionManager.stopSession(session.id, { graceful: true, reason: 'Server shutdown' }));
      }
    }
    // Covers partially started sessions that have not reached SessionManager yet.
    for (const session of services.spawnerService.listActiveSessions()) {
      await attempt(() => services.spawnerService.terminate(session.id, false));
    }
    await attempt(() => lspManager.stopAll());
    broadcaster.stop();
    services.autoExportService.stop();
    await attempt(() => services.syncService.export({ outputDir: resolve(projectRoot, '.stoneforge/sync'), full: false }));
    await attempt(() => services.storageBackend.close());
    if (failures.length) throw new AggregateError(failures, 'Server shutdown failed');
  })();
  return { services, port: actualPort, agentCount, daemonStatus, hasConnectedClients: () => getEventsClientCount() > 0, close };
}

/** One server owns each database, including standalone CLI and Desktop launches. */
export async function startSmithyServer(options: SmithyServerOptions = {}): Promise<SmithyServerResult> {
  const releaseLock = acquireWorkspaceLock(options.dbPath ?? DEFAULT_DB_PATH);
  process.once('exit', releaseLock);
  const release = () => { process.removeListener('exit', releaseLock); releaseLock(); };
  try {
    const result = await startUnlockedSmithyServer(options);
    let closing: Promise<void> | undefined;
    return { ...result, close: () => closing ??= result.close().finally(release) };
  } catch (error) {
    release();
    throw error;
  }
}
