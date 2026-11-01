import { defineConfig, devices } from '@playwright/test';

// Real built backend + web UI in temporary workspaces. The spec starts and
// restarts its own servers on fresh ports; no shared project data.
// Prerequisite: pnpm --filter @stoneforge/smithy... build && pnpm --filter @stoneforge/smithy-web build:web
export default defineConfig({
  testDir: './tests',
  testMatch: 'onboarding-persistence.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: 'list',
  use: { ...devices['Desktop Chrome'] },
});
