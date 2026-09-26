import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repository = resolve(import.meta.dir, '../../../../..');
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(STONEFORGE_|SF_)/.test(key) || ['ORCHESTRATOR_URL', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete env[key];
}
let workspace: string;
let server: ReturnType<typeof Bun.serve>;
let state: unknown;
let stopBody: unknown;
let statusCode: number;
let stopCode: number;
let rawStatus: string | undefined;
let rawStop: string | undefined;
let requests: string[];

beforeAll(() => {
  // Exercise the freshly built Node CLI, including parsing, routing and exit/output formatting.
  execFileSync('pnpm', ['--filter', '@stoneforge/smithy...', 'build'], {
    cwd: repository, env, timeout: 120_000, stdio: 'pipe',
  });
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'sf-daemon-cli-')));
  mkdirSync(join(workspace, '.stoneforge/server.lock'), { recursive: true });
}, 120_000);

afterAll(() => { if (workspace) rmSync(workspace, { recursive: true, force: true }); });

beforeEach(() => {
  state = { isRunning: true };
  stopBody = { success: true, isRunning: false, message: 'Daemon stopped.' };
  statusCode = stopCode = 200;
  rawStatus = rawStop = undefined;
  requests = [];
  server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      // Isolated Desktop-style identity/authentication fixture; never consult live routing.
      if (request.headers.get('x-stoneforge-project') !== 'fixture-project' ||
          request.headers.get('x-stoneforge-instance') !== 'fixture-instance' ||
          request.headers.get('x-stoneforge-secret') !== 'fixture-secret') {
        return new Response('Unauthorized fixture request', { status: 401 });
      }
      const path = new URL(request.url).pathname;
      if (path === '/api/desktop/identity') {
        return Response.json({ projectId: 'fixture-project', instanceId: 'fixture-instance', projectRoot: workspace });
      }
      requests.push(`${request.method} ${path}`);
      if (path === '/api/daemon/status' && request.method === 'GET') {
        return rawStatus === undefined ? Response.json(state, { status: statusCode }) : new Response(rawStatus, { status: statusCode });
      }
      if (path === '/api/daemon/stop' && request.method === 'POST') {
        if (stopCode === 200) state = { isRunning: false };
        return rawStop === undefined ? Response.json(stopBody, { status: stopCode }) : new Response(rawStop, { status: stopCode });
      }
      return new Response('Unexpected fixture route', { status: 404 });
    },
  });
  writeFileSync(join(workspace, '.stoneforge/server.lock/desktop.json'), JSON.stringify({
    endpoint: server.url.origin, projectRoot: workspace, projectId: 'fixture-project',
    instanceId: 'fixture-instance', secret: 'fixture-secret',
  }));
});

afterEach(() => { server.stop(true); });

function run(args: string[], input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn('node', [join(repository, 'packages/smithy/dist/bin/sf.js'), 'daemon', ...args], {
      cwd: workspace, env: { ...env, STONEFORGE_ROOT: workspace }, stdio: 'pipe', timeout: 10_000,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) reject(new Error(`CLI terminated by ${signal}: ${stderr}`));
      else resolveResult({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

const runningStates = [
  { isRunning: true }, { isRunning: true, running: false, status: 'stopped' },
  { running: true }, { status: 'running' },
];
const stoppedStates = [
  { isRunning: false }, { isRunning: false, running: true, status: 'running' },
  { running: false }, { running: false, status: 'running' }, { status: 'stopped' }, { status: 'not_running' },
];

describe('daemon CLI state and readback', () => {
  for (const value of runningStates) {
    test(`stops running state ${JSON.stringify(value)} and reads back stopped`, async () => {
      state = value;
      expect((await run(['status', '--quiet'])).stdout).toBe('running\n');
      expect((await run(['status'])).stdout).toBe('Status:    running\n');
      requests = [];
      const result = await run(['stop', '--force', '--json']);
      expect(result).toEqual({ code: 0, stdout: JSON.stringify({ success: true, data: stopBody }, null, 2) + '\n', stderr: '' });
      expect(requests).toEqual(['GET /api/daemon/status', 'POST /api/daemon/stop']);
      const readback = await run(['status', '--quiet']);
      expect(readback).toEqual({ code: 0, stdout: 'stopped\n', stderr: '' });
    });
  }
  for (const value of stoppedStates) {
    test(`does not stop state ${JSON.stringify(value)}; status agrees in every mode`, async () => {
      state = value;
      const result = await run(['stop', '--force', '--json']);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ success: true, data: { status: 'not_running', message: 'Daemon is not running' } });
      expect(result.stderr).toBe('');
      expect(requests).toEqual(['GET /api/daemon/status']);
      expect((await run(['status', '--quiet'])).stdout).toBe('stopped\n');
      expect((await run(['status'])).stdout).toBe('Status:    stopped\n');
      expect(JSON.parse((await run(['status', '--json'])).stdout).data).toEqual(value);
    });
  }
  for (const mode of [[], ['--quiet'], ['--json']]) {
    test(`preserves stop output ${mode.join(' ')}`, async () => {
      const result = await run(['stop', '--force', ...mode]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe('');
      if (mode.includes('--json')) expect(JSON.parse(result.stdout).data).toEqual(stopBody);
      else expect(result.stdout).toBe(mode.includes('--quiet') ? 'stopped\n' : 'Daemon stopped.\n');
    });
  }
  test('preserves plain and quiet output when already stopped', async () => {
    state = { isRunning: false };
    expect(await run(['stop', '--force'])).toEqual({ code: 0, stdout: 'Daemon is not running\n', stderr: '' });
    expect(await run(['stop', '--force', '--quiet'])).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(requests).toEqual(['GET /api/daemon/status', 'GET /api/daemon/status']);
  });
  test('canonical stopped acknowledgement overrides legacy running output', async () => {
    stopBody = { isRunning: false, running: true, status: 'running' };
    expect(await run(['stop', '--force', '--quiet'])).toEqual({ code: 0, stdout: 'stopped\n', stderr: '' });
  });
  for (const reply of [{ status: 'stopped' }, { running: false }, { message: 'Legacy stop acknowledged' }]) {
    test(`accepts legacy stop acknowledgement ${JSON.stringify(reply)}`, async () => {
      stopBody = reply;
      const result = await run(['stop', '--force', '--json']);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).data).toEqual(reply);
    });
  }
  test('requires confirmation and preserves cancellation', async () => {
    const result = await run(['stop'], 'n\n');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Continue? (y/N): Cancelled');
    expect(requests).toEqual(['GET /api/daemon/status']);
  });
  test('confirmation sends stop', async () => {
    const result = await run(['stop'], 'yes\n');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Daemon stopped.');
    expect(requests).toEqual(['GET /api/daemon/status', 'POST /api/daemon/stop']);
  });
});

describe('daemon CLI failures', () => {
  const invalid = [null, [], 'running', {}, { isRunning: 'false', running: true }, { isRunning: null, status: 'running' }, { running: 1 }, { status: 'unknown' }];
  for (const value of invalid) {
    test(`rejects invalid status ${JSON.stringify(value)} without STOP or success`, async () => {
      state = value;
      for (const command of ['stop', 'status']) {
        const result = await run([command, ...(command === 'stop' ? ['--force'] : []), '--json']);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(JSON.parse(result.stderr).success).toBe(false);
        expect(result.stderr).toContain('Invalid daemon status response');
      }
      expect(requests).toEqual(['GET /api/daemon/status', 'GET /api/daemon/status']);
    });
  }
  for (const phase of ['status', 'stop']) {
    for (const mode of [[], ['--json'], ['--quiet']]) {
      test(`reports ${phase} HTTP failure (${mode.join(' ') || 'plain'})`, async () => {
        if (phase === 'status') { statusCode = 503; state = { error: { code: 'UNAVAILABLE', message: 'fixture unavailable' } }; }
        else { stopCode = 500; stopBody = { error: { code: 'INTERNAL_ERROR', message: 'fixture unavailable' } }; }
        const result = await run(['stop', '--force', ...mode]);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('fixture unavailable');
        expect(result.stderr).not.toContain('[object Object]');
        expect(requests.length).toBe(phase === 'status' ? 1 : 2);
      });
    }
    test(`rejects malformed JSON from ${phase}`, async () => {
      if (phase === 'status') rawStatus = '<html>bad response</html>';
      else rawStop = '<html>bad response</html>';
      const result = await run(['stop', '--force']);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Failed to');
    });
  }
  for (const value of [null, [], {}, { success: false, message: 'Stop rejected' }, { error: 'Stop rejected' }, { isRunning: true }, { running: true }, { status: 'running' }, { isRunning: 'false' }]) {
    test(`does not announce success for stop response ${JSON.stringify(value)}`, async () => {
      stopBody = value;
      const result = await run(['stop', '--force']);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Failed to stop daemon');
    });
  }
});
