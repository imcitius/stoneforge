import { test, expect } from '@playwright/test';

for (const path of ['/tests/fixtures/responsive-title.html', '/metrics']) {
  test(`chart title switches at the small breakpoint: ${path}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    // Intercept every API and WebSocket before navigation, including full-app preloaders.
    await page.routeWebSocket(/.*/, () => {});
    await page.route(url => url.pathname.startsWith('/api/'), route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/elements/all') {
        return route.fulfill({ json: { data: {}, totalElements: 0, types: [], loadedAt: new Date().toISOString() } });
      }
      if (url.pathname === '/api/provider-metrics') {
        const metric = {
          group: 'fixture-model', totalInputTokens: 1000, totalOutputTokens: 0,
          totalCacheReadTokens: 0, totalCacheCreationTokens: 0, totalTokens: 1000,
          sessionCount: 1, avgDurationMs: 1000, errorRate: 0, failedCount: 0, rateLimitedCount: 0,
          usageStatus: 'available', usageSessionCount: 1, legacySessionCount: 0,
          pricedSessionCount: 1, estimatedCostStatus: 'available',
          estimatedCost: { totalCost: 0.03, inputCost: 0.03, outputCost: 0, cacheReadCost: 0, cacheCreationCost: 0 },
        };
        return route.fulfill({ json: {
          timeRange: { days: 7, label: '7d' }, groupBy: url.searchParams.get('groupBy'),
          metrics: [metric], timeSeries: [{ ...metric, bucket: '2026-09-26T00:00:00Z' }],
        } });
      }
      return route.fulfill({ json: {
        tasks: [], agents: [], plans: [], elements: [], entities: [], sessions: [],
        notifications: [], requests: [], directors: [], providers: [], messages: [],
        preset: 'auto', total: 0, count: 0, available: false,
        mergeRequests: [], counts: { needsReview: 0, testing: 0, conflicts: 0, merged: 0 },
      } });
    });
    await page.addInitScript(() => {
      localStorage.setItem('stoneforge:onboarding-complete', 'true');
    });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(path);
    const chart = page.getByTestId('tasks-completed-chart');
    const title = chart.locator('h4');
    const desktop = title.locator(':scope > span').nth(0);
    const mobile = title.locator(':scope > span').nth(1);
    await expect(desktop).toHaveText('Task Completions (Last 7 days)');
    // Keep Tailwind utility literals out of fixtures/specs so they cannot supply
    // a missing candidate and accidentally repair the stylesheet under test.
    await testInfo.attach('initial-title-displays', {
      body: JSON.stringify(await title.locator(':scope > span').evaluateAll(spans =>
        spans.map(span => ({ text: span.textContent, display: getComputedStyle(span).display })))),
      contentType: 'application/json',
    });
    await page.getByTestId('charts-grid-activity').screenshot({ path: testInfo.outputPath('initial-charts.png') });
    for (const width of [1280, 639, 640, 320, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      if (width >= 640) {
        await expect(desktop).toBeVisible();
        await expect(mobile).toBeHidden();
        await expect(title).toHaveJSProperty('innerText', 'Task Completions (Last 7 days)');
      } else {
        await expect(desktop).toBeHidden();
        await expect(mobile).toBeVisible();
        await expect(title).toHaveJSProperty('innerText', 'Task Completions (La...');
      }
      await expect(page.getByTestId('stat-total-tokens')).toBeVisible();
      await expect(page.getByTestId('model-cost-breakdown')).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
}
