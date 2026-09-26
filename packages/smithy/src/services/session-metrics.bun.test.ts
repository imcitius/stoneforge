import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createStorage, initializeSchema, MIGRATIONS, type StorageBackend } from '@stoneforge/storage';
import type { EntityId } from '@stoneforge/core';
import type { AgentMessage, AgentProvider } from '../providers/types.js';
import { AsyncQueue } from '../providers/opencode/async-queue.js';
import { CodexEventMapper } from '../providers/codex/event-mapper.js';
import { SpawnerServiceImpl } from '../runtime/spawner.js';
import { createMetricsRoutes } from '../server/routes/metrics.js';
import { createSessionMessageService } from '../server/services/session-messages.js';
import type { Services } from '../server/services.js';
import { createCostService } from './cost-service.js';
import { createMetricsService } from './metrics-service.js';
import { SessionMetricsTracker } from './session-metrics.js';

// Shape verified with local codex-cli 0.157.0 generate-json-schema (no model call).
function notification(input: number, output: number, cached = 0, threadId = 'thread-1') {
  return { method: 'thread/tokenUsage/updated', params: { threadId, turnId: 'turn-1', tokenUsage: {
    total: { inputTokens: input, outputTokens: output, cachedInputTokens: cached,
      reasoningOutputTokens: 2, totalTokens: input + output },
    last: { inputTokens: input, outputTokens: output, cachedInputTokens: cached,
      reasoningOutputTokens: 2, totalTokens: input + output },
  } } };
}

describe('session metrics ingestion and API', () => {
  let storage: StorageBackend;
  beforeEach(() => { storage = createStorage({ path: ':memory:' }); initializeSchema(storage); });
  afterEach(() => storage.close());

  function record(id: string, tracker: SessionMetricsTracker) {
    createMetricsService(storage).upsert({ ...tracker.snapshot(), sessionId: id, durationMs: 100, outcome: 'completed' });
    createSessionMessageService(storage).saveMessage({ id: `${id}-message`, sessionId: id,
      agentId: 'el-worker' as EntityId, type: 'assistant', isError: false });
  }

  async function metrics(query: string) {
    const app = createMetricsRoutes({ metricsService: createMetricsService(storage),
      costService: createCostService(storage) } as Services);
    const response = await app.request(`/api/provider-metrics?${query}`);
    expect(response.status).toBe(200);
    return response.json();
  }

  test('missing usage, measured zero, and partial coverage remain distinct in every grouping', async () => {
    const missing = new SessionMetricsTracker('claude-code', 'claude-sonnet-4');
    record('missing', missing);
    const zero = new SessionMetricsTracker('claude-code', 'claude-sonnet-4');
    zero.observe({ type: 'result', raw: { usage: { input_tokens: 0, output_tokens: 0 } } });
    record('zero', zero);
    const unavailable = (await metrics('sessionId=missing')).metrics[0];
    expect(unavailable).toMatchObject({ totalTokens: 0, usageStatus: 'unavailable',
      estimatedCostStatus: 'unavailable', pricedSessionCount: 0 });
    expect((await metrics('sessionId=zero')).metrics[0]).toMatchObject({ totalTokens: 0,
      usageStatus: 'available', estimatedCostStatus: 'available', pricedSessionCount: 1 });
    for (const groupBy of ['provider', 'model', 'agent']) {
      const body = await metrics(`groupBy=${groupBy}&includeSeries=true`);
      expect(body.metrics[0]).toMatchObject({ sessionCount: 2, usageStatus: 'partial',
        usageSessionCount: 1, estimatedCostStatus: 'partial', pricedSessionCount: 1 });
      if (groupBy !== 'agent') expect(body.timeSeries[0]).toMatchObject({ usageStatus: 'partial', usageSessionCount: 1 });
    }
    // Late usage replaces missing coverage; later missing updates cannot erase it.
    record('missing', zero);
    record('missing', missing);
    expect((await metrics('sessionId=missing')).metrics[0].usageStatus).toBe('available');
  });

  test('Codex cumulative events are filtered, not double-counted, and never priced as Sonnet', async () => {
    const tracker = new SessionMetricsTracker('codex', 'gpt-6-astra');
    const mapper = new CodexEventMapper();
    expect(mapper.mapNotification(notification(500, 20, 100, 'other'), 'thread-1')).toEqual([]);
    expect(mapper.mapNotification(notification(-1, 20), 'thread-1')).toEqual([]);
    expect(mapper.mapNotification(notification(10, 20, 11), 'thread-1')).toEqual([]);
    for (const n of [notification(100, 10, 80), notification(100, 10, 80), notification(150, 20, 100)]) {
      for (const event of mapper.mapNotification(n, 'thread-1')) tracker.observe(event as Parameters<SessionMetricsTracker['observe']>[0]);
      record('codex', tracker);
    }
    expect((await metrics('groupBy=provider')).metrics[0]).toMatchObject({ group: 'codex',
      totalInputTokens: 50, totalOutputTokens: 20, totalCacheReadTokens: 100,
      usageStatus: 'available', estimatedCostStatus: 'unavailable', pricedSessionCount: 0 });
    expect((await metrics('groupBy=model')).metrics[0].group).toBe('gpt-6-astra');
    // Thread lifetime totals on resume must not be charged to a new spawn.
    expect(new CodexEventMapper(false).mapNotification(notification(9000, 400), 'thread-1')).toEqual([]);
  });

  test('Claude SDK usage survives the real spawner, including tool-only blocks and deduplication', async () => {
    const queue = new AsyncQueue<AgentMessage>();
    const provider: AgentProvider = {
      name: 'claude-code',
      headless: { name: 'fixture', async isAvailable() { return true; }, async spawn() {
        return { sendMessage() {}, async interrupt() {}, close() { queue.close(); },
          [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator]() };
      } },
      interactive: { name: 'unused', async isAvailable() { return false; }, async spawn() { throw new Error('unused'); } },
      async isAvailable() { return true; }, getInstallInstructions() { return ''; }, async listModels() { return []; },
    };
    queue.push({ type: 'system', subtype: 'init', sessionId: 'claude-thread', raw: { model: 'claude-sonnet-4' } });
    const spawner = new SpawnerServiceImpl({ provider, workingDirectory: '/tmp', timeout: 1000 });
    const { session, events } = await spawner.spawn('el-worker' as EntityId, 'worker', { model: 'requested-model' });
    expect(session).toMatchObject({ provider: 'claude-code', model: 'claude-sonnet-4' });
    const tracker = new SessionMetricsTracker(session.provider!, session.model);
    events.on('event', event => { tracker.observe(event); record(session.id, tracker); });
    const exited = new Promise(resolve => events.once('exit', resolve));
    const raw = { message: { id: 'msg-1', model: 'claude-sonnet-4',
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 } } };
    queue.push({ type: 'tool_use', tool: { name: 'Read' }, raw });
    queue.push({ type: 'assistant', content: 'text from the same SDK message', raw });
    queue.push({ type: 'result', raw: { usage: { input_tokens: 100, output_tokens: 20 },
      modelUsage: { 'claude-sonnet-4': { cacheReadInputTokens: 30, cacheCreationInputTokens: 10 } } } });
    await exited;
    for (const query of [`sessionId=${session.id}`, 'groupBy=provider', 'groupBy=model', 'groupBy=agent']) {
      const metric = (await metrics(query)).metrics[0];
      expect(metric).toMatchObject({ totalInputTokens: 100, totalOutputTokens: 20,
        totalCacheReadTokens: 30, totalCacheCreationTokens: 10, usageStatus: 'available', estimatedCostStatus: 'available' });
      expect(metric.estimatedCost.totalCost).toBeGreaterThan(0);
    }
  });

  test('does not price a multi-model Claude session using only its first model', async () => {
    const tracker = new SessionMetricsTracker('claude-code', 'claude-sonnet-4');
    tracker.observe({ type: 'assistant', raw: { message: { id: 'first', model: 'claude-sonnet-4',
      usage: { input_tokens: 100, output_tokens: 10 } } } });
    record('multiple-models', tracker);
    tracker.observe({ type: 'result', raw: { usage: { input_tokens: 200, output_tokens: 20 },
      modelUsage: { 'claude-sonnet-4': {}, 'claude-opus-4': {} } } });
    record('multiple-models', tracker);
    expect((await metrics('groupBy=model')).metrics[0]).toMatchObject({ group: 'unknown',
      totalInputTokens: 200, estimatedCostStatus: 'unavailable', usageStatus: 'available' });
  });

  test('cost aggregation includes only observed, priced usage within the requested range', async () => {
    const known = new SessionMetricsTracker('claude-code', 'claude-sonnet-4');
    known.observe({ type: 'result', raw: { usage: { input_tokens: 100, output_tokens: 10 } } });
    record('known', known);
    const knownCost = (await metrics('sessionId=known')).metrics[0].estimatedCost;
    const unknown = new SessionMetricsTracker('claude-code', 'unpriced-model');
    unknown.observe({ type: 'result', raw: { usage: { input_tokens: 900, output_tokens: 90 } } });
    record('unknown-price', unknown);
    record('old', known);
    storage.run("UPDATE provider_metrics SET timestamp = '2000-01-01T00:00:00.000Z' WHERE session_id = 'old'");
    for (const groupBy of ['provider', 'agent']) {
      const metric = (await metrics(`groupBy=${groupBy}`)).metrics[0];
      expect(metric).toMatchObject({ sessionCount: 2, totalInputTokens: 1000,
        usageStatus: 'available', estimatedCostStatus: 'partial', pricedSessionCount: 1 });
      expect(metric.estimatedCost).toEqual(knownCost);
    }
    expect((await metrics('sessionId=old')).metrics[0].estimatedCost).toEqual(knownCost);
  });

  test('migration leaves historical attribution and counters intact with unknown availability', async () => {
    const legacy = createStorage({ path: ':memory:' });
    try {
      legacy.migrate(MIGRATIONS.filter(m => m.version <= 12));
      legacy.run(`INSERT INTO provider_metrics (id,timestamp,provider,session_id,input_tokens,output_tokens,outcome)
        VALUES ('old',?,'claude-code','historical',0,0,'completed')`, [new Date().toISOString()]);
      const before = legacy.query('SELECT * FROM provider_metrics')[0];
      initializeSchema(legacy);
      const after = legacy.query('SELECT * FROM provider_metrics')[0];
      expect(after).toEqual({ ...before, usage_available: null });
      const metrics = createMetricsService(legacy).aggregateByProvider({ days: 7 });
      expect(metrics[0]).toMatchObject({ group: 'claude-code', usageStatus: 'unknown', legacySessionCount: 1, usageSessionCount: 0 });
      expect(createCostService(legacy).enrichWithCosts(metrics, 'provider')[0].estimatedCostStatus).toBe('unavailable');
    } finally { legacy.close(); }
  });
});
