/** Real Git + current-source CLI. No live project, installed CLI or network fixtures. */
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTask, type EntityId, type Task } from '@stoneforge/core';
import { createQuarryAPI, type QuarryAPI } from '@stoneforge/quarry';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { ProjectRepositories } from './project-repositories.js';
import { mergeBranch } from './merge.js';
import { assertGitIdentity } from './identity.js';

setDefaultTimeout(30_000);
const cliSource = path.resolve(import.meta.dir, '../bin/sf.ts');
const fixtureIdentity = {
  GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'author@example.test',
  GIT_COMMITTER_NAME: 'Fixture Committer', GIT_COMMITTER_EMAIL: 'committer@example.test',
};
let savedEnv: NodeJS.ProcessEnv;
let root: string, repo: string, source: string, remote: string;
let storage: StorageBackend, api: QuarryAPI, task: Task;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
function commit(cwd: string, name: string) {
  writeFileSync(path.join(cwd, name), name);
  git(cwd, 'add', '--', name);
  execFileSync('git', ['commit', '-qm', name], { cwd, env: { ...process.env, ...fixtureIdentity } });
}
function cli(args: string[], json = true, cwd = root) {
  return spawnSync(process.execPath, [cliSource, ...args, ...(json ? ['--json'] : [])], {
    cwd, encoding: 'utf8', env: { ...process.env, STONEFORGE_ROOT: root }, timeout: 20_000,
  });
}
function nativeIdentityErrors() {
  return ['AUTHOR', 'COMMITTER'].map(role => spawnSync('git', ['var', `GIT_${role}_IDENT`], {
    cwd: source, env: process.env, encoding: 'utf8',
  })).filter(result => result.status !== 0).map(result => result.stderr);
}
function snapshot() {
  return {
    source: git(source, 'rev-parse', 'HEAD'), target: git(repo, 'rev-parse', 'main'),
    remote: git(remote, 'rev-parse', 'main'), status: git(source, 'status', '--porcelain'),
    index: git(source, 'write-tree'), metadata: JSON.stringify(task.metadata),
  };
}
async function preserved(before: ReturnType<typeof snapshot>) {
  expect(snapshot()).toEqual(before);
  expect(existsSync(source)).toBe(true);
  expect(existsSync(git(source, 'rev-parse', '--git-path', 'MERGE_HEAD'))).toBe(false);
  expect((await api.get<Task>(task.id))?.status).toBe('review');
  expect(JSON.stringify((await api.get<Task>(task.id))?.metadata)).toBe(before.metadata);
  expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('_merge-');
}

beforeEach(async () => {
  savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (/^(GIT_|STONEFORGE_|SF_)/.test(key) || key === 'EMAIL' || key === 'ORCHESTRATOR_URL') delete process.env[key];
  }
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.LC_ALL = 'C';
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sf-identity-')));
  repo = path.join(root, 'core'); source = path.join(root, 'source'); remote = path.join(root, 'remote.git');
  mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.useConfigOnly', 'true');
  git(repo, 'config', 'commit.gpgsign', 'false');
  commit(repo, 'README');
  git(root, 'clone', '--bare', repo, remote); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'fetch', 'origin');
  git(repo, 'worktree', 'add', '-b', 'feature', source, 'main');
  mkdirSync(path.join(root, '.stoneforge'));
  storage = createStorage({ path: path.join(root, '.stoneforge/stoneforge.db') }); initializeSchema(storage);
  api = createQuarryAPI(storage);
  await new ProjectRepositories(root, api).add({ id: 'core', path: repo, targetBranch: 'main' });
  const raw = await createTask({ title: 'Identity fixture', createdBy: 'user:fixture' as EntityId });
  task = await api.create<Task>(raw as unknown as Parameters<QuarryAPI['create']>[0]);
  task = await api.update<Task>(task.id, { status: 'in_progress' });
  task = await api.update<Task>(task.id, { status: 'review', metadata: { orchestrator: {
    repositoryId: 'core', targetBranch: 'main', branch: 'feature', worktree: source, mergeStatus: 'pending',
  } } });
});
afterEach(() => {
  storage?.close();
  rmSync(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

const cases = {
  missing: () => {},
  'partial config': () => { git(repo, 'config', 'user.name', 'Fixture User'); },
  'author only': () => { Object.assign(process.env, { GIT_AUTHOR_NAME: fixtureIdentity.GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL: fixtureIdentity.GIT_AUTHOR_EMAIL }); },
  'committer only': () => { Object.assign(process.env, { GIT_COMMITTER_NAME: fixtureIdentity.GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL: fixtureIdentity.GIT_COMMITTER_EMAIL }); },
  'malformed author': () => { Object.assign(process.env, fixtureIdentity, { GIT_AUTHOR_NAME: '<>' }); },
  'empty committer': () => { Object.assign(process.env, fixtureIdentity, { GIT_COMMITTER_NAME: '' }); },
};
for (const [name, configure] of Object.entries(cases)) {
  for (const operation of ['sync', 'merge'] as const) {
    for (const json of [true, false]) {
      test(`${operation} ${json ? 'JSON' : 'plain'}: ${name} fails before integration, retains task/source and Git error`, async () => {
        commit(source, 'TASK'); commit(repo, 'TARGET'); configure();
        const errors = nativeIdentityErrors(); expect(errors.length).toBeGreaterThan(0);
        const before = snapshot();
        const tracePath = path.join(root, 'git-trace');
        process.env.GIT_TRACE = tracePath;
        const result = cli(['task', operation, task.id, ...(operation === 'merge' ? ['--local'] : [])], json);
        expect(result.status, result.stdout + result.stderr).not.toBe(0);
        const output = json ? JSON.parse(result.stderr).error : result.stdout + result.stderr;
        if (json) expect(JSON.parse(result.stderr).success).toBe(false);
        expect(output).toContain('Git identity preflight failed');
        expect(output).toContain(task.id); expect(output).toContain('feature'); expect(output).toContain(source);
        expect(output).toContain('repository-local user.name/user.email');
        for (const error of errors) expect(output).toContain(error);
        expect(readFileSync(tracePath, 'utf8')).not.toMatch(/built-in: git (merge |commit )/);
        await preserved(before);
      });
    }
  }
}

for (const kind of ['config', 'role config', 'command-local env', 'command-local config'] as const) {
  for (const operation of ['sync', 'merge'] as const) {
    test(`${operation}: ${kind} succeeds with Git-resolved author and committer`, async () => {
      commit(source, 'TASK'); commit(repo, 'TARGET');
      let author = 'Fixture Author <author@example.test>', committer = 'Fixture Committer <committer@example.test>';
      if (kind === 'config') {
        git(repo, 'config', 'user.name', 'Fixture User'); git(repo, 'config', 'user.email', 'user@example.test');
        author = committer = 'Fixture User <user@example.test>';
      } else if (kind === 'role config') {
        for (const role of ['author', 'committer']) {
          git(repo, 'config', `${role}.name`, role === 'author' ? 'Fixture Author' : 'Fixture Committer');
          git(repo, 'config', `${role}.email`, `${role}@example.test`);
        }
      } else if (kind === 'command-local env') Object.assign(process.env, fixtureIdentity);
      else {
        Object.assign(process.env, {
          GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Command User',
          GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'command@example.test',
        });
        author = committer = 'Command User <command@example.test>';
      }
      const result = cli(['task', operation, task.id, ...(operation === 'merge' ? ['--local'] : [])]);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).success).toBe(true);
      const cwd = operation === 'sync' ? source : repo;
      expect(git(cwd, 'log', '-1', '--format=%an <%ae>%n%cn <%ce>')).toBe(`${author}\n${committer}`);
      expect(git(cwd, 'show', 'HEAD:TASK')).toBe('TASK'); expect(git(cwd, 'show', 'HEAD:TARGET')).toBe('TARGET');
      expect((await api.get<Task>(task.id))?.status).toBe(operation === 'sync' ? 'review' : 'closed');
    });
  }
}

for (const mode of ['up-to-date', 'source-ahead', 'fast-forward', 'no-ff config'] as const) {
  test(`sync without identity: ${mode}`, async () => {
    if (mode === 'source-ahead') commit(source, 'TASK');
    if (mode === 'fast-forward' || mode === 'no-ff config') commit(repo, 'TARGET');
    if (mode === 'no-ff config') git(repo, 'config', 'merge.ff', 'false');
    const before = snapshot();
    const result = cli(['task', 'sync', task.id]);
    expect(result.status, result.stdout + result.stderr).toBe(mode === 'no-ff config' ? 1 : 0);
    if (mode === 'no-ff config') await preserved(before);
    else expect(git(source, 'merge-base', '--is-ancestor', 'main', 'HEAD')).toBe('');
  });
}

test('already merged source needs no identity', async () => {
  const result = await mergeBranch({ workspaceRoot: repo, sourceBranch: 'feature', targetBranch: 'main', localOnly: true });
  expect(result).toMatchObject({ success: true, alreadyMerged: true });
});

for (const mergeStrategy of ['squash', 'merge'] as const) {
  test(`${mergeStrategy} helper checks actual temp commit cwd, not main checkout identity`, async () => {
    commit(source, 'TASK');
    git(repo, 'config', 'user.name', 'Shared User');
    git(repo, 'config', 'user.email', 'shared@example.test');
    const invalidConfig = path.join(root, 'merge-identity-config');
    writeFileSync(invalidConfig, '[author]\nname = <>\n');
    git(repo, 'config', `includeIf.gitdir:${repo}/.git/worktrees/_merge-*.path`, invalidConfig);
    await assertGitIdentity(repo, { operation: 'fixture control', source: 'main' });
    const before = snapshot();
    const result = await mergeBranch({ workspaceRoot: repo, sourceBranch: 'feature', targetBranch: 'main', localOnly: true, mergeStrategy, taskId: task.id, sourceWorktree: source });
    expect(result.success).toBe(false); expect(result.hasConflict).toBe(false);
    expect(result.error).toContain('Git identity preflight failed'); expect(result.error).toContain('_merge-');
    await preserved(before);
  });
}

test('sync honors worktree-specific invalid identity over valid shared config', async () => {
  commit(source, 'TASK'); commit(repo, 'TARGET');
  git(repo, 'config', 'user.name', 'Shared User'); git(repo, 'config', 'user.email', 'shared@example.test');
  git(repo, 'config', 'extensions.worktreeConfig', 'true'); git(source, 'config', '--worktree', 'author.name', '<>');
  const before = snapshot(); const result = cli(['task', 'sync', task.id]);
  expect(result.status).toBe(1); expect(JSON.parse(result.stderr).error).toContain('GIT_AUTHOR_IDENT');
  await preserved(before);
});

test('standalone merge --cleanup retains source and remote when identity fails', async () => {
  commit(source, 'TASK'); git(source, 'push', 'origin', 'feature');
  const before = snapshot(); const remoteSource = git(remote, 'rev-parse', 'feature');
  const result = cli(['merge', '--branch', 'feature', '--into', 'main', '--cleanup'], true, source);
  expect(result.status).toBe(1); expect(JSON.parse(result.stderr).error).toContain('Git identity preflight failed');
  expect(git(remote, 'rev-parse', 'feature')).toBe(remoteSource); await preserved(before);
});

test('Git validation remains authoritative: non-RFC email accepted by Git is not rejected', async () => {
  Object.assign(process.env, fixtureIdentity, { GIT_AUTHOR_EMAIL: 'local-address' });
  await assertGitIdentity(source, { operation: 'fixture', source: 'feature' });
  commit(source, 'TASK');
  const result = await mergeBranch({ workspaceRoot: repo, sourceBranch: 'feature', targetBranch: 'main', localOnly: true });
  expect(result.success, result.error).toBe(true);
  expect(git(repo, 'log', '-1', '--format=%ae')).toBe('local-address');
});

for (const localOnly of [true, false]) {
  test(`missing identity does not auto-create or publish review target (local=${localOnly})`, async () => {
    commit(source, 'TASK');
    const before = snapshot();
    const result = await mergeBranch({ workspaceRoot: repo, sourceBranch: 'feature', targetBranch: 'review/new', localOnly });
    expect(result.success).toBe(false); expect(result.error).toContain('Git identity preflight failed');
    expect(git(repo, 'branch', '--list', 'review/new')).toBe('');
    expect(git(remote, 'branch', '--list', 'review/new')).toBe('');
    await preserved(before);
  });
}

for (const [options, succeeds] of [
  ['--no-ff', false], ['"--no-ff"', false], ['--no-ff --ff', true],
  ['--no-ff --ff-only', true], ['--squash', true], ['--log=3 --ff', true],
] as const) {
  test(`fast-forward sync with branch.mergeOptions=${options} and no identity`, async () => {
    commit(repo, 'TARGET'); git(source, 'config', 'branch.feature.mergeOptions', options);
    const before = snapshot(); const result = cli(['task', 'sync', task.id]);
    expect(result.status === 0, result.stdout + result.stderr).toBe(succeeds);
    if (!succeeds) {
      expect(JSON.parse(result.stderr).error).toContain('Git identity preflight failed');
      await preserved(before);
    }
  });
}

test('no-commit sync permits absent author when Git only needs committer', async () => {
  commit(source, 'TASK'); commit(repo, 'TARGET');
  git(source, 'config', 'branch.feature.mergeOptions', '--no-commit');
  Object.assign(process.env, { GIT_COMMITTER_NAME: 'Fixture Committer', GIT_COMMITTER_EMAIL: 'committer@example.test' });
  const before = git(source, 'rev-parse', 'HEAD'); const result = cli(['task', 'sync', task.id]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(git(source, 'rev-parse', 'HEAD')).toBe(before);
  expect(existsSync(git(source, 'rev-parse', '--git-path', 'MERGE_HEAD'))).toBe(true);
});

test('unrelated Git failure is nonzero JSON and retains original error', async () => {
  commit(source, 'TASK'); commit(repo, 'TARGET'); Object.assign(process.env, fixtureIdentity);
  // An invalid merge strategy is a Git error, not an identity error or conflict.
  git(source, 'config', 'branch.feature.mergeOptions', '--strategy=fixture-missing-strategy');
  const before = snapshot(); const result = cli(['task', 'sync', task.id]);
  expect(result.status).toBe(1); expect(JSON.parse(result.stderr).success).toBe(false);
  expect(JSON.parse(result.stderr).error).toContain('fixture-missing-strategy');
  expect(JSON.parse(result.stderr).error).not.toContain('Git identity preflight failed');
  await preserved(before);
});

test('merge option message text cannot disable identity preflight', async () => {
  commit(repo, 'TARGET');
  git(source, 'config', 'branch.feature.mergeOptions', "--no-ff -m '--no-commit'");
  Object.assign(process.env, { GIT_COMMITTER_NAME: 'Fixture Committer', GIT_COMMITTER_EMAIL: 'committer@example.test' });
  const before = snapshot(); const result = cli(['task', 'sync', task.id]);
  expect(result.status).toBe(1); expect(JSON.parse(result.stderr).error).toContain('GIT_AUTHOR_IDENT');
  await preserved(before);
});

test('identity error context containing CONFLICT is not mistaken for a merge conflict', async () => {
  commit(source, 'TASK'); git(source, 'branch', '-m', 'CONFLICT-feature');
  const before = snapshot();
  const result = await mergeBranch({ workspaceRoot: repo, sourceBranch: 'CONFLICT-feature', targetBranch: 'main', localOnly: true });
  expect(result.success).toBe(false); expect(result.hasConflict).toBe(false);
  expect(result.error).toContain('Git identity preflight failed');
  expect(result.error).toContain('CONFLICT-feature');
  await preserved(before);
});
