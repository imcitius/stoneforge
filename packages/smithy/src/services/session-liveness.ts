/**
 * Session liveness, resume prompt and director watchdog helpers (el-4dcv06).
 *
 * Pure helpers live here; the dispatch daemon owns persistence and effects.
 */

/** Default inactivity after which a running worker/steward session with an assigned task is treated as hung. */
export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Default inactivity after which a running worker/steward session without an assigned task is ended. */
export const DEFAULT_IDLE_SESSION_WITHOUT_TASK_MS = 10 * 60 * 1000;

/**
 * Default base delay between automatic orphan resumes of the same task (el-55qcdj).
 * The n-th resume (0-based count of earlier resumes) waits base * 2^n after the
 * previous session of that agent on the task started.
 */
export const DEFAULT_ORPHAN_RESUME_BACKOFF_MS = 60 * 1000;

/** Upper bound for a single orphan resume delay. */
export const MAX_ORPHAN_RESUME_BACKOFF_MS = 30 * 60 * 1000;

/** Delay required before the next automatic resume, given the number of earlier resumes. 0 = no delay. */
export function orphanResumeBackoffMs(previousAttempts: number, baseMs: number): number {
  if (!(baseMs > 0)) return 0;
  const exponent = Math.min(Math.max(0, Math.floor(previousAttempts) || 0), 20);
  return Math.min(baseMs * 2 ** exponent, Math.max(baseMs, MAX_ORPHAN_RESUME_BACKOFF_MS));
}

/**
 * Remaining wait before an orphaned task may be resumed again. A session that
 * already ran longer than the delay (e.g. stopped as hung, or a long run before
 * a crash or a server restart) is resumed at once; only resumes in quick
 * succession are spaced out. Without a recorded start there is no delay.
 */
export function orphanResumeWaitMs(input: {
  readonly now: number;
  readonly lastSessionStartedAt?: number;
  readonly previousAttempts: number;
  readonly baseMs: number;
}): number {
  const started = input.lastSessionStartedAt;
  if (started === undefined || !Number.isFinite(started)) return 0;
  const delay = orphanResumeBackoffMs(input.previousAttempts, input.baseMs);
  return Math.max(0, started + delay - input.now);
}

export type IdleSessionVerdict = 'active' | 'hung' | 'idle-without-task';

/**
 * Decides what to do with a running worker/steward session.
 * A threshold of 0 disables that check.
 */
export function classifyIdleSession(input: {
  readonly idleMs: number;
  readonly hasAssignedTask: boolean;
  readonly sessionIdleTimeoutMs: number;
  readonly idleSessionWithoutTaskMs: number;
}): IdleSessionVerdict {
  if (!Number.isFinite(input.idleMs)) return 'active';
  if (input.hasAssignedTask) {
    return input.sessionIdleTimeoutMs > 0 && input.idleMs >= input.sessionIdleTimeoutMs ? 'hung' : 'active';
  }
  return input.idleSessionWithoutTaskMs > 0 && input.idleMs >= input.idleSessionWithoutTaskMs ? 'idle-without-task' : 'active';
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}min` : `${hours}h`;
}

// ----------------------------------------------------------------------------
// Resume prompt
// ----------------------------------------------------------------------------

export interface InterruptedResumeContext {
  readonly role: 'worker' | 'steward';
  readonly taskId: string;
  readonly taskTitle: string;
  readonly taskStatus?: string;
  readonly branch?: string;
  readonly head?: string;
  readonly mergeStatus?: string;
  /** Previous session as recorded by the session manager or task history. */
  readonly previousSession?: {
    readonly id?: string;
    readonly startedAt?: string;
    readonly endedAt?: string;
    readonly terminationReason?: string;
  };
  /** Set when the daemon itself stopped the previous session as hung. */
  readonly hung?: { readonly stoppedAt: string; readonly idleMs: number; readonly lastActivityAt?: string };
  readonly lastHandoffNote?: string;
  /** 1-based automatic resume attempt and the cap before recovery escalation. */
  readonly attempt?: number;
  readonly maxAttempts?: number;
}

/**
 * Accurate resume prompt for a session that ended without `sf task complete`
 * or `sf task handoff`. Replaces the former unconditional "interrupted by a
 * server restart" text: the daemon only knows that the session ended, plus
 * whatever end state was recorded.
 */
export function buildInterruptedResumePrompt(ctx: InterruptedResumeContext): string {
  const lines: string[] = [];
  const action = ctx.role === 'steward' ? 'recorded a merge/review outcome' : 'ran `sf task complete` or `sf task handoff`';
  if (ctx.hung) {
    lines.push(
      `Your previous session on this task was stopped by the dispatch daemon at ${ctx.hung.stoppedAt} because it stayed running ` +
      `without any provider output for ${formatDuration(ctx.hung.idleMs)}` +
      `${ctx.hung.lastActivityAt ? ` (last activity ${ctx.hung.lastActivityAt})` : ''}. It was treated as hung.`
    );
  } else {
    lines.push(
      `Your previous session on this task ended before it ${action}. ` +
      'The daemon only knows that the session is no longer running (it may have exited, crashed, been stopped, or the server restarted).'
    );
  }

  const state: string[] = [];
  const previous = ctx.previousSession;
  if (previous && (previous.id || previous.startedAt || previous.endedAt || previous.terminationReason)) {
    const parts = [
      previous.startedAt ? `started ${previous.startedAt}` : undefined,
      previous.endedAt ? `ended ${previous.endedAt}` : undefined,
    ].filter(Boolean).join(', ');
    state.push(`- Previous session${previous.id ? ` ${previous.id}` : ''}${parts ? `: ${parts}` : ''}` +
      `${previous.terminationReason ? ` (reason: ${previous.terminationReason})` : ''}.`);
  } else if (!ctx.hung) {
    state.push('- No end record is available for the previous session.');
  }
  const taskState = [
    ctx.taskStatus ? `status ${ctx.taskStatus}` : undefined,
    ctx.mergeStatus ? `merge status ${ctx.mergeStatus}` : undefined,
    ctx.branch ? `branch ${ctx.branch}${ctx.head ? ` at ${ctx.head.slice(0, 12)}` : ''}` : undefined,
  ].filter(Boolean).join('; ');
  if (taskState) state.push(`- Task ${ctx.taskId}: ${taskState}.`);
  if (ctx.lastHandoffNote) {
    const note = ctx.lastHandoffNote.length > 500 ? `${ctx.lastHandoffNote.slice(0, 500)}…` : ctx.lastHandoffNote;
    state.push(`- Last handoff note: ${note}`);
  }
  if (ctx.attempt !== undefined && ctx.maxAttempts !== undefined && ctx.maxAttempts > 0) {
    state.push(`- Automatic resume attempt ${ctx.attempt} of ${ctx.maxAttempts}${ctx.role === 'worker' ? ' before a recovery steward takes over' : ''}.`);
  }
  if (state.length) lines.push('Last known state:', ...state);

  if (ctx.role === 'steward') {
    lines.push(
      `You are still assigned to review/merge task ${ctx.taskId}: "${ctx.taskTitle}".`,
      'Check the current merge status and worktree before acting; do not repeat a merge or review that is already recorded.',
      'Please continue the merge review from where you left off.',
    );
  } else {
    lines.push(
      `You are still assigned to task ${ctx.taskId}: "${ctx.taskTitle}".`,
      'Check the worktree (git status, git log) before acting; do not redo work that is already committed. ' +
      'If the previous session hung on a long-running command, do not rerun it unchanged without a timeout.',
      `Please continue working on this task from where you left off and end with \`sf task complete ${ctx.taskId}\` ` +
      `or \`sf task handoff ${ctx.taskId} --message "..."\`.`,
    );
  }
  return lines.join('\n');
}

// ----------------------------------------------------------------------------
// Director watchdog
// ----------------------------------------------------------------------------

/** Why a task does not need the Director: only executor capacity or a confirmed provider limit blocks it. */
export interface WatchdogWait {
  readonly taskId: string;
  readonly kind: 'worker-capacity' | 'steward-capacity' | 'provider-limit';
  /** ISO timestamp of the soonest reset of the limit that blocks the eligible executors. */
  readonly resetsAt?: string;
}

export function describeWatchdogWait(wait: WatchdogWait): string {
  switch (wait.kind) {
    case 'worker-capacity': return `${wait.taskId} (all eligible workers busy)`;
    case 'steward-capacity': return `${wait.taskId} (all merge stewards busy)`;
    case 'provider-limit': return `${wait.taskId} (provider limit${wait.resetsAt ? `, resets ${wait.resetsAt}` : ''})`;
  }
}

/**
 * Signature of a watchdog wake. Unchanged actionable tasks and unchanged
 * provider limits produce the same signature, so the Director is not woken
 * again until either changes.
 */
export function watchdogSignature(actionableTaskIds: readonly string[], limits: readonly string[]): string {
  return `${[...new Set(actionableTaskIds)].sort().join(',')}|${[...new Set(limits)].sort().join(',')}`;
}
