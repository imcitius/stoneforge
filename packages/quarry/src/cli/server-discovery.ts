import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
const exec = promisify(execFile);
export interface ExternalServer {
  pid: number;
  started: string;
  endpoint: string;
  database: string;
  credentials?: { projectId: string; instanceId: string; secret: string };
}
async function command(file: string, args: string[]): Promise<string> {
  try { return (await exec(file, args, { timeout: 3000, maxBuffer: 1024 * 1024 })).stdout.trim(); }
  catch (error) { if ((error as { code?: number }).code === 1) return ''; throw error; }
}
export async function externalServerAlive(server: ExternalServer): Promise<boolean> {
  try {
    const started = await command('/bin/ps', ['-p', String(server.pid), '-o', 'lstart=']);
    if (!started || started !== server.started) return false;
    const files = await command('/usr/sbin/lsof', ['-nP', '-a', '-p', String(server.pid), '-Fn']);
    const host = new URL(server.endpoint).host;
    return files.split('\n').includes('n' + server.database) && files.split('\n').some((line) => line === 'n' + host || line === 'n*:' + new URL(server.endpoint).port);
  } catch { return false; }
}
/** Discover by database owner and listening socket, never by a default port. */
export async function findExternalServer(root: string): Promise<ExternalServer | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const database = await realpath(join(root, '.stoneforge/stoneforge.db'));
  const holders = await command('/usr/sbin/lsof', ['-t', database]);
  for (const value of holders.split('\n').filter(Boolean)) {
    const pid = Number(value);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
    const started = await command('/bin/ps', ['-p', value, '-o', 'lstart=']);
    const listeners = await command('/usr/sbin/lsof', ['-nP', '-a', '-p', value, '-iTCP', '-sTCP:LISTEN', '-Fn']);
    for (const line of listeners.split('\n')) {
      const match = /^n(127\.0\.0\.1|\[::1\]|\*):(\d+)$/.exec(line);
      if (!match) continue;
      const endpoint = `http://${match[1] === '*' ? '127.0.0.1' : match[1]}:${match[2]}`;
      const server: ExternalServer = { pid, started, endpoint, database };
      try {
        // Modern instances have an authenticated descriptor. Legacy servers
        // must prove the exact database through health plus OS socket ownership.
        try {
          const data = JSON.parse(await readFile(join(root, '.stoneforge/server.lock/desktop.json'), 'utf8'));
          if (data.endpoint === endpoint && data.projectRoot === root && data.secret && data.projectId && data.instanceId) server.credentials = data;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue; }
        const headers = server.credentials ? {
          'x-stoneforge-project': server.credentials.projectId,
          'x-stoneforge-instance': server.credentials.instanceId,
          'x-stoneforge-secret': server.credentials.secret,
        } : undefined;
        const response = await fetch(endpoint + (headers ? '/api/desktop/identity' : '/api/health'), { headers, signal: AbortSignal.timeout(2000), redirect: 'error' });
        if (!response.ok) continue;
        const health = await response.json() as Record<string, unknown>;
        if (headers ? health.projectRoot !== root || health.instanceId !== server.credentials!.instanceId || health.projectId !== server.credentials!.projectId :
          typeof health.database !== 'string' || await realpath(health.database) !== database || health.status !== 'ok') continue;
        if (await externalServerAlive(server)) return server;
      } catch { /* A database client without a matching server is not adoptable. */ }
    }
  }
  return undefined;
}
