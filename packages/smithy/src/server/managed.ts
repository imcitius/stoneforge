/** Desktop-only child entry point. Load server modules only AFTER fixing workspace context. */
import { realpathSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { SmithyServerResult } from './index.js';

if (!process.send) throw new Error('Managed server requires a parent IPC channel');
let server: SmithyServerResult | undefined;
let stopping = false;
let starting: Promise<void> | undefined;

async function shutdown(code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 45_000);
  try {
    await starting;
    await server?.close();
  } catch (error) {
    console.error('[managed] Shutdown failed:', error);
    code = 1;
  } finally {
    clearTimeout(timeout);
    process.exit(code);
  }
}
process.on('disconnect', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object' || !('type' in message)) return;
  if (message.type === 'stop') { void shutdown(); return; }
  if (message.type !== 'start' || starting || stopping) return;
  starting = start(message as Record<string, unknown>);
  void starting.catch((error) => {
    process.send?.({ type: 'error', error: error instanceof Error ? error.message : String(error) });
    void shutdown(1);
  });
});

async function start(message: Record<string, unknown>): Promise<void> {
  for (const key of ['projectRoot', 'projectId', 'instanceId', 'secret', 'webRoot']) {
    if (typeof message[key] !== 'string' || !message[key]) throw new Error(`Missing ${key}`);
  }
  const projectRoot = realpathSync(message.projectRoot as string);
  const dbPath = join(projectRoot, '.stoneforge/stoneforge.db');
  if (!existsSync(dbPath)) throw new Error('Select an initialized Stoneforge workspace');
  process.chdir(projectRoot);
  process.env.STONEFORGE_ROOT = projectRoot;
  process.env.STONEFORGE_DB_PATH = dbPath;
  process.env.STONEFORGE_UPLOAD_DIR = resolve(projectRoot, '.stoneforge/uploads/terminal');
  process.env.DAEMON_AUTO_START = 'false';
  delete process.env.SF_ENTITY_ID;
  const identity = { projectId: message.projectId as string, instanceId: message.instanceId as string, protocolVersion: 1 };
  process.env.STONEFORGE_DESKTOP_INSTANCE_ID = identity.instanceId;
  const secret = Buffer.from(message.secret as string);
  const { startSmithyServer } = await import('./index.js');
  server = await startSmithyServer({
    projectRoot, dbPath, port: 0, host: '127.0.0.1', webRoot: message.webRoot as string,
    identity, autoResume: false, autoStartDaemon: false,
    authorize: (headers) => {
      const provided = Buffer.from(headers.get('x-stoneforge-secret') ?? '');
      return headers.get('x-stoneforge-project') === identity.projectId &&
        headers.get('x-stoneforge-instance') === identity.instanceId &&
        provided.length === secret.length && timingSafeEqual(provided, secret);
    },
  });
  // The lock owns this private connection file; releasing the lock removes it.
  // CLI tools discover it through STONEFORGE_ROOT, including inside worktrees.
  writeFileSync(join(projectRoot, '.stoneforge/server.lock/desktop.json'), JSON.stringify({
    ...identity, projectRoot, endpoint: `http://127.0.0.1:${server.port}`, secret: message.secret,
  }), { mode: 0o600 });
  if (!stopping) process.send?.({ type: 'ready', ...identity, projectRoot, pid: process.pid, port: server.port });
}
