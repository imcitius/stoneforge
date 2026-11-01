import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { TEST_API_URL } from './e2e-ports';

const execFileAsync = promisify(execFile);

// Derive paths from this file so the spec runs from any checkout location.
// Must match the test database used by playwright.config.ts and global-setup.ts.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const TEST_DB_PATH = resolve(REPO_ROOT, '.stoneforge-test/stoneforge.db');
const SF_CLI_PATH = resolve(REPO_ROOT, 'packages/quarry/dist/bin/sf.js');

// The dashboard route rendered by DashboardPage. `/` redirects to a lens chosen
// from localStorage settings, so tests navigate to the overview directly.
const DASHBOARD_PATH = '/dashboard/overview';

// Variables that bind the CLI to a live workspace or Desktop session. They are
// stripped so the CLI only touches the e2e test database passed with --db.
const WORKSPACE_ENV_VARS = [
  'STONEFORGE_ROOT',
  'STONEFORGE_DESKTOP_INSTANCE_ID',
  'STONEFORGE_SESSION_ID',
  'STONEFORGE_DB',
  'STONEFORGE_DB_PATH',
  'STONEFORGE_CONFIG',
  'STONEFORGE_UPLOAD_DIR',
];

function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of WORKSPACE_ENV_VARS) delete env[name];
  return env;
}

/**
 * Create a task through the built quarry CLI against the e2e test database.
 * Returns the new task ID.
 */
async function createTaskViaCli(title: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'bun',
    [SF_CLI_PATH, '--db', TEST_DB_PATH, '--json', 'create', 'task', '--title', title],
    { cwd: REPO_ROOT, env: cliEnv() },
  );
  // Plugin-loader warnings may precede the JSON document on stdout.
  const result = JSON.parse(stdout.slice(stdout.indexOf('{'))) as {
    success: boolean;
    data?: { id: string };
    error?: string;
  };
  if (!result.success || !result.data) {
    throw new Error(result.error ?? 'CLI reported failure without an error message');
  }
  return result.data.id;
}

/**
 * Create a task via the CLI. Skips the test only when the CLI has not been built;
 * any other CLI failure fails the test instead of hiding a regression.
 */
async function createTaskOrSkip(title: string): Promise<string> {
  test.skip(!existsSync(SF_CLI_PATH), `quarry CLI not built at ${SF_CLI_PATH}; run pnpm --filter @stoneforge/quarry build`);
  return createTaskViaCli(title);
}

/** The connection indicator in the app header (AppShell ConnectionStatus). */
function liveIndicator(page: Page) {
  return page.getByText('Live', { exact: true });
}

async function readMetricNumber(page: Page, testId: string): Promise<number> {
  const value = await page.getByTestId(testId).locator('p.font-semibold').textContent();
  return parseInt(value ?? '', 10);
}

test.describe('TB4: Real-time Updates (WebSocket)', () => {
  test('WebSocket endpoint is accessible', async () => {
    // Open a WebSocket directly against the API server (bypassing the Vite proxy)
    // and complete the upgrade handshake. A plain HTTP GET on /ws is not upgraded
    // and falls through to the HTTP router (404), so it is not a useful probe.
    const wsUrl = `${TEST_API_URL.replace(/^http/, 'ws')}/ws`;
    const opened = await new Promise<boolean>((resolvePromise, rejectPromise) => {
      const socket = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        socket.close();
        rejectPromise(new Error(`Timed out opening ${wsUrl}`));
      }, 5000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        socket.close();
        resolvePromise(true);
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        rejectPromise(new Error(`WebSocket connection to ${wsUrl} failed`));
      });
    });
    expect(opened).toBe(true);
  });

  test('connection indicator shows Live when connected', async ({ page }) => {
    await page.goto(DASHBOARD_PATH);

    await expect(liveIndicator(page)).toBeVisible({ timeout: 10000 });
  });

  test('UI updates when task is created via CLI', async ({ page }) => {
    await page.goto(DASHBOARD_PATH);

    await expect(page.getByTestId('dashboard-page')).toBeVisible();
    await expect(liveIndicator(page)).toBeVisible({ timeout: 10000 });

    // Wait for stats to load (the metric shows '...' while loading).
    const totalTasks = page.getByTestId('metric-total-tasks');
    await expect(totalTasks.locator('p.font-semibold')).toHaveText(/^\d+$/);
    const initialTotal = await readMetricNumber(page, 'metric-total-tasks');

    await createTaskOrSkip(`WebSocket Test Task ${Date.now()}`);

    // Without a reload, the WebSocket event invalidates the stats query and the
    // Total Tasks metric (ready + blocked) picks up the new open task.
    await expect(async () => {
      expect(await readMetricNumber(page, 'metric-total-tasks')).toBeGreaterThan(initialTotal);
    }).toPass({ timeout: 10000 });
  });

  test('client receives a WebSocket event for an element created via CLI', async ({ page }) => {
    const receivedElementIds = new Set<string>();
    page.on('websocket', (ws) => {
      if (!new URL(ws.url()).pathname.endsWith('/ws')) return; // ignore Vite HMR socket
      ws.on('framereceived', ({ payload }) => {
        try {
          const message = JSON.parse(payload.toString()) as {
            type?: string;
            event?: { elementId?: string };
          };
          if (message.type === 'event' && message.event?.elementId) {
            receivedElementIds.add(message.event.elementId);
          }
        } catch {
          // Ignore non-JSON frames
        }
      });
    });

    await page.goto(DASHBOARD_PATH);
    await expect(liveIndicator(page)).toBeVisible({ timeout: 10000 });

    const taskId = await createTaskOrSkip(`Real-time Event Test ${Date.now()}`);

    // The server broadcaster polls the database, so the CLI write reaches the client.
    await expect.poll(() => receivedElementIds.has(taskId), { timeout: 10000 }).toBe(true);
  });

  test('WebSocket reconnects after disconnect', async ({ page }) => {
    // Proxy the app's /ws connection so the test can drop it. Each new client
    // connection is forwarded to the real server.
    const connections: WebSocketRoute[] = [];
    await page.routeWebSocket(/\/ws$/, (ws) => {
      connections.push(ws);
      ws.connectToServer();
    });

    await page.goto(DASHBOARD_PATH);
    await expect(liveIndicator(page)).toBeVisible({ timeout: 10000 });
    // The app may hold more than one /ws client (e.g. dev-mode double mounts).
    const initial = connections.splice(0);
    expect(initial.length).toBeGreaterThan(0);

    // Drop every open connection; the client must notice and reconnect on its own.
    await Promise.all(initial.map((ws) => ws.close({ code: 1011, reason: 'test disconnect' })));

    await expect(page.getByText('Reconnecting...')).toBeVisible({ timeout: 5000 });
    await expect(liveIndicator(page)).toBeVisible({ timeout: 10000 });
    expect(connections.length).toBeGreaterThan(0);
    await expect(page.getByTestId('dashboard-page')).toBeVisible();
  });

  test('health endpoint shows WebSocket stats', async ({ page }) => {
    // First visit the page to establish a WebSocket connection
    await page.goto(DASHBOARD_PATH);
    await expect(liveIndicator(page)).toBeVisible({ timeout: 10000 });

    // Now check the health endpoint
    const response = await page.request.get('/api/health');
    expect(response.ok()).toBe(true);

    const health = await response.json();
    expect(health.websocket).toBeDefined();
    expect(typeof health.websocket.clients).toBe('number');
    expect(health.websocket.clients).toBeGreaterThanOrEqual(1);
    expect(typeof health.websocket.broadcasting).toBe('boolean');
  });

  test('system status section shows WebSocket status', async ({ page }) => {
    await page.goto(DASHBOARD_PATH);

    // Wait for WebSocket connection and page load
    await expect(liveIndicator(page)).toBeVisible({ timeout: 10000 });

    // The System Status section (formerly "Server Info") shows WebSocket stats
    await expect(page.getByRole('heading', { name: 'System Status' })).toBeVisible();
    await expect(page.getByText('WebSocket Clients')).toBeVisible();
    await expect(page.getByText('Broadcasting')).toBeVisible();
  });
});
