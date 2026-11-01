/**
 * Durable onboarding tour state.
 *
 * Completion/dismissal is stored by the workspace backend
 * (`/api/settings/onboarding-tour`), not in browser storage. Desktop opens each
 * project from a backend on a dynamic 127.0.0.1 port; localStorage is scoped to
 * that origin, so a value written before a backend or app restart is invisible
 * afterwards. The backend record is per workspace, so projects stay isolated.
 *
 * localStorage remains only:
 * - as a legacy source, migrated to the workspace once observable;
 * - as a same-origin fallback when the backend cannot be reached;
 * - for the in-progress step (resume after reload).
 */

export const LEGACY_COMPLETE_KEY = 'stoneforge:onboarding-complete';
export const STEP_STORAGE_KEY = 'stoneforge:onboarding-step';
export const ONBOARDING_TOUR_ENDPOINT = '/api/settings/onboarding-tour';

export type OnboardingTourStatus = 'completed' | 'dismissed';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PersistenceDeps {
  fetch: typeof fetch;
  storage: StorageLike;
}

/** Legacy/fallback completion flag in this origin's storage. */
export function readLocalCompleted(storage: StorageLike): boolean {
  return storage.getItem(LEGACY_COMPLETE_KEY) === 'true';
}

/**
 * Store a status for this workspace. `null` is an explicit restart.
 * Returns true when the workspace backend accepted it. On failure the
 * same-origin flag keeps the previous (pre-backend) behaviour.
 */
export async function saveOnboardingTour(
  status: OnboardingTourStatus | null,
  { fetch, storage }: PersistenceDeps,
): Promise<boolean> {
  let ok = false;
  try {
    const response = await fetch(ONBOARDING_TOUR_ENDPOINT, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    ok = response.ok;
  } catch {
    ok = false;
  }
  if (status === null || ok) {
    // The workspace record is authoritative. Leaving the origin-wide flag would
    // leak this workspace's completion to another workspace served on the same
    // origin (e.g. standalone `sf serve` on a fixed port).
    storage.removeItem(LEGACY_COMPLETE_KEY);
  } else {
    storage.setItem(LEGACY_COMPLETE_KEY, 'true');
  }
  return ok;
}

export interface OnboardingTourSnapshot {
  /** Effective state: whether the tour counts as completed/dismissed here. */
  completed: boolean;
  /** Workspace record; `null` when the backend could not answer. */
  workspaceCompleted: boolean | null;
}

/**
 * Read the workspace state without writing anything. Falls back to the legacy
 * same-origin flag when the backend cannot answer.
 *
 * Callers that also issue user mutations must apply the snapshot's side
 * effects with `settleOnboardingTour` through the same serialized write queue,
 * and only when no user mutation was issued after this read started: the
 * snapshot may be stale by then (e.g. an explicit restart while it was held).
 */
export async function readOnboardingTour({ fetch, storage }: PersistenceDeps): Promise<OnboardingTourSnapshot> {
  const legacy = readLocalCompleted(storage);
  let completed: unknown;
  try {
    const response = await fetch(ONBOARDING_TOUR_ENDPOINT, { headers: { 'Content-Type': 'application/json' } });
    if (!response.ok) return { completed: legacy, workspaceCompleted: null };
    completed = ((await response.json()) as { completed?: unknown } | null)?.completed;
  } catch {
    return { completed: legacy, workspaceCompleted: null };
  }
  if (typeof completed !== 'boolean') return { completed: legacy, workspaceCompleted: null };
  return { completed: completed || legacy, workspaceCompleted: completed };
}

/**
 * Apply a snapshot's local cleanup and legacy migration:
 * - workspace completed → obsolete local completion/step state is cleared;
 * - workspace not completed but this origin still has a legacy completion
 *   flag → migrate it to the workspace once.
 * The legacy flag is re-read here, so a restart that already cleared it wins.
 */
export async function settleOnboardingTour(
  snapshot: OnboardingTourSnapshot,
  deps: PersistenceDeps,
): Promise<void> {
  const { storage } = deps;
  if (snapshot.workspaceCompleted === true) {
    storage.removeItem(LEGACY_COMPLETE_KEY);
    storage.removeItem(STEP_STORAGE_KEY);
  } else if (snapshot.workspaceCompleted === false && readLocalCompleted(storage)) {
    await saveOnboardingTour('completed', deps);
  }
}

/**
 * Resolve whether the tour has been completed/dismissed in this workspace and
 * settle it immediately. Only for callers with no concurrent user mutations.
 */
export async function hydrateOnboardingTour(deps: PersistenceDeps): Promise<boolean> {
  const snapshot = await readOnboardingTour(deps);
  await settleOnboardingTour(snapshot, deps);
  return snapshot.completed;
}

export interface OnboardingTourStore {
  /** User mutation (finish/skip → status, explicit restart → null). Newer than any pending read. */
  save(status: OnboardingTourStatus | null): Promise<unknown>;
  /**
   * Read the workspace state. Resolves `null` when a user mutation was issued
   * while the read was pending (the snapshot is stale and must be ignored).
   * Otherwise queues the snapshot's migration/cleanup behind earlier writes;
   * it is dropped if a user mutation is issued before it runs.
   */
  hydrate(): Promise<OnboardingTourSnapshot | null>;
  /** Settles when every queued write has finished. */
  idle(): Promise<void>;
}

/**
 * One serialized write queue per page for the onboarding state, so the
 * workspace always ends with the user's latest action: a delayed hydration
 * cannot migrate a legacy flag over an explicit restart (or any other user
 * mutation) issued before it resolved.
 */
export function createOnboardingTourStore(getDeps: () => PersistenceDeps): OnboardingTourStore {
  let version = 0;
  let writes: Promise<unknown> = Promise.resolve();
  const enqueue = (write: (deps: PersistenceDeps) => Promise<unknown>) => {
    writes = writes.catch(() => {}).then(() => write(getDeps()));
    return writes;
  };
  return {
    save(status) {
      version++;
      return enqueue((deps) => saveOnboardingTour(status, deps));
    },
    async hydrate() {
      const started = version;
      const snapshot = await readOnboardingTour(getDeps());
      if (version !== started) return null;
      void enqueue((deps) => (version !== started ? Promise.resolve() : settleOnboardingTour(snapshot, deps)))
        .catch(() => {});
      return snapshot;
    },
    async idle() {
      await writes.catch(() => {});
    },
  };
}
