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
