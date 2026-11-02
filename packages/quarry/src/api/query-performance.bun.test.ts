/**
 * Query API Performance Tests
 *
 * Performance benchmarks for the QuarryAPI query operations.
 * These tests measure execution time and ensure operations complete
 * within acceptable thresholds for various dataset sizes.
 *
 * Benchmark categories:
 * - CRUD operations (create, get, list, update, delete)
 * - Task queries (ready, blocked)
 * - Dependency operations
 * - Search operations
 * - Pagination performance
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { loadavg } from 'node:os';
import { QuarryAPIImpl } from './quarry-api.js';
import { createStorage, initializeSchema } from '@stoneforge/storage';
import type { StorageBackend } from '@stoneforge/storage';
import type { Element, EntityId, ElementId, Task, Document } from '@stoneforge/core';
import { createTask, Priority, TaskStatus, createDocument, ContentType, DependencyType } from '@stoneforge/core';
import type { TaskFilter } from './types.js';

// ============================================================================
// Test Configuration
// ============================================================================

/**
 * Performance thresholds in milliseconds
 * These are conservative thresholds that should pass on most systems
 */
const THRESHOLDS = {
  // Single operation thresholds
  singleCreate: 50,
  singleGet: 10,
  singleUpdate: 50,
  singleDelete: 50,

  // Batch operation thresholds (per item average)
  batchCreatePerItem: 15,
  batchGetPerItem: 5,

  // Query thresholds for 100 items
  listAll: 100,
  listFiltered: 100,
  listPaginated: 50,

  // Task-specific query thresholds for 100 items
  ready: 150,
  blocked: 150,

  // Dependency thresholds
  addDependency: 50,
  getDependencyTree: 200,

  // Search thresholds for 100 items
  search: 200,
};

/**
 * Test dataset sizes
 * Note: DEFAULT_PAGE_SIZE in the API is 50, so tests expecting exact counts
 * should use small or pageSize datasets to avoid pagination issues.
 */
const DATASET_SIZES = {
  small: 10,
  pageSize: 50, // Matches DEFAULT_PAGE_SIZE to avoid pagination issues
  medium: 100,
  large: 200, // Reduced from 500 for faster test runs
};

// ============================================================================
// Test Helpers
// ============================================================================

const mockEntityId = 'user:perf-test' as EntityId;

/**
 * Helper to cast element for api.create()
 */
function toCreateInput<T extends Element>(element: T): Parameters<QuarryAPIImpl['create']>[0] {
  return element as unknown as Parameters<QuarryAPIImpl['create']>[0];
}

/**
 * Create a test task element with unique ID
 * Generates a unique element ID to avoid hash collisions
 */
async function createTestTask(
  overrides: Partial<Parameters<typeof createTask>[0]> = {}
): Promise<Task> {
  // Generate a unique ID directly to avoid hash collision issues
  const uniqueId = `el-${crypto.randomUUID().replace(/-/g, '').substring(0, 8)}` as ElementId;
  return createTask({
    id: uniqueId,
    title: `PerfTest-${uniqueId}`,
    createdBy: mockEntityId,
    tags: ['perf-test'],
    ...overrides,
  });
}

/**
 * Create a test document element with unique content
 * Uses UUID for guaranteed uniqueness
 */
async function createTestDocument(
  overrides: Partial<Parameters<typeof createDocument>[0]> = {}
): Promise<Document> {
  const uniqueId = crypto.randomUUID();
  return createDocument({
    contentType: ContentType.MARKDOWN,
    content: `# Document ${uniqueId}\n\nThis is a test document for performance testing.`,
    createdBy: mockEntityId,
    tags: ['perf-test'],
    ...overrides,
  });
}

/**
 * Measure execution time of an async function
 */
async function measureTime<T>(fn: () => Promise<T>): Promise<{ result: T; duration: number }> {
  const start = performance.now();
  const result = await fn();
  const duration = performance.now() - start;
  return { result, duration };
}

/**
 * Fixed number of independent timed runs behind each absolute threshold.
 * Never adapt this count, or add runs, in response to an assertion outcome.
 */
const THRESHOLD_SAMPLES = 16;

/**
 * Threshold estimator: fastest of THRESHOLD_SAMPLES independent timed runs.
 *
 * `measure` performs any per-run setup untimed and returns the duration of the
 * operation under test (normally via measureTime). Host contention
 * (preemption, other processes' gates, slower-core scheduling) only adds time
 * to an individual run, so the minimum estimates the uncontended cost of the
 * same deterministic work. A real regression adds work to every run,
 * including the fastest, so thresholds stay unchanged (el-53k1uj).
 */
async function minimumDuration(
  measure: (sample: number) => Promise<number>,
  samples = THRESHOLD_SAMPLES
): Promise<number> {
  const durations: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    durations.push(await measure(sample));
  }
  expect(durations.length).toBe(samples);
  return Math.min(...durations);
}

/** Minimum duration of THRESHOLD_SAMPLES repeated runs of the same read. */
async function minimumReadDuration<T>(
  read: () => Promise<T>,
  check: (result: T) => void = () => {}
): Promise<number> {
  return minimumDuration(async () => {
    const { result, duration } = await measureTime(read);
    check(result);
    return duration;
  });
}

/**
 * Create multiple tasks in batch with unique IDs
 */
async function createTaskBatch(
  api: QuarryAPIImpl,
  count: number,
  overrides: Partial<Parameters<typeof createTask>[0]> = {}
): Promise<Task[]> {
  const tasks: Task[] = [];
  for (let i = 0; i < count; i++) {
    const task = await createTestTask(overrides);
    const created = await api.create(toCreateInput(task));
    tasks.push(created as Task);
  }
  return tasks;
}

// Six independent samples per size: every position and directed size transition
// occurs equally often. Never add samples in response to an assertion outcome.
const SCALING_ORDERS = [
  [0, 1, 2], [2, 1, 0], [1, 2, 0],
  [0, 2, 1], [2, 0, 1], [1, 0, 2],
];
const CREATE_SIZES = [10, 50, 100];
const LIST_SIZES = [50, 100, 150];
const CREATE_BATCHES = 32;
const LIST_QUERIES = 256;

type ScalingSample = { durations: number[]; operations: number };
type CreateBatch = (api: QuarryAPIImpl, size: number) => Promise<Task[]>;
type ListTasks = (api: QuarryAPIImpl, size: number) => Promise<Task[]>;
const listTasks: ListTasks = (api, size) => api.list<Task>({ type: 'task', limit: size });
const wallClock = () => performance.now();

async function withScalingDatabase<T>(run: (api: QuarryAPIImpl) => Promise<T>): Promise<T> {
  const storage = createStorage({ path: ':memory:' });
  try {
    initializeSchema(storage);
    return await run(new QuarryAPIImpl(storage));
  } finally {
    storage.close();
  }
}

async function measureCreateSample(
  size: number,
  create: CreateBatch = createTaskBatch,
  clock = wallClock,
  batches = CREATE_BATCHES
): Promise<ScalingSample> {
  const durations: number[] = [];
  for (let batch = 0; batch < batches; batch++) {
    // Each batch grows only from 0 to size. Schema setup/teardown is not timed.
    await withScalingDatabase(async (freshApi) => {
      const start = clock();
      const tasks = await create(freshApi, size);
      durations.push(clock() - start);
      expect(tasks.length).toBe(size);
    });
  }
  return { durations, operations: batches * size };
}

async function measureListSample(
  size: number,
  list: ListTasks = listTasks,
  clock = wallClock,
  queries = LIST_QUERIES
): Promise<ScalingSample> {
  return withScalingDatabase(async (freshApi) => {
    await createTaskBatch(freshApi, size);
    // Prepare this database's query path; global warmup below uses other DBs.
    expect((await list(freshApi, size)).length).toBe(size);
    let count = 0;
    // Time every query separately: one duration per query (see minimumPerQuery).
    const durations: number[] = [];
    for (let query = 0; query < queries; query++) {
      const start = clock();
      const tasks = await list(freshApi, size);
      durations.push(clock() - start);
      count += tasks.length;
    }
    expect(count).toBe(size * queries);
    return { durations, operations: queries };
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return (sorted[Math.floor(middle)] + sorted[Math.ceil(middle) - 1]) / 2;
}

/** Reduces one independent sample to a per-operation cost. */
type SampleEstimator = (sample: ScalingSample) => number;
/** Sample estimator: summed duration divided by operations (mean per operation). */
const meanPerOperation: SampleEstimator = ({ durations, operations }) =>
  durations.reduce((sum, duration) => sum + duration, 0) / operations;
/**
 * Sample estimator: fastest single query in the sample (one duration per query).
 * Host contention (preemption, slower-core scheduling, runtime helper threads
 * competing for CPU) only adds time to an individual query, so the minimum of
 * 256 queries estimates the uncontended cost of the same deterministic work.
 * A real superlinear regression adds work to every query, including the fastest.
 */
const minimumPerQuery: SampleEstimator = ({ durations, operations }) => {
  expect(durations.length).toBe(operations);
  return Math.min(...durations);
};

async function measureScaling(
  name: string,
  sizes: number[],
  sample: (size: number) => Promise<ScalingSample>,
  estimate: SampleEstimator,
  unit = 'ms'
): Promise<number> {
  // Fixed warmup, never calibrated from measured ratios or pass/fail.
  const warmup = [];
  for (const size of sizes) warmup.push(await sample(size));
  const samples: ScalingSample[][] = sizes.map(() => []);
  for (const order of SCALING_ORDERS) {
    for (const index of order) samples[index].push(await sample(sizes[index]));
  }
  const totals = samples.map((group) => group.map(({ durations }) =>
    durations.reduce((sum, duration) => sum + duration, 0)));
  const estimates = samples.map((group) => group.map(estimate));
  // Median across the six independent samples of each size.
  const medians = estimates.map(median);
  const ratio = medians[medians.length - 1] / medians[0];
  // Diagnostic only: the mean-per-operation medians and their endpoint ratio.
  const meanMedians = samples.map((group) => median(group.map(meanPerOperation)));
  // Log every raw duration (rounded to 1 ns), including warmup and outliers,
  // before asserting. The returned ratio itself is not rounded.
  console.log('[scaling]', JSON.stringify({
    name, unit, estimator: estimate.name, sizes, orders: SCALING_ORDERS, warmup, samples,
    totals, estimates, medians, ratio, meanMedians,
    meanRatio: meanMedians[meanMedians.length - 1] / meanMedians[0],
    loadavg: loadavg(),
  }, (_key, value) => (typeof value === 'number' ? Number(value.toFixed(6)) : value)));
  return ratio;
}

function assertCreateScaling(ratio: number): void {
  expect(ratio).toBeLessThan(4);
}

function assertListScaling(ratio: number): void {
  // 150 / 50 = 3: the existing contract requires strictly sublinear query time.
  // Wall-clock ratios use minimumPerQuery medians (el-55qcdj); never raise this.
  expect(ratio).toBeLessThan(LIST_SIZES[2] / LIST_SIZES[0]);
}

// ============================================================================
// Performance Tests
// ============================================================================

describe('Query API Performance', () => {
  let backend: StorageBackend;
  let api: QuarryAPIImpl;

  beforeEach(() => {
    backend = createStorage({ path: ':memory:' });
    initializeSchema(backend);
    api = new QuarryAPIImpl(backend);
  });

  afterEach(() => {
    if (backend.isOpen) {
      backend.close();
    }
  });

  // ==========================================================================
  // Single Operation Performance
  // ==========================================================================

  describe('Single Operation Performance', () => {
    // Each run times exactly one operation; see minimumDuration.
    it('should create a single task within threshold', async () => {
      const duration = await minimumDuration(async () => {
        const task = await createTestTask();
        const { result, duration } = await measureTime(() => api.create(toCreateInput(task)));
        expect(result.id).toBe(task.id);
        return duration;
      });

      expect(duration).toBeLessThan(THRESHOLDS.singleCreate);
    });

    it('should get a single element within threshold', async () => {
      const task = await createTestTask();
      const created = await api.create(toCreateInput(task));

      const duration = await minimumReadDuration(() => api.get(created.id),
        (result) => expect(result?.id).toBe(created.id));

      expect(duration).toBeLessThan(THRESHOLDS.singleGet);
    });

    it('should update a single element within threshold', async () => {
      const duration = await minimumDuration(async (sample) => {
        const created = await api.create(toCreateInput(await createTestTask()));
        const title = `Updated Title ${sample}`;
        const { result, duration } = await measureTime(() =>
          api.update<Task>(created.id, { title })
        );
        expect(result.title).toBe(title);
        return duration;
      });

      expect(duration).toBeLessThan(THRESHOLDS.singleUpdate);
    });

    it('should delete a single element within threshold', async () => {
      const duration = await minimumDuration(async () => {
        const created = await api.create(toCreateInput(await createTestTask()));
        const { duration } = await measureTime(() => api.delete(created.id));
        expect((await api.get<Task>(created.id))?.status).toBe(TaskStatus.TOMBSTONE);
        return duration;
      });

      expect(duration).toBeLessThan(THRESHOLDS.singleDelete);
    });

    it('should ignore a contended run but reject work added to every run', async () => {
      // Deterministic durations, no timer: one run inflated by host contention
      // (el-53k1uj measured 113.21 ms against the 50 ms create threshold).
      const runs = (extra: number) => (sample: number) =>
        Promise.resolve((sample === 0 ? 113.21 : 4 + (sample % 3)) + extra);
      let calls = 0;
      const contended = await minimumDuration((sample) => {
        calls++;
        return runs(0)(sample);
      });
      expect(calls).toBe(THRESHOLD_SAMPLES);
      expect(contended).toBeLessThan(THRESHOLDS.singleCreate);

      // A regression adding 60 ms of work to every run raises the minimum too.
      const regressed = await minimumDuration(runs(60));
      expect(() => expect(regressed).toBeLessThan(THRESHOLDS.singleCreate)).toThrow();
    });
  });

  // ==========================================================================
  // Batch Create Performance
  // ==========================================================================

  describe('Batch Create Performance', () => {
    it('should create small batch of tasks efficiently', async () => {
      const count = DATASET_SIZES.small;
      const { duration } = await measureTime(async () => {
        await createTaskBatch(api, count);
      });

      const perItem = duration / count;
      expect(perItem).toBeLessThan(THRESHOLDS.batchCreatePerItem);
    });

    it('should create medium batch of tasks efficiently', async () => {
      const count = DATASET_SIZES.medium;
      const { duration } = await measureTime(async () => {
        await createTaskBatch(api, count);
      });

      const perItem = duration / count;
      expect(perItem).toBeLessThan(THRESHOLDS.batchCreatePerItem);
    });

    it('should create large batch of tasks with reasonable performance', async () => {
      const count = DATASET_SIZES.large;
      const { duration } = await measureTime(async () => {
        await createTaskBatch(api, count);
      });

      // For large batches, allow 2x the per-item threshold
      const perItem = duration / count;
      expect(perItem).toBeLessThan(THRESHOLDS.batchCreatePerItem * 2);
    });
  });

  // ==========================================================================
  // List Query Performance
  // ==========================================================================

  describe('List Query Performance', () => {
    beforeEach(async () => {
      // Pre-populate with medium dataset
      await createTaskBatch(api, DATASET_SIZES.medium);
    });

    it('should list all elements within threshold', async () => {
      const duration = await minimumReadDuration(
        () => api.list<Task>({ type: 'task', limit: DATASET_SIZES.medium }),
        (result) => expect(result.length).toBe(DATASET_SIZES.medium)
      );

      expect(duration).toBeLessThan(THRESHOLDS.listAll);
    });

    it('should list with status filter within threshold', async () => {
      const duration = await minimumReadDuration(() =>
        api.list<Task>({ type: 'task', status: TaskStatus.OPEN } as TaskFilter)
      );

      expect(duration).toBeLessThan(THRESHOLDS.listFiltered);
    });

    it('should list with priority filter within threshold', async () => {
      const duration = await minimumReadDuration(() =>
        api.list<Task>({ type: 'task', priority: Priority.MEDIUM } as TaskFilter)
      );

      expect(duration).toBeLessThan(THRESHOLDS.listFiltered);
    });

    it('should list with tag filter within threshold', async () => {
      const duration = await minimumReadDuration(() =>
        api.list<Task>({ type: 'task', tags: ['batch-5'] })
      );

      expect(duration).toBeLessThan(THRESHOLDS.listFiltered);
    });

    it('should list with pagination within threshold', async () => {
      const duration = await minimumReadDuration(
        () => api.listPaginated<Task>({ type: 'task', limit: 20, offset: 0 }),
        (result) => expect(result.items.length).toBe(20)
      );

      expect(duration).toBeLessThan(THRESHOLDS.listPaginated);
    });

    it('should handle multiple pages efficiently', async () => {
      const pageSize = 20;
      const totalPages = Math.ceil(DATASET_SIZES.medium / pageSize);
      const durations: number[] = [];

      for (let page = 0; page < totalPages; page++) {
        const { duration } = await measureTime(() =>
          api.listPaginated<Task>({
            type: 'task',
            limit: pageSize,
            offset: page * pageSize,
          })
        );
        durations.push(duration);
      }

      const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
      expect(avgDuration).toBeLessThan(THRESHOLDS.listPaginated);
    });

    it('should sort by created_at within threshold', async () => {
      const duration = await minimumReadDuration(() =>
        api.list<Task>({ type: 'task', orderBy: 'created_at', orderDir: 'desc' })
      );

      expect(duration).toBeLessThan(THRESHOLDS.listFiltered);
    });
  });

  // ==========================================================================
  // Ready/Blocked Query Performance
  // ==========================================================================

  describe('Ready/Blocked Query Performance', () => {
    it('should query ready tasks with no dependencies within threshold', async () => {
      // Use pageSize to stay within default API limits
      await createTaskBatch(api, DATASET_SIZES.pageSize);

      const duration = await minimumReadDuration(() => api.ready(),
        (result) => expect(result.length).toBe(DATASET_SIZES.pageSize));

      expect(duration).toBeLessThan(THRESHOLDS.ready);
    });

    it('should query ready tasks with filters within threshold', async () => {
      await createTaskBatch(api, DATASET_SIZES.pageSize);

      const duration = await minimumReadDuration(() =>
        api.ready({ priority: Priority.MEDIUM })
      );

      expect(duration).toBeLessThan(THRESHOLDS.ready);
    });

    it('should query blocked tasks within threshold', async () => {
      // Create tasks with dependencies - use pageSize to stay within limits
      const tasks = await createTaskBatch(api, DATASET_SIZES.pageSize);

      // Block half the tasks
      for (let i = 0; i < DATASET_SIZES.pageSize / 2; i++) {
        const blockerIdx = i * 2;
        const blockedIdx = i * 2 + 1;
        if (blockedIdx < tasks.length) {
          await api.addDependency({
            blockerId: tasks[blockedIdx].id,
            blockedId: tasks[blockerIdx].id,
            type: DependencyType.BLOCKS,
          });
        }
      }

      const duration = await minimumReadDuration(() => api.blocked(),
        (result) => expect(result.length).toBe(DATASET_SIZES.pageSize / 2));

      expect(duration).toBeLessThan(THRESHOLDS.blocked);
    });

    it('should handle ready query with complex dependency graph', async () => {
      const tasks = await createTaskBatch(api, DATASET_SIZES.pageSize);

      // Create a chain of dependencies: task[0] <- task[1] <- task[2] <- ... <- task[9]
      for (let i = 0; i < 10; i++) {
        if (i > 0) {
          await api.addDependency({
            blockerId: tasks[i].id,
            blockedId: tasks[i - 1].id,
            type: DependencyType.BLOCKS,
          });
        }
      }

      const duration = await minimumReadDuration(() => api.ready());

      // Should still complete within threshold even with chain
      expect(duration).toBeLessThan(THRESHOLDS.ready);
    });

    it('should handle ready query by assignee within threshold', async () => {
      // Create tasks with different assignees - use pageSize to stay within limits
      for (let i = 0; i < DATASET_SIZES.pageSize; i++) {
        const task = await createTestTask({
          assignee: `user:agent-${i % 10}` as EntityId,
        });
        await api.create(toCreateInput(task));
      }

      const duration = await minimumReadDuration(
        () => api.ready({ assignee: 'user:agent-0' as EntityId }),
        // 10% of tasks should be assigned to agent-0
        (result) => expect(result.length).toBe(DATASET_SIZES.pageSize / 10)
      );

      expect(duration).toBeLessThan(THRESHOLDS.ready);
    });
  });

  // ==========================================================================
  // Dependency Operation Performance
  // ==========================================================================

  describe('Dependency Operation Performance', () => {
    it('should add dependency within threshold', async () => {
      const duration = await minimumDuration(async () => {
        // Fresh, unrelated pair per run so every run does the same work.
        const task1 = await createTestTask();
        const task2 = await createTestTask();
        await api.create(toCreateInput(task1));
        await api.create(toCreateInput(task2));

        const { result, duration } = await measureTime(() =>
          api.addDependency({
            blockerId: task2.id,
            blockedId: task1.id,
            type: DependencyType.BLOCKS,
          })
        );
        expect(result.blockedId).toBe(task1.id);
        return duration;
      });

      expect(duration).toBeLessThan(THRESHOLDS.addDependency);
    });

    it('should add multiple dependencies efficiently', async () => {
      const count = DATASET_SIZES.small;
      const tasks = await createTaskBatch(api, count * 2);

      const { duration } = await measureTime(async () => {
        for (let i = 0; i < count; i++) {
          await api.addDependency({
            blockerId: tasks[i * 2 + 1].id,
            blockedId: tasks[i * 2].id,
            type: DependencyType.BLOCKS,
          });
        }
      });

      const perDep = duration / count;
      expect(perDep).toBeLessThan(THRESHOLDS.addDependency);
    });

    it('should get dependency tree within threshold', async () => {
      // Create a tree structure
      const tasks = await createTaskBatch(api, 20);

      // Create tree: 0 is root, 1-3 depend on 0, 4-12 depend on 1-3
      for (let i = 1; i <= 3; i++) {
        await api.addDependency({
          blockerId: tasks[i].id,
          blockedId: tasks[0].id,
          type: DependencyType.BLOCKS,
        });
      }
      for (let i = 4; i <= 12; i++) {
        await api.addDependency({
          blockerId: tasks[i].id,
          blockedId: tasks[Math.floor((i - 1) / 3)].id,
          type: DependencyType.BLOCKS,
        });
      }

      const duration = await minimumReadDuration(
        () => api.getDependencyTree(tasks[0].id),
        (result) => expect(result.root.element.id).toBe(tasks[0].id)
      );

      expect(duration).toBeLessThan(THRESHOLDS.getDependencyTree);
    });

    it('should get dependencies and dependents within threshold', async () => {
      const tasks = await createTaskBatch(api, 20);

      // Create hub-and-spoke: tasks 1-19 all blocked by task 0
      for (let i = 1; i < 20; i++) {
        await api.addDependency({
          blockedId: tasks[i].id,
          blockerId: tasks[0].id,
          type: DependencyType.BLOCKS,
        });
      }

      const depsTime = await minimumReadDuration(() => api.getDependencies(tasks[1].id),
        (deps) => expect(deps.length).toBe(1));

      const dependentsTime = await minimumReadDuration(() => api.getDependents(tasks[0].id),
        (dependents) => expect(dependents.length).toBe(19));

      expect(depsTime).toBeLessThan(50);
      expect(dependentsTime).toBeLessThan(100);
    });
  });

  // ==========================================================================
  // Search Performance
  // ==========================================================================

  describe('Search Performance', () => {
    // Use unique keyword per test run to avoid collisions with parallel tests
    const uniqueSearchKeyword = `SearchPerf${crypto.randomUUID().replace(/-/g, '').substring(0, 12)}`;

    beforeEach(async () => {
      // Pre-populate with documents for search testing
      // Use explicit unique IDs to avoid hash collisions that can occur
      // when many documents are created in quick succession
      for (let i = 0; i < DATASET_SIZES.medium; i++) {
        // Use unique keyword instead of generic 'Important' to avoid collisions
        const keyword = i % 2 === 0 ? uniqueSearchKeyword : 'RegularDoc';
        const uniqueId = crypto.randomUUID();
        // Generate explicit unique ID to avoid hash collision issues
        const docId = `el-${crypto.randomUUID().replace(/-/g, '').substring(0, 8)}` as ElementId;
        const doc = await createDocument({
          contentType: ContentType.MARKDOWN,
          content: `# ${keyword} Document ${uniqueId}\n\nThis is a ${keyword.toLowerCase()} test document for performance testing.`,
          createdBy: mockEntityId,
        });
        // Override the hash-generated ID with our explicit unique ID
        (doc as unknown as { id: ElementId }).id = docId;
        await api.create(toCreateInput(doc));
      }
    });

    it('should search by content keyword within threshold', async () => {
      const duration = await minimumReadDuration(
        () => api.search(uniqueSearchKeyword),
        // Half the documents have the unique keyword in content
        (result) => expect(result.length).toBe(DATASET_SIZES.medium / 2)
      );

      expect(duration).toBeLessThan(THRESHOLDS.search);
    });

    it('should search by content within threshold', async () => {
      const duration = await minimumReadDuration(() =>
        api.search('performance testing')
      );

      expect(duration).toBeLessThan(THRESHOLDS.search);
    });

    it('should search with type filter within threshold', async () => {
      // Add some tasks too
      await createTaskBatch(api, 20);

      const duration = await minimumReadDuration(() =>
        api.search('Document', { type: 'document' })
      );

      expect(duration).toBeLessThan(THRESHOLDS.search);
    });
  });

  // ==========================================================================
  // Scaling Performance
  // ==========================================================================

  describe('Scaling Performance', () => {
    it('should maintain consistent per-item performance as dataset grows', async () => {
      assertCreateScaling(await measureScaling('create', CREATE_SIZES, measureCreateSample,
        meanPerOperation));
    }, 30_000);

    it('should maintain list performance as dataset grows', async () => {
      assertListScaling(await measureScaling('list', LIST_SIZES, measureListSample,
        minimumPerQuery));
    }, 30_000);

    it('should reject quadratic create work with the same sampling and assertion', async () => {
      // Deterministic operation-count clock over real API work, not a timed busy
      // loop. The injected regression scans all existing tasks before each insert.
      // One batch suffices for this clock; it has no timer/scheduler resolution.
      let rows = 0;
      const clock = () => rows;
      const countedCreate = (scan: boolean): CreateBatch => async (freshApi, size) => {
        const tasks: Task[] = [];
        for (let i = 0; i < size; i++) {
          const task = await createTestTask();
          if (scan) {
            const existing = await freshApi.list<Task>({ type: 'task', limit: size });
            rows += existing.length;
            if (existing.some((candidate) => candidate.id === task.id)) {
              throw new Error('Duplicate task');
            }
          }
          tasks.push(await freshApi.create(toCreateInput(task)) as Task);
          rows++;
        }
        return tasks;
      };
      const linear = await measureScaling('create-linear-control', CREATE_SIZES,
        (size) => measureCreateSample(size, countedCreate(false), clock, 1), meanPerOperation,
        'row-visits');
      const quadratic = await measureScaling('create-quadratic-control', CREATE_SIZES,
        (size) => measureCreateSample(size, countedCreate(true), clock, 1), meanPerOperation,
        'row-visits');
      assertCreateScaling(linear);
      expect(() => assertCreateScaling(quadratic)).toThrow();
    }, 30_000);

    it('should reject quadratic list work with the same sampling and assertion', async () => {
      // Simulate an N+1 enrichment regression: re-list the entire dataset for
      // every returned task. Count actual rows materialized by the real API.
      let rows = 0;
      const clock = () => rows;
      const countedList = (rescan: boolean): ListTasks => async (freshApi, size) => {
        const tasks = await listTasks(freshApi, size);
        // One request plus all materialized rows: linear work with fixed overhead.
        rows += 1 + tasks.length;
        if (rescan) {
          for (const task of tasks) {
            const candidates = await listTasks(freshApi, size);
            rows += 1 + candidates.length;
            if (!candidates.some((candidate) => candidate.id === task.id)) {
              throw new Error('Missing task');
            }
          }
        }
        return tasks;
      };
      const linear = await measureScaling('list-linear-control', LIST_SIZES,
        (size) => measureListSample(size, countedList(false), clock, 1), minimumPerQuery,
        'row-visits');
      const quadratic = await measureScaling('list-quadratic-control', LIST_SIZES,
        (size) => measureListSample(size, countedList(true), clock, 1), minimumPerQuery,
        'row-visits');
      assertListScaling(linear);
      expect(() => assertListScaling(quadratic)).toThrow();
    }, 30_000);

    it('should maintain ready query performance as dependencies grow', async () => {
      const tasks = await createTaskBatch(api, 100);
      const timesWithDeps: number[] = [];

      // Measure with increasing number of dependencies
      const depCounts = [0, 10, 25, 50];

      for (let i = 0; i < depCounts.length; i++) {
        const depCount = depCounts[i];
        const prevDepCount = i > 0 ? depCounts[i - 1] : 0;

        // Add new dependencies
        for (let j = prevDepCount; j < depCount && j * 2 + 1 < tasks.length; j++) {
          await api.addDependency({
            blockerId: tasks[j * 2 + 1].id,
            blockedId: tasks[j * 2].id,
            type: DependencyType.BLOCKS,
          });
        }

        // Fastest of a fixed number of runs per step (see minimumDuration): a
        // single contended sample at either endpoint would distort the ratio.
        timesWithDeps.push(await minimumReadDuration(() => api.ready()));
      }

      // Ready query time should not explode as dependencies increase
      // Allow 4x slowdown for 50 deps vs 0 deps
      const ratio = timesWithDeps[timesWithDeps.length - 1] / timesWithDeps[0];
      expect(ratio).toBeLessThan(4);
    });
  });

  // ==========================================================================
  // Combined Operation Performance
  // ==========================================================================

  describe('Combined Operation Performance', () => {
    it('should handle create-update-query cycle efficiently', async () => {
      const iterations = 20;
      const { duration } = await measureTime(async () => {
        for (let i = 0; i < iterations; i++) {
          const task = await createTestTask();
          const created = await api.create(toCreateInput(task));
          await api.update<Task>(created.id, {
            status: TaskStatus.IN_PROGRESS,
            title: `Updated Task ${i}`,
          });
          await api.ready();
        }
      });

      const perIteration = duration / iterations;
      // Each iteration should complete in reasonable time
      expect(perIteration).toBeLessThan(100);
    });

    it('should handle concurrent-like operations efficiently', async () => {
      // Simulate multiple operations that might happen in rapid succession
      const tasks = await createTaskBatch(api, 50);

      const duration = await minimumDuration(async (sample) => {
        // Mix of operations; each run updates a different task so the update
        // performs a real status transition every time.
        const task = tasks[sample];
        const { duration } = await measureTime(async () => {
          await api.list<Task>({ type: 'task' });
          await api.ready();
          await api.get(task.id);
          await api.update<Task>(task.id, { status: TaskStatus.IN_PROGRESS });
          await api.ready();
          await api.blocked();
          await api.search('Test');
          await api.getDependencies(task.id);
        });
        return duration;
      });

      // All operations should complete quickly
      expect(duration).toBeLessThan(500);
    });
  });

  // ==========================================================================
  // Stats Performance
  // ==========================================================================

  describe('Stats Performance', () => {
    it('should compute stats within threshold', async () => {
      // Create diverse dataset
      await createTaskBatch(api, DATASET_SIZES.medium);
      for (let i = 0; i < 20; i++) {
        const doc = await createTestDocument();
        await api.create(toCreateInput(doc));
      }

      const duration = await minimumReadDuration(() => api.stats(), (result) => {
        expect(result.elementsByType.task).toBe(DATASET_SIZES.medium);
        expect(result.elementsByType.document).toBe(20);
      });

      expect(duration).toBeLessThan(200);
    });
  });
});

// ============================================================================
// Benchmark Summary Helper
// ============================================================================

describe('Performance Benchmark Summary', () => {
  let backend: StorageBackend;
  let api: QuarryAPIImpl;

  beforeAll(() => {
    backend = createStorage({ path: ':memory:' });
    initializeSchema(backend);
    api = new QuarryAPIImpl(backend);
  });

  afterAll(() => {
    if (backend.isOpen) {
      backend.close();
    }
  });

  it('should run comprehensive benchmark and log results', async () => {
    const results: Record<string, number> = {};

    // Create baseline dataset
    const tasks = await createTaskBatch(api, 100);

    // Measure key operations
    const { duration: listDuration } = await measureTime(() =>
      api.list<Task>({ type: 'task' })
    );
    results['list (100 items)'] = listDuration;

    const { duration: readyDuration } = await measureTime(() => api.ready());
    results['ready (100 items)'] = readyDuration;

    const { duration: searchDuration } = await measureTime(() =>
      api.search('Performance')
    );
    results['search (100 items)'] = searchDuration;

    const { duration: getDuration } = await measureTime(() =>
      api.get(tasks[0].id)
    );
    results['get (single)'] = getDuration;

    // Add some dependencies
    for (let i = 0; i < 25; i++) {
      await api.addDependency({
        blockerId: tasks[i * 2 + 1].id,
        blockedId: tasks[i * 2].id,
        type: DependencyType.BLOCKS,
      });
    }

    const { duration: blockedDuration } = await measureTime(() => api.blocked());
    results['blocked (25 blocked)'] = blockedDuration;

    const { duration: treeDuration } = await measureTime(() =>
      api.getDependencyTree(tasks[0].id)
    );
    results['getDependencyTree'] = treeDuration;

    const { duration: statsDuration } = await measureTime(() => api.stats());
    results['stats'] = statsDuration;

    // Log benchmark summary
    console.log('\n=== Performance Benchmark Summary ===');
    for (const [op, time] of Object.entries(results)) {
      console.log(`${op}: ${time.toFixed(2)}ms`);
    }
    console.log('=====================================\n');

    // Basic sanity checks - all operations should complete
    expect(Object.values(results).every((t) => t > 0)).toBe(true);
  });
});
