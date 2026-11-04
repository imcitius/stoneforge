/**
 * Test fixture: a minimal Desktop-style project server for CLI subprocess tests.
 *
 * Runs in its own child process (so tests may call the CLI with spawnSync),
 * writes `.stoneforge/server.lock/desktop.json` for `root` and serves the two
 * endpoints the CLI merge cleanup guard uses: `/api/desktop/identity` and
 * `/api/sessions`. Pass `env` to the CLI subprocess so it binds to this server.
 * Not exported from the package's testing index.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface FixtureSession {
  id: string;
  agentId?: string;
  status: string;
  worktree?: string;
  workingDirectory?: string;
}

export interface SessionServerFixture {
  env: Record<string, string>;
  /** Replace the sessions the server reports. */
  setSessions(sessions: FixtureSession[]): void;
  /** Number of /api/sessions requests received. */
  sessionRequests(): number;
  close(): Promise<void>;
}

const SERVER_SOURCE = `
const { createServer } = require('node:http');
const { appendFileSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const [root, state] = [process.env.FIXTURE_ROOT, process.env.FIXTURE_STATE];
const identity = { projectId: 'fixture-project', instanceId: 'fixture-instance', secret: 'fixture-secret' };
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.headers['x-stoneforge-project'] !== identity.projectId || req.headers['x-stoneforge-instance'] !== identity.instanceId ||
      req.headers['x-stoneforge-secret'] !== identity.secret) { res.statusCode = 403; res.end('{}'); return; }
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/api/desktop/identity') { res.end(JSON.stringify({ ...identity, projectRoot: root })); return; }
  if (url.pathname === '/api/sessions') {
    appendFileSync(join(state, 'requests'), 'x');
    const wanted = url.searchParams.get('status')?.split(',');
    const sessions = JSON.parse(readFileSync(join(state, 'sessions.json'), 'utf8'));
    res.end(JSON.stringify({ sessions: sessions.filter(s => !wanted || wanted.includes(s.status)) }));
    return;
  }
  res.statusCode = 404; res.end('{}');
});
server.listen(0, '127.0.0.1', () => {
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  mkdirSync(join(root, '.stoneforge/server.lock'), { recursive: true });
  writeFileSync(join(root, '.stoneforge/server.lock/desktop.json'), JSON.stringify({ endpoint, ...identity, projectRoot: root }));
  writeFileSync(join(state, 'ready'), endpoint);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

export async function startSessionServerFixture(root: string, sessions: FixtureSession[] = []): Promise<SessionServerFixture> {
  const state = mkdtempSync(path.join(tmpdir(), 'sf-session-fixture-'));
  writeFileSync(path.join(state, 'sessions.json'), JSON.stringify(sessions));
  writeFileSync(path.join(state, 'requests'), '');
  const lockDir = path.join(root, '.stoneforge/server.lock');
  mkdirSync(path.dirname(lockDir), { recursive: true });
  // Node or Bun, whichever runs the tests; both evaluate CommonJS with -e.
  const child: ChildProcess = spawn(process.execPath, ['-e', SERVER_SOURCE], {
    env: { ...process.env, FIXTURE_ROOT: root, FIXTURE_STATE: state },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const deadline = Date.now() + 10_000;
  while (!existsSync(path.join(state, 'ready'))) {
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('session server fixture did not start');
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return {
    env: { STONEFORGE_DESKTOP_INSTANCE_ID: 'fixture-instance' },
    setSessions(next) { writeFileSync(path.join(state, 'sessions.json'), JSON.stringify(next)); },
    sessionRequests: () => readFileSync(path.join(state, 'requests'), 'utf8').length,
    async close() {
      if (child.exitCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      rmSync(lockDir, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    },
  };
}
