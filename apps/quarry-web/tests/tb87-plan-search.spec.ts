import { test, expect, type Page } from '@playwright/test';

interface SeededPlan {
  id: string;
  title: string;
}

/**
 * Unique token for plan titles. The 'qzx' prefix keeps the fuzzy (subsequence)
 * search from matching plans created by other specs running in parallel.
 */
function uniqueToken(): string {
  return `qzx${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a plan through the API. TB121: plans require an initial task.
 * The e2e database starts with only the operator entity, so every test that
 * needs plans seeds its own instead of skipping. Seeded plans are not deleted:
 * other specs running in parallel snapshot GET /api/plans and then open those
 * plans, and the disposable e2e database is removed by global teardown.
 */
async function seedPlan(page: Page, title: string): Promise<SeededPlan> {
  const response = await page.request.post('/api/plans', {
    data: {
      title,
      createdBy: 'el-0000',
      initialTask: { title: `${title} task`, priority: 3 },
    },
  });
  expect(response.ok(), `POST /api/plans failed: ${await response.text()}`).toBe(true);
  const created = await response.json();
  return { id: created.id as string, title: created.title as string };
}

async function gotoPlans(page: Page): Promise<void> {
  await page.goto('/plans');
  await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });
}

/** Top-level plan rows only ('[data-testid^="plan-item-"]' alone also matches plan-item-title). */
function planRows(page: Page) {
  return page.locator('[data-testid="plans-list"] > [data-testid^="plan-item-"]');
}

function planRow(page: Page, plan: SeededPlan) {
  return page.getByTestId(`plan-item-${plan.id}`);
}

test.describe('TB87: Plan Search', () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage for consistent testing
    await page.goto('/plans');
    await page.evaluate(() => {
      localStorage.removeItem('plans.search');
    });
    await page.reload();
  });

  test('search bar is visible on Plans page', async ({ page }) => {
    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Search bar should be visible
    await expect(page.getByTestId('plan-search-container')).toBeVisible();
    await expect(page.getByTestId('plan-search-input')).toBeVisible();
  });

  test('search input has correct placeholder', async ({ page }) => {
    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    const searchInput = page.getByTestId('plan-search-input');
    await expect(searchInput).toHaveAttribute('placeholder', 'Search plans... (Press / to focus)');
  });

  test('typing in search input filters plans', async ({ page }) => {
    const token = uniqueToken();
    const alpha = await seedPlan(page, `TB87 Alpha ${token}`);
    const beta = await seedPlan(page, `TB87 Beta ${token}`);

    await gotoPlans(page);
    await expect(planRow(page, alpha)).toBeVisible();
    await expect(planRow(page, beta)).toBeVisible();

    // "alpha <token>" matches only the Alpha plan (Beta has no 'l' after its 'a')
    await page.getByTestId('plan-search-input').fill(`alpha ${token}`);

    await expect(planRow(page, beta)).toHaveCount(0);
    await expect(planRow(page, alpha)).toBeVisible();
    await expect(planRows(page)).toHaveCount(1);
  });

  test('search with no matches shows empty state', async ({ page }) => {
    const plan = await seedPlan(page, `TB87 NoMatch ${uniqueToken()}`);

    await gotoPlans(page);
    await expect(planRow(page, plan)).toBeVisible();

    // Type a search query that shouldn't match anything
    await page.getByTestId('plan-search-input').fill('xyzzynonexistentplan123456789');

    // No plans should be shown once the debounced filter applies
    await expect(planRows(page)).toHaveCount(0);

    // Empty state message should appear with search-specific text
    await expect(page.getByTestId('plans-no-search-results')).toBeVisible();
  });

  test('clear button appears when search has value', async ({ page }) => {
    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    const searchInput = page.getByTestId('plan-search-input');
    const clearButton = page.getByTestId('plan-search-clear');

    // Clear button should not be visible initially
    await expect(clearButton).not.toBeVisible();

    // Type something
    await searchInput.fill('test');

    // Clear button should now be visible
    await expect(clearButton).toBeVisible();
  });

  test('clicking clear button clears the search', async ({ page }) => {
    const plan = await seedPlan(page, `TB87 ClearButton ${uniqueToken()}`);

    await gotoPlans(page);
    await expect(planRow(page, plan)).toBeVisible();

    const searchInput = page.getByTestId('plan-search-input');

    // Type a search query that hides the seeded plan
    await searchInput.fill('xyzzynonexistentplan123456789');
    await expect(planRow(page, plan)).toHaveCount(0);

    // Click the clear button
    await page.getByTestId('plan-search-clear').click();

    // Input should be empty
    await expect(searchInput).toHaveValue('');

    // Clear button should be hidden again
    await expect(page.getByTestId('plan-search-clear')).not.toBeVisible();

    // The seeded plan is listed again
    await expect(planRow(page, plan)).toBeVisible();
  });

  test('pressing Escape clears search when input is focused', async ({ page }) => {
    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    const searchInput = page.getByTestId('plan-search-input');

    // Focus and type
    await searchInput.click();
    await searchInput.fill('test');
    await expect(searchInput).toHaveValue('test');

    // Press Escape
    await page.keyboard.press('Escape');

    // Input should be cleared
    await expect(searchInput).toHaveValue('');
  });

  test('pressing / focuses the search input', async ({ page }) => {
    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    const searchInput = page.getByTestId('plan-search-input');

    // Make sure search input is not focused initially
    await page.getByTestId('plans-page').click();

    // Press /
    await page.keyboard.press('/');

    // Search input should be focused
    await expect(searchInput).toBeFocused();
  });

  test('pressing / in a contenteditable keeps focus and inserts the character', async ({ page }) => {
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });
    await page.evaluate(() => {
      const editor = document.createElement('div');
      editor.contentEditable = 'true';
      editor.dataset.testid = 'shortcut-editor';
      document.body.appendChild(editor);
    });

    const editor = page.getByTestId('shortcut-editor');
    await editor.focus();
    await page.keyboard.press('/');

    await expect(editor).toBeFocused();
    await expect(editor).toHaveText('/');
    await expect(page.getByTestId('plan-search-input')).not.toBeFocused();
  });

  test('search highlights matching characters in plan titles', async ({ page }) => {
    const token = uniqueToken();
    const plan = await seedPlan(page, `TB87 Highlight ${token}`);

    await gotoPlans(page);
    await expect(planRow(page, plan)).toBeVisible();

    await page.getByTestId('plan-search-input').fill(token);
    await expect(planRows(page)).toHaveCount(1);

    // Each matched character is wrapped in its own <mark>
    const marks = planRow(page, plan).getByTestId('plan-item-title').locator('mark');
    await expect(marks).toHaveCount(token.length);
  });

  test('search combines with status filter', async ({ page }) => {
    // This test verifies that search works alongside status filtering
    // The implementation fetches plans filtered by status from server, then applies search client-side

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // First verify search works on the "All" filter
    const searchInput = page.getByTestId('plan-search-input');
    await searchInput.fill('nonexistent');
    await page.waitForTimeout(400);

    // Should show no results
    const noResultsVisible = await page.getByTestId('plans-no-search-results').isVisible().catch(() => false);
    const planListVisible = await page.getByTestId('plans-list').isVisible().catch(() => false);
    // Either shows no results message or empty list
    expect(noResultsVisible || !planListVisible).toBe(true);

    // Clear search
    await page.getByTestId('plan-search-clear').click();
    await page.waitForTimeout(400);

    // Switch to a specific status filter
    await page.getByTestId('status-filter-draft').click();
    await page.waitForTimeout(400);

    // Search should still work within the draft filter
    await searchInput.fill('nonexistent');
    await page.waitForTimeout(400);

    // Should still show no results (search works with status filter)
    const noResultsAfterFilter = await page.getByTestId('plans-no-search-results').isVisible().catch(() => false);
    const planListAfterFilter = await page.getByTestId('plans-list').isVisible().catch(() => false);
    expect(noResultsAfterFilter || !planListAfterFilter).toBe(true);
  });

  test('search persists in localStorage', async ({ page }) => {
    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    const searchInput = page.getByTestId('plan-search-input');
    await searchInput.fill('persisted-plan-search');

    // Wait for debounce
    await page.waitForTimeout(400);

    // Check localStorage
    const storedSearch = await page.evaluate(() => localStorage.getItem('plans.search'));
    expect(storedSearch).toBe('persisted-plan-search');
  });

  test('search is restored from localStorage on page load', async ({ page }) => {
    // Set localStorage first
    await page.goto('/plans');
    await page.evaluate(() => {
      localStorage.setItem('plans.search', 'restored-plan-search');
    });

    // Reload the page
    await page.reload();
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Search input should have the stored value
    const searchInput = page.getByTestId('plan-search-input');
    await expect(searchInput).toHaveValue('restored-plan-search');
  });

  test('search is debounced (300ms)', async ({ page }) => {
    const plan = await seedPlan(page, `TB87 Debounce ${uniqueToken()}`);

    await gotoPlans(page);
    await expect(planRow(page, plan)).toBeVisible();

    const searchInput = page.getByTestId('plan-search-input');
    await searchInput.fill('xyzzynonexistentplan123456789');

    // Immediately after typing the 300ms debounce has not fired: the list is unfiltered
    expect(await planRow(page, plan).isVisible()).toBe(true);

    // After the debounce period the filter applies
    await expect(planRow(page, plan)).toHaveCount(0);
    await expect(page.getByTestId('plans-no-search-results')).toBeVisible();
  });

  test('clearing search restores all plans', async ({ page }) => {
    const token = uniqueToken();
    const alpha = await seedPlan(page, `TB87 Restore Alpha ${token}`);
    const beta = await seedPlan(page, `TB87 Restore Beta ${token}`);

    await gotoPlans(page);
    await expect(planRow(page, alpha)).toBeVisible();
    await expect(planRow(page, beta)).toBeVisible();

    // Search for something that matches nothing
    await page.getByTestId('plan-search-input').fill('nonexistentuniquequery123');
    await expect(planRows(page)).toHaveCount(0);

    // Clear the search from the empty state
    await page.getByTestId('plans-clear-search').click();

    // Both seeded plans are listed again. Other specs create plans in
    // parallel, so the global row count is not compared.
    await expect(page.getByTestId('plan-search-input')).toHaveValue('');
    await expect(planRow(page, alpha)).toBeVisible();
    await expect(planRow(page, beta)).toBeVisible();
  });

  test('plan count updates when search is active', async ({ page }) => {
    const token = uniqueToken();
    const alpha = await seedPlan(page, `CountTestAlpha ${token}`);
    const beta = await seedPlan(page, `CountTestBeta ${token}`);

    await gotoPlans(page);
    await expect(planRow(page, alpha)).toBeVisible();
    await expect(planRow(page, beta)).toBeVisible();

    // Without a search the header shows the plain count, e.g. "(12)"
    const planCount = page.getByTestId('plans-count');
    await expect(planCount).toHaveText(/^\(\d+\)$/);

    // Search for one of the unique plans
    await page.getByTestId('plan-search-input').fill(`CountTestAlpha ${token}`);
    await expect(planRows(page)).toHaveCount(1);

    // Count shows "<filtered> of <total>"
    await expect(planCount).toHaveText(/^1 of \d+$/);
    const total = parseInt((await planCount.textContent())!.match(/of (\d+)/)![1], 10);
    expect(total).toBeGreaterThanOrEqual(2);
  });

  test('empty state shows clear search button', async ({ page }) => {
    const plan = await seedPlan(page, `TB87 EmptyState ${uniqueToken()}`);

    await gotoPlans(page);
    await expect(planRow(page, plan)).toBeVisible();

    // Search for something that won't match
    const searchInput = page.getByTestId('plan-search-input');
    await searchInput.fill('xyznonexistent123');

    // Empty state should show clear search button
    await expect(page.getByTestId('plans-clear-search')).toBeVisible();

    // Clicking it should clear the search
    await page.getByTestId('plans-clear-search').click();
    await expect(searchInput).toHaveValue('');
    await expect(planRow(page, plan)).toBeVisible();
  });
});
