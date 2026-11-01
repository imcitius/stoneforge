import type { Page } from '@playwright/test';

/**
 * Tour completion is stored per workspace on the backend. These specs share one
 * test server/database and run in parallel, so give every page its own
 * in-memory workspace record instead (starts not completed). Specs keep using
 * the legacy localStorage flag to start "completed": the client migrates it here.
 */
export async function mockOnboardingTourState(page: Page): Promise<void> {
  let status: 'completed' | 'dismissed' | null = null;
  await page.route('**/api/settings/onboarding-tour', async (route) => {
    if (route.request().method() === 'PUT') {
      status = (route.request().postDataJSON() as { status: typeof status }).status;
    }
    await route.fulfill({ json: { completed: status !== null, status, updatedAt: null } });
  });
}
