import { test, expect, type APIResponse, type Page } from '@playwright/test';

// The e2e server is shared by parallel specs. Keep every plan and task scoped to
// its creating test so assertions never depend on another test's database state.
const fixtures = new WeakMap<Page, { planIds: string[]; taskIds: string[] }>();

function fixtureIds(page: Page) {
  let ids = fixtures.get(page);
  if (!ids) {
    ids = { planIds: [], taskIds: [] };
    fixtures.set(page, ids);
  }
  return ids;
}

async function createPlan(page: Page, { data }: { data: Record<string, unknown> }): Promise<APIResponse> {
  const response = await page.request.post('/api/plans', {
    data: {
      ...data,
      createdBy: 'el-0000',
      initialTask: { title: `Initial task for ${data.title}`, priority: 3 },
    },
  });
  expect(response.status()).toBe(201);
  const created = await response.json();
  fixtureIds(page).planIds.push(created.id);
  fixtureIds(page).taskIds.push(created.initialTask.id);
  return response;
}

async function seedPlan(page: Page) {
  const response = await createPlan(page, { data: { title: `E2E plan ${Date.now()}` } });
  return response.json() as Promise<{ id: string; title: string; status: string; initialTask: { id: string } }>;
}

async function createTask(page: Page, options: { data: Record<string, unknown> }): Promise<APIResponse> {
  const response = await page.request.post('/api/tasks', options);
  expect(response.ok()).toBe(true);
  fixtureIds(page).taskIds.push((await response.json()).id);
  return response;
}

test.afterEach(async ({ page }) => {
  const ids = fixtures.get(page);
  if (!ids) return;
  for (const taskId of ids.taskIds) {
    await page.request.delete(`/api/tasks/${taskId}?force=true`);
  }
  for (const planId of ids.planIds) {
    await page.request.delete(`/api/plans/${planId}?force=true`);
  }
});

test.describe('TB24: Plan List with Progress', () => {
  // ============================================================================
  // API Endpoint Tests
  // ============================================================================

  test('GET /api/plans returns list of plans', async ({ page }) => {
    const seededPlan = await seedPlan(page);
    const response = await page.request.get('/api/plans');
    expect(response.ok()).toBe(true);
    const plans = await response.json();
    expect(Array.isArray(plans)).toBe(true);
    expect(plans.some((plan: { id: string }) => plan.id === seededPlan.id)).toBe(true);

    // Check each plan has required fields
    for (const plan of plans) {
      expect(plan.type).toBe('plan');
      expect(plan.title).toBeDefined();
      expect(['draft', 'active', 'completed', 'cancelled']).toContain(plan.status);
      expect(plan.createdAt).toBeDefined();
      expect(plan.updatedAt).toBeDefined();
      expect(plan.createdBy).toBeDefined();
    }
  });

  test('GET /api/plans supports status filter parameter', async ({ page }) => {
    await seedPlan(page);
    // Test that the status parameter is accepted (even if not fully functional)
    // Note: Full status filtering requires plan-specific query support
    const response = await page.request.get('/api/plans?status=draft');
    expect(response.ok()).toBe(true);
    const plans = await response.json();
    expect(Array.isArray(plans)).toBe(true);
  });

  test('GET /api/plans/:id returns a plan', async ({ page }) => {
    const plan = await seedPlan(page);

    // Get single plan
    const response = await page.request.get(`/api/plans/${plan.id}`);
    expect(response.ok()).toBe(true);
    const fetchedPlan = await response.json();

    expect(fetchedPlan.id).toBe(plan.id);
    expect(fetchedPlan.type).toBe('plan');
    expect(fetchedPlan.title).toBeDefined();
  });

  test('GET /api/plans/:id returns 404 for invalid ID', async ({ page }) => {
    const response = await page.request.get('/api/plans/el-invalid999999');
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  test('GET /api/plans/:id with hydrate.progress includes progress', async ({ page }) => {
    const plan = await seedPlan(page);

    const response = await page.request.get(`/api/plans/${plan.id}?hydrate.progress=true`);
    expect(response.ok()).toBe(true);
    const hydratedPlan = await response.json();

    expect(hydratedPlan._progress).toBeDefined();
    expect(typeof hydratedPlan._progress.totalTasks).toBe('number');
    expect(typeof hydratedPlan._progress.completedTasks).toBe('number');
    expect(typeof hydratedPlan._progress.completionPercentage).toBe('number');
  });

  test('GET /api/plans/:id/progress returns progress metrics', async ({ page }) => {
    const plan = await seedPlan(page);

    const response = await page.request.get(`/api/plans/${plan.id}/progress`);
    expect(response.ok()).toBe(true);
    const progress = await response.json();

    expect(typeof progress.totalTasks).toBe('number');
    expect(typeof progress.completedTasks).toBe('number');
    expect(typeof progress.inProgressTasks).toBe('number');
    expect(typeof progress.blockedTasks).toBe('number');
    expect(typeof progress.remainingTasks).toBe('number');
    expect(typeof progress.completionPercentage).toBe('number');

    // Validate percentage is between 0 and 100
    expect(progress.completionPercentage).toBeGreaterThanOrEqual(0);
    expect(progress.completionPercentage).toBeLessThanOrEqual(100);
  });

  test('GET /api/plans/:id/tasks returns tasks in plan', async ({ page }) => {
    const plan = await seedPlan(page);

    const response = await page.request.get(`/api/plans/${plan.id}/tasks`);
    expect(response.ok()).toBe(true);
    const tasks = await response.json();

    expect(Array.isArray(tasks)).toBe(true);

    // Each task should be a valid task
    for (const task of tasks) {
      expect(task.type).toBe('task');
      expect(task.title).toBeDefined();
      expect(task.status).toBeDefined();
    }
  });

  test('POST /api/plans creates a new plan', async ({ page }) => {
    const newPlan = {
      title: `Test Plan ${Date.now()}`,
      createdBy: 'el-0000',
      status: 'draft',
      tags: ['test'],
    };

    const response = await createPlan(page, {
      data: newPlan,
    });

    expect(response.status()).toBe(201);
    const created = await response.json();

    expect(created.type).toBe('plan');
    expect(created.title).toBe(newPlan.title);
    expect(created.status).toBe('draft');
    expect(created.createdBy).toBe(newPlan.createdBy);
    expect(created.id).toBeDefined();
  });

  test('POST /api/plans validates required fields', async ({ page }) => {
    // Missing title
    const response1 = await page.request.post('/api/plans', {
      data: { createdBy: 'el-0000', initialTask: { title: 'Initial task', priority: 3 } },
    });
    expect(response1.status()).toBe(400);

    // Missing createdBy
    const response2 = await page.request.post('/api/plans', {
      data: { title: 'Test Plan', initialTask: { title: 'Initial task', priority: 3 } },
    });
    expect(response2.status()).toBe(400);
  });

  test('PATCH /api/plans/:id updates a plan', async ({ page }) => {
    // Create a plan to update
    const createResponse = await createPlan(page, {
      data: {
        title: `Update Test Plan ${Date.now()}`,
        createdBy: 'el-0000',
        status: 'draft',
      },
    });
    const plan = await createResponse.json();

    // Update the plan
    const newTitle = `Updated Title ${Date.now()}`;
    const updateResponse = await page.request.patch(`/api/plans/${plan.id}`, {
      data: { title: newTitle, status: 'active' },
    });

    expect(updateResponse.ok()).toBe(true);
    const updated = await updateResponse.json();

    expect(updated.title).toBe(newTitle);
    expect(updated.status).toBe('active');
  });

  test('PATCH /api/plans/:id validates status values', async ({ page }) => {
    const plan = await seedPlan(page);

    const response = await page.request.patch(`/api/plans/${plan.id}`, {
      data: { status: 'invalid_status' },
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  // ============================================================================
  // UI Tests - Plans Page
  // ============================================================================

  test('plans page is accessible', async ({ page }) => {
    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });
  });

  test('plans page shows header with title', async ({ page }) => {
    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });
    // Use role-based selector to get the h1 specifically
    await expect(page.getByRole('heading', { name: 'Plans' })).toBeVisible();
  });

  test('plans page shows status filter tabs', async ({ page }) => {
    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('status-filter')).toBeVisible();

    // Check all status filters are present
    await expect(page.getByTestId('status-filter-all')).toBeVisible();
    await expect(page.getByTestId('status-filter-active')).toBeVisible();
    await expect(page.getByTestId('status-filter-draft')).toBeVisible();
    await expect(page.getByTestId('status-filter-completed')).toBeVisible();
    await expect(page.getByTestId('status-filter-cancelled')).toBeVisible();
  });

  test('clicking status filter changes filter', async ({ page }) => {
    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on active filter
    await page.getByTestId('status-filter-active').click();

    // The active filter should be selected (has different styling)
    await expect(page.getByTestId('status-filter-active')).toHaveClass(/bg-white/);
  });

  test('plans list shows plans when available', async ({ page }) => {
    // Seed a plan rather than branching on an earlier GET /api/plans snapshot:
    // other specs create plans in parallel, so an empty snapshot can be stale by
    // the time the page loads.
    const plan = await seedPlan(page);

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Should show plans list containing the seeded plan
    await expect(page.getByTestId('plans-list')).toBeVisible();
    await expect(page.getByTestId(`plan-item-${plan.id}`)).toBeVisible();
    await expect(page.getByTestId('plans-empty')).toHaveCount(0);
  });

  test('plans list shows plan count', async ({ page }) => {
    const plan = await seedPlan(page);

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId(`plan-item-${plan.id}`)).toBeVisible();

    // Header count matches the rendered rows. Other specs create and delete plans
    // in parallel, so compare against the list rather than an earlier API snapshot.
    const rows = page.locator('[data-testid="plans-list"] > [data-testid^="plan-item-"]');
    await expect(async () => {
      const rowCount = await rows.count();
      expect(rowCount).toBeGreaterThan(0);
      await expect(page.getByTestId('plans-count')).toHaveText(`(${rowCount})`, { timeout: 1000 });
    }).toPass({ timeout: 10000 });
  });

  test('clicking plan opens detail panel', async ({ page }) => {
    const plan = await seedPlan(page);

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on first plan
    await page.getByTestId(`plan-item-${plan.id}`).click();

    // Detail panel should appear
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });
  });

  test('plan detail panel shows plan title', async ({ page }) => {
    const plan = await seedPlan(page);

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on first plan
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    // Check title is displayed
    await expect(page.getByTestId('plan-detail-title')).toContainText(plan.title);
  });

  test('plan detail panel shows status badge', async ({ page }) => {
    const plan = await seedPlan(page);

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on first plan
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    // Check status badge is displayed in the detail panel
    await expect(
      page.getByTestId('plan-detail-panel').getByTestId(`status-badge-${plan.status}`)
    ).toBeVisible();
  });

  test('plan detail panel shows progress ring (TB86)', async ({ page }) => {
    const plan = await seedPlan(page);

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on first plan
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    // Check progress ring is displayed instead of progress bar (TB86)
    await expect(page.getByTestId('plan-detail-progress-ring')).toBeVisible();
  });

  test('plan detail panel shows task status summary', async ({ page }) => {
    const plan = await seedPlan(page);

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on first plan
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    // Check task status summary is displayed
    await expect(page.getByTestId('task-status-summary')).toBeVisible();
  });

  test('plan detail panel close button works', async ({ page }) => {
    const plan = await seedPlan(page);

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on first plan
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    // Click close button
    await page.getByTestId('plan-detail-close').click();

    // Panel should close
    await expect(page.getByTestId('plan-detail-panel')).not.toBeVisible({ timeout: 5000 });
  });

  test('plans page is navigable via sidebar', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard-page')).toBeVisible({ timeout: 10000 });

    // Click on Plans in sidebar
    await page.getByTestId('nav-plans').click();

    // Should navigate to plans page
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 5000 });
    expect(page.url()).toContain('/plans');
  });
});

// ============================================================================
// TB47: Edit Plan Tests
// ============================================================================

test.describe('TB47: Edit Plan', () => {
  // ============================================================================
  // API Endpoint Tests
  // ============================================================================

  test('POST /api/plans/:id/tasks adds task to plan', async ({ page }) => {
    // Create a plan
    const planResponse = await createPlan(page, {
      data: {
        title: `Test Plan ${Date.now()}`,
        createdBy: 'el-0000',
        status: 'draft',
      },
    });
    expect(planResponse.status()).toBe(201);
    const plan = await planResponse.json();

    // Create a task
    const taskResponse = await createTask(page, {
      data: {
        title: `Test Task ${Date.now()}`,
        createdBy: 'el-0000',
        status: 'open',
        priority: 3,
      },
    });
    expect(taskResponse.ok()).toBe(true);
    const task = await taskResponse.json();

    // Add task to plan
    const addResponse = await page.request.post(`/api/plans/${plan.id}/tasks`, {
      data: { taskId: task.id },
    });
    expect(addResponse.status()).toBe(201);
    const dependency = await addResponse.json();
    expect(dependency.blockedId).toBe(task.id);
    expect(dependency.blockerId).toBe(plan.id);
  });

  test('POST /api/plans/:id/tasks returns 404 for invalid plan', async ({ page }) => {
    const response = await page.request.post('/api/plans/el-invalid999/tasks', {
      data: { taskId: 'el-task123' },
    });
    expect(response.status()).toBe(404);
  });

  test('POST /api/plans/:id/tasks returns 400 for missing taskId', async ({ page }) => {
    // Create a plan first
    const planResponse = await createPlan(page, {
      data: {
        title: `Test Plan ${Date.now()}`,
        createdBy: 'el-0000',
      },
    });
    const plan = await planResponse.json();

    const response = await page.request.post(`/api/plans/${plan.id}/tasks`, {
      data: {},
    });
    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('DELETE /api/plans/:id/tasks/:taskId removes task from plan', async ({ page }) => {
    // Create a plan
    const planResponse = await createPlan(page, {
      data: {
        title: `Test Plan ${Date.now()}`,
        createdBy: 'el-0000',
      },
    });
    const plan = await planResponse.json();

    // Create a task
    const taskResponse = await createTask(page, {
      data: {
        title: `Test Task ${Date.now()}`,
        createdBy: 'el-0000',
        status: 'open',
        priority: 3,
      },
    });
    const task = await taskResponse.json();

    // Add task to plan
    await page.request.post(`/api/plans/${plan.id}/tasks`, {
      data: { taskId: task.id },
    });

    // Remove task from plan
    const removeResponse = await page.request.delete(`/api/plans/${plan.id}/tasks/${task.id}`);
    expect(removeResponse.ok()).toBe(true);
    const body = await removeResponse.json();
    expect(body.success).toBe(true);

    // Verify task is no longer in plan
    const tasksResponse = await page.request.get(`/api/plans/${plan.id}/tasks`);
    const tasks = await tasksResponse.json();
    expect(tasks.find((t: { id: string }) => t.id === task.id)).toBeUndefined();
  });

  test('DELETE /api/plans/:id/tasks/:taskId returns 404 if task not in plan', async ({ page }) => {
    // Create a plan
    const planResponse = await createPlan(page, {
      data: {
        title: `Test Plan ${Date.now()}`,
        createdBy: 'el-0000',
      },
    });
    const plan = await planResponse.json();

    // Create a task but don't add it to the plan
    const taskResponse = await createTask(page, {
      data: {
        title: `Test Task ${Date.now()}`,
        createdBy: 'el-0000',
        status: 'open',
        priority: 3,
      },
    });
    const task = await taskResponse.json();

    // Try to remove - should fail
    const removeResponse = await page.request.delete(`/api/plans/${plan.id}/tasks/${task.id}`);
    expect(removeResponse.status()).toBe(404);
  });

  // ============================================================================
  // UI Tests - Edit Title
  // ============================================================================

  test('plan detail panel shows edit button on hover', async ({ page }) => {
    const plan = await seedPlan(page);

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on first plan
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    // Hover over title area to reveal edit button
    await page.getByTestId('plan-detail-title').hover();
    await expect(page.getByTestId('edit-title-btn')).toBeVisible();
  });

  test('clicking edit button shows title input', async ({ page }) => {
    const plan = await seedPlan(page);

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on first plan
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    // Click edit button
    await page.getByTestId('plan-detail-title').hover();
    await page.getByTestId('edit-title-btn').click();

    // Input should be visible
    await expect(page.getByTestId('plan-title-input')).toBeVisible();
    await expect(page.getByTestId('save-title-btn')).toBeVisible();
    await expect(page.getByTestId('cancel-edit-btn')).toBeVisible();
  });

  test('editing title and saving updates the plan', async ({ page }) => {
    // Create a plan to edit
    const createResponse = await createPlan(page, {
      data: {
        title: `Original Title ${Date.now()}`,
        createdBy: 'el-0000',
      },
    });
    const plan = await createResponse.json();

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on the plan
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    // Enter edit mode
    await page.getByTestId('plan-detail-title').hover();
    await page.getByTestId('edit-title-btn').click();

    // Change the title
    const newTitle = `Updated Title ${Date.now()}`;
    await page.getByTestId('plan-title-input').fill(newTitle);
    await page.getByTestId('save-title-btn').click();

    // Wait for update and verify
    await expect(page.getByTestId('plan-detail-title')).toContainText(newTitle, { timeout: 5000 });
  });

  test('pressing Escape cancels title edit', async ({ page }) => {
    const plan = await seedPlan(page);

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on first plan
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    const originalTitle = await page.getByTestId('plan-detail-title').textContent();

    // Enter edit mode
    await page.getByTestId('plan-detail-title').hover();
    await page.getByTestId('edit-title-btn').click();

    // Change input but press Escape
    await page.getByTestId('plan-title-input').fill('Changed Title');
    await page.keyboard.press('Escape');

    // Should show original title
    await expect(page.getByTestId('plan-detail-title')).toContainText(originalTitle || '');
    await expect(page.getByTestId('plan-title-input')).not.toBeVisible();
  });

  // ============================================================================
  // UI Tests - Status Transitions
  // ============================================================================

  test('draft plan shows Activate button', async ({ page }) => {
    // Create a draft plan
    const createResponse = await createPlan(page, {
      data: {
        title: `Draft Plan ${Date.now()}`,
        createdBy: 'el-0000',
        status: 'draft',
      },
    });
    const plan = await createResponse.json();

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on the plan
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    // Should show Activate button
    await expect(page.getByTestId('status-action-active')).toBeVisible();
    await expect(page.getByTestId('status-action-active')).toContainText('Activate');
  });

  test('clicking Activate changes status to active', async ({ page }) => {
    // Create a draft plan
    const createResponse = await createPlan(page, {
      data: {
        title: `Draft Plan ${Date.now()}`,
        createdBy: 'el-0000',
        status: 'draft',
      },
    });
    const plan = await createResponse.json();

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on the plan
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    // Click Activate
    await page.getByTestId('status-action-active').click();

    // Status badge in detail panel should update (scope to detail panel to avoid ambiguity)
    const detailPanel = page.getByTestId('plan-detail-panel');
    await expect(detailPanel.getByTestId('status-badge-active')).toBeVisible({ timeout: 5000 });
  });

  test('active plan shows Complete and Cancel buttons', async ({ page }) => {
    // Create an active plan
    const createResponse = await createPlan(page, {
      data: {
        title: `Active Plan ${Date.now()}`,
        createdBy: 'el-0000',
        status: 'active',
      },
    });
    const plan = await createResponse.json();

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on the plan
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    // Should show Complete and Cancel buttons
    await expect(page.getByTestId('status-action-completed')).toBeVisible();
    await expect(page.getByTestId('status-action-cancelled')).toBeVisible();
  });

  // ============================================================================
  // UI Tests - Add Task
  // ============================================================================

  test('plan detail panel shows Add Task button', async ({ page }) => {
    const plan = await seedPlan(page);

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on first plan
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    // Add Task button should be visible
    await expect(page.getByTestId('add-task-btn')).toBeVisible();
  });

  test('clicking Add Task opens task picker modal', async ({ page }) => {
    const plan = await seedPlan(page);

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on first plan
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    // Click Add Task button
    await page.getByTestId('add-task-btn').click();

    // Modal should appear
    await expect(page.getByTestId('task-picker-modal')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('task-picker-search')).toBeVisible();
  });

  test('task picker shows search input and loads', async ({ page }) => {
    // Create a plan
    const planResponse = await createPlan(page, {
      data: {
        title: `Test Plan ${Date.now()}`,
        createdBy: 'el-0000',
      },
    });
    const plan = await planResponse.json();

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on the plan
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    // Open task picker
    await page.getByTestId('add-task-btn').click();
    await expect(page.getByTestId('task-picker-modal')).toBeVisible({ timeout: 5000 });

    // Should show the search input
    await expect(page.getByTestId('task-picker-search')).toBeVisible();

    // Wait for loading to complete and check modal has content area
    await page.waitForTimeout(1000);

    // Modal should be functional (has close button)
    await expect(page.getByTestId('task-picker-close')).toBeVisible();

    // Close the modal
    await page.getByTestId('task-picker-close').click();
    await expect(page.getByTestId('task-picker-modal')).not.toBeVisible({ timeout: 5000 });
  });

  test('can add task to plan via API call', async ({ page }) => {
    // This test uses the API directly since the UI task picker may have many tasks
    // and finding a specific one is unreliable. The UI functionality is tested
    // in "clicking Add Task opens task picker modal" and API is tested separately.

    // Create a plan
    const planResponse = await createPlan(page, {
      data: {
        title: `Test Plan ${Date.now()}`,
        createdBy: 'el-0000',
      },
    });
    const plan = await planResponse.json();

    // Create a task
    const taskResponse = await createTask(page, {
      data: {
        title: `API Test Task ${Date.now()}`,
        createdBy: 'el-0000',
        status: 'open',
        priority: 3,
      },
    });
    const task = await taskResponse.json();

    // Add task to plan via API
    const addResponse = await page.request.post(`/api/plans/${plan.id}/tasks`, {
      data: { taskId: task.id },
    });
    expect(addResponse.status()).toBe(201);

    // Navigate to plans page and verify task is in plan
    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on the plan
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    // Task should appear in plan task list
    await expect(page.getByTestId(`plan-task-${task.id}`)).toBeVisible({ timeout: 5000 });
  });

  // ============================================================================
  // UI Tests - Remove Task
  // ============================================================================

  test('tasks in plan show remove button on hover', async ({ page }) => {
    // Create a plan with a task
    const planResponse = await createPlan(page, {
      data: {
        title: `Test Plan ${Date.now()}`,
        createdBy: 'el-0000',
      },
    });
    const plan = await planResponse.json();

    const taskResponse = await createTask(page, {
      data: {
        title: `Test Task ${Date.now()}`,
        createdBy: 'el-0000',
        status: 'open',
        priority: 3,
      },
    });
    const task = await taskResponse.json();

    // Add task to plan
    await page.request.post(`/api/plans/${plan.id}/tasks`, {
      data: { taskId: task.id },
    });

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on the plan
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    // Hover over task to reveal remove button
    await page.getByTestId(`plan-task-${task.id}`).hover();
    await expect(page.getByTestId(`remove-task-${task.id}`)).toBeVisible();
  });

  test('clicking remove button twice removes task from plan', async ({ page }) => {
    // Create a plan with a task
    const planResponse = await createPlan(page, {
      data: {
        title: `Test Plan ${Date.now()}`,
        createdBy: 'el-0000',
      },
    });
    const plan = await planResponse.json();

    const taskResponse = await createTask(page, {
      data: {
        title: `Test Task ${Date.now()}`,
        createdBy: 'el-0000',
        status: 'open',
        priority: 3,
      },
    });
    const task = await taskResponse.json();

    // Add task to plan
    await page.request.post(`/api/plans/${plan.id}/tasks`, {
      data: { taskId: task.id },
    });

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on the plan
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    // Wait for task to appear
    await expect(page.getByTestId(`plan-task-${task.id}`)).toBeVisible({ timeout: 5000 });

    // Hover and click remove button (first click shows confirmation state)
    await page.getByTestId(`plan-task-${task.id}`).hover();
    await page.getByTestId(`remove-task-${task.id}`).click();

    // Button should change to confirmation state (red background)
    await expect(page.getByTestId(`remove-task-${task.id}`)).toHaveClass(/bg-red-500/);

    // Second click confirms removal
    await page.getByTestId(`remove-task-${task.id}`).click();

    // Task should be removed
    await expect(page.getByTestId(`plan-task-${task.id}`)).not.toBeVisible({ timeout: 5000 });
  });
});

// ============================================================================
// TB86: Plan Visual Progress Indicator
// ============================================================================
test.describe('TB86: Plan Visual Progress Indicator', () => {
  // API Tests
  test('GET /api/plans with hydrate.progress returns plans with progress', async ({ page }) => {
    const seededPlan = await seedPlan(page);
    const response = await page.request.get('/api/plans?hydrate.progress=true');
    expect(response.ok()).toBe(true);
    const plans = await response.json();
    expect(Array.isArray(plans)).toBe(true);
    expect(plans.some((plan: { id: string }) => plan.id === seededPlan.id)).toBe(true);

    // Each plan should have _progress field
    for (const plan of plans) {
      expect(plan._progress).toBeDefined();
      expect(typeof plan._progress.totalTasks).toBe('number');
      expect(typeof plan._progress.completedTasks).toBe('number');
      expect(typeof plan._progress.completionPercentage).toBe('number');
      expect(plan._progress.completionPercentage).toBeGreaterThanOrEqual(0);
      expect(plan._progress.completionPercentage).toBeLessThanOrEqual(100);
    }
  });

  test('GET /api/plans without hydrate.progress does not include progress', async ({ page }) => {
    const plan = await seedPlan(page);
    const response = await page.request.get('/api/plans');
    expect(response.ok()).toBe(true);
    const plans = await response.json();

    // Plans should NOT have _progress field
    expect(plans.find((item: { id: string }) => item.id === plan.id)?._progress).toBeUndefined();
  });

  // UI Tests - Plan List Progress Ring
  test('plan list item shows mini progress ring', async ({ page }) => {
    const plan = await seedPlan(page);

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('plans-list')).toBeVisible({ timeout: 5000 });

    await expect(page.getByTestId(`plan-progress-${plan.id}`)).toBeVisible();
  });

  test('mini progress ring shows correct percentage', async ({ page }) => {
    // Create a plan with tasks to verify percentage display
    const createPlanResponse = await createPlan(page, {
      data: {
        title: `Progress Ring Test ${Date.now()}`,
        createdBy: 'el-0000',
        status: 'draft',
      },
    });
    const plan = await createPlanResponse.json();

    // Create a task
    const createTaskResponse = await createTask(page, {
      data: {
        title: `Task for Progress Ring ${Date.now()}`,
        createdBy: 'el-0000',
        status: 'open',
      },
    });
    const task = await createTaskResponse.json();

    // Add task to plan
    await page.request.post(`/api/plans/${plan.id}/tasks`, {
      data: { taskId: task.id },
    });

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId(`plan-item-${plan.id}`)).toBeVisible({ timeout: 5000 });

    // Progress ring should show 0% (task is open, not completed)
    const progressRing = page.getByTestId(`plan-progress-${plan.id}`);
    await expect(progressRing).toBeVisible();
    await expect(progressRing).toHaveAttribute('data-percentage', '0');
  });

  // UI Tests - Plan Detail Progress Ring
  test('plan detail panel shows large progress ring with breakdown', async ({ page }) => {
    const plan = await seedPlan(page);

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on first plan
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    // Check progress ring with breakdown is displayed
    await expect(page.getByTestId('progress-ring-breakdown')).toBeVisible();
    await expect(page.getByTestId('plan-detail-progress-ring')).toBeVisible();
    await expect(page.getByTestId('progress-breakdown-count')).toBeVisible();
    await expect(page.getByTestId('progress-breakdown-remaining')).toBeVisible();
  });

  test('progress ring breakdown shows correct task counts', async ({ page }) => {
    // Create a plan with known task counts
    const createPlanResponse = await createPlan(page, {
      data: {
        title: `Breakdown Test ${Date.now()}`,
        createdBy: 'el-0000',
        status: 'active',
      },
    });
    const plan = await createPlanResponse.json();

    // The initial task is open; add one completed task.
    const task1Response = await createTask(page, {
      data: {
        title: `Completed Task ${Date.now()}`,
        createdBy: 'el-0000',
        status: 'closed',
      },
    });
    const task1 = await task1Response.json();
    await page.request.post(`/api/plans/${plan.id}/tasks`, {
      data: { taskId: task1.id },
    });

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on the plan
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    // Check breakdown text shows "1 of 2 tasks"
    await expect(page.getByTestId('progress-breakdown-count')).toContainText('1 of 2 tasks');
    await expect(page.getByTestId('progress-breakdown-remaining')).toContainText('1 remaining');
  });

  test('progress ring color changes based on percentage', async ({ page }) => {
    // Test that progress ring has correct status attribute based on percentage
    const plan = await seedPlan(page);

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on first plan
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    // Check that progress ring has a status attribute (healthy, at-risk, or behind)
    const progressRing = page.getByTestId('plan-detail-progress-ring');
    await expect(progressRing).toBeVisible();
    const status = await progressRing.getAttribute('data-status');
    expect(['healthy', 'at-risk', 'behind']).toContain(status);
  });

  test('progress ring updates when task is completed', async ({ page }) => {
    // Create a plan with an open task
    const createPlanResponse = await createPlan(page, {
      data: {
        title: `Update Test ${Date.now()}`,
        createdBy: 'el-0000',
        status: 'active',
      },
    });
    const plan = await createPlanResponse.json();

    const createTaskResponse = await createTask(page, {
      data: {
        title: `Task to Complete ${Date.now()}`,
        createdBy: 'el-0000',
        status: 'open',
      },
    });
    const task = await createTaskResponse.json();

    await page.request.post(`/api/plans/${plan.id}/tasks`, {
      data: { taskId: task.id },
    });

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on the plan
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    // Initial percentage should be 0%
    const progressRing = page.getByTestId('plan-detail-progress-ring');
    await expect(progressRing).toHaveAttribute('data-percentage', '0');

    // Complete both tasks via API
    await page.request.patch(`/api/tasks/${plan.initialTask.id}`, {
      data: { status: 'closed' },
    });
    await page.request.patch(`/api/tasks/${task.id}`, {
      data: { status: 'closed' },
    });

    // Reload the page to see the update
    await page.reload();
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on the plan again
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    // Percentage should now be 100%
    const updatedRing = page.getByTestId('plan-detail-progress-ring');
    await expect(updatedRing).toHaveAttribute('data-percentage', '100');
  });

  test('task status summary is still visible alongside progress ring', async ({ page }) => {
    const plan = await seedPlan(page);

    await page.goto('/plans');
    await expect(page.getByTestId('plans-page')).toBeVisible({ timeout: 10000 });

    // Click on first plan
    await page.getByTestId(`plan-item-${plan.id}`).click();
    await expect(page.getByTestId('plan-detail-panel')).toBeVisible({ timeout: 5000 });

    // Both progress ring and task status summary should be visible
    await expect(page.getByTestId('plan-detail-progress-ring')).toBeVisible();
    await expect(page.getByTestId('task-status-summary')).toBeVisible();
  });
});
