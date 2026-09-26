import { test, expect, type Page } from '@playwright/test';
import type { AggregatedProviderMetrics, ProviderTimeSeriesPoint } from '../src/api/types';

function metric(overrides: Partial<AggregatedProviderMetrics> = {}): AggregatedProviderMetrics {
  return { group: 'fixture-model', totalInputTokens: 0, totalOutputTokens: 0,
    totalCacheReadTokens: 0, totalCacheCreationTokens: 0, totalTokens: 0,
    sessionCount: 1, avgDurationMs: 1000, errorRate: 0, failedCount: 0, rateLimitedCount: 0,
    usageStatus: 'available', usageSessionCount: 1, legacySessionCount: 0,
    pricedSessionCount: 1, estimatedCostStatus: 'available',
    estimatedCost: { totalCost: 0, inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheCreationCost: 0 },
    ...overrides };
}

async function open(page: Page, metrics: AggregatedProviderMetrics[], series?: ProviderTimeSeriesPoint[], status = 200) {
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/provider-metrics') {
      return route.fulfill({ status, json: status === 200 ? {
        timeRange: { days: 7, label: '7d' }, groupBy: url.searchParams.get('groupBy'), metrics,
        timeSeries: series ?? metrics.map(m => ({ ...m, bucket: '2026-09-26T00:00:00Z' })),
      } : { error: { message: 'Fixture unavailable' } } });
    }
    return route.fulfill({ json: { tasks: [], agents: [], plans: [], elements: [],
      mergeRequests: [], counts: { needsReview: 0, testing: 0, conflicts: 0, merged: 0 } } });
  });
  await page.goto('/tests/fixtures/metrics.html');
  await expect(page.getByTestId('stat-total-tokens')).not.toContainText('Loading');
}

const cases = [
  { name: 'measured zero', row: metric(), usage: '0', cost: '$0.00' },
  { name: 'unavailable', row: metric({ usageStatus: 'unavailable', usageSessionCount: 0,
    pricedSessionCount: 0, estimatedCostStatus: 'unavailable' }), usage: 'unavailable', cost: 'unavailable' },
  { name: 'legacy unknown', row: metric({ usageStatus: 'unknown', usageSessionCount: 0,
    legacySessionCount: 1, pricedSessionCount: 0, estimatedCostStatus: 'unavailable',
    totalInputTokens: 123, totalTokens: 123 }), usage: 'unknown', cost: 'unavailable' },
  { name: 'partial', row: metric({ usageStatus: 'partial', usageSessionCount: 1, sessionCount: 3,
    legacySessionCount: 1, pricedSessionCount: 1, estimatedCostStatus: 'partial',
    totalInputTokens: 1000, totalTokens: 1000, estimatedCost: {
      totalCost: 0.03, inputCost: 0.03, outputCost: 0, cacheReadCost: 0, cacheCreationCost: 0 },
  }), usage: '1.0K (partial; recorded subtotal)', cost: '$0.03 (partial; priced subtotal)' },
  { name: 'observed but unpriced', row: metric({ pricedSessionCount: 0,
    estimatedCostStatus: 'unavailable' }), usage: '0', cost: 'unavailable' },
  { name: 'older server', row: metric({ usageStatus: undefined, usageSessionCount: undefined,
    legacySessionCount: undefined, estimatedCostStatus: undefined, pricedSessionCount: undefined,
    estimatedCost: undefined }), usage: 'unknown', cost: 'unknown' },
];

for (const scenario of cases) {
  test(`visible cards, table and chart: ${scenario.name}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await open(page, [scenario.row]);
    const tokens = page.getByTestId('stat-total-tokens');
    await expect(tokens.locator('.text-2xl')).toHaveText(scenario.usage);
    await expect(page.getByTestId('stat-estimated-cost').locator('.text-2xl')).toHaveText(scenario.cost);
    const table = page.getByTestId('model-cost-breakdown');
    await expect(table.locator('tbody tr td').nth(1)).toHaveText(scenario.usage);
    await expect(table.locator('tbody tr td').last()).toHaveText(scenario.cost);
    await expect(table.locator('tfoot tr td').last()).toHaveText(scenario.cost);
    await expect(page.getByTestId('stat-total-sessions')).toContainText('Metric Records');
    const chart = page.getByTestId('token-usage-trend-chart');
    if (scenario.usage === 'unknown' || scenario.usage === 'unavailable') {
      await expect(chart).toContainText(`Token usage ${scenario.usage}`);
      await expect(chart.locator('.recharts-line-dot')).toHaveCount(0);
    } else {
      await expect(chart.locator('.recharts-line-dot')).toHaveCount(1);
    }
    expect(errors).toEqual([]);
    if (scenario.name === 'partial') {
      await page.getByTestId('provider-analytics').screenshot({ path: testInfo.outputPath('provider-analytics.png') });
    }
  });
}

test('mixed groups and buckets retain measured zero, gaps, partial labels and priced subtotal', async ({ page }) => {
  const available = metric();
  const missing = metric({ group: 'missing', usageStatus: 'unavailable', usageSessionCount: 0,
    pricedSessionCount: 0, estimatedCostStatus: 'unavailable' });
  const series = [
    { ...available, bucket: '2026-09-23T00:00:00Z' },
    { ...missing, bucket: '2026-09-24T00:00:00Z' },
    { ...cases[3].row, bucket: '2026-09-25T00:00:00Z' },
  ];
  await open(page, [available, missing], series);
  await expect(page.getByTestId('stat-total-tokens')).toContainText('0 (partial; recorded subtotal)');
  await expect(page.getByTestId('stat-estimated-cost')).toContainText('$0.00 (partial; priced subtotal)');
  const chart = page.getByTestId('token-usage-trend-chart');
  await expect(chart).toContainText('partial');
  await expect(chart.locator('.recharts-line-dot')).toHaveCount(2);
  await chart.locator('.recharts-line-dot').last().hover();
  await expect(chart.locator('.recharts-tooltip-wrapper')).toContainText('1,000 tokens (partial; recorded subtotal)');
  await expect(chart).not.toContainText('Total:');
  await expect(page.getByTestId('token-trend-coverage')).toContainText('gaps are unavailable or unknown');
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.getByTestId('stat-estimated-cost')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByTestId('metrics-timerange').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Last 14 days' }).click();
  await expect(page.getByTestId('metrics-timerange')).toContainText('Last 14 days');
});

for (const status of [200, 500]) {
  test(`empty/error response ${status} does not imply measured zero`, async ({ page }) => {
    await open(page, [], [], status);
    await expect(page.getByTestId('stat-total-tokens').locator('.text-2xl')).toHaveText('unavailable');
    await expect(page.getByTestId('stat-estimated-cost').locator('.text-2xl')).toHaveText('unavailable');
  });
}

const cacheCases = [
  { name: '80 of 100 Codex input', input: 20, read: 80, creation: 0, expected: '80%' },
  { name: 'all cache', input: 0, read: 100, creation: 0, expected: '100%' },
  { name: 'uncached only', input: 100, read: 0, creation: 0, expected: '0%' },
  { name: 'measured empty input', input: 0, read: 0, creation: 0, expected: 'N/A (no input tokens)' },
  { name: 'cache write contributes to denominator', input: 20, read: 60, creation: 20, expected: '60%' },
  { name: 'cache write only', input: 0, read: 0, creation: 100, expected: '0%' },
];

for (const scenario of cacheCases) {
  test(`cache rate card, model and total agree: ${scenario.name}`, async ({ page }) => {
    await open(page, [metric({ totalInputTokens: scenario.input, totalCacheReadTokens: scenario.read,
      totalCacheCreationTokens: scenario.creation, totalOutputTokens: 900 })]);
    await expect(page.getByTestId('stat-cache-hit-rate').locator('.text-2xl')).toHaveText(scenario.expected);
    const table = page.getByTestId('model-cost-breakdown');
    await expect(table.locator('tbody tr td').nth(5)).toHaveText(scenario.expected);
    await expect(table.locator('tfoot tr td').nth(5)).toHaveText(scenario.expected);
  });
}

test('cache rates weight tokens across models instead of averaging percentages', async ({ page }, testInfo) => {
  await open(page, [
    metric({ group: 'cached-model', totalInputTokens: 20, totalCacheReadTokens: 80 }),
    metric({ group: 'uncached-model', totalInputTokens: 900 }),
  ]);
  const table = page.getByTestId('model-cost-breakdown');
  await expect(table.locator('tbody tr').nth(0).locator('td').nth(5)).toHaveText('80%');
  await expect(table.locator('tbody tr').nth(1).locator('td').nth(5)).toHaveText('0%');
  await expect(table.locator('tfoot tr td').nth(5)).toHaveText('8%');
  await expect(page.getByTestId('stat-cache-hit-rate').locator('.text-2xl')).toHaveText('8%');
  await page.getByTestId('provider-analytics').screenshot({ path: testInfo.outputPath('cache-weighted.png') });
});

for (const scenario of [
  { name: 'partial observed', coverage: { usageStatus: 'partial' as const, sessionCount: 2, usageSessionCount: 1,
    legacySessionCount: 0 }, expected: '80% (partial; recorded ratio)' },
  { name: 'partial with legacy', coverage: { usageStatus: 'partial' as const, sessionCount: 2, usageSessionCount: 1,
    legacySessionCount: 1 }, expected: 'unknown' },
  { name: 'only legacy', coverage: { usageStatus: 'unknown' as const, usageSessionCount: 0,
    legacySessionCount: 1 }, expected: 'unknown' },
  { name: 'old server', coverage: { usageStatus: undefined, usageSessionCount: undefined,
    legacySessionCount: undefined }, expected: 'unknown' },
  { name: 'unavailable', coverage: { usageStatus: 'unavailable' as const, usageSessionCount: 0,
    legacySessionCount: 0 }, expected: 'unavailable' },
]) {
  test(`cache ratio coverage: ${scenario.name}`, async ({ page }) => {
    await open(page, [metric({ totalInputTokens: 20, totalCacheReadTokens: 80, ...scenario.coverage })]);
    await expect(page.getByTestId('stat-cache-hit-rate').locator('.text-2xl')).toHaveText(scenario.expected);
    const table = page.getByTestId('model-cost-breakdown');
    await expect(table.locator('tbody tr td').nth(5)).toHaveText(scenario.expected);
    await expect(table.locator('tfoot tr td').nth(5)).toHaveText(scenario.expected);
  });
}

test('legacy mixed with measured groups makes both combined cache rates unknown', async ({ page }) => {
  await open(page, [
    metric({ group: 'measured', totalInputTokens: 20, totalCacheReadTokens: 80 }),
    metric({ group: 'legacy', totalInputTokens: 100, totalCacheReadTokens: 80,
      usageStatus: 'unknown', usageSessionCount: 0, legacySessionCount: 1 }),
  ]);
  const table = page.getByTestId('model-cost-breakdown');
  await expect(table.locator('tbody tr').nth(0).locator('td').nth(5)).toHaveText('80%');
  await expect(table.locator('tbody tr').nth(1).locator('td').nth(5)).toHaveText('unknown');
  await expect(table.locator('tfoot tr td').nth(5)).toHaveText('unknown');
  await expect(page.getByTestId('stat-cache-hit-rate').locator('.text-2xl')).toHaveText('unknown');
  // Legacy counters still contribute to the unchanged public numeric token subtotal.
  await expect(table.locator('tfoot tr td').nth(1)).toHaveText('120 (partial; recorded subtotal)');
});
