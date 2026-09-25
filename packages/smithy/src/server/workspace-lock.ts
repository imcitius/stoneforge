import { mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Exclusive ownership shared by managed Desktop and standalone sf serve. */
export function acquireWorkspaceLock(dbPath: string): () => void {
  if (dbPath === ':memory:') return () => {};
  const absoluteDb = resolve(dbPath);
  mkdirSync(dirname(absoluteDb), { recursive: true });
  const lock = join(realpathSync(dirname(absoluteDb)), 'server.lock');
  try { mkdirSync(lock); } catch {
    throw new Error(`Workspace is already served, or has a stale lock: ${lock}. Close its owner first. After a crash, verify no server or agents remain before removing this directory.`);
  }
  const release = () => rmSync(lock, { recursive: true, force: true });
  try {
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
    // Older servers do not participate in our lock. On macOS, fail closed if
    // another process already has the SQLite file open. Do not adopt/kill it.
    if (process.platform === 'darwin') {
      let holders = '';
      try {
        holders = execFileSync('/usr/sbin/lsof', ['-t', absoluteDb], {
          encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch (error) {
        if ((error as { status?: number }).status !== 1) throw new Error('Cannot check existing workspace database owners');
      }
      if (holders) throw new Error('Workspace database is open in another process. Stop its sf serve instance first.');
    }
    return release;
  } catch (error) { release(); throw error; }
}
