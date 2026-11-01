import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { collectBuildInfo } from '../scripts/build-info.mjs';
import { parseReleaseVersion, isPrerelease, resolveReleaseVersion, assertReleaseTree, gitHead, artifactNames, formatChecksums, RELEASE_VERSION_ENV } from '../scripts/release.mjs';

const desktop = resolve(import.meta.dirname, '..');

test('parses release tags and bare versions as strict semver, stripping one leading v', () => {
  assert.equal(parseReleaseVersion('v1.26.0'), '1.26.0');
  assert.equal(parseReleaseVersion('1.26.0'), '1.26.0');
  assert.equal(parseReleaseVersion('v0.0.0'), '0.0.0');
  assert.equal(parseReleaseVersion('v1.26.0-rc.1'), '1.26.0-rc.1');
  assert.equal(parseReleaseVersion('v0.0.0-local.1'), '0.0.0-local.1');
  assert.equal(parseReleaseVersion('v2.0.0-alpha-beta.0.x7'), '2.0.0-alpha-beta.0.x7');
  assert.equal(parseReleaseVersion(' v10.20.30 '), '10.20.30');
  assert.equal(isPrerelease('v1.26.0-rc.1'), true);
  assert.equal(isPrerelease('v1.26.0'), false);
});

test('rejects non-semver tags with a clear message', () => {
  for (const bad of ['v1.2', '1.2', '1.2.3.4', 'v1.2.3.4', 'garbage', '', 'v', 'vv1.2.3', 'V1.2.3', 'v01.2.3', 'v1.02.3',
    'v1.2.3-', 'v1.2.3-rc..1', 'v1.2.3-01', 'v1.2.3 rc', 'release-1.2.3', 'refs/tags/v1.2.3', 'v1.2.3+build.5', 'v-1.2.3']) {
    assert.throws(() => parseReleaseVersion(bad), /Invalid release version/, `expected rejection of ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parseReleaseVersion(undefined), /must be a string/);
});

test('resolves the release version from --version or the environment, otherwise local mode', () => {
  assert.equal(resolveReleaseVersion([], {}), null);
  assert.equal(resolveReleaseVersion(['--other'], { [RELEASE_VERSION_ENV]: '' }), null);
  assert.equal(resolveReleaseVersion(['--version', 'v1.26.0'], {}), '1.26.0');
  assert.equal(resolveReleaseVersion(['--', '--version=v1.26.0-rc.1'], {}), '1.26.0-rc.1');
  assert.equal(resolveReleaseVersion([], { [RELEASE_VERSION_ENV]: 'v0.0.0-local.1' }), '0.0.0-local.1');
  assert.equal(resolveReleaseVersion(['--version', '1.2.3'], { [RELEASE_VERSION_ENV]: 'v1.2.3' }), '1.2.3');
  assert.throws(() => resolveReleaseVersion(['--version', 'v1.2.3'], { [RELEASE_VERSION_ENV]: 'v1.2.4' }), /Conflicting release versions/);
  assert.throws(() => resolveReleaseVersion(['--version'], {}), /requires a value/);
  assert.throws(() => resolveReleaseVersion(['--version', '--no-smoke'], {}), /requires a value/);
  assert.throws(() => resolveReleaseVersion(['--version', 'v1.2'], {}), /Invalid release version "v1.2"/);
  assert.throws(() => resolveReleaseVersion([], { [RELEASE_VERSION_ENV]: 'garbage' }), /Invalid release version/);
});

test('names release artifacts deterministically, arm64 only', () => {
  assert.deepEqual(artifactNames('v1.26.0'), { zip: 'Stoneforge-Desktop-1.26.0-arm64.zip', dmg: 'Stoneforge-Desktop-1.26.0-arm64.dmg',
    sums: 'SHA256SUMS.txt', volumeName: 'Stoneforge Desktop 1.26.0' });
  assert.equal(artifactNames('1.26.0-rc.1').zip, 'Stoneforge-Desktop-1.26.0-rc.1-arm64.zip');
  assert.equal(artifactNames('0.0.0-local.1').dmg, 'Stoneforge-Desktop-0.0.0-local.1-arm64.dmg');
  assert.throws(() => artifactNames('1.26.0', 'x64'), /only arm64/);
  assert.throws(() => artifactNames('1.26'), /Invalid release version/);
});

test('formats sorted shasum-compatible checksum lines', () => {
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  assert.equal(formatChecksums([{ name: 'z.zip', sha256: b }, { name: 'a.dmg', sha256: a }]), `${a}  a.dmg\n${b}  z.zip\n`);
  assert.throws(() => formatChecksums([{ name: 'x', sha256: 'nothex' }]), /Invalid SHA-256/);
  assert.throws(() => formatChecksums([{ name: '../x', sha256: a }]), /Invalid checksum file name/);
});

test('release tree check refuses dirty trees, commit mismatch and missing Git metadata', () => {
  const head = 'c'.repeat(40);
  assertReleaseTree({ version: '1.0.0', commit: head, dirty: false }, head);
  assert.throws(() => assertReleaseTree({ version: '1.0.0', commit: head, dirty: true }, head), /Refusing to build release 1\.0\.0: working tree is dirty/);
  assert.throws(() => assertReleaseTree({ version: '1.0.0', commit: 'd'.repeat(40), dirty: false }, head), /build-info commit d{40} != HEAD c{40}/);
  assert.throws(() => assertReleaseTree({ version: '1.0.0', commit: 'unknown', dirty: false }, null), /no Git HEAD.*build-info has no commit/);
});

test('release tree check against a real Git repository', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'sf-release-tree-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-q');
    await writeFile(join(repo, 'file.txt'), 'one\n');
    git('add', 'file.txt');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'init');
    const head = gitHead(repo);
    assert.match(head, /^[0-9a-f]{40}$/);
    const clean = collectBuildInfo(repo, '1.2.3');
    assert.equal(clean.dirty, false);
    assertReleaseTree(clean, head);

    await writeFile(join(repo, 'untracked.txt'), 'x\n');
    assert.throws(() => assertReleaseTree(collectBuildInfo(repo, '1.2.3'), gitHead(repo)), /working tree is dirty/);
    await rm(join(repo, 'untracked.txt'));
    await writeFile(join(repo, 'file.txt'), 'two\n');
    assert.throws(() => assertReleaseTree(collectBuildInfo(repo, '1.2.3'), gitHead(repo)), /working tree is dirty/);
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-am', 'second');
    // Build info captured before the new commit no longer matches HEAD.
    assert.throws(() => assertReleaseTree(clean, gitHead(repo)), /build-info commit .* != HEAD/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
  const notRepo = await mkdtemp(join(tmpdir(), 'sf-release-nogit-'));
  try {
    assert.equal(gitHead(notRepo), null);
    assert.throws(() => assertReleaseTree(collectBuildInfo(notRepo, '1.2.3'), gitHead(notRepo)), /no Git HEAD/);
  } finally {
    await rm(notRepo, { recursive: true, force: true });
  }
});

test('package:mac rejects an invalid release version before packaging anything', () => {
  const result = spawnSync(process.execPath, [join(desktop, 'scripts/package.mjs'), '--version', 'v1.2'], { encoding: 'utf8', env: { ...process.env, [RELEASE_VERSION_ENV]: '' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /package:mac: Invalid release version "v1.2"/);
});

test('release-artifacts refuses a non-release app', async () => {
  const fake = await mkdtemp(join(tmpdir(), 'sf-release-app-'));
  try {
    const app = join(fake, 'Stoneforge Desktop.app');
    execFileSync('mkdir', ['-p', join(app, 'Contents/Resources/app')]);
    await writeFile(join(app, 'Contents/Resources/app/build-info.json'), JSON.stringify({ version: '0.1.0', commit: 'c'.repeat(40), branch: 'x', dirty: true }));
    const result = spawnSync(process.execPath, [join(desktop, 'scripts/release-artifacts.mjs'), '--app', app, '--out', join(fake, 'out')], { encoding: 'utf8', env: { ...process.env, [RELEASE_VERSION_ENV]: '' } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is not a release build/);
  } finally {
    await rm(fake, { recursive: true, force: true });
  }
});
