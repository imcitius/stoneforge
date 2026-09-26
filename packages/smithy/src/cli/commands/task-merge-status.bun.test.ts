/**
 * Task Merge-Status Command Tests
 *
 * Tests for the `sf task merge-status` CLI command, specifically the merge
 * verification logic when marking tasks as merged.
 */

import { describe, it, expect, mock } from 'bun:test';
import { parseArgs } from '@stoneforge/quarry/cli';
import { taskMergeStatusCommand, verifyMergeStatus } from './task.js';

// ============================================================================
// Command Structure Tests
// ============================================================================

describe('taskMergeStatusCommand structure', () => {
  it('should have correct name and description', () => {
    expect(taskMergeStatusCommand.name).toBe('merge-status');
    expect(taskMergeStatusCommand.description).toBe('Update the merge status of a task');
  });

  it('should have a handler', () => {
    expect(typeof taskMergeStatusCommand.handler).toBe('function');
  });

  it('should have the --force option', () => {
    expect(taskMergeStatusCommand.options).toBeDefined();
    const forceOpt = taskMergeStatusCommand.options!.find(o => o.name === 'force');
    expect(forceOpt).toBeDefined();
    expect(forceOpt!.short).toBe('f');
    expect(forceOpt!.hasValue).toBeUndefined(); // boolean flag, no value
  });

  it('should document --force in help text', () => {
    expect(taskMergeStatusCommand.help).toBeDefined();
    expect(taskMergeStatusCommand.help).toContain('--force');
  });

  it('should parse --force flag from argv', () => {
    const argv = ['task', 'merge-status', 'el-abc123', 'merged', '--force'];
    const parsed = parseArgs(argv, taskMergeStatusCommand.options);
    expect(parsed.commandOptions.force).toBe(true);
  });

  it('should parse -f short flag from argv', () => {
    const argv = ['task', 'merge-status', 'el-abc123', 'merged', '-f'];
    const parsed = parseArgs(argv, taskMergeStatusCommand.options);
    expect(parsed.commandOptions.force).toBe(true);
  });

  it('should not set force when --force is omitted', () => {
    const argv = ['task', 'merge-status', 'el-abc123', 'merged'];
    const parsed = parseArgs(argv, taskMergeStatusCommand.options);
    expect(parsed.commandOptions.force).toBeUndefined();
  });
});

// ============================================================================
// verifyMergeStatus Tests
// ============================================================================

describe('verifyMergeStatus', () => {
  const baseParams = {
    branch: 'feature/my-branch',
    effectiveTarget: 'master',
    workspaceRoot: '/workspace',
  };

  // Helper to create a mock execFileAsync
  function createMockExec(responses: Record<string, { stdout?: string; error?: Error }>) {
    return mock(async (file: string, args: string[], _opts: Record<string, unknown>) => {
      for (const [pattern, response] of Object.entries(responses)) {
        if (file === 'git' && args[0] === pattern) {
          if (response.error) {
            throw response.error;
          }
          return { stdout: response.stdout ?? '', stderr: '' };
        }
      }
      throw new Error(`Unexpected command: ${file} ${JSON.stringify(args)}`);
    });
  }

  it('passes literal refs and hashes as separate Git arguments', async () => {
    const branch = 'feature/$(echo${IFS}branch);&';
    const effectiveTarget = 'release/`echo${IFS}target`';
    const mergeCommitHash = 'hash; echo "literal"';
    const execFileAsync = createMockExec({
      fetch: {},
      'rev-list': { error: new Error('bad revision') },
      'merge-base': {},
    });
    const result = await verifyMergeStatus({
      ...baseParams, branch, effectiveTarget, mergeCommitHash, execFileAsync,
    });

    expect(result.status).toBe('ok');
    expect(execFileAsync.mock.calls).toEqual([
      ['git', ['fetch', 'origin'], { cwd: '/workspace', encoding: 'utf8', timeout: 60_000 }],
      ['git', ['rev-list', '--count', '--end-of-options', branch, `^origin/${effectiveTarget}`, '--'],
        { cwd: '/workspace', encoding: 'utf8' }],
      ['git', ['merge-base', '--is-ancestor', '--', mergeCommitHash, `origin/${effectiveTarget}`],
        { cwd: '/workspace', encoding: 'utf8' }],
    ]);
  });

  describe('when branch exists and all commits are on target', () => {
    it('should return ok', async () => {
      const execFileAsync = createMockExec({
        fetch: { stdout: '' },
        'rev-list': { stdout: '0\n' },
      });

      const result = await verifyMergeStatus({
        ...baseParams,
        execFileAsync,
      });

      expect(result.status).toBe('ok');
    });
  });

  describe('when branch exists and has unmerged commits', () => {
    it('should return error with commit count', async () => {
      const execFileAsync = createMockExec({
        fetch: { stdout: '' },
        'rev-list': { stdout: '3\n' },
      });

      const result = await verifyMergeStatus({
        ...baseParams,
        execFileAsync,
      });

      expect(result.status).toBe('error');
      expect(result.message).toContain('3 commit(s) not on origin/master');
      expect(result.message).toContain('sf task merge');
    });
  });

  describe('when source branch is deleted (unknown revision)', () => {
    it('should fail when no merge commit hash is recorded', async () => {
      const execFileAsync = createMockExec({
        fetch: { stdout: '' },
        'rev-list': { error: new Error('fatal: bad revision \'origin/master..feature/my-branch\'') },
      });

      const result = await verifyMergeStatus({
        ...baseParams,
        mergeCommitHash: undefined,
        execFileAsync,
      });

      expect(result.status).toBe('error');
      expect(result.message).toContain('source branch feature/my-branch no longer exists');
      expect(result.message).toContain('no merge commit hash is recorded');
      expect(result.message).toContain('--force');
    });

    it('should fail when unknown revision error is used', async () => {
      const execFileAsync = createMockExec({
        fetch: { stdout: '' },
        'rev-list': { error: new Error('unknown revision or path not in the working tree') },
      });

      const result = await verifyMergeStatus({
        ...baseParams,
        mergeCommitHash: undefined,
        execFileAsync,
      });

      expect(result.status).toBe('error');
      expect(result.message).toContain('source branch feature/my-branch no longer exists');
    });

    it('should succeed when merge commit hash IS on target', async () => {
      const commitHash = 'abc123def456';
      const execFileAsync = createMockExec({
        fetch: { stdout: '' },
        'rev-list': { error: new Error('bad revision') },
        'merge-base': { stdout: '' }, // exit 0 = is ancestor
      });

      const result = await verifyMergeStatus({
        ...baseParams,
        mergeCommitHash: commitHash,
        execFileAsync,
      });

      expect(result.status).toBe('ok');
    });

    it('should fail when merge commit hash is NOT on target', async () => {
      const commitHash = 'abc123def456';
      const execFileAsync = createMockExec({
        fetch: { stdout: '' },
        'rev-list': { error: new Error('bad revision') },
        'merge-base': { error: new Error('exit code 1') },
      });

      const result = await verifyMergeStatus({
        ...baseParams,
        mergeCommitHash: commitHash,
        execFileAsync,
      });

      expect(result.status).toBe('error');
      expect(result.message).toContain(`merge commit ${commitHash} is not on origin/master`);
      expect(result.message).toContain('--force');
    });
  });

  describe('--force flag', () => {
    it('should bypass when branch is deleted and no commit hash', async () => {
      const execFileAsync = createMockExec({
        fetch: { stdout: '' },
        'rev-list': { error: new Error('bad revision') },
      });

      const result = await verifyMergeStatus({
        ...baseParams,
        mergeCommitHash: undefined,
        force: true,
        execFileAsync,
      });

      expect(result.status).toBe('forced');
      expect(result.message).toContain('--force used');
      expect(result.message).toContain('no merge commit hash is recorded');
    });

    it('should bypass when branch is deleted and commit hash not on target', async () => {
      const commitHash = 'abc123def456';
      const execFileAsync = createMockExec({
        fetch: { stdout: '' },
        'rev-list': { error: new Error('bad revision') },
        'merge-base': { error: new Error('exit code 1') },
      });

      const result = await verifyMergeStatus({
        ...baseParams,
        mergeCommitHash: commitHash,
        force: true,
        execFileAsync,
      });

      expect(result.status).toBe('forced');
      expect(result.message).toContain('--force used');
      expect(result.message).toContain(`Merge commit ${commitHash}`);
    });

    it('should not be needed when merge commit hash IS on target', async () => {
      const commitHash = 'abc123def456';
      const execFileAsync = createMockExec({
        fetch: { stdout: '' },
        'rev-list': { error: new Error('bad revision') },
        'merge-base': { stdout: '' },
      });

      // Even with force=true, when commit is on target, result should be ok (not forced)
      const result = await verifyMergeStatus({
        ...baseParams,
        mergeCommitHash: commitHash,
        force: true,
        execFileAsync,
      });

      expect(result.status).toBe('ok');
    });
  });

  describe('other git errors', () => {
    it('should propagate non-revision errors', async () => {
      const execFileAsync = createMockExec({
        fetch: { stdout: '' },
        'rev-list': { error: new Error('fatal: not a git repository') },
      });

      const result = await verifyMergeStatus({
        ...baseParams,
        execFileAsync,
      });

      expect(result.status).toBe('error');
      expect(result.message).toContain('verification failed');
      expect(result.message).toContain('not a git repository');
    });
  });
});
