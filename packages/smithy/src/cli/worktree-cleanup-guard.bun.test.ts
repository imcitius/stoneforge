/**
 * el-2mlwrb: CLI merge cleanup must not remove a task worktree that another live
 * session still uses.
 *
 * Incident: merge steward session A ran `sf task merge <id> --local`; the daemon
 * had started a second session B of the same steward in the same task worktree.
 * The CLI's unconditional `git worktree remove --force` deleted the directory
 * while B was running its merge gate. The CLI has no SessionManager, so it asks
 * the workspace server for live sessions. These tests use real Git repositories,
 * a real SQLite database, the real CLI in a subprocess and a Desktop-style server
 * fixture that reports sessions.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createQuarryAPI, type QuarryAPI } from '@stoneforge/quarry';
import { createEntity, createTask, EntityTypeValue, TaskStatus, type EntityId, type Task } from '@stoneforge/core';
import { ProjectRepositories } from '../git/project-repositories.js';
import { getOrchestratorTaskMeta } from '../types/task-meta.js';
import { decideWorktreeCleanup } from './worktree-cleanup-guard.js';
import { findOtherLiveSessionInWorktree } from '../runtime/worktree-session-use.js';
import { startSessionServerFixture, type SessionServerFixture } from '../testing/session-server-fixture.js';

setDefaultTimeout(60_000);
const cliSource = path.resolve(import.meta.dir, '../bin/sf.ts');

describe('decideWorktreeCleanup', () => {
  const base = '/project';
  const wt = '/project/.stoneforge/.worktrees/core/task';

  test('another live session in the worktree retains it', async () => {
    const decision = await decideWorktreeCleanup({
      worktreePath: wt, base, callerSessionId: 'caller',
      listSessions: async () => [{ id: 'other', agentId: 'el-steward', status: 'running', workingDirectory: wt }],
    });
    expect(decision).toMatchObject({ remove: false, reason: 'in-use', sessionId: 'other', agentId: 'el-steward' });
  });

  test('a session working in a subdirectory of the worktree also retains it', async () => {
    const decision = await decideWorktreeCleanup({
      worktreePath: wt, base,
      listSessions: async () => [{ id: 'other', status: 'starting', workingDirectory: `${wt}/packages/smithy` }],
    });
    expect(decision).toMatchObject({ remove: false, reason: 'in-use', sessionId: 'other' });
  });

  test("the caller's own session, other worktrees and ended sessions allow removal", async () => {
    const decision = await decideWorktreeCleanup({
      worktreePath: wt, base, callerSessionId: 'caller',
      listSessions: async () => [
        { id: 'caller', status: 'running', worktree: wt },
        { id: 'elsewhere', status: 'running', worktree: `${wt}-other` },
        { id: 'ended', status: 'terminated', worktree: wt },
        { id: 'suspended', status: 'suspended', worktree: wt },
      ],
    });
    expect(decision).toEqual({ remove: true });
  });

  test('relative recorded paths resolve against the project root', () => {
    expect(findOtherLiveSessionInWorktree([{ id: 's', status: 'running', worktree: '.stoneforge/.worktrees/core/task' }], wt, base)?.id).toBe('s');
  });

  test('unknown liveness retains the worktree (fail-safe)', async () => {
    const decision = await decideWorktreeCleanup({
      worktreePath: wt, base,
      listSessions: async () => { throw new Error('No running server found for this workspace.'); },
    });
    expect(decision).toMatchObject({ remove: false, reason: 'unknown' });
    if (!decision.remove) expect(decision.message).toContain('No running server found');
  });
});

let root: string, repo: string, storage: StorageBackend, api: QuarryAPI, repositories: ProjectRepositories, owner: EntityId;
let server: SessionServerFixture | undefined;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const branchExists = (branch: string) => {
  try { git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`); return true; } catch { return false; }
};
function commit(cwd: string, file: string) {
  writeFileSync(path.join(cwd, file), file);
  git(cwd, 'add', file); git(cwd, 'commit', '-qm', file);
}

/** Async CLI run: the fixture server lives in this process and must keep serving. */
function cli(env: Record<string, string>, cwd: string, ...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const executable = process.env.SF_TEST_CLI ?? process.execPath;
  return new Promise(resolve => {
    execFile(executable, [...(process.env.SF_TEST_CLI ? [] : [cliSource]), ...args, '--json'], {
      cwd, encoding: 'utf8', timeout: 30_000,
      // Caller identity is explicit in each test; never inherit the agent's.
      env: { ...process.env, STONEFORGE_ROOT: root, STONEFORGE_SESSION_ID: '', STONEFORGE_DESKTOP_INSTANCE_ID: '', ...env },
    }, (error, stdout, stderr) => {
      resolve({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

async function reviewTask() {
  const raw = await createTask({ title: 'Guarded cleanup', createdBy: owner, metadata: { orchestrator: { repositoryId: 'core', targetBranch: 'master' } } });
  let task = await api.create<Task>(raw as unknown as Parameters<QuarryAPI['create']>[0]);
  const manager = await repositories.forTask(task);
  const worktree = await manager.createWorktree({ agentName: 'worker', taskId: task.id, customBranch: `agent/worker/${task.id}`, baseBranch: 'master' });
  task = (await api.get<Task>(task.id))!;
  task = await api.update<Task>(task.id, {
    status: TaskStatus.REVIEW, assignee: owner,
    metadata: { ...task.metadata, orchestrator: {
      ...getOrchestratorTaskMeta(task.metadata), branch: worktree.branch, worktree: worktree.path,
      assignedAgent: owner, sessionId: 'steward-a', mergeStatus: 'pending',
      sessionHistory: [{ sessionId: 'steward-a', agentId: owner, agentName: 'steward', agentRole: 'steward', startedAt: task.createdAt }],
    } },
  });
  commit(worktree.path, 'TASK');
  return { task, worktree };
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sf-cleanup-guard-')));
  repo = path.join(root, 'core'); mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master'); git(repo, 'config', 'user.email', 'test@example.com'); git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  commit(repo, 'README');
  mkdirSync(path.join(root, '.stoneforge'));
  storage = createStorage({ path: path.join(root, '.stoneforge/stoneforge.db') }); initializeSchema(storage); api = createQuarryAPI(storage);
  const entity = await createEntity({ name: 'steward', entityType: EntityTypeValue.AGENT, createdBy: 'system:test' as EntityId });
  owner = (await api.create(entity as unknown as Parameters<QuarryAPI['create']>[0])).id as unknown as EntityId;
  repositories = new ProjectRepositories(root, api);
  await repositories.add({ id: 'core', path: repo, targetBranch: 'master', delivery: 'local' });
});
afterEach(async () => {
  await server?.close(); server = undefined;
  storage.close(); rmSync(root, { recursive: true, force: true });
});

describe('sf task merge cleanup (REGRESSION el-2mlwrb)', () => {
  test('another live session in the task worktree: merge succeeds, worktree and branch are kept', async () => {
    const { task, worktree } = await reviewTask();
    server = await startSessionServerFixture(root, [
      { id: 'steward-a', agentId: owner, status: 'running', workingDirectory: worktree.path },
      { id: 'steward-b', agentId: owner, status: 'running', workingDirectory: worktree.path },
    ]);
    const result = await cli({ ...server.env, STONEFORGE_SESSION_ID: 'steward-a' }, worktree.path, 'task', 'merge', task.id, '--local');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(server.sessionRequests()).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.data?.worktreeCleanup ?? output.worktreeCleanup).toMatchObject({ removed: false, retainedReason: 'in-use', sessionId: 'steward-b' });

    expect(existsSync(path.join(worktree.path, 'TASK'))).toBe(true);
    expect(branchExists(worktree.branch)).toBe(true);
    expect(readFileSync(path.join(repo, 'TASK'), 'utf8')).toBe('TASK');
    const closed = (await api.get<Task>(task.id))!;
    expect(closed.status).toBe('closed');
    expect(closed.metadata.orchestrator).toMatchObject({ mergeStatus: 'merged' });
  });

  test('no other live session: worktree and branch are removed', async () => {
    const { task, worktree } = await reviewTask();
    server = await startSessionServerFixture(root, [
      { id: 'steward-a', agentId: owner, status: 'running', workingDirectory: worktree.path },
      { id: 'steward-b', agentId: owner, status: 'terminated', workingDirectory: worktree.path },
    ]);
    const result = await cli({ ...server.env, STONEFORGE_SESSION_ID: 'steward-a' }, worktree.path, 'task', 'merge', task.id, '--local');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(server.sessionRequests()).toBe(1);
    expect(existsSync(worktree.path)).toBe(false);
    expect(branchExists(worktree.branch)).toBe(false);
    expect((await api.get<Task>(task.id))!.status).toBe('closed');
  });

  test('live sessions cannot be determined (no server): merge succeeds, worktree is kept', async () => {
    const { task, worktree } = await reviewTask();
    const result = await cli({}, root, 'task', 'merge', task.id, '--local');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.data?.worktreeCleanup ?? output.worktreeCleanup).toMatchObject({ removed: false, retainedReason: 'unknown' });
    expect(existsSync(path.join(worktree.path, 'TASK'))).toBe(true);
    expect(branchExists(worktree.branch)).toBe(true);
    expect((await api.get<Task>(task.id))!.metadata.orchestrator).toMatchObject({ mergeStatus: 'merged' });
  });
});

describe('sf merge --cleanup (REGRESSION el-2mlwrb)', () => {
  test('keeps the source worktree and branch while another live session uses it', async () => {
    const { worktree } = await reviewTask();
    server = await startSessionServerFixture(root, [
      { id: 'other', agentId: owner, status: 'running', worktree: worktree.path },
    ]);
    const result = await cli({ ...server.env, STONEFORGE_SESSION_ID: 'caller' }, worktree.path, 'merge', '--cleanup');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(path.join(repo, 'TASK'), 'utf8')).toBe('TASK');
    expect(existsSync(path.join(worktree.path, 'TASK'))).toBe(true);
    expect(branchExists(worktree.branch)).toBe(true);
  });

  test('removes the source worktree and branch when only the caller uses it', async () => {
    const { worktree } = await reviewTask();
    server = await startSessionServerFixture(root, [
      { id: 'caller', agentId: owner, status: 'running', worktree: worktree.path },
    ]);
    const result = await cli({ ...server.env, STONEFORGE_SESSION_ID: 'caller' }, worktree.path, 'merge', '--cleanup');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(existsSync(worktree.path)).toBe(false);
    expect(branchExists(worktree.branch)).toBe(false);
  });
});
