/**
 * Orchestrator Task Metadata Types
 *
 * This module defines the metadata structure for tasks in the orchestration system.
 * Tasks gain additional metadata when managed by the orchestrator to track:
 * - Git branch association
 * - Worktree location
 * - Claude Code session ID for resumption
 *
 * This metadata is stored in the task's `metadata` field alongside any existing
 * task metadata.
 */

import type { EntityId, ElementId, Timestamp } from '@stoneforge/core';

// ============================================================================
// Orchestrator Task Metadata
// ============================================================================

/**
 * Orchestrator-specific metadata attached to tasks managed by the orchestration system.
 *
 * This is stored in the task's `metadata` field under the `orchestrator` key:
 * ```typescript
 * task.metadata = {
 *   ...existingMetadata,
 *   orchestrator: OrchestratorTaskMeta
 * }
 * ```
 */
export interface CompletionOperation {
  operationId: string;
  taskVersion: Timestamp;
  phase: 'claimed' | 'push_started' | 'push_failed' | 'pushed' | 'mr_started' | 'unknown' | 'receipt' | 'finalized';
  mode: 'worker' | 'admin';
  agentId: EntityId;
  sessionId?: string;
  owner?: EntityId;
  assignedAgent?: EntityId;
  branch?: string;
  worktree?: string;
  repositoryId?: string;
  commitOid?: string;
  cwd?: string;
  push: boolean;
  createMR: boolean;
  provider?: string;
  baseBranch: string;
  summary?: string;
  commitHash?: string;
  title: string;
  body: string;
  receipt?: { id?: number; url?: string; provider: string };
  error?: string;
  reconciliations?: { operatorId: EntityId; reason: string; at: Timestamp; previousPhase: CompletionOperation['phase']; mergeRequestId?: number }[];
}

export interface OrchestratorTaskMeta {
  readonly completionOperation?: CompletionOperation;
  readonly completionHistory?: readonly CompletionOperation[];
  /** Stable repository ID within the project. Frozen once dispatched. */
  readonly repositoryId?: string;
  readonly repositoryLocked?: boolean;
  /** Git branch created for this task (e.g., "agent/alice/task-123-implement-feature") */
  readonly branch?: string;

  /** Path to the worktree where the agent is working (e.g., ".stoneforge/.worktrees/alice-implement-feature/") */
  readonly worktree?: string;

  /**
   * Target branch for merging this task. Inherited from the owning director
   * at dispatch time. If not set, falls back to workspace default.
   */
  readonly targetBranch?: string;

  /** Claude Code session ID for this task, enabling session resumption */
  readonly sessionId?: string;

  /** Entity ID of the agent assigned to this task */
  readonly assignedAgent?: EntityId;

  /** Entity ID of the director that created/owns this task for message routing */
  readonly owningDirector?: EntityId;

  /** When the agent started working on this task */
  readonly startedAt?: Timestamp;

  /** When the agent completed this task (before merge) */
  readonly completedAt?: Timestamp;

  /** When the branch was merged */
  readonly mergedAt?: Timestamp;

  /** Merge status tracking */
  readonly mergeStatus?: MergeStatus;

  /** If merge failed, the reason */
  readonly mergeFailureReason?: string;

  /** Number of times tests have been run on this branch */
  readonly testRunCount?: number;

  /** Last test result */
  readonly lastTestResult?: TestResult;

  /** Number of times this task has been reconciled from a closed-but-unmerged state */
  readonly reconciliationCount?: number;

  /** Number of times this task has been recovered from a stuck merging/testing state */
  readonly stuckMergeRecoveryCount?: number;

  /** Number of times the steward orphan recovery has re-dispatched a steward for this task */
  readonly stewardRecoveryCount?: number;

  /**
   * Number of consecutive times the orphan recovery loop has resumed this task
   * without a status change. When this exceeds the configured threshold,
   * the daemon spawns a recovery steward instead of resuming the worker.
   */
  readonly resumeCount?: number;

  /**
   * Consecutive worker handoffs without progress (no new commit on the task
   * branch, no title/description/dependency change other than handoff notes).
   * Maintained by the dispatch daemon; not reset by rate-limit or crash paths.
   */
  readonly noProgress?: NoProgressState;

  /**
   * Set when the dispatch daemon stopped automatic redispatch (task DEFERRED)
   * after repeated no-progress handoffs. Cleared on release.
   */
  readonly dispatchHold?: DispatchHold;

  /**
   * Last session the dispatch daemon stopped because it stayed 'running'
   * without provider output for longer than `sessionIdleTimeoutMs` (hung).
   * Shown in the resume prompt; also prevents counting one hang twice.
   */
  readonly lastHungSession?: HungSessionRecord;

  /**
   * Last worker/steward session on this task for which a provider rate limit
   * was detected. The next orphan resume of that agent after such a session is
   * not counted toward `resumeCount` / `stewardRecoveryCount`, and a hang stop
   * of that session is not counted toward the no-progress guard.
   */
  readonly lastRateLimitedSession?: RateLimitedSessionRecord;

  /**
   * Last time the dispatch daemon released this task from an executor whose
   * provider was rate-limited (no live session), so another executor with
   * capacity could take it. Branch and worktree are kept.
   */
  readonly lastRateLimitRelease?: RateLimitReleaseRecord;

  /**
   * Set of issue types that have been reported for this task.
   * Prevents duplicate messages/fix tasks for the same type of issue.
   * Format: "test_failure", "merge_conflict", etc.
   */
  readonly reportedIssues?: readonly string[];

  // ----------------------------------------
  // Handoff Context (for task continuation)
  // ----------------------------------------

  /** Branch preserved from handoff (may differ from current branch if not yet continued) */
  readonly handoffBranch?: string;

  /** Worktree path preserved from handoff */
  readonly handoffWorktree?: string;

  /** Session ID of the last agent that worked on this task before handoff */
  readonly lastSessionId?: string;

  /** Timestamp when the task was handed off */
  readonly handoffAt?: Timestamp;

  /** Entity ID of the agent who handed off the task */
  readonly handoffFrom?: EntityId;

  // ----------------------------------------
  // Merge Request Information (for completed tasks)
  // ----------------------------------------

  /** URL of the merge request created for this task */
  readonly mergeRequestUrl?: string;

  /** Merge request identifier (e.g. PR number) */
  readonly mergeRequestId?: number;

  /** Which provider created the merge request (e.g. 'github', 'local') */
  readonly mergeRequestProvider?: string;

  /** Completion summary provided by the agent */
  readonly completionSummary?: string;

  /** Git commit hash from the squash-merge into the target branch */
  readonly mergeCommitHash?: string;

  /** Last commit hash before completion */
  readonly lastCommitHash?: string;

  /** History of all handoffs for this task */
  readonly handoffHistory?: HandoffHistoryEntry[];

  /** Recent sessions (worker and steward); append retains at most 50 entries, not a full audit */
  readonly sessionHistory?: readonly TaskSessionHistoryEntry[];

  // ----------------------------------------
  // Branch Sync Information (for merge steward review)
  // ----------------------------------------

  /** Result of the most recent branch sync with master */
  readonly lastSyncResult?: SyncResultMeta;
}

/**
 * Metadata about a branch sync operation result
 */
export interface SyncResultMeta {
  /** Whether the sync succeeded without conflicts */
  readonly success: boolean;
  /** List of conflicted file paths (if any) */
  readonly conflicts?: string[];
  /** Error message (if sync failed for non-conflict reasons) */
  readonly error?: string;
  /** Human-readable message */
  readonly message: string;
  /** When the sync was performed */
  readonly syncedAt: Timestamp;
}

// ============================================================================
// No-progress handoff guard
// ============================================================================

/** Snapshot used to decide whether a handoff made progress. */
export interface ProgressFingerprint {
  /** Head commit of the task branch, or undefined when it could not be read */
  readonly commit?: string;
  /** Hash of title, description without agent handoff notes, and dependencies */
  readonly content: string;
}

export interface NoProgressState {
  /** Consecutive handoffs without progress */
  readonly count: number;
  /** Fingerprint recorded at the last dispatch (baseline for the next handoff) */
  readonly fingerprint?: ProgressFingerprint;
  /** handoffAt value already counted, so one handoff is never counted twice */
  readonly evaluatedHandoffAt?: Timestamp;
}

export interface DispatchHold {
  readonly reason: string;
  readonly heldAt: Timestamp;
  readonly count: number;
  readonly limit: number;
  /** Fingerprint at hold time; a different fingerprint releases the hold */
  readonly fingerprint: ProgressFingerprint;
  readonly handoffAt?: Timestamp;
  readonly directorId?: EntityId;
  /** Director notification (sent at most once per hold) */
  readonly notifiedAt?: Timestamp;
  readonly notificationMessageId?: string;
  readonly notificationError?: string;
  /** What triggered the hold. Absent (legacy) means 'handoff'. */
  readonly trigger?: 'handoff' | 'hung-session';
}

/** A session stopped by the daemon's liveness check. */
export interface HungSessionRecord {
  /** Internal session ID that was stopped */
  readonly sessionId: string;
  readonly providerSessionId?: string;
  readonly agentId: EntityId;
  readonly agentRole: 'worker' | 'steward';
  /** Last provider output/activity seen before the stop */
  readonly lastActivityAt: Timestamp;
  readonly stoppedAt: Timestamp;
  /** Inactivity at the time of the stop */
  readonly idleMs: number;
}

/** A worker/steward session that hit a provider rate limit. */
export interface RateLimitedSessionRecord {
  /** Internal session ID */
  readonly sessionId: string;
  readonly providerSessionId?: string;
  readonly agentId: EntityId;
  readonly agentRole: 'worker' | 'steward';
  /** Provider whose limit was reported (e.g. 'codex', 'claude-code') */
  readonly provider?: string;
  readonly detectedAt: Timestamp;
  /** Tracked reset time of the limit (after floor/cap clamping) */
  readonly resetsAt?: Timestamp;
}

/** A task released from a rate-limited executor (no live session). */
export interface RateLimitReleaseRecord {
  readonly fromAgentId: EntityId;
  readonly fromAgentRole: 'worker' | 'steward';
  /** Provider of the released executor */
  readonly provider?: string;
  /** Internal session ID of that executor's last session on the task */
  readonly sessionId?: string;
  readonly releasedAt: Timestamp;
  /** Soonest reset of the executor's limit at release time */
  readonly resetsAt?: string;
}

// ============================================================================
// Handoff History Entry
// ============================================================================

/**
 * An entry in the handoff history for a task
 */
export interface HandoffHistoryEntry {
  /** Session ID of the agent that handed off */
  readonly sessionId: string;
  /** Message explaining why the handoff occurred */
  readonly message?: string;
  /** Branch at time of handoff */
  readonly branch?: string;
  /** Worktree at time of handoff */
  readonly worktree?: string;
  /** When the handoff occurred */
  readonly handoffAt: Timestamp;
}

// ============================================================================
// Task Session History Entry
// ============================================================================

/**
 * An entry in the session history for a task, tracking all sessions (worker and steward)
 * that have worked on this task.
 */
export interface TaskSessionHistoryEntry {
  /** Internal session ID (used to fetch messages via GET /api/sessions/:id/messages) */
  readonly sessionId: string;
  /** Provider session ID (for resume) */
  readonly providerSessionId?: string;
  /** Entity ID of the agent */
  readonly agentId: EntityId;
  /** Display name of the agent */
  readonly agentName: string;
  /** Role of the agent */
  readonly agentRole: 'worker' | 'steward';
  /** Timestamp when the session started */
  readonly startedAt: Timestamp;
  /** Timestamp when the session ended (undefined if still running) */
  readonly endedAt?: Timestamp;
  /**
   * Why the session ended, when the dispatch daemon knows it. 'rate-limited':
   * a provider rate limit was detected in this session; it is not counted
   * toward the resume/recovery caps.
   */
  readonly endReason?: 'rate-limited';
  /** When the provider rate limit was detected in this session */
  readonly rateLimitedAt?: Timestamp;
  /** Tracked reset time of that limit */
  readonly rateLimitResetsAt?: Timestamp;
}

// ============================================================================
// Merge Status Types
// ============================================================================

/**
 * Status of the merge process for a completed task's branch
 */
export type MergeStatus =
  | 'pending'            // Task completed, awaiting merge
  | 'testing'            // Steward is running tests on the branch
  | 'merging'            // Tests passed, merge in progress
  | 'merged'             // Successfully merged
  | 'conflict'           // Merge conflict detected
  | 'test_failed'        // Tests failed, needs attention
  | 'failed'             // Merge failed for other reason
  | 'not_applicable'     // No merge needed (e.g., fix already existed on master)
  | 'awaiting_approval'; // PR created, waiting for human approval/merge

/**
 * All valid merge status values
 */
export const MergeStatusValues = [
  'pending',
  'testing',
  'merging',
  'merged',
  'conflict',
  'test_failed',
  'failed',
  'not_applicable',
  'awaiting_approval',
] as const;

/**
 * Type guard to check if a value is a valid MergeStatus
 */
export function isMergeStatus(value: unknown): value is MergeStatus {
  return typeof value === 'string' && MergeStatusValues.includes(value as MergeStatus);
}

// ============================================================================
// Test Result Types
// ============================================================================

/**
 * Result of running tests on a task's branch
 */
export interface TestResult {
  /** Whether tests passed */
  readonly passed: boolean;

  /** Total number of tests run */
  readonly totalTests?: number;

  /** Number of tests that passed */
  readonly passedTests?: number;

  /** Number of tests that failed */
  readonly failedTests?: number;

  /** Number of tests that were skipped */
  readonly skippedTests?: number;

  /** When the test run completed */
  readonly completedAt: Timestamp;

  /** Duration of the test run in milliseconds */
  readonly durationMs?: number;

  /** Error message if tests failed to run */
  readonly errorMessage?: string;
}

/**
 * Type guard to check if a value is a valid TestResult
 */
export function isTestResult(value: unknown): value is TestResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.passed === 'boolean' &&
    typeof obj.completedAt === 'string'
  );
}

// ============================================================================
// Orchestrator Task Metadata Utilities
// ============================================================================

/**
 * Extracts orchestrator metadata from a task's metadata field
 */
export function getOrchestratorTaskMeta(
  taskMetadata: Record<string, unknown> | undefined
): OrchestratorTaskMeta | undefined {
  if (!taskMetadata || typeof taskMetadata.orchestrator !== 'object') {
    return undefined;
  }
  return taskMetadata.orchestrator as OrchestratorTaskMeta;
}

/**
 * Sets orchestrator metadata on a task's metadata field
 */
export function setOrchestratorTaskMeta(
  existingMetadata: Record<string, unknown> | undefined,
  orchestratorMeta: OrchestratorTaskMeta
): Record<string, unknown> {
  return {
    ...existingMetadata,
    orchestrator: orchestratorMeta,
  };
}

/**
 * Updates orchestrator metadata on a task's metadata field
 */
export function updateOrchestratorTaskMeta(
  existingMetadata: Record<string, unknown> | undefined,
  updates: Partial<OrchestratorTaskMeta>
): Record<string, unknown> {
  const existing = getOrchestratorTaskMeta(existingMetadata) ?? {};
  return setOrchestratorTaskMeta(existingMetadata, {
    ...existing,
    ...updates,
  });
}

/**
 * Type guard to validate OrchestratorTaskMeta structure
 */
export function isOrchestratorTaskMeta(value: unknown): value is OrchestratorTaskMeta {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;

  // All fields are optional, so we just check types if present
  if (obj.branch !== undefined && typeof obj.branch !== 'string') return false;
  if (obj.worktree !== undefined && typeof obj.worktree !== 'string') return false;
  if (obj.targetBranch !== undefined && typeof obj.targetBranch !== 'string') return false;
  if (obj.sessionId !== undefined && typeof obj.sessionId !== 'string') return false;
  if (obj.assignedAgent !== undefined && typeof obj.assignedAgent !== 'string') return false;
  if (obj.owningDirector !== undefined && typeof obj.owningDirector !== 'string') return false;
  if (obj.mergeStatus !== undefined && !isMergeStatus(obj.mergeStatus)) return false;
  if (obj.lastTestResult !== undefined && !isTestResult(obj.lastTestResult)) return false;

  return true;
}

// ============================================================================
// Session History Utilities
// ============================================================================

/** Maximum number of session history entries to keep per task */
const MAX_SESSION_HISTORY_ENTRIES = 50;

/**
 * Appends a session history entry to the task's orchestrator metadata.
 * Caps the history at MAX_SESSION_HISTORY_ENTRIES entries.
 *
 * @param existingMetadata - The task's existing metadata
 * @param entry - The session history entry to append
 * @returns Updated task metadata with the new session history entry
 */
export function appendTaskSessionHistory(
  existingMetadata: Record<string, unknown> | undefined,
  entry: TaskSessionHistoryEntry
): Record<string, unknown> {
  const existing = getOrchestratorTaskMeta(existingMetadata);
  const existingHistory = existing?.sessionHistory ?? [];
  const newHistory = [...existingHistory, entry].slice(-MAX_SESSION_HISTORY_ENTRIES);

  return updateOrchestratorTaskMeta(existingMetadata, {
    sessionHistory: newHistory,
  });
}

/**
 * Closes a session history entry by setting the endedAt timestamp.
 * Finds the session history entry matching the sessionId that has no endedAt.
 *
 * @param existingMetadata - The task's existing metadata
 * @param sessionId - The session ID to close
 * @param endedAt - The timestamp when the session ended
 * @returns Updated task metadata with the closed session history entry
 */
export function closeTaskSessionHistory(
  existingMetadata: Record<string, unknown> | undefined,
  sessionId: string,
  endedAt: Timestamp
): Record<string, unknown> {
  const existing = getOrchestratorTaskMeta(existingMetadata);
  const existingHistory = existing?.sessionHistory ?? [];

  const updatedHistory = existingHistory.map((entry) => {
    if (entry.sessionId === sessionId && entry.endedAt === undefined) {
      return { ...entry, endedAt };
    }
    return entry;
  });

  return updateOrchestratorTaskMeta(existingMetadata, {
    sessionHistory: updatedHistory,
  });
}

/**
 * Records on a session history entry that a provider rate limit was detected
 * in that session (`endReason: 'rate-limited'`). Unknown session IDs leave the
 * history unchanged; an entry keeps its first detection time.
 */
export function markTaskSessionRateLimited(
  existingMetadata: Record<string, unknown> | undefined,
  sessionId: string,
  detectedAt: Timestamp,
  resetsAt?: Timestamp,
): Record<string, unknown> {
  const existing = getOrchestratorTaskMeta(existingMetadata);
  const existingHistory = existing?.sessionHistory ?? [];
  if (!existingHistory.some((entry) => entry.sessionId === sessionId)) return existingMetadata ?? {};
  const updatedHistory = existingHistory.map((entry) => {
    if (entry.sessionId !== sessionId) return entry;
    return {
      ...entry,
      endReason: 'rate-limited' as const,
      rateLimitedAt: entry.rateLimitedAt ?? detectedAt,
      ...(resetsAt ? { rateLimitResetsAt: resetsAt } : {}),
    };
  });
  return updateOrchestratorTaskMeta(existingMetadata, { sessionHistory: updatedHistory });
}

/**
 * Returns the rate-limit record when the agent's most recent session on this
 * task hit a provider rate limit, i.e. that session must not count toward the
 * resume/recovery caps. Matches the agent's last session-history entry (or,
 * without history, the task's recorded provider session ID).
 */
export function findRateLimitedPreviousSession(
  meta: OrchestratorTaskMeta | undefined,
  agentId: EntityId,
): RateLimitedSessionRecord | undefined {
  const record = meta?.lastRateLimitedSession;
  if (!record || record.agentId !== agentId) return undefined;
  const last = [...(meta?.sessionHistory ?? [])].reverse().find((entry) => entry.agentId === agentId);
  if (last) return last.sessionId === record.sessionId ? record : undefined;
  const current = meta?.sessionId;
  return current !== undefined && (current === record.sessionId || current === record.providerSessionId) ? record : undefined;
}

// ============================================================================
// Branch and Worktree Naming Utilities
// ============================================================================

/**
 * Generates a branch name for an agent working on a task
 *
 * Format: agent/{worker-name}/{task-id}-{slug}
 *
 * @param workerName - The agent's name
 * @param taskId - The task ID
 * @param slug - URL-friendly slug derived from task title (optional)
 */
export function generateBranchName(
  workerName: string,
  taskId: ElementId,
  slug?: string
): string {
  const safeName = workerName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const safeTaskId = taskId.toLowerCase();
  if (slug) {
    const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30);
    return `agent/${safeName}/${safeTaskId}-${safeSlug}`;
  }
  return `agent/${safeName}/${safeTaskId}`;
}

/**
 * Generates a worktree path for an agent working on a task
 *
 * Format: .stoneforge/.worktrees/{worker-name}-{task-slug}/
 *
 * @param workerName - The agent's name
 * @param slug - URL-friendly slug derived from task title (optional)
 */
export function generateWorktreePath(
  workerName: string,
  slug?: string
): string {
  const safeName = workerName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (slug) {
    const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30);
    return `.stoneforge/.worktrees/${safeName}-${safeSlug}`;
  }
  return `.stoneforge/.worktrees/${safeName}`;
}

/**
 * Generates a branch name for a persistent worker session
 *
 * Format: session/{worker-name}-{timestamp}
 *
 * @param workerName - The agent's name
 * @param timestamp - Timestamp string (e.g. '20240115143022')
 */
export function generateSessionBranchName(
  workerName: string,
  timestamp: string
): string {
  const safeName = workerName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `session/${safeName}-${timestamp}`;
}

/**
 * Generates a worktree path for a persistent worker session
 *
 * Format: .stoneforge/.worktrees/{worker-name}-session-{timestamp}/
 *
 * @param workerName - The agent's name
 * @param timestamp - Timestamp string (e.g. '20240115143022')
 */
export function generateSessionWorktreePath(
  workerName: string,
  timestamp: string
): string {
  const safeName = workerName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `.stoneforge/.worktrees/${safeName}-session-${timestamp}`;
}

/**
 * Creates a URL-friendly slug from a task title
 */
export function createSlugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')  // Remove special characters
    .replace(/\s+/g, '-')          // Replace spaces with hyphens
    .replace(/-+/g, '-')           // Collapse multiple hyphens
    .slice(0, 30)                  // Limit length
    .replace(/^-|-$/g, '');        // Trim leading/trailing hyphens
}
