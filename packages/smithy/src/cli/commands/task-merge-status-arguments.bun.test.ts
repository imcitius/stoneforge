/** Real merge-status regressions: only temporary repositories, file remotes and harmless markers. */
import { afterEach, beforeEach, expect, test, setDefaultTimeout } from 'bun:test';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createQuarryAPI } from '@stoneforge/quarry';
import { createTask, type EntityId, type Task } from '@stoneforge/core';
import { ProjectRepositories } from '../../git/project-repositories.js';
import { verifyMergeStatus } from './task.js';

setDefaultTimeout(30_000);
const execFileAsync = promisify(execFile);
const cliSource = path.resolve(import.meta.dir, '../../bin/sf.ts');
let root: string, repo: string, remote: string, initial: string;
let storage: StorageBackend | undefined;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const markerRef = (name: string) => `${name}/$(touch\${IFS}${root}/${name}-marker)`;
function noMarkers() {
  for (const name of ['source', 'target', 'hash', 'backtick']) {
    expect(existsSync(path.join(root, `${name}-marker`))).toBe(false);
  }
}
const verify = (params: Pick<Parameters<typeof verifyMergeStatus>[0], 'branch'> &
  Partial<Parameters<typeof verifyMergeStatus>[0]>) => verifyMergeStatus({
  effectiveTarget: 'main', workspaceRoot: repo, execFileAsync, ...params,
});
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sf-status-argv-')));
  repo = path.join(root, 'core'); remote = path.join(root, 'remote.git'); mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'commit', '--allow-empty', '-qm', 'initial');
  initial = git(repo, 'rev-parse', 'HEAD');
  git(root, 'clone', '--bare', '--', repo, remote);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'fetch', 'origin');
});
afterEach(() => {
  storage?.close(); storage = undefined;
  rmSync(root, { recursive: true, force: true });
});

test('valid shell-special source and target names are literal, with fresh remote verification', async () => {
  const branch = markerRef('source');
  const effectiveTarget = markerRef('target');
  git(repo, 'branch', branch);
  git(repo, 'branch', effectiveTarget);
  git(repo, 'push', 'origin', effectiveTarget);
  expect((await verify({ branch, effectiveTarget })).status).toBe('ok');
  git(repo, 'checkout', branch);
  git(repo, 'commit', '--allow-empty', '-qm', 'unmerged');
  // Advancing only the local target must not count as remote delivery, even with --force.
  git(repo, 'branch', '-f', effectiveTarget, 'HEAD');
  for (const force of [false, true]) {
    const result = await verify({ branch, effectiveTarget, force });
    expect(result.status).toBe('error');
    expect(result.message).toContain('1 commit(s) not on origin/');
  }
  // Update the bare remote directly; verifyMergeStatus must fetch before checking.
  git(remote, 'fetch', repo, `${branch}:refs/heads/${effectiveTarget}`);
  expect((await verify({ branch, effectiveTarget })).status).toBe('ok');
  noMarkers();
});

test('backticks, quotes, dollar variables and shell operators in valid refs stay literal', async () => {
  const branch = `feature/\`touch\${IFS}${root}/backtick-marker\`;"'$HOME&`;
  git(repo, 'branch', branch);
  expect((await verify({ branch })).status).toBe('ok');
  noMarkers();
});

test('deleted source requires a delivered commit hash or explicit force', async () => {
  const branch = markerRef('source');
  const effectiveTarget = markerRef('target');
  git(repo, 'push', 'origin', `main:refs/heads/${effectiveTarget}`);
  expect((await verify({ branch, effectiveTarget, mergeCommitHash: initial })).status).toBe('ok');
  git(repo, 'commit', '--allow-empty', '-qm', 'not delivered');
  const unmerged = git(repo, 'rev-parse', 'HEAD');
  for (const mergeCommitHash of [undefined, unmerged]) {
    expect((await verify({ branch, effectiveTarget, mergeCommitHash })).status).toBe('error');
    expect((await verify({ branch, effectiveTarget, mergeCommitHash, force: true })).status).toBe('forced');
  }
  noMarkers();
});

test('recorded hash payload cannot execute or falsely verify a deleted source', async () => {
  const mergeCommitHash = `${initial}; touch '${root}/hash-marker'; #`;
  const result = await verify({ branch: 'deleted', mergeCommitHash });
  expect(result.status).toBe('error');
  expect(result.message).toContain('is not on origin/main');
  expect((await verify({ branch: 'deleted', mergeCommitHash, force: true })).status).toBe('forced');
  noMarkers();
});

test('option-looking source and hash do not become Git options', async () => {
  expect((await verify({ branch: '--all' })).status).toBe('error');
  expect((await verify({ branch: 'deleted', mergeCommitHash: '--help' })).status).toBe('error');
});

test('fetch errors remain errors with --force', async () => {
  git(repo, 'remote', 'set-url', 'origin', path.join(root, 'missing.git'));
  const result = await verify({ branch: 'main', force: true });
  expect(result.status).toBe('error');
  expect(result.message).toContain('verification failed');
});

for (const scenario of ['merged', 'unmerged', 'deleted-hash-payload', 'forced-deleted'] as const) {
  test(`CLI merge-status ${scenario} preserves verification and lifecycle`, async () => {
    mkdirSync(path.join(root, '.stoneforge'));
    storage = createStorage({ path: path.join(root, '.stoneforge/stoneforge.db') });
    initializeSchema(storage);
    const api = createQuarryAPI(storage);
    const targetBranch = markerRef('target');
    const branch = markerRef('source');
    git(repo, 'branch', targetBranch);
    git(repo, 'push', 'origin', `main:refs/heads/${targetBranch}`);
    if (scenario === 'merged' || scenario === 'unmerged') {
      git(repo, 'checkout', '-b', branch);
      if (scenario === 'unmerged') git(repo, 'commit', '--allow-empty', '-qm', 'not delivered');
    }
    await new ProjectRepositories(root, api).add({ id: 'core', path: repo, targetBranch });
    const raw = await createTask({ title: 'Merge status fixture', createdBy: 'user:test' as EntityId });
    let task = await api.create<Task>(raw as unknown as Parameters<typeof api.create>[0]);
    task = await api.update<Task>(task.id, { status: 'in_progress' });
    task = await api.update<Task>(task.id, {
      status: 'review', metadata: { orchestrator: {
        repositoryId: 'core', branch, targetBranch, mergeStatus: 'pending',
        ...(scenario === 'deleted-hash-payload' ? { mergeCommitHash: `${initial}; touch '${root}/hash-marker'; #` } : {}),
      } },
    });
    const executable = process.env.SF_TEST_CLI ?? process.execPath;
    const result = spawnSync(executable, [
      ...(process.env.SF_TEST_CLI ? [] : [cliSource]),
      'task', 'merge-status', task.id, 'merged',
      ...(scenario === 'forced-deleted' ? ['--force'] : []), '--json',
    ], { cwd: root, encoding: 'utf8', env: { ...process.env, STONEFORGE_ROOT: root }, timeout: 20_000 });
    const succeeds = scenario === 'merged' || scenario === 'forced-deleted';
    expect(result.status === 0, result.stdout + result.stderr).toBe(succeeds);
    const updated = await api.get<Task>(task.id);
    expect(updated?.status).toBe(succeeds ? 'closed' : 'review');
    expect(updated?.metadata.orchestrator).toMatchObject({ mergeStatus: succeeds ? 'merged' : 'pending' });
    if (scenario === 'forced-deleted') expect(result.stderr).toContain('--force used');
    expect(git(remote, 'rev-parse', targetBranch)).toBe(initial);
    noMarkers();
  });
}
