/**
 * Ports used by the quarry-web Playwright e2e servers.
 *
 * Shared by playwright.config.ts (which starts the servers) and specs that must
 * reach the API server directly (bypassing the Vite proxy). The defaults avoid
 * the development servers (API 3456, web 5173); override them with
 * QUARRY_E2E_API_PORT / QUARRY_E2E_WEB_PORT to run several suites in parallel.
 */

function portFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${name} must be a TCP port number, got "${raw}"`);
  }
  return port;
}

export const TEST_API_PORT = portFromEnv('QUARRY_E2E_API_PORT', 3459);
export const TEST_WEB_PORT = portFromEnv('QUARRY_E2E_WEB_PORT', 5176);
export const TEST_API_URL = `http://localhost:${TEST_API_PORT}`;
