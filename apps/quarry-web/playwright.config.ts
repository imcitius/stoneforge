import { defineConfig, devices } from '@playwright/test';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { TEST_API_PORT, TEST_WEB_PORT } from './tests/e2e-ports';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
const testDbPath = resolve(projectRoot, '.stoneforge-test/stoneforge.db');

// Dedicated test ports (see tests/e2e-ports.ts) avoid conflicts with development servers
const testApiPort = TEST_API_PORT;
const testWebPort = TEST_WEB_PORT;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  globalSetup: './tests/global-setup.ts',
  globalTeardown: './tests/global-teardown.ts',
  use: {
    baseURL: `http://localhost:${testWebPort}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      // Auto-export is disabled so the e2e server does not write
      // apps/quarry-server/.stoneforge/sync/*.jsonl (its export dir is cwd-relative).
      command: `STONEFORGE_DB_PATH=${testDbPath} STONEFORGE_SYNC_AUTO_EXPORT=false PORT=${testApiPort} bun run src/index.ts`,
      cwd: resolve(__dirname, '../quarry-server'),
      port: testApiPort,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `VITE_API_PORT=${testApiPort} bun run dev -- --port ${testWebPort}`,
      port: testWebPort,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
