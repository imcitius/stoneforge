/**
 * Performance Tests for Dependency Graph Operations
 *
 * These tests guard the dependency system against algorithmic regressions:
 * - Cycle detection on deep chains (50+ nodes)
 * - Cycle detection on wide graphs (many siblings)
 * - Blocked cache rebuild on large datasets
 * - Blocked cache point queries and incremental updates
 *
 * The checks are deterministic: instead of wall-clock bounds (which flake when
 * the host is loaded), each test counts the storage work an operation performs
 * (read/write calls and rows returned to JS) and, for point operations, asserts
 * via EXPLAIN QUERY PLAN that SQLite uses an index rather than a table scan.
 * Those counts depend only on the algorithm and the graph, so a regression to a
 * full scan, a per-node table load, a missing early exit or an unbounded
 * traversal changes them by a large factor while timing noise cannot.
 *
 * Complexity targets based on spec:
 * - Cycle detection: one indexed lookup per visited node, bounded by maxDepth
 * - Blocked cache: O(1) indexed point lookups and updates
 * - Rebuild: a constant number of indexed lookups per checked element (linear)
 */

import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  DependencyService,
  createDependencyService,
  DEFAULT_CYCLE_DETECTION_CONFIG,
} from './dependency.js';
import {
  BlockedCacheService,
  createBlockedCacheService,
} from './blocked-cache.js';
import { createStorage, initializeSchema } from '@stoneforge/storage';
import type { StorageBackend } from '@stoneforge/storage';
import type { ElementId, EntityId } from '@stoneforge/core';
import { DependencyType, GateType } from '@stoneforge/core';

// ============================================================================
// Test Configuration
// ============================================================================

/**
 * Storage-work bounds for blocked cache rebuild, per checked element.
 *
 * rebuild() does three DISTINCT scans of `dependencies` to find candidate
 * elements, then for each element a fixed set of indexed lookups: its
 * parent-child parents, its own blocking dependencies, the blocker's
 * status/type (1-2 queryOne calls) and its parent-child children. Measured on
 * the graphs below: 4 reads/element for `blocks` chains and 5 for plan/task
 * hierarchies, at most 4 rows read per element (graphs here have one blocking
 * dependency per element). The bounds leave one spare read/row per element for
 * harmless refactors; a per-element full scan of `dependencies` or
 * `blocked_cache` reads O(n) rows per element (>=50 at n>=50) and fails them.
 */
const REBUILD_BOUNDS = {
  /** Fixed reads: the three DISTINCT candidate scans */
  fixedReads: 3,
  /** Max read calls per checked element */
  readsPerElement: 6,
  /** Max rows returned per checked element (candidate rows + lookups) */
  rowsPerElement: 5,
};

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a chain of blocking dependencies: A -> B -> C -> ...
 * Returns array of element IDs in order
 */
function createDependencyChain(
  service: DependencyService,
  length: number,
  createdBy: EntityId,
  type: DependencyType = DependencyType.BLOCKS
): ElementId[] {
  const ids: ElementId[] = [];
  for (let i = 0; i < length; i++) {
    ids.push(`el-chain-${i}` as ElementId);
  }

  for (let i = 0; i < ids.length - 1; i++) {
    service.addDependency({
      blockedId: ids[i + 1],
      blockerId: ids[i],
      type,
      createdBy,
    });
  }

  return ids;
}

/**
 * Create a wide graph where one element has many children
 * Returns { parent, children } IDs
 */
function createWideGraph(
  service: DependencyService,
  childCount: number,
  createdBy: EntityId,
  type: DependencyType = DependencyType.BLOCKS
): { parent: ElementId; children: ElementId[] } {
  const parent = 'el-wide-parent' as ElementId;
  const children: ElementId[] = [];

  for (let i = 0; i < childCount; i++) {
    const child = `el-wide-child-${i}` as ElementId;
    children.push(child);
    service.addDependency({
      blockedId: child,
      blockerId: parent,
      type,
      createdBy,
    });
  }

  return { parent, children };
}


/**
 * Helper to create test elements in the database for blocked cache tests
 */
function createTestElement(
  db: StorageBackend,
  id: string,
  type: string,
  status: string,
  createdBy: EntityId
): void {
  const now = new Date().toISOString();
  const data = JSON.stringify({ status, title: `Test ${id}` });
  db.run(
    `INSERT INTO elements (id, type, data, created_at, updated_at, created_by, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, type, data, now, now, createdBy, null]
  );
}

/** Storage work performed by an operation, as seen through StorageBackend */
interface StorageOps {
  /** query() + queryOne() calls */
  reads: number;
  /** run() calls (INSERT/UPDATE/DELETE) */
  writes: number;
  /** Rows returned to JS by all reads */
  rowsRead: number;
  /** SQL of every read, in call order */
  readSql: string[];
  /** SQL of every write, in call order */
  writeSql: string[];
}

/**
 * Run `fn` and count the storage reads, writes and rows it performs.
 * Spies call through to the real backend and are restored afterwards.
 */
function recordStorageOps<T>(db: StorageBackend, fn: () => T): { result: T; ops: StorageOps } {
  const querySpy = spyOn(db, 'query');
  const queryOneSpy = spyOn(db, 'queryOne');
  const runSpy = spyOn(db, 'run');
  try {
    const result = fn();
    let rowsRead = 0;
    for (const r of querySpy.mock.results) {
      if (r.type === 'return') rowsRead += (r.value as unknown[]).length;
    }
    for (const r of queryOneSpy.mock.results) {
      if (r.type === 'return' && r.value != null) rowsRead += 1; // miss: undefined or null
    }
    return {
      result,
      ops: {
        reads: querySpy.mock.calls.length + queryOneSpy.mock.calls.length,
        writes: runSpy.mock.calls.length,
        rowsRead,
        readSql: [...querySpy.mock.calls, ...queryOneSpy.mock.calls].map((c) => String(c[0])),
        writeSql: runSpy.mock.calls.map((c) => String(c[0])),
      },
    };
  } finally {
    querySpy.mockRestore();
    queryOneSpy.mockRestore();
    runSpy.mockRestore();
  }
}

/**
 * Assert SQLite resolves `sql` against `table` with an index SEARCH keyed on
 * `keyColumn`, never a full SCAN, i.e. the statement is an O(log n) point
 * access. Requiring the key column matters: a search on a low-selectivity
 * index (e.g. dependency `type`) still visits a large share of the table.
 */
function expectIndexedAccess(
  db: StorageBackend,
  sql: string,
  params: unknown[],
  table: string,
  keyColumn: string
): void {
  const plan = db
    .query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params)
    .map((row) => row.detail);
  const tablePattern = new RegExp(`\\b${table}\\b`);
  const accesses = plan.filter((detail) => tablePattern.test(detail));
  expect(accesses.length).toBeGreaterThan(0);
  for (const detail of accesses) {
    expect(detail).toMatch(new RegExp(`^SEARCH ${table} USING .*\\(${keyColumn}=\\?`));
  }
}

// ============================================================================
// Performance Tests
// ============================================================================

describe('Dependency Performance', () => {
  let db: StorageBackend;
  let service: DependencyService;
  const testEntity = 'en-perf-test' as EntityId;

  beforeEach(() => {
    db = createStorage({ path: ':memory:' });
    service = createDependencyService(db);
    service.initSchema();
  });

  afterEach(() => {
    db.close();
  });

  // ==========================================================================
  // Cycle Detection Performance
  // ==========================================================================

  describe('Cycle Detection - Deep Chains', () => {
    // BFS does exactly one indexed lookup of an element's blocking edges per
    // visited node and stops as soon as it reaches the target. On a chain each
    // lookup returns one edge, so the work is fully determined by chain length.

    test('detects cycle in 50-node chain with one indexed lookup per node', () => {
      const ids = createDependencyChain(service, 50, testEntity);

      const { result, ops } = recordStorageOps(db, () =>
        service.detectCycle(
          ids[0], // first element (blockedId) - would be blocked by last
          ids[ids.length - 1], // last element (blockerId) - would create cycle
          DependencyType.BLOCKS
        )
      );

      expect(result.hasCycle).toBe(true);
      expect(result.nodesVisited).toBe(50); // Should visit all nodes
      // Every node except the target (found before its lookup) is expanded once
      expect(ops.reads).toBe(49);
      // Only the 49 chain edges are read: no full-table loads
      expect(ops.rowsRead).toBe(49);
      expect(ops.writes).toBe(0);
      // The per-node lookup is an index search, not a scan of `dependencies`
      expectIndexedAccess(
        db,
        ops.readSql[0],
        [ids[ids.length - 1], DependencyType.BLOCKS, DependencyType.PARENT_CHILD, DependencyType.AWAITS],
        'dependencies',
        'blocked_id'
      );
    });

    test('detects cycle in 100-node chain with one indexed lookup per node', () => {
      const ids = createDependencyChain(service, 100, testEntity);

      const { result, ops } = recordStorageOps(db, () =>
        service.detectCycle(ids[0], ids[ids.length - 1], DependencyType.BLOCKS)
      );

      expect(result.hasCycle).toBe(true);
      // Default depth limit is 100, so should visit all nodes
      expect(result.nodesVisited).toBe(100);
      expect(ops.reads).toBe(99);
      expect(ops.rowsRead).toBe(99);
    });

    test('depth limit prevents runaway on very deep chains', () => {
      // Create chain longer than default depth limit
      const ids = createDependencyChain(service, 150, testEntity);
      const maxDepth = DEFAULT_CYCLE_DETECTION_CONFIG.maxDepth;

      const { result, ops } = recordStorageOps(db, () =>
        service.detectCycle(ids[0], ids[ids.length - 1], DependencyType.BLOCKS)
      );

      // Should hit depth limit before finding cycle
      expect(result.depthLimitReached).toBe(true);
      expect(result.hasCycle).toBe(false);
      // Work stops exactly at the depth limit: nodes at depth 0..maxDepth-1
      // are visited and expanded, nothing beyond.
      expect(result.nodesVisited).toBe(maxDepth);
      expect(ops.reads).toBe(maxDepth);
      expect(ops.rowsRead).toBe(maxDepth);
    });

    test('no-cycle check is efficient on deep chain', () => {
      const ids = createDependencyChain(service, 50, testEntity);

      // Check adding unrelated dependency (no cycle possible): ids[0] is the
      // chain root and has no blockers, so a single empty lookup suffices.
      const { result, ops } = recordStorageOps(db, () =>
        service.detectCycle('el-unrelated' as ElementId, ids[0], DependencyType.BLOCKS)
      );

      expect(result.hasCycle).toBe(false);
      expect(result.nodesVisited).toBe(1);
      expect(ops.reads).toBe(1);
      expect(ops.rowsRead).toBe(0);
    });
  });

  describe('Cycle Detection - Wide Graphs', () => {
    // Siblings must not be touched: work depends on the path from the new
    // blocker, not on how many other children share the parent.

    test('adding to wide graph (50 children) is efficient', () => {
      const { parent } = createWideGraph(service, 50, testEntity);

      // Add new child - no path from parent back to the child
      const { ops } = recordStorageOps(db, () =>
        service.addDependency({
          blockedId: 'el-new-child' as ElementId,
          blockerId: parent,
          type: DependencyType.BLOCKS,
          createdBy: testEntity,
        })
      );

      // One empty lookup of the parent's blockers, then one INSERT
      expect(ops.reads).toBe(1);
      expect(ops.rowsRead).toBe(0);
      expect(ops.writes).toBe(1);
    });

    test('cycle check on wide graph with 100 children', () => {
      const { parent, children } = createWideGraph(service, 100, testEntity);

      // Check if adding dependency from child back to parent would cycle
      // Since parent blocks children, child blocking parent would create cycle
      // blockedId=parent, blockerId=children[50]
      const { result, ops } = recordStorageOps(db, () =>
        service.detectCycle(parent, children[50], DependencyType.BLOCKS)
      );

      // Cycle IS detected: child50 -> (blocked_id=child50, blocker=parent) -> parent == blockedId
      expect(result.hasCycle).toBe(true);
      // Found after expanding only child50; the other 99 siblings are not read
      expect(result.nodesVisited).toBe(2);
      expect(ops.reads).toBe(1);
      expect(ops.rowsRead).toBe(1);
    });

    test('no cycle when adding unrelated dependency in wide graph', () => {
      createWideGraph(service, 100, testEntity);

      // Check if adding dependency between two unrelated elements would cycle
      const { result, ops } = recordStorageOps(db, () =>
        service.detectCycle(
          'el-unrelated-a' as ElementId,
          'el-unrelated-b' as ElementId,
          DependencyType.BLOCKS
        )
      );

      // No cycle since these elements are unrelated to the graph
      expect(result.hasCycle).toBe(false);
      // A single empty lookup; none of the 100 graph edges is read
      expect(result.nodesVisited).toBe(1);
      expect(ops.reads).toBe(1);
      expect(ops.rowsRead).toBe(0);
    });

    test('handles diamond pattern efficiently', () => {
      // Create multiple diamond patterns
      for (let i = 0; i < 20; i++) {
        const a = `el-d${i}-a` as ElementId;
        const b = `el-d${i}-b` as ElementId;
        const c = `el-d${i}-c` as ElementId;
        const d = `el-d${i}-d` as ElementId;

        service.addDependency({
          blockedId: b,
          blockerId: a,
          type: DependencyType.BLOCKS,
          createdBy: testEntity,
        });
        service.addDependency({
          blockedId: c,
          blockerId: a,
          type: DependencyType.BLOCKS,
          createdBy: testEntity,
        });
        service.addDependency({
          blockedId: d,
          blockerId: b,
          type: DependencyType.BLOCKS,
          createdBy: testEntity,
        });
        service.addDependency({
          blockedId: d,
          blockerId: c,
          type: DependencyType.BLOCKS,
          createdBy: testEntity,
        });
      }

      // Check cycle detection on diamond pattern
      // Would d blocking a create a cycle? blockedId=a, blockerId=d
      const { result, ops } = recordStorageOps(db, () =>
        service.detectCycle('el-d10-a' as ElementId, 'el-d10-d' as ElementId, DependencyType.BLOCKS)
      );

      expect(result.hasCycle).toBe(true);
      // Only diamond 10 is explored: d, b, c expanded (a is the target), and
      // only its 4 edges are read out of the 80 in the graph.
      expect(result.nodesVisited).toBe(4);
      expect(ops.reads).toBe(3);
      expect(ops.rowsRead).toBe(4);
    });
  });

  describe('Cycle Detection - Mixed Blocking Types', () => {
    test('handles mixed blocking types efficiently', () => {
      // Create chain with mixed blocking types
      const ids: ElementId[] = [];
      for (let i = 0; i < 30; i++) {
        ids.push(`el-mixed-${i}` as ElementId);
      }

      // Use different blocking types
      for (let i = 0; i < ids.length - 1; i++) {
        const type =
          i % 3 === 0
            ? DependencyType.BLOCKS
            : i % 3 === 1
              ? DependencyType.PARENT_CHILD
              : DependencyType.AWAITS;

        const metadata =
          type === DependencyType.AWAITS
            ? { gateType: GateType.TIMER, waitUntil: '2030-01-01T00:00:00.000Z' }
            : undefined;

        service.addDependency({
          blockedId: ids[i + 1],
          blockerId: ids[i],
          type,
          createdBy: testEntity,
          metadata,
        });
      }

      // Would last element blocking first create a cycle? blockedId=first, blockerId=last
      const { result, ops } = recordStorageOps(db, () =>
        service.detectCycle(ids[0], ids[ids.length - 1], DependencyType.BLOCKS)
      );

      expect(result.hasCycle).toBe(true);
      // All three blocking types are followed with one lookup per node
      expect(result.nodesVisited).toBe(30);
      expect(ops.reads).toBe(29);
      expect(ops.rowsRead).toBe(29);
    });
  });

  describe('Non-Blocking Dependencies', () => {
    test('non-blocking types skip cycle detection (instant)', () => {
      // Create chain with blocking dependencies
      createDependencyChain(service, 50, testEntity);

      // Non-blocking type should skip all traversal. Assert the skip
      // deterministically (no graph reads) rather than with a sub-millisecond
      // wall-clock bound, which is flaky on loaded machines.
      const querySpy = spyOn(db, 'query');
      const result = service.detectCycle(
        'el-chain-49' as ElementId,
        'el-chain-0' as ElementId,
        DependencyType.REFERENCES // non-blocking
      );

      expect(result.hasCycle).toBe(false);
      expect(result.nodesVisited).toBe(0); // No traversal for non-blocking
      expect(querySpy).not.toHaveBeenCalled(); // No dependency lookups
      querySpy.mockRestore();
    });

    test('relates-to type skips cycle detection', () => {
      // Populate the graph so a traversal would have work to do.
      createDependencyChain(service, 50, testEntity);

      const querySpy = spyOn(db, 'query');
      const result = service.detectCycle(
        'el-chain-49' as ElementId,
        'el-chain-0' as ElementId,
        DependencyType.RELATES_TO
      );

      expect(result.hasCycle).toBe(false);
      expect(result.nodesVisited).toBe(0);
      expect(querySpy).not.toHaveBeenCalled();
      querySpy.mockRestore();
    });
  });
});

describe('Blocked Cache Performance', () => {
  let db: StorageBackend;
  let cacheService: BlockedCacheService;
  const testEntity = 'en-cache-perf' as EntityId;

  beforeEach(() => {
    db = createStorage({ path: ':memory:' });
    initializeSchema(db);
    cacheService = createBlockedCacheService(db);
  });

  afterEach(() => {
    db.close();
  });

  /** Assert rebuild() did a linear amount of storage work (see REBUILD_BOUNDS) */
  function expectLinearRebuild(
    ops: StorageOps,
    result: { elementsChecked: number; elementsBlocked: number }
  ): void {
    const n = result.elementsChecked;
    expect(ops.reads).toBeLessThanOrEqual(
      REBUILD_BOUNDS.fixedReads + REBUILD_BOUNDS.readsPerElement * n
    );
    expect(ops.rowsRead).toBeLessThanOrEqual(REBUILD_BOUNDS.rowsPerElement * n);
    // One clear plus one insert per blocked element
    expect(ops.writes).toBe(1 + result.elementsBlocked);
  }

  // ==========================================================================
  // Cache Rebuild Performance
  // ==========================================================================

  describe('Cache Rebuild', () => {
    test('rebuilds cache for 100 elements with linear storage work', () => {
      // Create 100 elements with blocking dependencies
      for (let i = 0; i < 100; i++) {
        const elementId = `el-rebuild-${i}`;
        createTestElement(db, elementId, 'task', 'open', testEntity);

        if (i > 0) {
          // Each element blocks the previous one
          db.run(
            `INSERT INTO dependencies (blocked_id, blocker_id, type, created_at, created_by, metadata)
             VALUES (?, ?, ?, ?, ?, null)`,
            [`el-rebuild-${i - 1}`, elementId, DependencyType.BLOCKS, new Date().toISOString(), testEntity]
          );
        }
      }

      const { result, ops } = recordStorageOps(db, () => cacheService.rebuild());

      // 99 elements have blocking dependencies (1-99, not 0 since element 0 has no dependencies as source)
      expect(result.elementsChecked).toBe(99);
      expect(result.elementsBlocked).toBe(99);
      expectLinearRebuild(ops, result);
    });

    test('rebuild work scales with dependent elements, not total elements', () => {
      // Create 500 elements with mixed dependency patterns
      for (let i = 0; i < 500; i++) {
        const elementId = `el-rebuild500-${i}`;
        createTestElement(db, elementId, 'task', 'open', testEntity);
      }

      // Create chain dependencies (every 5th element blocks the previous)
      for (let i = 5; i < 500; i += 5) {
        db.run(
          `INSERT INTO dependencies (blocked_id, blocker_id, type, created_at, created_by, metadata)
           VALUES (?, ?, ?, ?, ?, null)`,
          [`el-rebuild500-${i - 5}`, `el-rebuild500-${i}`, DependencyType.BLOCKS, new Date().toISOString(), testEntity]
        );
      }

      const { result, ops } = recordStorageOps(db, () => cacheService.rebuild());

      expect(result.elementsChecked).toBe(99); // 100 elements with dependencies
      // Bounded by the 99 checked elements; the other 400 elements are never read
      expectLinearRebuild(ops, result);
    });

    test('rebuild handles parent-child hierarchies efficiently', () => {
      // Create a hierarchy: 10 plans, each with 10 tasks
      for (let plan = 0; plan < 10; plan++) {
        const planId = `el-plan-${plan}`;
        createTestElement(db, planId, 'plan', 'active', testEntity);

        for (let task = 0; task < 10; task++) {
          const taskId = `el-plan${plan}-task${task}`;
          createTestElement(db, taskId, 'task', 'open', testEntity);

          // Task is child of plan
          db.run(
            `INSERT INTO dependencies (blocked_id, blocker_id, type, created_at, created_by, metadata)
             VALUES (?, ?, ?, ?, ?, null)`,
            [taskId, planId, DependencyType.PARENT_CHILD, new Date().toISOString(), testEntity]
          );
        }
      }

      const { result, ops } = recordStorageOps(db, () => cacheService.rebuild());

      expect(result.elementsChecked).toBe(100); // 100 tasks
      expect(result.elementsBlocked).toBe(0); // plans do not block their tasks
      expectLinearRebuild(ops, result);
    });
  });

  // ==========================================================================
  // Cache Query Performance
  // ==========================================================================

  describe('Cache Queries', () => {
    test('isBlocked query is O(1)', () => {
      // Create elements and populate cache
      for (let i = 0; i < 100; i++) {
        const elementId = `el-query-${i}`;
        createTestElement(db, elementId, 'task', 'open', testEntity);
        if (i % 2 === 0) {
          cacheService.addBlocked(
            elementId as ElementId,
            'el-blocker' as ElementId,
            `Blocked by test ${i}`
          );
        }
      }

      const { ops } = recordStorageOps(db, () => {
        for (let i = 0; i < 100; i++) {
          cacheService.isBlocked(`el-query-${i}` as ElementId);
        }
      });

      // Exactly one point read per call, returning at most its own row:
      // 50 blocked hits, 50 misses, never the rest of the cache.
      expect(ops.reads).toBe(100);
      expect(ops.rowsRead).toBe(50);
      expect(ops.writes).toBe(0);
      // ...and that read is a primary-key search, not a scan of blocked_cache
      expectIndexedAccess(db, ops.readSql[0], ['el-query-0'], 'blocked_cache', 'element_id');
    });

    test('getAllBlocked scales linearly with blocked count', () => {
      // Create 200 elements, half blocked
      for (let i = 0; i < 200; i++) {
        const elementId = `el-all-${i}`;
        createTestElement(db, elementId, 'task', 'open', testEntity);
        if (i < 100) {
          cacheService.addBlocked(
            elementId as ElementId,
            'el-blocker' as ElementId,
            `Blocked ${i}`
          );
        }
      }

      const { result: blocked, ops } = recordStorageOps(db, () => cacheService.getAllBlocked());

      expect(blocked).toHaveLength(100);
      // A single read of exactly the blocked rows (no per-row follow-up queries)
      expect(ops.reads).toBe(1);
      expect(ops.rowsRead).toBe(100);
    });

    test('getBlockedBy scales with count', () => {
      // Create 100 elements blocked by same blocker
      const blocker = 'el-main-blocker' as ElementId;
      for (let i = 0; i < 100; i++) {
        const elementId = `el-by-${i}`;
        createTestElement(db, elementId, 'task', 'open', testEntity);
        cacheService.addBlocked(elementId as ElementId, blocker, `Blocked ${i}`);
      }
      // And 100 blocked by another blocker, which must not be returned to JS
      for (let i = 0; i < 100; i++) {
        const elementId = `el-other-${i}`;
        createTestElement(db, elementId, 'task', 'open', testEntity);
        cacheService.addBlocked(elementId as ElementId, 'el-other-blocker' as ElementId, `Other ${i}`);
      }

      const { result: blocked, ops } = recordStorageOps(db, () => cacheService.getBlockedBy(blocker));

      expect(blocked).toHaveLength(100);
      // Filtered in SQL: one read returning only the matching rows
      expect(ops.reads).toBe(1);
      expect(ops.rowsRead).toBe(100);
    });
  });

  // ==========================================================================
  // Incremental Update Performance
  // ==========================================================================

  describe('Incremental Updates', () => {
    test('addBlocked is O(1)', () => {
      // Pre-create elements
      for (let i = 0; i < 100; i++) {
        createTestElement(db, `el-inc-${i}`, 'task', 'open', testEntity);
      }

      const { ops } = recordStorageOps(db, () => {
        for (let i = 0; i < 100; i++) {
          cacheService.addBlocked(
            `el-inc-${i}` as ElementId,
            'el-blocker' as ElementId,
            `Reason ${i}`
          );
        }
      });

      // One upsert per call, no reads: cost does not grow with cache size
      expect(ops.writes).toBe(100);
      expect(ops.reads).toBe(0);
      expect(cacheService.count()).toBe(100);
    });

    test('removeBlocked is O(1)', () => {
      // Create and block elements
      for (let i = 0; i < 100; i++) {
        const elementId = `el-rem-${i}`;
        createTestElement(db, elementId, 'task', 'open', testEntity);
        cacheService.addBlocked(
          elementId as ElementId,
          'el-blocker' as ElementId,
          `Reason ${i}`
        );
      }

      const { ops } = recordStorageOps(db, () => {
        for (let i = 0; i < 100; i++) {
          cacheService.removeBlocked(`el-rem-${i}` as ElementId);
        }
      });

      // One delete per call, no reads...
      expect(ops.writes).toBe(100);
      expect(ops.reads).toBe(0);
      expect(cacheService.count()).toBe(0);
      // ...located by primary-key search rather than a scan of blocked_cache
      expectIndexedAccess(db, ops.writeSql[0], ['el-rem-0'], 'blocked_cache', 'element_id');
    });
  });
});

describe('Combined Operations Performance', () => {
  let db: StorageBackend;
  let depService: DependencyService;
  let cacheService: BlockedCacheService;
  const testEntity = 'en-combined' as EntityId;

  beforeEach(() => {
    db = createStorage({ path: ':memory:' });
    initializeSchema(db);
    depService = createDependencyService(db);
    cacheService = createBlockedCacheService(db);
  });

  afterEach(() => {
    db.close();
  });

  test('workflow: create graph, rebuild cache, query', () => {
    // Create a realistic dependency graph
    // 50 tasks with various blocking relationships
    for (let i = 0; i < 50; i++) {
      createTestElement(db, `el-wf-${i}`, 'task', 'open', testEntity);
    }

    // Create dependency chains
    for (let i = 1; i < 50; i++) {
      if (i % 3 === 0) {
        // Every 3rd task blocks previous
        db.run(
          `INSERT INTO dependencies (blocked_id, blocker_id, type, created_at, created_by, metadata)
           VALUES (?, ?, ?, ?, ?, null)`,
          [`el-wf-${i - 1}`, `el-wf-${i}`, DependencyType.BLOCKS, new Date().toISOString(), testEntity]
        );
      }
    }

    // Rebuild cache
    const { result: rebuildResult, ops: rebuildOps } = recordStorageOps(db, () =>
      cacheService.rebuild()
    );
    expect(rebuildResult.elementsChecked).toBe(16);
    expect(rebuildResult.elementsBlocked).toBe(16);
    expect(rebuildOps.reads).toBeLessThanOrEqual(
      REBUILD_BOUNDS.fixedReads + REBUILD_BOUNDS.readsPerElement * rebuildResult.elementsChecked
    );
    expect(rebuildOps.rowsRead).toBeLessThanOrEqual(
      REBUILD_BOUNDS.rowsPerElement * rebuildResult.elementsChecked
    );

    // Query blocked and non-blocked
    const { result: blocked, ops: queryOps } = recordStorageOps(db, () => {
      const all = cacheService.getAllBlocked();
      // Check individual elements
      for (let i = 0; i < 50; i++) {
        cacheService.isBlocked(`el-wf-${i}` as ElementId);
      }
      return all;
    });

    expect(blocked).toHaveLength(rebuildResult.elementsBlocked);
    // One list read plus one point read per element; each blocked row is
    // returned once by the list and once by its own point lookup.
    expect(queryOps.reads).toBe(1 + 50);
    expect(queryOps.rowsRead).toBe(2 * rebuildResult.elementsBlocked);
  });

  test('stress: many dependencies between few elements', () => {
    // Create 10 elements with many dependency types between them
    const elements: ElementId[] = [];
    for (let i = 0; i < 10; i++) {
      const id = `el-stress-${i}` as ElementId;
      elements.push(id);
      createTestElement(db, id, 'task', 'open', testEntity);
    }

    // Add many non-blocking dependencies (should be fast)
    const nonBlockingTypes = [
      DependencyType.REFERENCES,
      DependencyType.RELATES_TO,
      DependencyType.CAUSED_BY,
    ];

    let depCount = 0;
    const { ops } = recordStorageOps(db, () => {
      for (let i = 0; i < elements.length; i++) {
        for (let j = i + 1; j < elements.length; j++) {
          for (const type of nonBlockingTypes) {
            try {
              depService.addDependency({
                blockedId: elements[i],
                blockerId: elements[j],
                type,
                createdBy: testEntity,
              });
              depCount++;
            } catch {
              // Ignore duplicates for relates-to
            }
          }
        }
      }
    });

    // Non-blocking types skip cycle detection: every add is a single INSERT
    // with no graph reads at all.
    expect(depCount).toBe(45 * nonBlockingTypes.length);
    expect(ops.reads).toBe(0);
    expect(ops.writes).toBe(depCount);
  });
});

// ============================================================================
// Benchmark Summary
// ============================================================================

describe('Performance Summary', () => {
  test('documents performance characteristics', () => {
    // This test documents expected performance characteristics
    // based on the dependency system specification

    const characteristics = {
      cycleDetection: {
        algorithm: 'BFS traversal from target to source',
        complexity: 'O(V + E) where V=vertices, E=edges',
        depthLimit: DEFAULT_CYCLE_DETECTION_CONFIG.maxDepth,
        optimizations: [
          'Non-blocking types skip traversal entirely',
          'Visited set prevents re-traversing nodes',
          'Depth limit prevents infinite loops',
        ],
      },
      blockedCache: {
        purpose: '~25x speedup on large datasets',
        readComplexity: 'O(1) for single element lookup',
        writeComplexity: 'O(1) for add/remove',
        rebuildComplexity: 'O(n * d) where n=elements, d=avg dependency depth',
        optimizations: [
          'Topological sort for transitive blocking',
          'Single table scan for ready queries',
          'Incremental updates avoid full rebuild',
        ],
      },
      rebuildBounds: REBUILD_BOUNDS,
    };

    expect(characteristics.cycleDetection.depthLimit).toBe(100);
    expect(characteristics.blockedCache.readComplexity).toBe('O(1) for single element lookup');
  });
});
