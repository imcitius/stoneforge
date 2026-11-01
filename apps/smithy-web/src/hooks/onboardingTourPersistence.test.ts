import { describe, expect, it } from 'vitest';
import {
  LEGACY_COMPLETE_KEY,
  ONBOARDING_TOUR_ENDPOINT,
  STEP_STORAGE_KEY,
  createOnboardingTourStore,
  hydrateOnboardingTour,
  saveOnboardingTour,
  type StorageLike,
} from './onboardingTourPersistence';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
}

/** In-memory stand-in for one workspace backend. */
function workspace(initial: 'completed' | 'dismissed' | null = null) {
  let status = initial;
  const calls: Array<{ method: string; body?: unknown }> = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    expect(url).toBe(ONBOARDING_TOUR_ENDPOINT);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, body });
    if (method === 'PUT') status = body.status;
    return new Response(JSON.stringify({ completed: status !== null, status }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, get status() { return status; } };
}

const offline = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof globalThis.fetch;
const missingRoute = (async () => new Response('not found', { status: 404 })) as unknown as typeof globalThis.fetch;

describe('onboarding tour persistence', () => {
  it('fresh workspace and fresh origin: not completed', async () => {
    const ws = workspace();
    expect(await hydrateOnboardingTour({ fetch: ws.fetch, storage: memoryStorage() })).toBe(false);
  });

  it('dismissal survives a new origin (backend restart on another port)', async () => {
    const ws = workspace();
    await saveOnboardingTour('dismissed', { fetch: ws.fetch, storage: memoryStorage() });
    // Different port → empty localStorage, same workspace backend record.
    expect(await hydrateOnboardingTour({ fetch: ws.fetch, storage: memoryStorage() })).toBe(true);
    expect(ws.status).toBe('dismissed');
  });

  it('workspaces are isolated', async () => {
    const a = workspace();
    const b = workspace();
    await saveOnboardingTour('completed', { fetch: a.fetch, storage: memoryStorage() });
    expect(await hydrateOnboardingTour({ fetch: b.fetch, storage: memoryStorage() })).toBe(false);
  });

  it('does not leave an origin-wide flag that leaks to another workspace on the same origin', async () => {
    const origin = memoryStorage();
    await saveOnboardingTour('completed', { fetch: workspace().fetch, storage: origin });
    expect(origin.getItem(LEGACY_COMPLETE_KEY)).toBeNull();
    expect(await hydrateOnboardingTour({ fetch: workspace().fetch, storage: origin })).toBe(false);
  });

  it('migrates an observable legacy completion into the workspace once', async () => {
    const ws = workspace();
    const storage = memoryStorage({ [LEGACY_COMPLETE_KEY]: 'true' });
    expect(await hydrateOnboardingTour({ fetch: ws.fetch, storage })).toBe(true);
    expect(ws.status).toBe('completed');
    expect(storage.getItem(LEGACY_COMPLETE_KEY)).toBeNull();
    expect(await hydrateOnboardingTour({ fetch: ws.fetch, storage: memoryStorage() })).toBe(true);
  });

  it('workspace completion clears a stale in-progress step so it cannot resume', async () => {
    const storage = memoryStorage({ [STEP_STORAGE_KEY]: '4' });
    expect(await hydrateOnboardingTour({ fetch: workspace('dismissed').fetch, storage })).toBe(true);
    expect(storage.getItem(STEP_STORAGE_KEY)).toBeNull();
  });

  it('explicit restart clears the workspace record', async () => {
    const ws = workspace('completed');
    await saveOnboardingTour(null, { fetch: ws.fetch, storage: memoryStorage() });
    expect(ws.status).toBeNull();
    expect(await hydrateOnboardingTour({ fetch: ws.fetch, storage: memoryStorage() })).toBe(false);
  });

  it('falls back to same-origin storage when the backend is unreachable or lacks the route', async () => {
    for (const fetch of [offline, missingRoute]) {
      const storage = memoryStorage();
      expect(await saveOnboardingTour('dismissed', { fetch, storage })).toBe(false);
      expect(storage.getItem(LEGACY_COMPLETE_KEY)).toBe('true');
      expect(await hydrateOnboardingTour({ fetch, storage })).toBe(true);
      expect(await hydrateOnboardingTour({ fetch, storage: memoryStorage() })).toBe(false);
    }
  });
});

/**
 * Workspace whose GET answers can be held, like a slow backend at page load.
 * The answer reflects the record when the GET was *received*, so a held
 * answer is stale once a later PUT lands.
 */
function heldWorkspace(initial: 'completed' | 'dismissed' | null = null) {
  let status = initial;
  const puts: unknown[] = [];
  const held: Array<() => void> = [];
  const fetch = (async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'PUT') {
      status = JSON.parse(String(init!.body)).status;
      puts.push(status);
      return new Response(JSON.stringify({ completed: status !== null, status }), { status: 200 });
    }
    const snapshot = status;
    await new Promise<void>((release) => held.push(release));
    return new Response(JSON.stringify({ completed: snapshot !== null, status: snapshot }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const releaseGet = async () => {
    while (held.length === 0) await Promise.resolve();
    held.shift()!();
  };
  return { fetch, puts, releaseGet, get status() { return status; } };
}

describe('onboarding tour store: user mutations win over delayed hydration', () => {
  it('explicit restart while hydration is held is not overwritten by legacy migration', async () => {
    const ws = heldWorkspace();
    const storage = memoryStorage({ [LEGACY_COMPLETE_KEY]: 'true' });
    const store = createOnboardingTourStore(() => ({ fetch: ws.fetch, storage }));
    const hydration = store.hydrate();
    // Settings → Restart Onboarding Tour before the GET (completed: false) resolves.
    await store.save(null);
    expect(ws.status).toBeNull();
    await ws.releaseGet();
    expect(await hydration).toBeNull();
    await store.idle();
    expect(ws.puts).toEqual([null]);
    expect(ws.status).toBeNull();
    expect(storage.getItem(LEGACY_COMPLETE_KEY)).toBeNull();
    // Restart persisted: a fresh page load (new store/origin) gets the tour again.
    const next = createOnboardingTourStore(() => ({ fetch: workspace(ws.status).fetch, storage: memoryStorage() }));
    expect((await next.hydrate())?.completed).toBe(false);
  });

  it('restart issued before the held GET even starts its write still wins', async () => {
    const ws = heldWorkspace();
    const storage = memoryStorage({ [LEGACY_COMPLETE_KEY]: 'true' });
    const store = createOnboardingTourStore(() => ({ fetch: ws.fetch, storage }));
    const hydration = store.hydrate();
    const restart = store.save(null); // not awaited: PUT still queued/in flight
    await ws.releaseGet();
    expect(await hydration).toBeNull();
    await restart;
    await store.idle();
    expect(ws.puts).toEqual([null]);
    expect(ws.status).toBeNull();
  });

  it.each(['dismissed', 'completed'] as const)('%s issued while hydration is held wins over stale state', async (status) => {
    const ws = heldWorkspace();
    const storage = memoryStorage();
    const store = createOnboardingTourStore(() => ({ fetch: ws.fetch, storage }));
    const hydration = store.hydrate();
    await store.save(status);
    await ws.releaseGet(); // stale answer: completed false
    expect(await hydration).toBeNull();
    await store.idle();
    expect(ws.puts).toEqual([status]);
    expect(ws.status).toBe(status);
  });

  it('a stale "completed" answer does not clear the step of a tour restarted meanwhile', async () => {
    const ws = heldWorkspace('dismissed');
    const storage = memoryStorage();
    const store = createOnboardingTourStore(() => ({ fetch: ws.fetch, storage }));
    const hydration = store.hydrate();
    await store.save(null);
    storage.setItem(STEP_STORAGE_KEY, '2'); // restarted tour in progress
    await ws.releaseGet();
    expect(await hydration).toBeNull();
    await store.idle();
    expect(storage.getItem(STEP_STORAGE_KEY)).toBe('2');
    expect(ws.status).toBeNull();
  });

  it('without a concurrent mutation, hydration migrates the legacy flag once through the queue', async () => {
    const ws = heldWorkspace();
    const storage = memoryStorage({ [LEGACY_COMPLETE_KEY]: 'true' });
    const store = createOnboardingTourStore(() => ({ fetch: ws.fetch, storage }));
    const hydration = store.hydrate();
    await ws.releaseGet();
    expect(await hydration).toEqual({ completed: true, workspaceCompleted: false });
    await store.idle();
    expect(ws.puts).toEqual(['completed']);
    expect(storage.getItem(LEGACY_COMPLETE_KEY)).toBeNull();
  });

  it('a restart issued after hydration resolved runs after the migration and wins', async () => {
    const ws = heldWorkspace();
    const storage = memoryStorage({ [LEGACY_COMPLETE_KEY]: 'true' });
    const store = createOnboardingTourStore(() => ({ fetch: ws.fetch, storage }));
    const hydration = store.hydrate();
    await ws.releaseGet();
    expect((await hydration)?.completed).toBe(true);
    await store.save(null);
    await store.idle();
    expect(ws.status).toBeNull();
    expect(ws.puts.at(-1)).toBeNull();
  });
});
