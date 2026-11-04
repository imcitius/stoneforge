/**
 * Which live session (if any) other than the caller uses a worktree.
 *
 * Shared by every merge cleanup path (MergeStewardService in the server and the
 * `sf task merge` / `sf merge --cleanup` CLI commands) so they apply one rule:
 * a session uses a worktree when its recorded worktree or working directory is
 * the worktree or a directory inside it.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';

/** Session statuses that still have (or are about to have) a running process. */
export const LIVE_SESSION_STATUSES = ['starting', 'running', 'terminating'] as const;

export interface WorktreeSessionCandidate {
  id: string;
  agentId?: string;
  status?: string;
  worktree?: string;
  workingDirectory?: string;
}

function canonical(directory: string, base: string): string {
  const resolved = path.resolve(base, directory);
  try { return realpathSync(resolved); } catch { return resolved; }
}

/** True when the session's worktree/working directory is `worktreePath` or inside it. */
export function sessionUsesWorktree(session: WorktreeSessionCandidate, worktreePath: string, base: string): boolean {
  const target = canonical(worktreePath, base);
  return [session.worktree, session.workingDirectory].some(directory => {
    if (!directory) return false;
    const candidate = canonical(directory, base);
    return candidate === target || candidate.startsWith(target + path.sep);
  });
}

/**
 * The first live session other than `callerSessionId` that uses the worktree.
 * Sessions without a status are treated as live (fail-safe).
 */
export function findOtherLiveSessionInWorktree<T extends WorktreeSessionCandidate>(
  sessions: readonly T[],
  worktreePath: string,
  base: string,
  callerSessionId?: string,
): T | undefined {
  return sessions.find(session => session.id !== callerSessionId &&
    (session.status === undefined || (LIVE_SESSION_STATUSES as readonly string[]).includes(session.status)) &&
    sessionUsesWorktree(session, worktreePath, base));
}
