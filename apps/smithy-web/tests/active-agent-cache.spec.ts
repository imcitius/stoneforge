import { test, expect } from '@playwright/test';
import type { AggregatedProviderMetrics } from '../src/api/types';

function metric(overrides: Partial<AggregatedProviderMetrics> = {}): AggregatedProviderMetrics {
  const row = {
    group: 'fixture', totalInputTokens: 900, totalOutputTokens: 20,
    totalCacheReadTokens: 100, totalCacheCreationTokens: 0, totalTokens: 920,
    sessionCount: 1, avgDurationMs: 1000, errorRate: 0, failedCount: 0, rateLimitedCount: 0,
    usageStatus: 'available' as const, usageSessionCount: 1, legacySessionCount: 0,
    estimatedCost: { totalCost: 0.03, inputCost: 0.03, outputCost: 0, cacheReadCost: 0, cacheCreationCost: 0 },
    ...overrides,
  };
  row.totalTokens = row.totalInputTokens + row.totalOutputTokens;
  return row;
}

const cases = [
  { name: 'below 10 percent (old denominator falsely high)', row: metric({ totalInputTokens: 910 }), high: false },
  { name: 'exactly 10 percent', row: metric(), high: false },
  { name: 'above 10 percent', row: metric({ totalInputTokens: 890 }), high: true },
  { name: 'all cache with zero uncached and output', row: metric({ totalInputTokens: 0, totalOutputTokens: 0 }), high: true },
  { name: 'creation lowers rate to 10 percent', row: metric({ totalInputTokens: 100, totalCacheCreationTokens: 800 }), high: false },
  { name: 'creation with rate above 10 percent', row: metric({ totalInputTokens: 100, totalCacheCreationTokens: 799 }), high: true },
  { name: 'cache creation only', row: metric({ totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheCreationTokens: 100 }), high: false },
  { name: 'measured empty', row: metric({ totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, estimatedCost: undefined }), high: false },
  { name: 'measured zero cache', row: metric({ totalCacheReadTokens: 0 }), high: false },
  { name: 'output excluded from denominator', row: metric({ totalInputTokens: 0, totalOutputTokens: 10000 }), high: true },
  { name: 'compact display and full tooltip', row: metric({ totalInputTokens: 1200, totalOutputTokens: 15000, totalCacheReadTokens: 400, totalCacheCreationTokens: 30 }), high: true },
  { name: 'legacy unknown nonzero', row: metric({ totalInputTokens: 1, usageStatus: 'unknown', usageSessionCount: 0, legacySessionCount: 1 }), high: false },
  { name: 'old server missing coverage', row: metric({ totalInputTokens: 1, usageStatus: undefined, usageSessionCount: undefined, legacySessionCount: undefined }), high: false },
  { name: 'partial coverage without legacy', row: metric({ totalInputTokens: 1, usageStatus: 'partial', sessionCount: 2 }), high: false },
  { name: 'partial coverage with legacy', row: metric({ totalInputTokens: 1, usageStatus: 'partial', sessionCount: 2, legacySessionCount: 1 }), high: false },
  { name: 'unsupported usage', row: metric({ totalInputTokens: 1, usageStatus: 'unavailable', usageSessionCount: 0 }), high: false },
  { name: 'unavailable zero is not measured zero', row: metric({ totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, usageStatus: 'unavailable', usageSessionCount: 0 }), high: false, hidden: true },
  { name: 'unknown zero is not measured zero', row: metric({ totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, usageStatus: undefined, usageSessionCount: undefined, legacySessionCount: undefined }), high: false, hidden: true },
];

for (const scenario of cases) {
  test(scenario.name, async ({ page }, testInfo) => {
    const errors: string[] = [];
    const sessions = new Set<string>();
    page.on('pageerror', error => errors.push(error.message));
    await page.route(url => url.pathname.startsWith('/api/'), route => {
      const url = new URL(route.request().url());
      expect(url.pathname).toBe('/api/provider-metrics');
      const session = url.searchParams.get('sessionId')!;
      expect(['session-interactive', 'session-headless']).toContain(session);
      sessions.add(session);
      return route.fulfill({ json: { timeRange: { days: 7, label: '7d' }, groupBy: 'session', metrics: [scenario.row] } });
    });
    await page.goto('/tests/fixtures/active-agent.html');
    // Let both real query hooks finish rendering, including tests of absent content.
    await expect.poll(() => sessions.size).toBe(2);
    await expect(page.getByTestId('fixture-query-status')).toHaveText('settled');
    await expect.poll(() => page.evaluate(() => document.querySelectorAll('[data-testid="agent-card-token-usage"]').length))
      .toBe(scenario.hidden ? 0 : 2);
    for (const variant of ['interactive', 'headless']) {
      const card = page.getByTestId(`active-agent-card-agent-${variant}`);
      await expect(card).toBeVisible();
      const usage = card.getByTestId('agent-card-token-usage');
      if (scenario.hidden) {
        await expect(usage).toHaveCount(0);
        continue;
      }
      await expect(usage.getByTitle('High cache hit rate', { exact: true })).toHaveCount(scenario.high ? 1 : 0);
      const row = scenario.row;
      // Existing display/tooltip is intentionally uncached input plus output.
      const display = scenario.name === 'compact display and full tooltip' ? '1.2k in / 15k out'
        : `${row.totalInputTokens} in / ${row.totalOutputTokens === 10000 ? '10k' : row.totalOutputTokens} out`;
      await expect(usage).toHaveText(`${display}${scenario.high ? '⚡' : ''}`);
      const parts = [`Input: ${row.totalInputTokens.toLocaleString('en-US')}`, `Output: ${row.totalOutputTokens.toLocaleString('en-US')}`];
      if (row.totalCacheReadTokens > 0) parts.push(`Cache Read: ${row.totalCacheReadTokens.toLocaleString('en-US')}`);
      if (row.totalCacheCreationTokens > 0) parts.push(`Cache Creation: ${row.totalCacheCreationTokens.toLocaleString('en-US')}`);
      if (row.estimatedCost) parts.push('Est. Cost: $0.03');
      await expect(usage).toHaveAttribute('title', parts.join(' | '));
    }
    expect(errors).toEqual([]);
    if (scenario.name === 'all cache with zero uncached and output' || scenario.name === 'measured empty') {
      await page.screenshot({ path: testInfo.outputPath('cards.png') });
    }
  });
}
