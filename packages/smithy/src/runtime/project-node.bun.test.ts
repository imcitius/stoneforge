/**
 * Project Node selection — regression tests with real temporary fixtures.
 *
 * Fixture Node executables are small shell scripts in directories whose names
 * contain spaces. They report a fixed `--version` and, for any other
 * invocation, delegate to a real Node when one is available. Fixture package
 * managers record how they were invoked and which `node` they saw on PATH.
 *
 * Process spawns and timeouts (el-45u96a): tests of the selection rules use
 * {@link fixtureProbe}, which reads the version a fixture would print instead
 * of executing it, so their result cannot depend on host load. Real
 * `--version` probes stay covered by the explicit-Node test and by every
 * WorktreeManager, Spawner and merge-steward test, which go through production
 * code paths. Tests that spawn real processes get {@link REAL_SPAWN_TIMEOUT_MS}
 * instead of Bun's 5 s default: production allows each probe 10 s, so a slow
 * but successful probe must not be reported as a Bun timeout, and on the
 * shared, heavily loaded gate host (load 20–180) one such test once took
 * 5067 ms. The bound only catches hangs; no assertion depends on speed.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ElementId, EntityId } from '@stoneforge/core';
import {
  ProjectNodeError,
  projectNodeEnvironment,
  readNodeRequirement,
  resolveProjectNode,
  satisfiesNodeRange,
} from './project-node.js';
import { SpawnerServiceImpl } from './spawner.js';
import type { AgentProvider, InteractiveSession, InteractiveSpawnOptions } from '../providers/types.js';
import { createWorktreeManager, WorktreeError } from '../git/worktree-manager.js';
import { ProjectRepositories, repositoryForDirectory } from '../git/project-repositories.js';
import { MergeStewardServiceImpl } from '../services/merge-steward-service.js';

const REAL_NODE = Bun.which('node') ?? undefined;
const REAL_NPM = Bun.which('npm') ?? undefined;
/** Above project-node.ts probeVersion's own 10 s timeout; see the header. */
const REAL_SPAWN_TIMEOUT_MS = 30_000;

let sandbox: string;
const savedEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NVM_DIR: process.env.NVM_DIR, PM_LOG: process.env.PM_LOG, FAKE_PM_MODE: process.env.FAKE_PM_MODE };

beforeEach(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sf node fixtures ')));
  process.env.HOME = path.join(sandbox, 'home');
  fs.mkdirSync(process.env.HOME);
  delete process.env.NVM_DIR;
  process.env.PM_LOG = path.join(sandbox, 'pm.log');
  delete process.env.FAKE_PM_MODE;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function writeExecutable(file: string, content: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
  return file;
}

/** A Node installation directory with node + fake package managers. */
function fakeNodeDir(name: string, version: string, extras: { sf?: boolean } = {}): string {
  const bin = path.join(sandbox, name, 'bin');
  const delegate = REAL_NODE ? `exec "${REAL_NODE}" "$@"` : 'exit 0';
  writeExecutable(path.join(bin, 'node'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v${version}; exit 0; fi\n${delegate}\n`);
  const manager = (tool: string) => writeExecutable(path.join(bin, tool), [
    '#!/bin/sh',
    `echo "${tool} $* | node=$(node --version) | sf=$(command -v sf)" >> "$PM_LOG"`,
    'if [ "$FAKE_PM_MODE" = "ebadengine" ]; then echo "npm error code EBADENGINE" >&2; echo "npm error engine Unsupported engine" >&2; exit 1; fi',
    'exit 0',
    '',
  ].join('\n'));
  manager('npm');
  manager('pnpm');
  writeExecutable(path.join(bin, 'corepack'), `#!/bin/sh\necho "corepack $* | node=$(node --version)" >> "$PM_LOG"\nif [ "$1" = "--version" ]; then echo 0.0.0; exit 0; fi\ntool="$1"; shift\nexec "$(dirname "$0")/$tool" "$@"\n`);
  if (extras.sf) writeExecutable(path.join(bin, 'sf'), '#!/bin/sh\necho project-sf\n');
  writeExecutable(path.join(bin, 'claude'), '#!/bin/sh\necho shared-dir-claude\n');
  return bin;
}

/** Stoneforge's own runtime directory: bundled node + sf (Desktop layout). */
function stoneforgeRuntimeDir(): string {
  const bin = path.join(sandbox, 'Stoneforge Desktop.app', 'runtime');
  writeExecutable(path.join(bin, 'node'), '#!/bin/sh\necho v22.23.3\n');
  writeExecutable(path.join(bin, 'sf'), '#!/bin/sh\necho bundled-sf\n');
  return bin;
}

/**
 * Version probe for selection-logic tests: returns the version a fixture
 * script from {@link fakeNodeDir}/{@link stoneforgeRuntimeDir} would print,
 * without spawning it. Executables outside the sandbox (e.g. a system
 * /usr/bin/node on Linux) are reported as unusable so results stay host
 * independent. `probed` records every path the resolver asked about.
 */
function fixtureProbe() {
  const probed: string[] = [];
  const probeVersion = async (node: string) => {
    probed.push(node);
    if (!node.startsWith(sandbox + path.sep)) return { error: 'outside fixture sandbox (stub probe)' };
    const match = /echo (v\d+\.\d+\.\d+)/.exec(fs.readFileSync(node, 'utf8'));
    return match ? { version: match[1] } : { error: 'fixture prints no version' };
  };
  return { probed, probeVersion };
}

function project(name: string, files: Record<string, string>): string {
  const dir = path.join(sandbox, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
  return dir;
}

function gitRepo(name: string, files: Record<string, string>): string {
  const dir = project(name, files);
  execSync('git init -q -b master && git config user.email t@example.com && git config user.name t && git add -A && git commit -q -m init', { cwd: dir });
  return dir;
}

const STABLES_LIKE = {
  'package.json': JSON.stringify({ name: 'app', version: '1.0.0', engines: { node: '>=24.22.0 <24.23' } }),
  '.nvmrc': '24.22.0\n',
  '.npmrc': 'engine-strict=true\n',
  'package-lock.json': JSON.stringify({ name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'app', version: '1.0.0', engines: { node: '>=24.22.0 <24.23' } } } }, null, 2) + '\n',
};

function pmLog(): string[] {
  try { return fs.readFileSync(process.env.PM_LOG!, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
}

describe('satisfiesNodeRange', () => {
  test.each([
    ['24.22.0', '>=24.22.0 <25', true],
    ['22.23.3', '>=24.22.0 <25', false],
    ['26.8.2', '>=24.22.0 <25', false],
    ['24.9.0', '^24.1', true],
    ['25.0.0', '^24', false],
    ['20.11.1', '18.x || 20.x', true],
    ['22.1.0', '~22.1.0', true],
    ['22.2.0', '~22.1.0', false],
    ['24.0.0', '22 - 24', true],
    ['25.0.0', '22 - 24', false],
    ['24.22.0', '24.22.0', true],
    ['24.22.1', '24.22', true],
    ['24.23.0', '24.22', false],
    ['22.0.0', '>= 22', true],
    ['18.0.0', '*', true],
  ])('%s satisfies %s → %s', (version, range, expected) => {
    expect(satisfiesNodeRange(version, range)).toBe(expected);
  });
});

describe('readNodeRequirement', () => {
  test('reads engines and .nvmrc; none for unconstrained projects', () => {
    expect(readNodeRequirement(project('a', STABLES_LIKE))).toEqual({ engines: '>=24.22.0 <24.23', versionFile: { file: '.nvmrc', version: '24.22.0' } });
    expect(readNodeRequirement(project('b', { 'package.json': '{"name":"b"}' }))).toBeUndefined();
    expect(readNodeRequirement(project('c', { '.node-version': 'v22\n' }))).toEqual({ engines: undefined, versionFile: { file: '.node-version', version: '22' } });
  });
});

describe('resolveProjectNode', () => {
  test('selects compatible PATH Node over an earlier incompatible bundled one; mixed 22/24 projects differ', async () => {
    const runtime = stoneforgeRuntimeDir();
    const node24 = fakeNodeDir('node 24', '24.22.0');
    const node26 = fakeNodeDir('homebrew', '26.8.2');
    // Newer compatible Nodes later on PATH and in nvm must not displace the
    // first compatible PATH entry.
    const node24Later = fakeNodeDir('node 24 later', '24.22.5');
    fakeNodeDir(path.join('home', '.nvm', 'versions', 'node', 'v24.22.9'), '24.22.9');
    const env = { PATH: [runtime, node26, node24, node24Later, '/usr/bin', '/bin'].join(':'), HOME: process.env.HOME };
    const app24 = project('app 24', STABLES_LIKE);
    const app22 = project('app 22', { 'package.json': JSON.stringify({ engines: { node: '>=22.12.0 <23' } }) });
    const { probed, probeVersion } = fixtureProbe();
    const options = { env, systemPrefixes: [], probeVersion };

    const r24 = await resolveProjectNode(app24, options);
    expect(r24).toMatchObject({ status: 'selected', node: path.join(node24, 'node'), version: 'v24.22.0', source: 'path' });
    expect(probed).toEqual(expect.arrayContaining([runtime, node26, node24].map((dir) => path.join(dir, 'node'))));
    // Without a version file only engines.node decides: the incompatible
    // bundled 22 and Homebrew 26 come first on PATH and must be skipped; the
    // first compatible PATH Node wins over newer PATH and nvm ones.
    const engines24 = project('app 24 engines only', { 'package.json': JSON.stringify({ engines: { node: '>=24.22.0 <24.23' } }) });
    expect(await resolveProjectNode(engines24, options)).toMatchObject({ status: 'selected', node: path.join(node24, 'node'), version: 'v24.22.0', source: 'path' });
    const r22 = await resolveProjectNode(app22, options);
    expect(r22).toMatchObject({ status: 'selected', node: path.join(runtime, 'node'), version: 'v22.23.3' });
    const before = probed.length;
    expect(await resolveProjectNode(project('plain', { 'package.json': '{}' }), options)).toEqual({ status: 'unconstrained' });
    expect(probed).toHaveLength(before);
  });

  test('incompatible-only and missing Node produce actionable errors listing what was checked', async () => {
    const runtime = stoneforgeRuntimeDir();
    const node26 = fakeNodeDir('homebrew', '26.8.2');
    const app = project('app', STABLES_LIKE);
    const { probeVersion } = fixtureProbe();
    const error = await resolveProjectNode(app, { env: { PATH: `${runtime}:${node26}`, HOME: process.env.HOME }, systemPrefixes: [], repositoryId: 'stables', probeVersion }).catch((e) => e);
    expect(error).toBeInstanceOf(ProjectNodeError);
    expect(error.code).toBe('PROJECT_NODE_INCOMPATIBLE');
    expect(error.message).toContain('>=24.22.0 <24.23');
    expect(error.message).toContain(`${path.join(runtime, 'node')} (v22.23.3)`);
    expect(error.message).toContain(`${path.join(node26, 'node')} (v26.8.2)`);
    expect(error.message).toContain('sf repo update stables --node-path');
    expect(error.message).toContain('nvm');

    const missing = await resolveProjectNode(app, { env: { PATH: path.join(sandbox, 'empty'), HOME: process.env.HOME }, systemPrefixes: [], probeVersion }).catch((e) => e);
    expect(missing).toBeInstanceOf(ProjectNodeError);
    expect(missing.message).toContain('no Node executables found');
  });

  test('explicit Node is authoritative: validated, never replaced by a discovered one', async () => {
    const node24 = fakeNodeDir('node 24', '24.22.0');
    const node26 = fakeNodeDir('homebrew', '26.8.2');
    const app = project('app', STABLES_LIKE);
    const env = { PATH: node24, HOME: process.env.HOME };
    await expect(resolveProjectNode(app, { env, systemPrefixes: [], explicitNode: path.join(node26, 'node') })).rejects.toThrow(/Configured Node/);
    await expect(resolveProjectNode(app, { env, systemPrefixes: [], explicitNode: path.join(sandbox, 'missing', 'node') })).rejects.toThrow(/not an absolute path to an executable/);
    expect(await resolveProjectNode(app, { env: { PATH: '' }, systemPrefixes: [], explicitNode: path.join(node24, 'node') }))
      .toMatchObject({ status: 'selected', source: 'explicit', version: 'v24.22.0' });
  }, REAL_SPAWN_TIMEOUT_MS);

  test('discovers installed nvm versions and prefers the .nvmrc match', async () => {
    const versions = path.join(process.env.HOME!, '.nvm', 'versions', 'node');
    for (const v of ['24.22.0', '24.22.9']) {
      fs.mkdirSync(path.join(versions, `v${v}`), { recursive: true });
      fs.renameSync(path.dirname(fakeNodeDir(`nvm-${v}`, v)), path.join(versions, `v${v}`, 'x'));
      fs.renameSync(path.join(versions, `v${v}`, 'x', 'bin'), path.join(versions, `v${v}`, 'bin'));
    }
    const app = project('app', STABLES_LIKE);
    const result = await resolveProjectNode(app, { env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME }, systemPrefixes: [], probeVersion: fixtureProbe().probeVersion });
    expect(result).toMatchObject({ status: 'selected', source: 'version-manager', node: path.join(versions, 'v24.22.0', 'bin', 'node') });
  });
});

describe('projectNodeEnvironment', () => {
  test('child commands get the project Node while sf stays on the Stoneforge runtime', async () => {
    const runtime = stoneforgeRuntimeDir();
    const node24 = fakeNodeDir('node 24', '24.22.0', { sf: true });
    const app = project('app', STABLES_LIKE);
    const basePath = [runtime, '/usr/bin', '/bin'].join(':');
    const resolution = await resolveProjectNode(app, { explicitNode: path.join(node24, 'node'), env: { PATH: basePath }, systemPrefixes: [] });
    const env = projectNodeEnvironment(resolution, basePath, path.join(sandbox, 'sf root'));
    expect(env.STONEFORGE_PROJECT_NODE).toBe(path.join(node24, 'node'));
    // Only the Node toolchain is linked; unrelated siblings are not reordered.
    expect(fs.readdirSync(env.PATH.split(':')[0]).filter((n) => !n.startsWith('.')).sort()).toEqual(['corepack', 'node', 'npm', 'pnpm']);
    const out = execFileSync('/bin/sh', ['-c', 'node --version; npm --version >/dev/null; sf; command -v sf'], { env: { ...process.env, ...env }, encoding: 'utf8' });
    expect(out.split('\n').slice(0, 3)).toEqual(['v24.22.0', 'bundled-sf', path.join(runtime, 'sf')]);
    expect(pmLog()[0]).toContain('node=v24.22.0');
    expect(projectNodeEnvironment({ status: 'unconstrained' }, basePath)).toEqual({});
  }, REAL_SPAWN_TIMEOUT_MS);
});

describe('WorktreeManager dependency install', () => {
  async function manager(repo: string, projectNodePath?: string) {
    const m = createWorktreeManager({ workspaceRoot: repo, repositoryId: 'app', projectNodePath });
    await m.initWorkspace();
    return m;
  }
  const create = (m: Awaited<ReturnType<typeof manager>>, name: string) =>
    m.createWorktree({ agentName: name, taskId: `task-${name}` as ElementId, taskTitle: name, installDependencies: true });

  test('incompatible Node: no install command runs and the worktree is not left behind', async () => {
    const node26 = fakeNodeDir('homebrew', '26.8.2');
    process.env.PATH = [node26, '/usr/bin', '/bin'].join(':');
    const repo = gitRepo('repo', STABLES_LIKE);
    const error = await create(await manager(repo), 'w1').catch((e) => e);
    expect(error).toBeInstanceOf(WorktreeError);
    expect(error.code).toBe('PROJECT_NODE_INCOMPATIBLE');
    expect(error.message).toContain('sf repo update app --node-path');
    expect(pmLog()).toEqual([]);
    expect(fs.existsSync(path.join(repo, '.stoneforge/.worktrees/w1-w1'))).toBe(false);
  }, REAL_SPAWN_TIMEOUT_MS);

  test('compatible Node: npm ci runs on it; lockfile and engine-strict untouched', async () => {
    const runtime = stoneforgeRuntimeDir();
    const node24 = fakeNodeDir('node 24', '24.22.0');
    process.env.PATH = [runtime, node24, '/usr/bin', '/bin'].join(':');
    const repo = gitRepo('repo', STABLES_LIKE);
    const { path: worktree } = await create(await manager(repo), 'w2');
    expect(pmLog()).toEqual([`npm ci | node=v24.22.0 | sf=${path.join(runtime, 'sf')}`]);
    expect(fs.readFileSync(path.join(worktree, 'package-lock.json'), 'utf8')).toBe(STABLES_LIKE['package-lock.json']);
    expect(fs.readFileSync(path.join(worktree, '.npmrc'), 'utf8')).toBe('engine-strict=true\n');
    expect(execSync('git status --porcelain', { cwd: worktree, encoding: 'utf8' })).toBe('');
    // Shim links live under the project's .stoneforge and are self-ignored.
    expect(execSync('git status --porcelain --untracked-files=all -- .stoneforge/.runtime', { cwd: repo, encoding: 'utf8' })).toBe('');
    expect(fs.existsSync(path.join(repo, '.stoneforge/.runtime/node-shims'))).toBe(true);
  }, REAL_SPAWN_TIMEOUT_MS);

  test('EBADENGINE is not retried with a loose install', async () => {
    const node24 = fakeNodeDir('node 24', '24.22.0');
    process.env.PATH = [node24, '/usr/bin', '/bin'].join(':');
    process.env.FAKE_PM_MODE = 'ebadengine';
    const repo = gitRepo('repo', STABLES_LIKE);
    const error = await create(await manager(repo), 'w3').catch((e) => e);
    expect(error).toBeInstanceOf(WorktreeError);
    expect(error.code).toBe('PROJECT_NODE_INCOMPATIBLE');
    expect(error.details).toContain('EBADENGINE');
    expect(pmLog().map((l) => l.split(' |')[0])).toEqual(['npm ci']);
  }, REAL_SPAWN_TIMEOUT_MS);

  test('declared package manager (packageManager + pnpm lockfile) runs through corepack on the project Node', async () => {
    const node24 = fakeNodeDir('node 24', '24.22.0');
    const node26 = fakeNodeDir('homebrew', '26.8.2');
    process.env.PATH = [node26, '/usr/bin', '/bin'].join(':');
    const repo = gitRepo('repo', {
      'package.json': JSON.stringify({ name: 'p', packageManager: 'pnpm@9.0.0', engines: { node: '>=24.22.0 <24.23' } }),
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    });
    await create(await manager(repo, path.join(node24, 'node')), 'w4');
    const calls = pmLog();
    expect(calls).toContain('corepack pnpm install --frozen-lockfile | node=v24.22.0');
    expect(calls).toContain('pnpm install --frozen-lockfile | node=v24.22.0 | sf=');
  }, REAL_SPAWN_TIMEOUT_MS);

  test.skipIf(!REAL_NODE || !REAL_NPM)('real npm ci with engine-strict on a compatible explicit Node', async () => {
    const real = fs.realpathSync(REAL_NODE!);
    const major = Number(execFileSync(real, ['--version'], { encoding: 'utf8' }).trim().slice(1).split('.')[0]);
    const range = `>=${major}.0.0 <${major + 1}`;
    const pkg = { name: 'real', version: '1.0.0', engines: { node: range }, scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'ran-with\', process.execPath + \' \' + process.version)"' } };
    const lock = JSON.stringify({ name: 'real', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'real', version: '1.0.0', engines: { node: range } } } }, null, 2) + '\n';
    process.env.PATH = [path.dirname(REAL_NPM!), '/usr/bin', '/bin'].join(':');
    const repo = gitRepo('real repo', { 'package.json': JSON.stringify(pkg), 'package-lock.json': lock, '.npmrc': 'engine-strict=true\n' });
    const { path: worktree } = await create(await manager(repo, REAL_NODE), 'w5');
    // The lifecycle script ran under the selected Node, reached through the shim.
    expect(fs.readFileSync(path.join(worktree, 'ran-with'), 'utf8')).toBe(`${real} ${execFileSync(real, ['--version'], { encoding: 'utf8' }).trim()}`);
    expect(fs.readFileSync(path.join(worktree, 'package-lock.json'), 'utf8')).toBe(lock);
    expect(fs.readFileSync(path.join(worktree, '.npmrc'), 'utf8')).toBe('engine-strict=true\n');
  }, 120_000);
});

describe('Spawner project Node preflight', () => {
  function provider() {
    const calls: InteractiveSpawnOptions[] = [];
    const session = {
      write: () => {}, requestExit: () => {}, resize: () => {}, kill: () => {},
      onData: () => {}, onExit: () => {}, getSessionId: () => 'provider-session',
    } satisfies InteractiveSession;
    const p: AgentProvider = {
      name: 'fixture',
      interactive: { name: 'fixture', spawn: async (options) => { calls.push(options); return session; }, isAvailable: async () => true },
      headless: { name: 'fixture', spawn: async () => { throw new Error('unused'); }, isAvailable: async () => true },
      isAvailable: async () => true, getInstallInstructions: () => '', listModels: async () => [],
    };
    return { calls, p };
  }
  const agent = 'el-worker' as EntityId;

  test('worker is not spawned without a compatible Node; director keeps its environment', async () => {
    process.env.PATH = [fakeNodeDir('homebrew', '26.8.2'), '/usr/bin', '/bin'].join(':');
    const repo = project('repo', STABLES_LIKE);
    const { calls, p } = provider();
    const spawner = new SpawnerServiceImpl({ provider: p, workingDirectory: repo });
    await expect(spawner.spawn(agent, 'worker', { mode: 'interactive', workingDirectory: repo })).rejects.toBeInstanceOf(ProjectNodeError);
    expect(calls).toHaveLength(0);
    await spawner.spawn(agent, 'director', { mode: 'interactive', workingDirectory: repo });
    expect(calls).toHaveLength(1);
    expect(calls[0].environmentVariables?.PATH).toBeUndefined();
  }, REAL_SPAWN_TIMEOUT_MS);

  test('worker child gets the registry-configured Node through PATH; sf stays bundled', async () => {
    const runtime = stoneforgeRuntimeDir();
    const node24 = fakeNodeDir('node 24', '24.22.0', { sf: true });
    process.env.PATH = [runtime, fakeNodeDir('homebrew', '26.8.2'), '/usr/bin', '/bin'].join(':');
    const root = gitRepo('project root', STABLES_LIKE);
    fs.mkdirSync(path.join(root, '.stoneforge'));
    const registry = new ProjectRepositories(root);
    await expect(registry.setNodePath('default', 'relative/node')).rejects.toThrow(/absolute/);
    await registry.setNodePath('default', path.join(node24, 'node'));
    execSync(`git worktree add -q -b agent/w "${path.join(root, '.stoneforge/.worktrees/w')}"`, { cwd: root });
    const worktree = path.join(root, '.stoneforge/.worktrees/w');
    expect((await repositoryForDirectory(root, worktree))?.nodePath).toBe(path.join(node24, 'node'));

    const { calls, p } = provider();
    const spawner = new SpawnerServiceImpl({ provider: p, workingDirectory: root, stoneforgeRoot: root });
    await spawner.spawn(agent, 'worker', { mode: 'interactive', workingDirectory: worktree });
    const env = calls[0].environmentVariables!;
    expect(env.STONEFORGE_PROJECT_NODE).toBe(path.join(node24, 'node'));
    expect(env.SF_ENTITY_ID).toBe(agent);
    const out = execFileSync('/bin/sh', ['-c', 'node --version; command -v sf'], { cwd: worktree, env: { ...process.env, ...env }, encoding: 'utf8' });
    expect(out.trim().split('\n')).toEqual(['v24.22.0', path.join(runtime, 'sf')]);

    await registry.setNodePath('default', null);
    expect((await registry.list())[0].nodePath).toBeUndefined();
  }, REAL_SPAWN_TIMEOUT_MS);
});

describe('Merge steward checks', () => {
  test('test command runs on the repository Node; incompatible Node fails the check without running it', async () => {
    const node24 = fakeNodeDir('node 24', '24.22.0');
    const repo = project('repo', STABLES_LIKE);
    const api = { get: async () => ({ id: 'el-t', metadata: {} }) };
    const service = (projectNodePath?: string) => new MergeStewardServiceImpl(api as never, {} as never, {} as never, {} as never,
      { workspaceRoot: repo, testCommand: 'node --version && echo ran', projectNodePath, repositoryId: 'app' });
    const ok = await service(path.join(node24, 'node')).runTests('el-t' as ElementId);
    expect(ok.passed).toBe(true);
    expect(ok.output).toContain('v24.22.0');

    process.env.PATH = [fakeNodeDir('homebrew', '26.8.2'), '/usr/bin', '/bin'].join(':');
    const bad = await service().runTests('el-t' as ElementId);
    expect(bad.passed).toBe(false);
    expect(bad.exitCode).toBe(1);
    expect(bad.output).toContain('sf repo update app --node-path');
    expect(bad.output).not.toContain('ran');
  }, REAL_SPAWN_TIMEOUT_MS);
});
