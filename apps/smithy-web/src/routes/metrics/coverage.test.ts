import { describe, expect, test } from 'vitest';
import { summarizeMetrics, tokenTrend } from './coverage';
import type { AggregatedProviderMetrics, ProviderTimeSeriesPoint } from '../../api/types';

const observed: AggregatedProviderMetrics = {
  group: 'known', sessionCount: 1, totalInputTokens: 100, totalOutputTokens: 10,
  totalCacheReadTokens: 5, totalCacheCreationTokens: 2, totalTokens: 110,
  avgDurationMs: 0, errorRate: 0, failedCount: 0, rateLimitedCount: 0,
  usageStatus: 'available', usageSessionCount: 1, legacySessionCount: 0,
  estimatedCostStatus: 'available', pricedSessionCount: 1,
  estimatedCost: { totalCost: 0.01, inputCost: 0.01, outputCost: 0, cacheReadCost: 0, cacheCreationCost: 0 },
};

describe('metrics coverage across groups', () => {
  test('old-server numeric costs are not added to a priced subtotal', () => {
    const legacy = { ...observed, usageStatus: undefined, usageSessionCount: undefined,
      legacySessionCount: undefined, estimatedCostStatus: undefined, pricedSessionCount: undefined,
      estimatedCost: { ...observed.estimatedCost!, totalCost: 999 } };
    expect(summarizeMetrics([observed, legacy])).toMatchObject({
      sessionCount: 2, usageSessionCount: 1, legacySessionCount: 1, usageStatus: 'partial',
      estimatedCost: 0.01, estimatedCostStatus: 'partial', pricedSessionCount: 1,
      totalInputTokens: 200, totalOutputTokens: 20,
    });
    expect(legacy.estimatedCost.totalCost).toBe(999);
  });

  test('missing cost breakdown is unknown even if an inconsistent count claims pricing', () => {
    expect(summarizeMetrics([{ ...observed, estimatedCost: undefined }]))
      .toMatchObject({ estimatedCostStatus: 'unknown', pricedSessionCount: 0 });
  });

  test('aggregates coverage per bucket and retains unavailable and legacy gaps', () => {
    const point = (bucket: string, overrides: Partial<ProviderTimeSeriesPoint> = {}): ProviderTimeSeriesPoint =>
      ({ ...observed, bucket, ...overrides });
    const result = tokenTrend([
      point('2026-09-23', { totalInputTokens: 0, totalOutputTokens: 0 }),
      point('2026-09-24', { usageStatus: 'unavailable', usageSessionCount: 0 }),
      point('2026-09-25', { usageStatus: 'unknown', usageSessionCount: 0, legacySessionCount: 1 }),
      point('2026-09-26'),
      point('2026-09-26', { group: 'missing', usageStatus: 'unavailable', usageSessionCount: 0,
        totalInputTokens: 0, totalOutputTokens: 0 }),
    ], 7);
    expect(result.map(p => p.value)).toEqual([0, null, null, 110]);
    expect(result.map(p => p.valueLabel)).toEqual([
      '0 tokens', 'unavailable', 'unknown', '110 tokens (partial; recorded subtotal)',
    ]);
  });
});


describe('cache hit rate uses all disjoint input categories', () => {
  const row = (input: number, read: number, creation = 0): AggregatedProviderMetrics => ({
    ...observed, totalInputTokens: input, totalCacheReadTokens: read, totalCacheCreationTokens: creation,
  });

  test.each([
    ['Codex 80 cached of 100 total input', 20, 80, 0, 80],
    ['all cache', 0, 100, 0, 100],
    ['uncached only', 100, 0, 0, 0],
    ['cache creation is input, not a hit', 20, 60, 20, 60],
    ['cache creation only', 0, 0, 100, 0],
    ['measured empty denominator', 0, 0, 0, null],
  ])('%s', (_name, input, read, creation, rate) => {
    const result = summarizeMetrics([row(input, read, creation)]);
    expect(result.cacheHitRate).toBe(rate);
    // Existing public totals still exclude the separate cache categories.
    expect(result.totalInputTokens).toBe(input);
    expect(result.totalTokens).toBe(input + observed.totalOutputTokens);
  });

  test('weights mixed groups by input tokens, rounds only after summing', () => {
    expect(summarizeMetrics([row(20, 80), row(900, 0)]).cacheHitRate).toBe(8);
    expect(summarizeMetrics([row(1, 1, 1), row(0, 1)]).cacheHitRate).toBe(50);
  });

  test('partial observed usage without legacy remains a labelled ratio', () => {
    const partial = { ...row(20, 80), usageStatus: 'partial' as const,
      sessionCount: 2, usageSessionCount: 1 };
    expect(summarizeMetrics([partial])).toMatchObject({ cacheHitRate: 80, cacheHitRateStatus: 'partial' });
  });

  test('legacy or old-server values cannot yield a precise ratio, even in a mixed aggregate', () => {
    const legacy = { ...row(100, 80), usageStatus: 'unknown' as const,
      usageSessionCount: 0, legacySessionCount: 1 };
    const oldServer = { ...row(100, 80), usageStatus: undefined,
      usageSessionCount: undefined, legacySessionCount: undefined };
    const partialLegacy = { ...row(120, 160), usageStatus: 'partial' as const,
      sessionCount: 2, usageSessionCount: 1, legacySessionCount: 1 };
    for (const records of [[legacy], [oldServer], [row(20, 80), legacy], [partialLegacy]]) {
      expect(summarizeMetrics(records)).toMatchObject({ cacheHitRate: null, cacheHitRateStatus: 'unknown' });
    }
    expect(summarizeMetrics([row(20, 80), legacy]).totalInputTokens).toBe(120);
    expect(legacy.totalCacheReadTokens).toBe(80);
  });

  test('missing observations and empty responses are unavailable, not zero percent', () => {
    for (const records of [[], [{ ...row(0, 0), usageStatus: 'unavailable' as const, usageSessionCount: 0 }]]) {
      expect(summarizeMetrics(records)).toMatchObject({ cacheHitRate: null, cacheHitRateStatus: 'unavailable' });
    }
  });
});
