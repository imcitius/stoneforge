/**
 * Docs Steward Service — Git argv safety regressions (el-5d1vq8)
 *
 * The session lifecycle used to build Git commands as shell strings with
 * interpolated worktree paths, branch names, file names and commit messages.
 * These tests run the real lifecycle against a temporary repository whose
 * path, steward branch name, staged file names and commit message all contain
 * shell metacharacters, and assert that nothing is executed and that Git
 * receives every value literally.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createDocsStewardService } from './docs-steward-service.js';

const SENTINELS = [
  'PWN_root',
  'PWN_root_tick',
  'PWN_branch',
  'PWN_branch_tick',
  'PWN_file',
  'PWN_file_tick',
  'PWN_msg',
  'PWN_msg_tick',
];

// Valid Git ref name (no spaces, no `..`, no `@{`) that would run two
// commands if it reached a shell.
const HOSTILE_STEWARD = 'steward$(touch${IFS}PWN_branch)`touch${IFS}PWN_branch_tick`';
const HOSTILE_BRANCH = `${HOSTILE_STEWARD}/docs/auto-updates`;

const HOSTILE_FILES = [
  '$(touch PWN_file).md',
  '`touch PWN_file_tick`.md',
  'with space "dq" \'sq\'.md',
  '-n.md',
  'glob*.md',
];

const HOSTILE_MESSAGE =
  'docs: fix $(touch PWN_msg) `touch PWN_msg_tick` "dq" \'sq\' \\ $HOME ; echo injected';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

describe('DocsStewardService git argv safety', () => {
  let parent: string;
  let repo: string;
  const searchDirs: string[] = [];

  function assertNoSentinels(): void {
    for (const dir of [...searchDirs, process.cwd()]) {
      for (const name of SENTINELS) {
        expect(fs.existsSync(path.join(dir, name)), `${name} in ${dir}`).toBe(false);
      }
    }
  }

  beforeEach(() => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-steward-argv-'));
    // Workspace path with spaces, quotes, `$(...)` and backticks.
    repo = path.join(parent, 'ws "dq" \'sq\' $(touch PWN_root) `touch PWN_root_tick`');
    fs.mkdirSync(repo);
    searchDirs.length = 0;
    searchDirs.push(parent, repo);

    git(repo, 'init', '-q', '-b', 'master');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
    git(repo, 'add', '--', 'README.md');
    git(repo, 'commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('creates, commits and cleans up a session with hostile path, branch, files and message', async () => {
    const service = createDocsStewardService({
      workspaceRoot: repo,
      autoPush: false,
      targetBranch: 'master',
    });

    const info = await service.createSessionWorktree(HOSTILE_STEWARD);
    searchDirs.push(info.path);

    expect(info.branch).toBe(HOSTILE_BRANCH);
    expect(info.created).toBe(true);
    expect(fs.existsSync(info.path)).toBe(true);
    expect(git(info.path, 'symbolic-ref', 'HEAD').trim()).toBe(`refs/heads/${HOSTILE_BRANCH}`);
    expect(
      git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/').split('\n')
    ).toContain(`refs/heads/${HOSTILE_BRANCH}`);
    assertNoSentinels();

    for (const file of HOSTILE_FILES) {
      fs.writeFileSync(path.join(info.path, file), `content of ${file}\n`);
    }
    // Would be staged too if `glob*.md` were treated as a glob pathspec.
    fs.writeFileSync(path.join(info.path, 'globX.md'), 'must stay untracked\n');

    await service.commitFix(HOSTILE_MESSAGE, HOSTILE_FILES);
    assertNoSentinels();

    expect(git(info.path, 'log', '-1', '--format=%B').trimEnd()).toBe(HOSTILE_MESSAGE);
    const committed = git(info.path, 'show', '--name-only', '-z', '--format=', 'HEAD')
      .split('\0')
      .filter(Boolean)
      .sort();
    expect(committed).toEqual([...HOSTILE_FILES].sort());
    expect(git(info.path, 'status', '--porcelain', '-z').split('\0')).toContain('?? globX.md');

    await service.cleanupSession(info.path, info.branch);
    assertNoSentinels();

    expect(fs.existsSync(info.path)).toBe(false);
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/').trim()).toBe(
      'refs/heads/master'
    );
  });

  it('reuses an existing hostile branch literally instead of creating it', async () => {
    git(repo, 'branch', '--', HOSTILE_BRANCH, 'master');

    const service = createDocsStewardService({
      workspaceRoot: repo,
      autoPush: false,
      targetBranch: 'master',
    });

    const info = await service.createSessionWorktree(HOSTILE_STEWARD);
    searchDirs.push(info.path);

    expect(info.created).toBe(false);
    expect(git(info.path, 'symbolic-ref', 'HEAD').trim()).toBe(`refs/heads/${HOSTILE_BRANCH}`);
    assertNoSentinels();

    await service.cleanupSession(info.path, info.branch);
    expect(fs.existsSync(info.path)).toBe(false);
    assertNoSentinels();
  });

  it('treats a tag with the branch name as non-existent branch (refs/heads lookup)', async () => {
    // Before the fix `git rev-parse --verify <name>` also matched tags, which
    // then made `git worktree add <path> <name>` check out a detached tag.
    git(repo, 'tag', 'tagged/docs/auto-updates');

    const service = createDocsStewardService({
      workspaceRoot: repo,
      autoPush: false,
      targetBranch: 'master',
    });

    const info = await service.createSessionWorktree('tagged');
    searchDirs.push(info.path);

    expect(info.created).toBe(true);
    expect(git(info.path, 'symbolic-ref', 'HEAD').trim()).toBe(
      'refs/heads/tagged/docs/auto-updates'
    );

    await service.cleanupSession(info.path, info.branch);
  });

  it('squash-merges the hostile session branch and cleans up', async () => {
    const service = createDocsStewardService({
      workspaceRoot: repo,
      autoPush: false,
      targetBranch: 'master',
    });

    const info = await service.createSessionWorktree(HOSTILE_STEWARD);
    searchDirs.push(info.path);
    fs.writeFileSync(path.join(info.path, HOSTILE_FILES[0]), 'merged\n');
    await service.commitFix(HOSTILE_MESSAGE, [HOSTILE_FILES[0]]);

    const result = await service.mergeAndCleanup(info.branch, HOSTILE_MESSAGE);
    assertNoSentinels();

    expect(result.success).toBe(true);
    expect(git(repo, 'log', '-1', '--format=%B', 'master').trimEnd()).toBe(HOSTILE_MESSAGE);
    expect(git(repo, 'show', 'master:' + HOSTILE_FILES[0])).toBe('merged\n');
    expect(fs.existsSync(info.path)).toBe(false);
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/').trim()).toBe(
      'refs/heads/master'
    );
  });
});
