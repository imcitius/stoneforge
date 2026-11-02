// Regression tests for scripts/ci-release.sh (the steps of .github/workflows/desktop-release.yml)
// that run without a packaged app: tag/version/mode resolution, release notes, the gh command,
// and the workflow pins. Packaging/verification are exercised by scripts/ci-release-local.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const desktop = resolve(import.meta.dirname, '..');
const root = resolve(desktop, '../..');
const script = join(root, 'scripts/ci-release.sh');
const workflow = readFileSync(join(root, '.github/workflows/desktop-release.yml'), 'utf8');

// Only the variables a test sets (plus PATH/HOME for node/bash) reach the script.
function run(step, vars = {}) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...vars };
  const result = spawnSync('bash', [script, step], { cwd: root, env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ci-release-test-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function resolveWith(vars) {
  return withTemp(async (dir) => {
    const output = join(dir, 'output'), envFile = join(dir, 'env');
    await writeFile(output, ''); await writeFile(envFile, '');
    const result = run('resolve', { GITHUB_OUTPUT: output, GITHUB_ENV: envFile, ...vars });
    const parse = (text) => Object.fromEntries(text.trim().split('\n').filter(Boolean).map((line) => line.split(/=(.*)/s).slice(0, 2)));
    return { ...result, outputs: parse(await readFile(output, 'utf8')), env: parse(await readFile(envFile, 'utf8')) };
  });
}

const push = (tag, extra = {}) => ({ GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: tag, ...extra });
const dispatch = (refType, refName, dryRun, version = '', extra = {}) => ({
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_TYPE: refType, GITHUB_REF_NAME: refName,
  RELEASE_DRY_RUN_INPUT: dryRun, RELEASE_VERSION_INPUT: version, ...extra,
});

test('tag push resolves a final release and writes step outputs and env', async () => {
  const r = await resolveWith(push('v1.26.0'));
  assert.equal(r.status, 0, r.stderr);
  const expected = { TAG: 'v1.26.0', VERSION: '1.26.0', PRERELEASE: 'false', DRY_RUN: 'false' };
  assert.deepEqual(r.outputs, expected);
  assert.deepEqual(r.env, expected);
});

test('a tag with a hyphen is a prerelease', async () => {
  const r = await resolveWith(push('v1.26.0-rc.1'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.outputs.VERSION, '1.26.0-rc.1');
  assert.equal(r.outputs.PRERELEASE, 'true');
  assert.equal(r.outputs.DRY_RUN, 'false');
});

test('invalid or non-tag pushes fail before any build', async () => {
  for (const [vars, message] of [
    [push('v1.2'), /invalid release version/],
    [push('v1.2.3+build.5'), /invalid release version/],
    [push('v01.2.3'), /invalid release version/],
    [push('1.2.3'), /must start with v/],
    [{ GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'master' }, /must be for a tag/],
    [{ GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'x' }, /unsupported event/],
  ]) {
    const r = await resolveWith(vars);
    assert.notEqual(r.status, 0, `${JSON.stringify(vars)} should fail`);
    assert.match(r.stderr, message);
    assert.deepEqual(r.outputs, {}, 'no outputs on failure');
  }
});

test('dispatch dry runs never publish and pick a version', async () => {
  let r = await resolveWith(dispatch('branch', 'master', 'true', '', { GITHUB_RUN_NUMBER: '42' }));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.outputs, { TAG: 'v0.0.0-dryrun.42', VERSION: '0.0.0-dryrun.42', PRERELEASE: 'true', DRY_RUN: 'true' });
  r = await resolveWith(dispatch('branch', 'master', 'true', 'v2.0.0'));
  assert.deepEqual(r.outputs, { TAG: 'v2.0.0', VERSION: '2.0.0', PRERELEASE: 'false', DRY_RUN: 'true' });
  r = await resolveWith(dispatch('tag', 'v1.3.0-beta.2', 'true'));
  assert.deepEqual(r.outputs, { TAG: 'v1.3.0-beta.2', VERSION: '1.3.0-beta.2', PRERELEASE: 'true', DRY_RUN: 'true' });
  r = await resolveWith(dispatch('branch', 'master', 'maybe'));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /dry_run input must be true or false/);
  r = await resolveWith(dispatch('branch', 'master', 'true', 'not-a-version'));
  assert.notEqual(r.status, 0);
});

test('a non-dry-run dispatch requires a tag ref and a matching version input', async () => {
  let r = await resolveWith(dispatch('branch', 'master', 'false'));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /must be started on a v\* tag ref/);
  r = await resolveWith(dispatch('tag', 'v1.4.0', 'false', '1.4.1'));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /does not match tag/);
  r = await resolveWith(dispatch('tag', 'v1.4.0', 'false', 'v1.4.0'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.outputs, { TAG: 'v1.4.0', VERSION: '1.4.0', PRERELEASE: 'false', DRY_RUN: 'false' });
});

const releaseVars = (dist, version, extra = {}) => ({
  CI_RELEASE_DIST: dist, TAG: `v${version}`, VERSION: version, PRERELEASE: version.includes('-') ? 'true' : 'false',
  DRY_RUN: 'false', GITHUB_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'imcitius/stoneforge', ...extra,
});

test('release notes carry the fixed arm64 / ad-hoc / first-launch / CLI section', async () => {
  await withTemp(async (dist) => {
    const r = run('notes', releaseVars(dist, '1.26.0', { GITHUB_RUN_ID: '123' }));
    assert.equal(r.status, 0, r.stderr);
    const notes = await readFile(join(dist, 'release-notes.md'), 'utf8');
    assert.match(notes, /Apple Silicon \(arm64\) only/);
    assert.match(notes, /Ad-hoc signed and not notarized/);
    assert.match(notes, /right-click/);
    assert.ok(notes.includes("xattr -dr com.apple.quarantine '/Applications/Stoneforge Desktop.app'"));
    assert.match(notes, /Codex and\/or Claude Code CLIs must already be installed and\s+authenticated/);
    assert.ok(notes.includes('Stoneforge-Desktop-1.26.0-arm64.dmg') && notes.includes('Stoneforge-Desktop-1.26.0-arm64.zip'));
    assert.ok(notes.includes('a'.repeat(40)));
    assert.ok(notes.includes('https://github.com/imcitius/stoneforge/actions/runs/123'));
  });
});

test('publish creates the release from the existing tag with zip, dmg and SHA256SUMS.txt', async () => {
  await withTemp(async (dist) => {
    await mkdir(join(dist, 'release'));
    await writeFile(join(dist, 'release-notes.md'), 'notes\n');
    const final = run('publish', releaseVars(dist, '1.26.0', { CI_RELEASE_PRINT_ONLY: '1' }));
    assert.equal(final.status, 0, final.stderr);
    const command = final.stdout.trim().split('\n').at(-1);
    assert.match(command, /^ gh release create v1\.26\.0 --repo imcitius\/stoneforge --verify-tag /);
    assert.match(command, /--generate-notes --notes-file /);
    assert.doesNotMatch(command, /--prerelease|--clobber|upload/);
    for (const name of ['Stoneforge-Desktop-1.26.0-arm64.zip', 'Stoneforge-Desktop-1.26.0-arm64.dmg', 'SHA256SUMS.txt']) {
      assert.ok(command.includes(join(dist, 'release', name).replace(/ /g, '\\ ')), `${name} attached`);
    }
    const pre = run('publish', releaseVars(dist, '1.26.0-rc.1', { CI_RELEASE_PRINT_ONLY: '1' }));
    assert.equal(pre.status, 0, pre.stderr);
    assert.match(pre.stdout, /--prerelease/);
    const dry = run('publish', releaseVars(dist, '1.26.0', { DRY_RUN: 'true', CI_RELEASE_PRINT_ONLY: '1' }));
    assert.notEqual(dry.status, 0);
    assert.match(dry.stderr, /dry run: refusing to publish/);
  });
});

test('workflow triggers, pins and permissions match the release contract', () => {
  const pinnedNode = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')).devDependencies.node;
  const pinnedPnpm = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager.replace('pnpm@', '');
  assert.match(workflow, /\n {2}push:\n {4}tags: \['v\*'\]\n {2}workflow_dispatch:\n/);
  assert.match(workflow, /\n {6}dry_run:\n(?: {8}.*\n)*? {8}type: boolean\n {8}default: true\n/);
  assert.match(workflow, /\npermissions:\n {2}contents: write\n\n/);
  assert.doesNotMatch(workflow, /secrets\./, 'no secrets beyond GITHUB_TOKEN (github.token)');
  assert.match(workflow, /\nconcurrency:\n {2}group: desktop-release-\$\{\{ github\.ref \}\}\n/);
  assert.match(workflow, /\n {4}runs-on: macos-15\n/);
  assert.doesNotMatch(workflow, /macos-latest/);
  assert.ok(workflow.includes(`node-version: ${pinnedNode}\n`), `Node ${pinnedNode}`);
  assert.ok(workflow.includes(`version: ${pinnedPnpm}\n`), `pnpm ${pinnedPnpm}`);
  assert.match(workflow, /cache: pnpm\n/);
  assert.match(workflow, /run: pnpm install --frozen-lockfile\n/);
  const steps = [...workflow.matchAll(/run: bash scripts\/ci-release\.sh (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(steps, ['resolve', 'preflight', 'build', 'artifacts', 'verify', 'notes', 'publish']);
  assert.match(workflow, /if: steps\.release\.outputs\.DRY_RUN == 'false'\n(?: {8}.*\n)*? {8}run: bash scripts\/ci-release\.sh publish/);
  assert.match(workflow, /if: steps\.release\.outputs\.DRY_RUN == 'true'\n {8}uses: actions\/upload-artifact@[0-9a-f]{40} # v4\.\d+\.\d+\n/);
  // The local runner executes the same subcommands in the same order.
  const local = readFileSync(join(root, 'scripts/ci-release-local.sh'), 'utf8');
  assert.deepEqual([...local.matchAll(/bash "\$STEP" (\w+)/g)].map((m) => m[1]), steps);
});

// Third-party actions are pinned to full commit SHAs with the release as a comment (el-3fg1vs);
// a retargeted tag must not change what runs, notably in the contents: write release workflow.
test('every workflow action is pinned to a full commit SHA', () => {
  const dir = join(root, '.github/workflows');
  const files = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.includes('desktop-release.yml'));
  let count = 0;
  for (const name of files) {
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:- )?uses:\s*(.*)$/);
      if (!m) continue;
      count += 1;
      assert.match(m[1], /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${name}: ${line.trim()}`);
    }
  }
  assert.ok(count > 0);
});

// `pnpm release` (scripts/release.mjs) only validates and prints the tag commands.
test('pnpm release helper validates the version and prints tag commands without creating anything', async () => {
  await withTemp(async (dir) => {
    const repo = join(dir, 'repo'), home = join(dir, 'home');
    await mkdir(repo); await mkdir(home);
    const helper = join(root, 'scripts/release.mjs');
    const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '-b', 'master'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.com');
    git('config', 'commit.gpgsign', 'false'); git('config', 'tag.gpgsign', 'false');
    await writeFile(join(repo, 'README'), 'x'); git('add', '.'); git('commit', '-qm', 'initial');
    const head = git('rev-parse', 'HEAD').stdout.trim();
    // No remote: read-only network checks only warn. Isolate from inherited Git/GitHub configuration.
    const env = { PATH: process.env.PATH, HOME: home, GH_CONFIG_DIR: join(home, 'gh'), GIT_CONFIG_NOSYSTEM: '1' };
    const release = (...args) => spawnSync(process.execPath, [helper, ...args], { cwd: repo, env, encoding: 'utf8' });

    let r = release('v1.26.0-rc.1');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`git tag -a v1.26.0-rc.1 -m "Stoneforge Desktop v1.26.0-rc.1" ${head}`));
    assert.ok(r.stdout.includes('git push origin v1.26.0-rc.1'));
    assert.match(r.stdout, /prerelease/);
    assert.equal(git('tag', '--list').stdout.trim(), '', 'no tag created');

    r = release('1.2');
    assert.notEqual(r.status, 0); assert.match(r.stderr, /Invalid release version/);
    r = release('v1.2.3', '--github-release');
    assert.notEqual(r.status, 0); assert.match(r.stderr, /unknown option/);
    r = release();
    assert.notEqual(r.status, 0); assert.match(r.stderr, /usage/);

    git('tag', 'v1.0.0');
    r = release('v1.0.0');
    assert.notEqual(r.status, 0); assert.match(r.stderr, /already exists locally/);

    await writeFile(join(repo, 'untracked'), 'x');
    r = release('v1.1.0');
    assert.notEqual(r.status, 0); assert.match(r.stderr, /working tree is not clean/);
  });
});
