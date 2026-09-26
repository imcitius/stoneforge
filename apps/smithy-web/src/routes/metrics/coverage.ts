import type { AggregatedProviderMetrics, ProviderTimeSeriesPoint, UsageCoverage } from '../../api/types';

export type MetricStatus = 'available' | 'partial' | 'unavailable' | 'unknown';

/** Missing additive fields from an older server are unverified, never measured zero. */
export function summarizeUsage(records: UsageCoverage[]) {
  const sessionCount = records.reduce((s, m) => s + m.sessionCount, 0);
  const usageSessionCount = records.reduce((s, m) => s + (m.usageSessionCount ?? 0), 0);
  const legacySessionCount = records.reduce((s, m) => s + (m.legacySessionCount ?? m.sessionCount), 0);
  const usageStatus: MetricStatus = sessionCount > 0 && usageSessionCount === sessionCount ? 'available'
    : usageSessionCount > 0 ? 'partial' : legacySessionCount > 0 ? 'unknown' : 'unavailable';
  return { sessionCount, usageSessionCount, legacySessionCount, usageStatus };
}

export function summarizeMetrics(records: AggregatedProviderMetrics[]) {
  const usage = summarizeUsage(records);
  const totalInputTokens = records.reduce((s, m) => s + m.totalInputTokens, 0);
  const totalOutputTokens = records.reduce((s, m) => s + m.totalOutputTokens, 0);
  const totalCacheReadTokens = records.reduce((s, m) => s + m.totalCacheReadTokens, 0);
  const totalCacheCreationTokens = records.reduce((s, m) => s + m.totalCacheCreationTokens, 0);
  const pricedRecords = records.filter(m => m.estimatedCost &&
    (m.estimatedCostStatus === 'available' || m.estimatedCostStatus === 'partial'));
  const pricedSessionCount = pricedRecords.reduce((s, m) => s + (m.pricedSessionCount ?? 0), 0);
  const estimatedCostStatus: MetricStatus = usage.sessionCount > 0 && pricedSessionCount === usage.sessionCount
    ? 'available' : pricedSessionCount > 0 ? 'partial'
      : records.some(m => !m.estimatedCostStatus || !m.estimatedCost) ? 'unknown' : 'unavailable';
  return {
    ...usage, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheCreationTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    estimatedCost: pricedRecords.reduce((s, m) => s + (m.estimatedCost?.totalCost ?? 0), 0),
    estimatedCostStatus, pricedSessionCount,
    cacheHitRate: totalInputTokens > 0 ? Math.round(totalCacheReadTokens / totalInputTokens * 100) : 0,
  };
}

export function metricValue(value: string, status: MetricStatus | undefined, kind = 'recorded'): string {
  if (status === 'available') return value;
  if (status === 'partial') return `${value} (partial; ${kind}${kind === 'recorded ratio' ? '' : ' subtotal'})`;
  return status ?? 'unknown';
}

export function usageCoverageText(m: UsageCoverage): string {
  return `Usage observed: ${m.usageSessionCount ?? 'unknown'}/${m.sessionCount} metric records; legacy unknown: ${m.legacySessionCount ?? 'unknown'}`;
}

/** Keep unavailable buckets as gaps; dropping them would connect unrelated observations. */
export function tokenTrend(series: ProviderTimeSeriesPoint[], days: number) {
  const buckets = new Map<string, ProviderTimeSeriesPoint[]>();
  for (const point of series) buckets.set(point.bucket, [...(buckets.get(point.bucket) ?? []), point]);
  return Array.from(buckets.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([bucket, points]) => {
    const { usageStatus } = summarizeUsage(points);
    const total = points.reduce((s, p) => s + p.totalInputTokens + p.totalOutputTokens, 0);
    const date = new Date(bucket);
    return {
      label: date.toLocaleDateString('en-US', days <= 7 ? { weekday: 'short' } : { month: 'short', day: 'numeric' }),
      value: usageStatus === 'available' || usageStatus === 'partial' ? total : null,
      valueLabel: metricValue(`${total.toLocaleString('en-US')} tokens`, usageStatus),
      date: bucket,
    };
  });
}
