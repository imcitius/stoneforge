/** Literal argv regressions. All repositories, remotes and marker payloads are temporary. */
import { beforeEach, afterEach, expect, test, setDefaultTimeout } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createQuarryAPI, type QuarryAPI } from '@stoneforge/quarry';
import { createTask, type Task, type EntityId } from '@stoneforge/core';
import { ProjectRepositories } from './project-repositories.js';
import { mergeBranch, ensureTargetBranchExists, hasRemote } from './merge.js';

setDefaultTimeout(30_000);
const cliSource = path.resolve(import.meta.dir, '../bin/sf.ts');
let root: string, repo: string, remote: string, initial: string;
let storage: StorageBackend | undefined;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});
const ref = (cwd: string, name: string) => git(cwd, 'rev-parse', '--verify', name).trim();
function commit(cwd: string, file: string, content = file) {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', '--', file);
  git(cwd, 'commit', '-qm', file);
  return ref(cwd, 'HEAD');
}
function source(branch = 'feature', worktree = path.join(root, 'source')) {
  git(repo, 'worktree', 'add', '-b', branch, '--', worktree, 'main');
  commit(worktree, 'TASK');
  return { branch, worktree };
}
function message() {
  return `  spaces "double" 'single' \\backslash $HOME \${USER}; & | < >\n\n$(touch '${root}/dollar-marker') \`touch '${root}/backtick-marker'\`\nlast line  `;
}
function expectNoMarkers() {
  for (const name of ['dollar-marker', 'backtick-marker', 'branch-marker', 'target-marker']) {
    expect(existsSync(path.join(root, name)), name).toBe(false);
  }
  expect(existsSync(path.join(repo, 'path-marker'))).toBe(false);
}
function expectMessage(cwd: string, hash: string, expected: string, finalNewline = true) {
  // Read the actual object body, not CLI output or a mocked command argument.
  const object = git(cwd, 'cat-file', 'commit', hash);
  expect(object.slice(object.indexOf('\n\n') + 2)).toBe(expected + (finalNewline ? '\n' : ''));
}
function cli(...args: string[]) { return cliAt(root, ...args); }
function cliAt(cwd: string, ...args: string[]) {
  const executable = process.env.SF_TEST_CLI ?? process.execPath;
  return spawnSync(executable, [...(process.env.SF_TEST_CLI ? [] : [cliSource]), ...args, '--json'], {
    cwd, encoding: 'utf8', env: { ...process.env, STONEFORGE_ROOT: root }, timeout: 20_000,
  });
}
async function project(): Promise<QuarryAPI> {
  mkdirSync(path.join(root, '.stoneforge'));
  storage = createStorage({ path: path.join(root, '.stoneforge/stoneforge.db') });
  initializeSchema(storage);
  const api = createQuarryAPI(storage);
  await new ProjectRepositories(root, api).add({ id: 'core', path: repo, targetBranch: 'main' });
  return api;
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sf-merge-argv-')));
  repo = path.join(root, 'core'); remote = path.join(root, 'remote.git'); mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com'); git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  initial = commit(repo, 'README');
  git(root, 'clone', '--bare', '--', repo, remote);
  git(repo, 'remote', 'add', 'origin', remote); git(repo, 'fetch', 'origin');
});
afterEach(() => {
  storage?.close(); storage = undefined;
  rmSync(root, { recursive: true, force: true });
});

for (const localOnly of [true, false]) {
  for (const mergeStrategy of ['squash', 'merge'] as const) {
    test(`${localOnly ? 'local' : 'remote'} ${mergeStrategy} preserves message bytes without shell substitution`, async () => {
      const { branch } = source();
      const result = await mergeBranch({ workspaceRoot: repo, sourceBranch: branch, targetBranch: 'main', localOnly, mergeStrategy, commitMessage: message() });
      expect(result.success, result.error).toBe(true);
      expectMessage(repo, result.commitHash!, message(), mergeStrategy === 'squash');
      expectNoMarkers();
      const object = git(repo, 'cat-file', 'commit', result.commitHash!);
      expect(object.match(/^parent /gm)?.length).toBe(mergeStrategy === 'squash' ? 1 : 2);
      expect(ref(repo, 'main')).toBe(result.commitHash!);
      expect(ref(remote, 'main')).toBe(localOnly ? initial : result.commitHash!);
      expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('_merge-');
    });
  }
}

test('source, target, remote name and worktree paths remain literal argv', async () => {
  const strangeRepo = path.join(root, 'core space "quote" $(touch${IFS}path-marker)');
  // No worktrees exist yet; moving the fixture preserves its relative .git directory.
  const { renameSync } = await import('node:fs'); renameSync(repo, strangeRepo); repo = strangeRepo;
  const target = `release/$(touch\${IFS}${root}/target-marker)`;
  const branch = `feature/$(touch\${IFS}${root}/branch-marker)`;
  const remoteName = 'remote;$(echo)';
  git(repo, 'remote', 'add', remoteName, remote);
  expect(await hasRemote(repo, remoteName)).toBe(true);
  await ensureTargetBranchExists(repo, target, false);
  const { worktree } = source(branch, path.join(root, 'source space "quoted"'));
  const result = await mergeBranch({ workspaceRoot: repo, sourceBranch: branch, targetBranch: target, commitMessage: message() });
  expect(result.success, result.error).toBe(true);
  expectMessage(remote, result.commitHash!, message());
  expect(ref(remote, target)).toBe(result.commitHash!);
  expect(readFileSync(path.join(worktree, 'TASK'), 'utf8')).toBe('TASK');
  expectNoMarkers();
  expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('_merge-');
});

for (const mergeStrategy of ['squash', 'merge'] as const) {
  test(`${mergeStrategy} conflict preserves target and cleans temporary worktree`, async () => {
    const { branch, worktree } = source();
    commit(worktree, 'README', 'source');
    const target = commit(repo, 'README', 'target');
    const result = await mergeBranch({ workspaceRoot: repo, sourceBranch: branch, targetBranch: 'main', localOnly: true, mergeStrategy, preflight: false, commitMessage: message() });
    expect(result.success).toBe(false); expect(result.hasConflict).toBe(true);
    expect(result.conflictFiles).toContain('README');
    expect(ref(repo, 'main')).toBe(target); expect(ref(remote, 'main')).toBe(initial);
    expect(existsSync(worktree)).toBe(true);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('_merge-');
    expectNoMarkers();
  });
}

test('option-looking source is rejected without interpreting it as a merge option', async () => {
  source();
  const result = await mergeBranch({ workspaceRoot: repo, sourceBranch: '--help', targetBranch: 'main', localOnly: true, commitMessage: message() });
  expect(result.success).toBe(false); expect(result.alreadyMerged).not.toBe(true);
  expect(ref(repo, 'main')).toBe(initial); expectNoMarkers();
});

test('rejected remote push reports failure with a literal retained commit message', async () => {
  const { branch } = source();
  // A local bare remote rejecting all pushes: no network and no executable payload hook.
  git(remote, 'config', 'receive.denyNonFastForwards', 'true');
  const other = path.join(root, 'other'); git(root, 'clone', '--', remote, other);
  git(other, 'config', 'user.email', 'test@example.com'); git(other, 'config', 'user.name', 'Test');
  const advanced = commit(other, 'OTHER'); git(other, 'push', 'origin', 'main');
  // Only push traffic is routed to this rejecting local destination. Fetch still reads original.
  const rejecting = path.join(root, 'rejecting.git'); git(root, 'clone', '--bare', '--', remote, rejecting);
  git(repo, 'remote', 'set-url', '--push', 'origin', rejecting);
  const another = commit(other, 'LATER'); git(other, 'push', rejecting, 'main');
  const result = await mergeBranch({ workspaceRoot: repo, sourceBranch: branch, targetBranch: 'main', commitMessage: message() });
  expect(result.success).toBe(false); expect(result.error).toContain('push to origin failed');
  expectMessage(repo, result.commitHash!, message()); expectNoMarkers();
  expect(ref(remote, 'main')).toBe(advanced); expect(ref(rejecting, 'main')).toBe(another);
  expect(ref(repo, 'main')).toBe(initial);
});

for (const localOnly of [true, false]) {
  test(`task merge ${localOnly ? 'local' : 'remote'} preserves title and literal cleanup paths`, async () => {
    const api = await project();
    const branch = `feature/$(touch\${IFS}${root}/branch-marker)`;
    const { worktree } = source(branch, path.join(root, 'source "quoted" $(touch${IFS}path-marker)'));
    git(repo, 'push', '--', 'origin', branch);
    const raw = await createTask({ title: message().trim(), createdBy: 'user:test' as EntityId });
    let task = await api.create<Task>(raw as unknown as Parameters<QuarryAPI['create']>[0]);
    task = await api.update<Task>(task.id, { status: 'in_progress' });
    task = await api.update<Task>(task.id, { status: 'review', metadata: { orchestrator: { repositoryId: 'core', targetBranch: 'main', branch, worktree, mergeStatus: 'pending' } } });
    const result = cli('task', 'merge', task.id, ...(localOnly ? ['--local'] : []));
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expectMessage(repo, ref(repo, 'main'), `${task.title} (${task.id})`);
    expect((await api.get<Task>(task.id))?.status).toBe('closed');
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, 'branch', '--list', branch)).toBe('');
    expect(git(remote, 'branch', '--list', branch).trim().length > 0).toBe(localOnly);
    expectNoMarkers();
    expect(existsSync(path.join(root, 'path-marker'))).toBe(false);
    expect(ref(remote, 'main')).toBe(localOnly ? initial : ref(repo, 'main'));
  });
}

for (const fail of [false, true]) {
  test(`standalone merge ${fail ? 'failure' : 'cleanup'} keeps arguments literal`, async () => {
    await project();
    const branch = `feature/$(touch\${IFS}${root}/branch-marker)`;
    const { worktree } = source(branch, path.join(root, 'source space "quoted"'));
    git(repo, 'push', '--', 'origin', branch);
    const result = cliAt(worktree, 'merge', '--branch', fail ? `missing/${branch}` : branch, '--message', message(), '--cleanup');
    expect(result.status === 0, result.stdout + result.stderr).toBe(!fail);
    if (!fail) {
      expectMessage(remote, ref(remote, 'main'), message());
      expect(existsSync(worktree)).toBe(false);
      expect(git(repo, 'branch', '--list', branch)).toBe('');
      expect(git(remote, 'branch', '--list', branch)).toBe('');
    } else {
      expect(ref(remote, 'main')).toBe(initial);
      expect(ref(repo, branch)).toBeTruthy();
    }
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('_merge-');
    expectNoMarkers();
  });
}

test('local delivery failure retains literal merge for recovery without changing target', async () => {
  const { branch, worktree } = source();
  writeFileSync(path.join(repo, 'README'), 'user changes');
  const result = await mergeBranch({ workspaceRoot: repo, sourceBranch: branch, targetBranch: 'main', localOnly: true, commitMessage: message() });
  expect(result.success).toBe(false); expect(result.error).toContain('Local delivery');
  expectMessage(repo, result.commitHash!, message()); expectNoMarkers();
  expect(ref(repo, 'main')).toBe(initial); expect(ref(remote, 'main')).toBe(initial);
  expect(readFileSync(path.join(repo, 'README'), 'utf8')).toBe('user changes');
  expect(existsSync(worktree)).toBe(true);
  expect(git(repo, 'worktree', 'list', '--porcelain')).toContain('_merge-');
});

test('push to different local destination fails post-push verification', async () => {
  const { branch } = source();
  const otherRemote = path.join(root, 'other.git');
  git(root, 'clone', '--bare', '--', remote, otherRemote);
  git(repo, 'remote', 'set-url', '--push', 'origin', otherRemote);
  const result = await mergeBranch({ workspaceRoot: repo, sourceBranch: branch, targetBranch: 'main', commitMessage: message() });
  expect(result.success).toBe(false); expect(result.error).toContain('post-push verification failed');
  expectMessage(otherRemote, result.commitHash!, message()); expectNoMarkers();
  expect(ref(repo, 'main')).toBe(initial); expect(ref(remote, 'main')).toBe(initial);
  expect(ref(otherRemote, 'main')).toBe(result.commitHash!);
});
