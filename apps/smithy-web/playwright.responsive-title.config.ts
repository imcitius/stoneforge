import { defineConfig, devices } from '@playwright/test';

// Real application styles, intercepted APIs, and no backend or shared project data.
export default defineConfig({
  testDir: './tests',
  testMatch: 'responsive-title.spec.ts',
  workers: 1,
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:5187', ...devices['Desktop Chrome'] },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 5187 --strictPort',
    port: 5187,
    reuseExistingServer: false,
    env: { VITE_API_PORT: '9' },
  },
});
