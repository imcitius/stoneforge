/**
 * Merge cleanup guard for CLI commands (`sf task merge`, `sf merge --cleanup`).
 *
 * The CLI runs in its own process and has no SessionManager. It asks the
 * workspace's running Smithy server (Desktop or external, via the same
 * authenticated discovery as other CLI server calls) for live sessions and keeps
 * the worktree when another session still uses it. The caller's own session
 * (STONEFORGE_SESSION_ID) is excluded.
 *
 * Fail-safe: when liveness cannot be determined (no server for the workspace,
 * request failure, malformed response) the worktree is retained. The merge itself
 * is already delivered and recorded; only cleanup is deferred.
 */
import { getOrchestratorUrl, orchestratorFetch } from '@stoneforge/quarry/cli';
import {
  LIVE_SESSION_STATUSES,
  findOtherLiveSessionInWorktree,
  type WorktreeSessionCandidate,
} from '../runtime/worktree-session-use.js';

export type LiveSessionLister = () => Promise<WorktreeSessionCandidate[]>;

export type WorktreeCleanupDecision =
  | { remove: true }
  | { remove: false; reason: 'in-use'; sessionId: string; agentId?: string; message: string }
  | { remove: false; reason: 'unknown'; message: string };

/** Live sessions reported by the workspace's Smithy server. Throws when unavailable. */
export async function listLiveSessionsFromServer(): Promise<WorktreeSessionCandidate[]> {
  const base = await getOrchestratorUrl();
  const response = await orchestratorFetch(`${base}/api/sessions?status=${LIVE_SESSION_STATUSES.join(',')}`, {
    method: 'GET',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`sessions request returned HTTP ${response.status}`);
  const data = await response.json() as { sessions?: unknown };
  if (!Array.isArray(data?.sessions)) throw new Error('sessions response has no session list');
  return data.sessions
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map(entry => ({
      id: String(entry.id ?? ''),
      agentId: typeof entry.agentId === 'string' ? entry.agentId : undefined,
      status: typeof entry.status === 'string' ? entry.status : undefined,
      worktree: typeof entry.worktree === 'string' ? entry.worktree : undefined,
      workingDirectory: typeof entry.workingDirectory === 'string' ? entry.workingDirectory : undefined,
    }));
}

export async function decideWorktreeCleanup(options: {
  worktreePath: string;
  /** Base directory for relative paths (the project root). */
  base: string;
  callerSessionId?: string;
  listSessions?: LiveSessionLister;
}): Promise<WorktreeCleanupDecision> {
  const { worktreePath, base, callerSessionId, listSessions = listLiveSessionsFromServer } = options;
  let sessions: WorktreeSessionCandidate[];
  try {
    sessions = await listSessions();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      remove: false,
      reason: 'unknown',
      message: `Worktree retained: could not determine live sessions (${reason}). ` +
        `Remove it once no session uses it: git worktree remove -- ${worktreePath}`,
    };
  }
  const other = findOtherLiveSessionInWorktree(sessions, worktreePath, base, callerSessionId);
  if (!other) return { remove: true };
  return {
    remove: false,
    reason: 'in-use',
    sessionId: other.id,
    agentId: other.agentId,
    message: `Worktree retained: live session ${other.id}${other.agentId ? ` (agent ${other.agentId})` : ''} still uses it. ` +
      `Remove it after that session ends: git worktree remove -- ${worktreePath}`,
  };
}
