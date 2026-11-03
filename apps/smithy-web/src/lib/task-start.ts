/**
 * Start-task helpers for the dashboard.
 *
 * POST /api/tasks/:id/start runs TaskAssignmentService.startTask: the caller
 * must assert the task's current assignee (a registered agent). These helpers
 * decide whether the Start action can be offered and turn the route's
 * 400/404/409/422 rejections into messages the operator can act on, instead of
 * the action silently doing nothing.
 */

import type { Task } from '../api/types';

/** Tooltip shown on the disabled Start action of an unassigned task. */
export const START_NEEDS_ASSIGNEE = 'Assign an agent first';

export interface StartAvailability {
  /** Start applies to this task's status (open). */
  visible: boolean;
  /** Start can be requested now. */
  enabled: boolean;
  /** Agent the request asserts as the starter (the current assignee). */
  agentId?: string;
  /** Why Start is disabled, for the tooltip and accessible label. */
  reason?: string;
}

export function getStartAvailability(task: Pick<Task, 'status' | 'assignee'> | undefined | null): StartAvailability {
  if (!task || task.status !== 'open') return { visible: false, enabled: false };
  if (!task.assignee) return { visible: true, enabled: false, reason: START_NEEDS_ASSIGNEE };
  return { visible: true, enabled: true, agentId: task.assignee };
}

/** Mirrors the server's startErrorKind, plus request-level failures. */
export type StartErrorKind = 'invalid-state' | 'invalid-assignee' | 'conflict' | 'invalid-input' | 'not-found' | 'unknown';

export class StartTaskError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly kind: StartErrorKind;
  /** Server message, without the UI's explanatory prefix. */
  readonly serverMessage: string;

  constructor(status: number, kind: StartErrorKind, serverMessage: string, code?: string) {
    super(describeStartFailure(status, kind, serverMessage));
    this.name = 'StartTaskError';
    this.status = status;
    this.kind = kind;
    this.code = code;
    this.serverMessage = serverMessage;
  }
}

const KNOWN_KINDS: readonly StartErrorKind[] = ['invalid-state', 'invalid-assignee', 'conflict'];

function classify(status: number, message: string, detailKind: unknown): StartErrorKind {
  if (typeof detailKind === 'string' && (KNOWN_KINDS as readonly string[]).includes(detailKind)) {
    return detailKind as StartErrorKind;
  }
  if (status === 400) return 'invalid-input';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 422) {
    // The route maps both invalid-state and invalid-assignee to 422; the
    // startTask messages name the status case explicitly.
    return /status; only open or in_progress/.test(message) ? 'invalid-state' : 'invalid-assignee';
  }
  return 'unknown';
}

function describeStartFailure(status: number, kind: StartErrorKind, message: string): string {
  switch (kind) {
    case 'invalid-assignee':
      return `The current assignment cannot start this task — assign it to a registered agent first. (${message})`;
    case 'invalid-state':
      return `This task can no longer be started from its current status. (${message})`;
    case 'conflict':
      return `The task changed while starting — refresh and try again. (${message})`;
    case 'invalid-input':
      return `Start request was rejected. (${message})`;
    case 'not-found':
      return `Task not found. (${message})`;
    default:
      return message || `Start failed (HTTP ${status})`;
  }
}

/** Build a StartTaskError from a non-OK response status and parsed JSON body. */
export function parseStartTaskError(status: number, body: unknown): StartTaskError {
  const error = (body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined) as
    | { code?: unknown; message?: unknown; details?: { startErrorKind?: unknown } }
    | undefined;
  const message = typeof error?.message === 'string' && error.message ? error.message : `HTTP ${status}`;
  const code = typeof error?.code === 'string' ? error.code : undefined;
  return new StartTaskError(status, classify(status, message, error?.details?.startErrorKind), message, code);
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

/**
 * POST /api/tasks/:id/start as the given agent. Throws StartTaskError on any
 * non-OK response so callers can surface the reason.
 */
export async function requestStartTask<T>(taskId: string, agentId: string, fetchImpl: FetchLike = fetch): Promise<T> {
  if (!agentId) throw new StartTaskError(400, 'invalid-assignee', START_NEEDS_ASSIGNEE);
  const response = await fetchImpl(`/api/tasks/${encodeURIComponent(taskId)}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw parseStartTaskError(response.status, body);
  }
  return response.json() as Promise<T>;
}
