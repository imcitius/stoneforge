import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createTask, TaskStatus, type EntityId } from '@stoneforge/core';
import { createQuarryAPI } from '@stoneforge/quarry';
import { getFormatter } from '@stoneforge/quarry/cli';
import { createStorage, initializeSchema } from '@stoneforge/storage';
import { cleanupMergedTask } from './task-merge-cleanup.js';

const execFileAsync = promisify(execFile);

describe('merged task cleanup with real Git worktrees', () => {
  let root: string;
  let repo: string;
  let worktree: string;
  const branch = 'agent/worker/task';
  const git = async (...args: string[]) =>
    (await execFileAsync('git', args, { cwd: repo, encoding: 'utf8' })).stdout.trim();
  const cleanup = (worktreePath: string | undefined = worktree) => cleanupMergedTask({
    workspaceRoot: repo, sourceBranch: branch, targetBranch: 'main', worktreePath,
  });
  const branchExists = async () => (await git('branch', '--list', branch)).length > 0;
  const remoteExists = async () => (await git('ls-remote', '--heads', 'origin', branch)).length > 0;
  const merge = async () => {
    await git('merge', '--no-ff', branch, '-m', 'Merge task');
    await git('push', 'origin', 'main');
  };

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'sf-task-cleanup-'));
    repo = path.join(root, 'repo');
    worktree = path.join(root, 'task worktree');
    mkdirSync(repo);
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'Cleanup Test');
    await git('config', 'user.email', 'cleanup@example.test');
    await git('config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(repo, '.gitignore'), '.stoneforge/\n');
    await git('add', '.gitignore');
    await git('commit', '-m', 'Initial');
    await git('init', '--bare', path.join(root, 'remote.git'));
    await git('remote', 'add', 'origin', path.join(root, 'remote.git'));
    await git('push', '-u', 'origin', 'main');
    await git('worktree', 'add', '-b', branch, worktree);
    writeFileSync(path.join(worktree, 'feature.txt'), 'task work\n');
    await git('-C', worktree, 'add', 'feature.txt');
    await git('-C', worktree, 'commit', '-m', 'Task change');
    await git('push', 'origin', branch);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('removes the owned worktree before safe local and remote branch deletion', async () => {
    await merge();
    // This is the original ordering defect: even a merged branch cannot be
    // deleted while it is checked out in its task worktree.
    await expect(git('branch', '-d', branch)).rejects.toThrow();
    await cleanup();
    expect(existsSync(worktree)).toBe(false);
    expect(await branchExists()).toBe(false);
    expect(await remoteExists()).toBe(false);
    expect(await git('worktree', 'list', '--porcelain')).not.toContain(worktree);
    await cleanup(); // Already absent resources are harmless.
  });

  test.each(['untracked', 'modified', 'locked'])('retains worktree and branches when worktree is %s', async kind => {
    await merge();
    const file = path.join(worktree, kind === 'untracked' ? 'user.txt' : 'feature.txt');
    if (kind === 'locked') await git('worktree', 'lock', worktree);
    else writeFileSync(file, 'user work\n');
    await expect(cleanup()).rejects.toThrow();
    expect(existsSync(worktree)).toBe(true);
    expect(await branchExists()).toBe(true);
    expect(await remoteExists()).toBe(true);
    if (kind !== 'locked') expect(readFileSync(file, 'utf8')).toBe('user work\n');
  });

  test('retains an unmerged branch even when its own upstream contains every commit', async () => {
    await git('branch', '--set-upstream-to', `origin/${branch}`, branch);
    await expect(cleanup()).rejects.toThrow('fully merged into origin/main');
    expect(await branchExists()).toBe(true);
    expect(await remoteExists()).toBe(true);
    expect(existsSync(worktree)).toBe(true);
  });

  test('retains squash-merged history instead of forcing deletion', async () => {
    await git('merge', '--squash', branch);
    await git('commit', '-m', 'Squash task');
    await git('push', 'origin', 'main');
    await expect(cleanup()).rejects.toThrow('Squash merges do not establish ancestry');
    expect(await branchExists()).toBe(true);
    expect(await remoteExists()).toBe(true);
    expect(existsSync(worktree)).toBe(true);
  });

  test('does not remove a worktree whose branch no longer matches task metadata', async () => {
    await merge();
    await git('-C', worktree, 'switch', '-c', 'other-task');
    await expect(cleanup()).rejects.toThrow('not an owned task worktree');
    expect(existsSync(worktree)).toBe(true);
    expect(await branchExists()).toBe(true);
  });

  test('does not remove another worktree that still checks out the task branch', async () => {
    await merge();
    const moved = path.join(root, 'other worktree');
    await git('worktree', 'move', worktree, moved);
    await expect(cleanup()).rejects.toThrow('still checked out in worktree');
    expect(existsSync(moved)).toBe(true);
    expect(await branchExists()).toBe(true);
  });

  test('reports safe branch deletion refusal and retains the remote branch', async () => {
    await merge();
    // Git -d consults upstream rather than HEAD when one is configured.
    await git('branch', 'old-upstream', 'main~1');
    await git('branch', '--set-upstream-to', 'old-upstream', branch);
    await expect(cleanup()).rejects.toThrow('not fully merged');
    expect(existsSync(worktree)).toBe(false);
    expect(await branchExists()).toBe(true);
    expect(await remoteExists()).toBe(true);
  });

  test('retains a remote branch that advanced beyond the merged local branch', async () => {
    await merge();
    const mergedTip = await git('rev-parse', branch);
    await git('-C', worktree, 'commit', '--allow-empty', '-m', 'Later work');
    await git('push', 'origin', branch);
    await git('-C', worktree, 'reset', '--soft', mergedTip);
    await expect(cleanup()).rejects.toThrow('fully merged into origin/main');
    expect(await branchExists()).toBe(true);
    expect(await remoteExists()).toBe(true);
    expect(existsSync(worktree)).toBe(true);
  });

  test('reports remote deletion failure after successful local cleanup', async () => {
    await merge();
    await git('--git-dir', path.join(root, 'remote.git'), 'config', 'receive.denyDeletes', 'true');
    await expect(cleanup()).rejects.toThrow('deletion prohibited');
    expect(existsSync(worktree)).toBe(false);
    expect(await branchExists()).toBe(false);
    expect(await remoteExists()).toBe(true);
  });

  // Run the real command handler in a child process: no global cwd/env changes
  // and no module mocks that could contaminate other Bun tests.
  async function runMergeHandler(mode: 'json' | 'quiet', dirty: boolean) {
    mkdirSync(path.join(repo, '.stoneforge'));
    const db = path.join(repo, '.stoneforge', 'stoneforge.db');
    const storage = createStorage({ path: db, create: true });
    initializeSchema(storage);
    const api = createQuarryAPI(storage);
    const task = await api.create(await createTask({
      title: 'Task cleanup regression', createdBy: 'system:test' as EntityId,
      status: TaskStatus.REVIEW,
      metadata: { orchestrator: { branch, targetBranch: 'main', worktree } },
    }));
    if (dirty) writeFileSync(path.join(worktree, 'user.txt'), 'keep me');
    const moduleUrl = new URL('../cli/commands/task.ts', import.meta.url).href;
    const script = `
      const { taskMergeCommand } = await import(${JSON.stringify(moduleUrl)});
      const result = await taskMergeCommand.handler([${JSON.stringify(task.id)}],
        ${JSON.stringify({ db, [mode]: true })});
      console.log(JSON.stringify(result));
    `;
    try {
      const { stdout } = await execFileAsync(process.execPath, ['-e', script], {
        cwd: repo, encoding: 'utf8', env: { ...process.env, STONEFORGE_ROOT: repo },
      });
      const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
      const saved = await api.get(task.id);
      expect(saved?.status, JSON.stringify(result)).toBe(TaskStatus.CLOSED);
      expect(saved?.metadata.orchestrator).toMatchObject({ mergeStatus: 'merged' });
      return result;
    } finally {
      storage.close();
    }
  }

  test('task merge handler cleans up an already merged task and closes it', async () => {
    await merge();
    const result = await runMergeHandler('json', false);
    expect(result.exitCode).toBe(0);
    expect(existsSync(worktree)).toBe(false);
    expect(await branchExists()).toBe(false);
    expect(await remoteExists()).toBe(false);
  }, 30_000);

  test('task merge handler preserves squash-only history while recording a successful merge', async () => {
    const result = await runMergeHandler('json', false);
    expect(result.exitCode).toBe(1);
    expect(result.data.cleanupError).toContain('Squash merges do not establish ancestry');
    expect(await git('show', 'origin/main:feature.txt')).toBe('task work');
    expect(await branchExists()).toBe(true);
    expect(await remoteExists()).toBe(true);
    expect(existsSync(worktree)).toBe(true);
  }, 30_000);

  test.each(['json', 'quiet'] as const)('task merge handler reports cleanup failure in %s mode without undoing merge status', async mode => {
    await merge();
    const result = await runMergeHandler(mode, true);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('was merged and is CLOSED, but cleanup failed');
    expect(getFormatter(mode).error(result)).toContain('was merged and is CLOSED, but cleanup failed');
    expect(result.data.cleanupError).toContain('worktree remove');
    expect(result.data.mergeStatus).toBe('merged');
    expect(readFileSync(path.join(worktree, 'user.txt'), 'utf8')).toBe('keep me');
    expect(await branchExists()).toBe(true);
    expect(await remoteExists()).toBe(true);
  }, 30_000);
});
