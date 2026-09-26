import { defineConfig, devices } from '@playwright/test';

// Real cards and query hooks with intercepted HTTP; no backend or project database.
export default defineConfig({
  testDir: './tests',
  testMatch: 'active-agent-cache.spec.ts',
  workers: 1,
  retries: 0,
  expect: { timeout: 2000 },
  use: { baseURL: 'http://127.0.0.1:5188', ...devices['Desktop Chrome'] },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 5188 --strictPort',
    port: 5188,
    reuseExistingServer: false,
    env: { VITE_API_PORT: '9' },
  },
});
