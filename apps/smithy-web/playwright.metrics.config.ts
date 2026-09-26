import { defineConfig, devices } from '@playwright/test';

// Component fixture plus intercepted HTTP only. No backend or project database.
export default defineConfig({
  testDir: './tests',
  testMatch: 'metrics-coverage.spec.ts',
  workers: 1,
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:5186', ...devices['Desktop Chrome'] },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 5186 --strictPort',
    port: 5186,
    reuseExistingServer: false,
    env: { VITE_API_PORT: '9' },
  },
});
