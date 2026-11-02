/**
 * Plugin API Integration Tests
 *
 * Tests for TB-O23a: Plugin System REST endpoints
 *
 * These tests verify the plugin API endpoints work correctly.
 * They spawn the orchestrator server against an isolated temporary project
 * (own cwd, STONEFORGE_ROOT, database, OS-assigned port, daemon disabled) so
 * they never touch an enclosing live workspace or its default port.
 */

import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import { resolve, dirname, join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Integration tests spawn an orchestrator server which can take time to start.
// The default 5000ms test timeout is too short for beforeAll server startup.
// Use STARTUP_TIMEOUT_MS + buffer for individual test execution time.
setDefaultTimeout(30_000);

// Test configuration
const STARTUP_POLL_INTERVAL_MS = 100;
// Orchestrator startup can take several seconds (git/worktree init, session restore).
// Use a generous timeout to avoid flaky startup failures on slower machines/CI.
const STARTUP_TIMEOUT_MS = Number(process.env.ORCHESTRATOR_TEST_STARTUP_TIMEOUT_MS ?? 20_000);
const TEST_HOST = '127.0.0.1';

// Server process and its isolated project
let serverProcess: Subprocess<'ignore', 'pipe', 'pipe'> | null = null;
let projectRoot = '';
let dbPath = '';
let SERVER_URL = '';

// ============================================================================
// Server Lifecycle
// ============================================================================

/**
 * Inherited variables that would point the spawned server at another project,
 * port or daemon. Agent and Desktop shells set several of these for the live
 * workspace; the test server must never see them.
 */
const INHERITED_ENV_TO_STRIP = new Set(['PORT', 'ORCHESTRATOR_PORT', 'HOST', 'DAEMON_AUTO_START', 'LOG_LEVEL']);

/**
 * Build the environment for the spawned server: strip Stoneforge/agent/port
 * variables and point it at a temporary project so it can neither open the
 * enclosing live project's database nor bind the default port.
 */
function buildIsolatedServerEnv(
  baseEnv: Record<string, string | undefined>,
  root: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (key.startsWith('STONEFORGE_') || key.startsWith('SF_') || INHERITED_ENV_TO_STRIP.has(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    STONEFORGE_ROOT: root,
    STONEFORGE_DB_PATH: join(root, '.stoneforge', 'stoneforge.db'),
    STONEFORGE_UPLOAD_DIR: join(root, '.stoneforge', 'uploads', 'terminal'),
    // Port 0: the OS picks a free port; the server logs the bound port.
    PORT: '0',
    HOST: TEST_HOST,
    DAEMON_AUTO_START: 'false',
    LOG_LEVEL: 'info',
  };
}

function createTestProject(): void {
  // realpath: macOS tmpdir is a symlink (/var -> /private/var)
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'stoneforge-plugin-api-test-')));
  mkdirSync(join(projectRoot, '.stoneforge'), { recursive: true });
  dbPath = join(projectRoot, '.stoneforge', 'stoneforge.db');
}

function removeTestProject(): void {
  if (projectRoot) {
    try {
      rmSync(projectRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

async function startServer(): Promise<void> {
  const serverPath = resolve(dirname(import.meta.path), 'index.ts');

  // cwd is the temp project: the server derives PROJECT_ROOT (daemon state,
  // plugin command cwd) from process.cwd().
  serverProcess = spawn({
    cmd: ['bun', 'run', serverPath],
    cwd: projectRoot,
    env: buildIsolatedServerEnv(process.env, projectRoot),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Stream stdout so the bound port can be read while the server keeps running.
  let stdout = '';
  let boundPort: number | null = null;
  const decoder = new TextDecoder();
  const stdoutPromise = (async () => {
    try {
      for await (const chunk of serverProcess!.stdout) {
        stdout += decoder.decode(chunk, { stream: true });
        if (boundPort === null) {
          const match = stdout.match(/Server running at http:\/\/[^\s:]+:(\d+)/);
          if (match) boundPort = Number(match[1]);
        }
      }
    } catch {
      // Process killed
    }
    return stdout;
  })();
  const stderrPromise = serverProcess.stderr
    ? new Response(serverProcess.stderr).text().catch(() => '')
    : Promise.resolve('');

  let exitCode: number | null = null;
  serverProcess.exited
    .then((code) => {
      exitCode = code;
    })
    .catch(() => {
      exitCode = -1;
    });

  const truncateOutput = (text: string, max = 4000) => {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n... (truncated ${text.length - max} chars)`;
  };

  // Wait for server to start
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exitCode !== null) {
      const [out, err] = await Promise.all([stdoutPromise, stderrPromise]);
      throw new Error(
        `Server exited before startup (exit code ${exitCode}).\n` +
          `stdout:\n${truncateOutput(out)}\n` +
          `stderr:\n${truncateOutput(err)}`
      );
    }
    if (boundPort !== null) {
      try {
        const url = `http://${TEST_HOST}:${boundPort}`;
        const response = await fetch(`${url}/api/health`);
        if (response.ok) {
          SERVER_URL = url;
          console.log(`[test] Server started successfully on port ${boundPort}`);
          return;
        }
      } catch {
        // Server not ready yet
      }
    }
    await Bun.sleep(STARTUP_POLL_INTERVAL_MS);
  }

  if (serverProcess) {
    serverProcess.kill();
  }
  const [out, err] = await Promise.all([stdoutPromise, stderrPromise]);
  throw new Error(
    `Server failed to start within ${STARTUP_TIMEOUT_MS}ms.\n` +
      `stdout:\n${truncateOutput(out)}\n` +
      `stderr:\n${truncateOutput(err)}`
  );
}

async function stopServer(): Promise<void> {
  if (serverProcess) {
    serverProcess.kill();
    await serverProcess.exited.catch(() => undefined);
    serverProcess = null;
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('Plugin API Integration Tests', () => {
  beforeAll(async () => {
    createTestProject();
    await startServer();
  });

  afterAll(async () => {
    await stopServer();
    removeTestProject();
  });

  describe('test isolation', () => {
    it('runs the server against a temporary project, not the enclosing workspace', () => {
      expect(existsSync(dbPath)).toBe(true);
      expect(SERVER_URL).not.toBe('http://localhost:3457');
    });

    it('strips inherited Stoneforge and agent environment', () => {
      const env = buildIsolatedServerEnv(
        {
          PATH: '/usr/bin',
          STONEFORGE_ROOT: '/live/project',
          STONEFORGE_DB_PATH: '/live/project/.stoneforge/stoneforge.db',
          STONEFORGE_DESKTOP_INSTANCE_ID: 'desktop-instance',
          STONEFORGE_SESSION_ID: 'session',
          SF_ENTITY_ID: 'el-worker',
          ORCHESTRATOR_PORT: '3457',
          PORT: '3457',
          DAEMON_AUTO_START: 'true',
        },
        '/tmp/isolated',
      );
      expect(env).toEqual({
        PATH: '/usr/bin',
        STONEFORGE_ROOT: '/tmp/isolated',
        STONEFORGE_DB_PATH: '/tmp/isolated/.stoneforge/stoneforge.db',
        STONEFORGE_UPLOAD_DIR: '/tmp/isolated/.stoneforge/uploads/terminal',
        PORT: '0',
        HOST: TEST_HOST,
        DAEMON_AUTO_START: 'false',
        LOG_LEVEL: 'info',
      });
    });
  });

  describe('GET /api/plugins/builtin', () => {
    it('should list all built-in plugins', async () => {
      const response = await fetch(`${SERVER_URL}/api/plugins/builtin`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.plugins).toBeDefined();
      expect(Array.isArray(data.plugins)).toBe(true);
      expect(data.count).toBeGreaterThan(0);

      // Check for expected built-in plugins
      const names = data.plugins.map((p: { name: string }) => p.name);
      expect(names).toContain('gc-ephemeral-tasks');
      expect(names).toContain('cleanup-stale-worktrees');
      expect(names).toContain('gc-ephemeral-workflows');
      expect(names).toContain('health-check-agents');
    });
  });

  describe('GET /api/plugins/builtin/:name', () => {
    it('should get details of a built-in plugin', async () => {
      const response = await fetch(`${SERVER_URL}/api/plugins/builtin/gc-ephemeral-tasks`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.plugin).toBeDefined();
      expect(data.plugin.name).toBe('gc-ephemeral-tasks');
      expect(data.plugin.type).toBe('command');
      expect(data.plugin.command).toContain('sf gc workflows');
    });

    it('should return 404 for unknown plugin', async () => {
      const response = await fetch(`${SERVER_URL}/api/plugins/builtin/unknown-plugin`);
      expect(response.ok).toBe(false);
      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/plugins/validate', () => {
    it('should validate a valid command plugin', async () => {
      const response = await fetch(`${SERVER_URL}/api/plugins/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'command',
          name: 'test-plugin',
          command: 'echo hello',
        }),
      });
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.valid).toBe(true);
      expect(data.errors).toHaveLength(0);
    });

    it('should reject an invalid plugin', async () => {
      const response = await fetch(`${SERVER_URL}/api/plugins/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'command',
          name: '', // Empty name
          command: 'echo hello',
        }),
      });
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.valid).toBe(false);
      expect(data.errors.length).toBeGreaterThan(0);
    });
  });

  describe('POST /api/plugins/execute', () => {
    it('should execute a simple command plugin', async () => {
      const response = await fetch(`${SERVER_URL}/api/plugins/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plugin: {
            type: 'command',
            name: 'echo-test',
            command: 'echo "hello from test"',
          },
        }),
      });
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.result).toBeDefined();
      expect(data.result.success).toBe(true);
      expect(data.result.pluginName).toBe('echo-test');
      expect(data.result.pluginType).toBe('command');
      expect(data.result.stdout).toContain('hello from test');
      expect(data.result.exitCode).toBe(0);
      expect(data.result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should capture exit code for failed commands', async () => {
      const response = await fetch(`${SERVER_URL}/api/plugins/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plugin: {
            type: 'command',
            name: 'fail-test',
            command: 'exit 42',
          },
        }),
      });
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.result.success).toBe(false);
      expect(data.result.exitCode).toBe(42);
    });
  });

  describe('POST /api/plugins/execute-batch', () => {
    it('should execute multiple plugins in sequence', async () => {
      const response = await fetch(`${SERVER_URL}/api/plugins/execute-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plugins: [
            { type: 'command', name: 'first', command: 'echo "first"' },
            { type: 'command', name: 'second', command: 'echo "second"' },
          ],
        }),
      });
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.total).toBe(2);
      expect(data.succeeded).toBe(2);
      expect(data.failed).toBe(0);
      expect(data.allSucceeded).toBe(true);
      expect(data.results).toHaveLength(2);
    });

    it('should continue on error by default', async () => {
      const response = await fetch(`${SERVER_URL}/api/plugins/execute-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plugins: [
            { type: 'command', name: 'first', command: 'echo "first"' },
            { type: 'command', name: 'fail', command: 'exit 1' },
            { type: 'command', name: 'third', command: 'echo "third"' },
          ],
        }),
      });
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.total).toBe(3);
      expect(data.succeeded).toBe(2);
      expect(data.failed).toBe(1);
      expect(data.skipped).toBe(0);
      expect(data.allSucceeded).toBe(false);
    });

    it('should stop on error when option is set', async () => {
      const response = await fetch(`${SERVER_URL}/api/plugins/execute-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plugins: [
            { type: 'command', name: 'first', command: 'echo "first"' },
            { type: 'command', name: 'fail', command: 'exit 1' },
            { type: 'command', name: 'third', command: 'echo "third"' },
          ],
          options: { stopOnError: true },
        }),
      });
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.total).toBe(3);
      expect(data.succeeded).toBe(1);
      expect(data.failed).toBe(1);
      expect(data.skipped).toBe(1);
    });
  });

  describe('POST /api/plugins/execute-builtin/:name', () => {
    it('should execute a built-in plugin by name', async () => {
      // Execute cleanup-stale-worktrees which runs git worktree prune
      // This should work in any git repository
      const response = await fetch(`${SERVER_URL}/api/plugins/execute-builtin/cleanup-stale-worktrees`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.result).toBeDefined();
      expect(data.result.pluginName).toBe('cleanup-stale-worktrees');
      expect(data.result.pluginType).toBe('command');
      // Note: May succeed or fail depending on git setup, but should have valid structure
      expect(typeof data.result.success).toBe('boolean');
    });

    it('should return 404 for unknown built-in plugin', async () => {
      const response = await fetch(`${SERVER_URL}/api/plugins/execute-builtin/unknown-plugin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.ok).toBe(false);
      expect(response.status).toBe(404);
    });
  });
});
