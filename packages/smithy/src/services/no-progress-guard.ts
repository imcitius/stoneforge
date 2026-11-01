/**
 * No-progress handoff guard helpers.
 *
 * A worker handoff "made progress" when, compared with the snapshot taken at
 * the previous dispatch, the task branch has a new head commit or the task's
 * title / description / dependencies changed. Handoff notes appended to the
 * description by `sf task handoff` are the handing-off agent's own change and
 * are excluded, so a blocked agent cannot reset the counter just by handing off.
 *
 * Pure helpers live here; the dispatch daemon owns persistence and effects.
 */

import { createHash } from 'node:crypto';
import type { Timestamp } from '@stoneforge/core';
import type {
  HandoffHistoryEntry,
  NoProgressState,
  OrchestratorTaskMeta,
  ProgressFingerprint,
} from '../types/task-meta.js';

/** Default number of consecutive no-progress handoffs before redispatch stops. */
export const DEFAULT_NO_PROGRESS_HANDOFF_LIMIT = 3;

/** Prefix `TaskAssignmentService.handoffTask` uses when appending notes. */
export const HANDOFF_NOTE_PREFIX = '\n\n[AGENT HANDOFF NOTE]: ';

/**
 * Removes agent handoff notes from a description.
 *
 * Exact notes recorded in handoff history are removed first (this handles
 * multi-line messages). Any remaining single-line notes (e.g. when history was
 * truncated) are removed by pattern.
 */
export function stripHandoffNotes(
  content: string,
  history: readonly Pick<HandoffHistoryEntry, 'message'>[] | undefined
): string {
  let result = content;
  const messages = [...new Set((history ?? []).map((entry) => entry.message).filter((m): m is string => !!m))]
    // Longer messages first so a message that is a prefix of another cannot
    // leave a dangling suffix behind.
    .sort((a, b) => b.length - a.length);
  for (const message of messages) {
    result = result.split(HANDOFF_NOTE_PREFIX + message).join('');
  }
  return result.replace(/\n\n\[AGENT HANDOFF NOTE\]: [^\n]*/g, '');
}

export interface FingerprintInput {
  readonly title: string;
  readonly description: string;
  readonly handoffHistory?: readonly Pick<HandoffHistoryEntry, 'message'>[];
  /** Dependencies where this task is the source, e.g. `blocks:el-abc` */
  readonly dependencies: readonly string[];
  readonly commit?: string;
}

export function computeProgressFingerprint(input: FingerprintInput): ProgressFingerprint {
  const hash = createHash('sha256');
  hash.update('title\0');
  hash.update(input.title);
  hash.update('\0description\0');
  hash.update(stripHandoffNotes(input.description, input.handoffHistory).trimEnd());
  hash.update('\0dependencies\0');
  hash.update([...input.dependencies].sort().join('\n'));
  return { commit: input.commit, content: hash.digest('hex') };
}

export function sameFingerprint(a: ProgressFingerprint | undefined, b: ProgressFingerprint | undefined): boolean {
  if (!a || !b) return false;
  return a.content === b.content && (a.commit ?? '') === (b.commit ?? '');
}

export interface NoProgressEvaluation {
  /** State to persist with the next dispatch (or the hold) */
  readonly state: NoProgressState;
  /** True when automatic redispatch must stop */
  readonly hold: boolean;
  /** True when a previous hold was lifted by someone else (e.g. undefer) */
  readonly holdReleased: boolean;
}

/**
 * Decides the consecutive no-progress handoff count for a ready task.
 *
 * - A handoff is counted once (keyed by `handoffAt`).
 * - A new handoff with an unchanged fingerprint increments the count; any
 *   change resets it to 0.
 * - No baseline (first dispatch, legacy metadata) cannot prove a lack of
 *   progress and starts at 0.
 * - A leftover `dispatchHold` on a ready task means the hold was lifted by a
 *   Director/Human (undefer, status change); the count restarts at 0.
 * - Rate-limit and crash paths never call this with a new `handoffAt`, so they
 *   neither increment nor reset the count.
 */
export function evaluateNoProgress(
  meta: OrchestratorTaskMeta | undefined,
  current: ProgressFingerprint,
  limit: number
): NoProgressEvaluation {
  const previous = meta?.noProgress;
  const handoffAt: Timestamp | undefined = meta?.handoffAt;
  const holdReleased = meta?.dispatchHold !== undefined;
  let count: number;
  if (holdReleased) {
    count = 0;
  } else if (!handoffAt || handoffAt === previous?.evaluatedHandoffAt) {
    // No new handoff since the baseline: keep the count unless something changed.
    count = previous?.fingerprint && !sameFingerprint(previous.fingerprint, current) ? 0 : previous?.count ?? 0;
  } else {
    count = sameFingerprint(previous?.fingerprint, current) ? (previous?.count ?? 0) + 1 : 0;
  }
  return {
    state: { count, fingerprint: current, evaluatedHandoffAt: handoffAt ?? previous?.evaluatedHandoffAt },
    hold: limit > 0 && count >= limit,
    holdReleased,
  };
}

/**
 * Counts a hung worker session (stopped by the daemon's liveness check) toward
 * the same consecutive no-progress counter as handoffs.
 *
 * - Compared with the last baseline (dispatch, handoff evaluation or previous
 *   hang): an unchanged fingerprint increments the count, any change resets it
 *   to 0. No baseline (legacy) cannot prove a lack of progress and gives 0.
 * - A leftover `dispatchHold` (lifted by undefer/status change) restarts the
 *   count before this hang is counted.
 * - `evaluatedHandoffAt` is preserved, so a later dispatch never re-counts a
 *   handoff that was already evaluated. The caller counts each stopped session
 *   once (keyed by `lastHungSession.sessionId`).
 */
export function evaluateHungSession(
  meta: OrchestratorTaskMeta | undefined,
  current: ProgressFingerprint,
  limit: number
): NoProgressEvaluation {
  const previous = meta?.noProgress;
  const holdReleased = meta?.dispatchHold !== undefined;
  const base = holdReleased ? 0 : previous?.count ?? 0;
  const count = sameFingerprint(previous?.fingerprint, current) ? base + 1 : 0;
  return {
    state: { count, fingerprint: current, evaluatedHandoffAt: previous?.evaluatedHandoffAt },
    hold: limit > 0 && count >= limit,
    holdReleased,
  };
}
