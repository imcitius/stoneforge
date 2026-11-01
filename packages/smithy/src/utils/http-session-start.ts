import type { EntityId } from '@stoneforge/core';
import type { SessionManager } from '../runtime/session-manager.js';

// Route factories sharing a manager must also share admission. Otherwise a second
// HTTP attempt can assign a task while the first awaits spawn, then release that
// assignment after SessionManager rejects the second start. This is deliberately
// an in-process HTTP boundary, not a runtime or cross-process ownership claim.
const pendingStarts = new WeakMap<SessionManager, Map<EntityId, { incompleteSessionId?: string }>>();

type HttpSessionStartAdmission =
  | { acquired: false; incompleteSessionId?: string }
  | { acquired: true; finish: (incompleteSessionId?: string) => void };

/**
 * Acquire synchronously before the first await/precheck. Keep the reservation
 * through preparation, assignment, publication, notifications and failed-start
 * cleanup. A rejected contender has no effects.
 *
 * An incomplete rollback retains admission for this manager's lifetime. Local
 * "terminated" state/absence of an active mapping does not prove provider cleanup
 * finished. Only the failing attempt supplies this identity; never rediscover a
 * session by agent lookup. There is deliberately no timeout or automatic reset:
 * this boundary has no exact cleanup-completion receipt to justify reopening.
 */
export function tryAcquireHttpSessionStart(
  manager: SessionManager,
  agentId: EntityId
): HttpSessionStartAdmission {
  let pending = pendingStarts.get(manager);
  if (!pending) {
    pending = new Map();
    pendingStarts.set(manager, pending);
  }
  const existing = pending.get(agentId);
  if (existing) return { acquired: false, incompleteSessionId: existing.incompleteSessionId };
  const attempt: { incompleteSessionId?: string } = {};
  pending.set(agentId, attempt);
  let finished = false;
  return { acquired: true, finish(incompleteSessionId) {
    if (finished) return;
    finished = true;
    if (incompleteSessionId !== undefined) attempt.incompleteSessionId = incompleteSessionId;
    else pending.delete(agentId);
  } };
}
