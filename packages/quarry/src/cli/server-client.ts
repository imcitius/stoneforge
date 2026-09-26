/** Bind CLI HTTP requests to the workspace's live Desktop instance. */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findStoneforgeDir } from '../config/file.js';

interface DesktopConnection {
  endpoint: string;
  projectRoot: string;
  projectId: string;
  instanceId: string;
  secret: string;
}

function desktopConnection(): DesktopConnection | undefined {
  const expectedInstance = process.env.STONEFORGE_DESKTOP_INSTANCE_ID;
  const directory = findStoneforgeDir(process.cwd());
  if (!directory) {
    if (expectedInstance) throw new Error('Desktop workspace is unavailable. Refusing to use another server.');
    return undefined;
  }
  let data: DesktopConnection;
  try { data = JSON.parse(readFileSync(join(directory, 'server.lock/desktop.json'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !expectedInstance) return undefined;
    throw new Error('Desktop connection is unavailable. Reopen the project; no other server was contacted.');
  }
  const endpoint = new URL(data.endpoint);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port ||
      endpoint.origin !== data.endpoint || !data.projectId || !data.instanceId || !data.secret ||
      data.projectRoot !== dirname(realpathSync(directory)) ||
      (expectedInstance && expectedInstance !== data.instanceId)) {
    throw new Error('Desktop connection does not match this workspace/session. Reopen the agent session.');
  }
  return data;
}

export function getOrchestratorUrl(explicit?: string): string {
  const desktop = desktopConnection();
  if (desktop) {
    if (explicit && explicit.replace(/\/$/, '') !== desktop.endpoint) throw new Error('Cannot override the server of a Desktop workspace.');
    return desktop.endpoint;
  }
  return (explicit || process.env.STONEFORGE_API_URL || process.env.ORCHESTRATOR_URL || 'http://localhost:3457').replace(/\/$/, '');
}

export async function orchestratorFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const desktop = desktopConnection();
  if (!desktop) return fetch(url, init);
  if (new URL(url).origin !== desktop.endpoint) throw new Error('Refusing a request to another project server.');
  const headers = new Headers(init.headers);
  headers.set('x-stoneforge-project', desktop.projectId);
  headers.set('x-stoneforge-instance', desktop.instanceId);
  headers.set('x-stoneforge-secret', desktop.secret);
  const signal = init.signal ?? AbortSignal.timeout(5000);
  const identity = await fetch(desktop.endpoint + '/api/desktop/identity', { headers, signal, redirect: 'error' });
  if (!identity.ok) throw new Error('Desktop server identity could not be verified.');
  const actual = await identity.json() as Partial<DesktopConnection>;
  if (actual.projectId !== desktop.projectId || actual.instanceId !== desktop.instanceId || actual.projectRoot !== desktop.projectRoot) {
    throw new Error('Desktop server identity mismatch; request was not sent.');
  }
  return fetch(url, { ...init, headers, signal, redirect: 'error' });
}
