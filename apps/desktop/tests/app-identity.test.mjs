import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  IDENTITIES, IDENTITY_ENV, resolveIdentity, packagedAppPath, defaultApp, bundleIdentifier, appExecutable,
  assertNotInstalledLocation, retargetToDevIdentity, copyAsDevApp, plistValue,
} from '../scripts/app-identity.mjs';
import { RELEASE_VERSION_ENV } from '../scripts/release.mjs';

const desktop = resolve(import.meta.dirname, '..');
const darwin = process.platform === 'darwin';

test('identities: release keeps ai.stoneforge.desktop, dev/test packages use a distinct ID and product name', () => {
  assert.deepEqual({ ...IDENTITIES.production }, { name: 'production', bundleId: 'ai.stoneforge.desktop', productName: 'Stoneforge Desktop' });
  assert.deepEqual({ ...IDENTITIES.dev }, { name: 'dev', bundleId: 'ai.stoneforge.desktop.dev', productName: 'Stoneforge Desktop Dev' });
});

test('resolveIdentity: dev by default, production for releases or explicit opt-in, conflicts rejected', () => {
  assert.equal(resolveIdentity(), IDENTITIES.dev);
  assert.equal(resolveIdentity({ env: { [IDENTITY_ENV]: 'dev' } }), IDENTITIES.dev);
  assert.equal(resolveIdentity({ release: true }), IDENTITIES.production);
  assert.equal(resolveIdentity({ release: true, env: { [IDENTITY_ENV]: 'production' } }), IDENTITIES.production);
  assert.equal(resolveIdentity({ argv: ['--production-identity'] }), IDENTITIES.production);
  assert.equal(resolveIdentity({ env: { [IDENTITY_ENV]: 'production' } }), IDENTITIES.production);
  assert.equal(resolveIdentity({ env: { [IDENTITY_ENV]: '' } }), IDENTITIES.dev);
  assert.throws(() => resolveIdentity({ env: { [IDENTITY_ENV]: 'prod' } }), /Invalid STONEFORGE_DESKTOP_IDENTITY="prod"/);
  assert.throws(() => resolveIdentity({ release: true, env: { [IDENTITY_ENV]: 'dev' } }), /Release builds use the production identity/);
  assert.throws(() => resolveIdentity({ argv: ['--production-identity'], env: { [IDENTITY_ENV]: 'dev' } }), /Conflicting identity/);
});

test('package outputs are named after the product, so dev and release bundles never share a path', () => {
  assert.equal(packagedAppPath('/d', IDENTITIES.dev, 'arm64'), '/d/dist/mac/Stoneforge Desktop Dev-darwin-arm64/Stoneforge Desktop Dev.app');
  assert.equal(packagedAppPath('/d', IDENTITIES.production, 'arm64'), '/d/dist/mac/Stoneforge Desktop-darwin-arm64/Stoneforge Desktop.app');
});

test('defaultApp: DESKTOP_APP wins, else the newest packaged identity, else the dev path', async () => {
  const fake = await mkdtemp(join(tmpdir(), 'sf-identity-default-'));
  try {
    assert.equal(defaultApp(fake, {}, 'arm64'), packagedAppPath(fake, IDENTITIES.dev, 'arm64'));
    assert.equal(defaultApp(fake, { DESKTOP_APP: '/x/My.app' }, 'arm64'), '/x/My.app');
    for (const [identity, seconds] of [[IDENTITIES.dev, 1000], [IDENTITIES.production, 2000]]) {
      const contents = join(packagedAppPath(fake, identity, 'arm64'), 'Contents');
      await mkdir(contents, { recursive: true });
      await writeFile(join(contents, 'Info.plist'), '<plist/>');
      await utimes(join(contents, 'Info.plist'), seconds, seconds);
    }
    assert.equal(defaultApp(fake, {}, 'arm64'), packagedAppPath(fake, IDENTITIES.production, 'arm64'));
    await utimes(join(packagedAppPath(fake, IDENTITIES.dev, 'arm64'), 'Contents/Info.plist'), 3000, 3000);
    assert.equal(defaultApp(fake, {}, 'arm64'), packagedAppPath(fake, IDENTITIES.dev, 'arm64'));
  } finally {
    await rm(fake, { recursive: true, force: true });
  }
});

test('assertNotInstalledLocation refuses /Applications and ~/Applications', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sf-identity-home-'));
  try {
    await mkdir(join(home, 'Applications'));
    assert.throws(() => assertNotInstalledLocation(join(home, 'Applications/Stoneforge Desktop Preview.app'), home), /inside .*Applications/);
    assert.throws(() => assertNotInstalledLocation('/Applications/Stoneforge Desktop.app', home), /inside \/Applications/);
    assert.doesNotThrow(() => assertNotInstalledLocation(join(home, 'mutant/Stoneforge Desktop.app'), home));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

/** Minimal signed production-identity bundle shaped like a package:mac output (main + one helper). */
async function fakeProductionApp(dir) {
  const app = join(dir, 'Stoneforge Desktop.app');
  const plist = (id, name, exe) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleName</key><string>${name}</string>
<key>CFBundleDisplayName</key><string>${name}</string><key>CFBundleExecutable</key><string>${exe}</string>
<key>CFBundlePackageType</key><string>APPL</string></dict></plist>`;
  const helper = join(app, 'Contents/Frameworks/Stoneforge Desktop Helper (GPU).app');
  for (const [bundle, id, name] of [[app, 'ai.stoneforge.desktop', 'Stoneforge Desktop'], [helper, 'ai.stoneforge.desktop.helper.GPU', 'Stoneforge Desktop Helper (GPU)']]) {
    await mkdir(join(bundle, 'Contents/MacOS'), { recursive: true });
    await writeFile(join(bundle, 'Contents/Info.plist'), plist(id, name, name));
    await copyFile('/usr/bin/true', join(bundle, 'Contents/MacOS', name));
    await chmod(join(bundle, 'Contents/MacOS', name), 0o755);
  }
  await mkdir(join(app, 'Contents/Resources/app'), { recursive: true });
  await writeFile(join(app, 'Contents/Resources/app/package.json'), JSON.stringify({ name: 'stoneforge-desktop', productName: 'Stoneforge Desktop', version: '1.0.0', main: 'main.js' }));
  await writeFile(join(app, 'Contents/Resources/app/build-info.json'), JSON.stringify({ version: '1.0.0', commit: 'c'.repeat(40), identity: 'production', bundleId: 'ai.stoneforge.desktop', productName: 'Stoneforge Desktop' }));
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--identifier', 'ai.stoneforge.desktop', app], { stdio: 'pipe' });
  return app;
}

test('copyAsDevApp: a test/mutant copy gets the dev bundle ID, names and userData product name, re-signed', { skip: !darwin }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-identity-copy-'));
  try {
    const source = await fakeProductionApp(dir);
    const copy = join(dir, 'mutant', 'Stoneforge Desktop.app');
    await mkdir(join(dir, 'mutant'));
    assert.equal(copyAsDevApp(source, copy, { home: dir }), IDENTITIES.dev);
    assert.equal(bundleIdentifier(copy), 'ai.stoneforge.desktop.dev');
    assert.equal(plistValue(copy, 'CFBundleName'), 'Stoneforge Desktop', 'CFBundleName names the helpers Electron looks up; it must stay');
    assert.equal(plistValue(copy, 'CFBundleDisplayName'), 'Stoneforge Desktop Dev');
    assert.equal(appExecutable(copy), join(copy, 'Contents/MacOS/Stoneforge Desktop'), 'executable file name is kept');
    assert.equal(bundleIdentifier(join(copy, 'Contents/Frameworks/Stoneforge Desktop Helper (GPU).app')), 'ai.stoneforge.desktop.dev.helper.GPU');
    assert.equal(JSON.parse(await readFile(join(copy, 'Contents/Resources/app/package.json'), 'utf8')).productName, 'Stoneforge Desktop Dev');
    const info = JSON.parse(await readFile(join(copy, 'Contents/Resources/app/build-info.json'), 'utf8'));
    assert.deepEqual([info.identity, info.bundleId, info.productName, info.commit], ['dev', 'ai.stoneforge.desktop.dev', 'Stoneforge Desktop Dev', 'c'.repeat(40)]);
    const signature = spawnSync('/usr/bin/codesign', ['-dv', copy], { encoding: 'utf8' }).stderr;
    assert.match(signature, /^Identifier=ai\.stoneforge\.desktop\.dev$/m, 'signature identifier is the dev ID');
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', copy]);
    // The source keeps the production identity.
    assert.equal(bundleIdentifier(source), 'ai.stoneforge.desktop');
    assert.throws(() => copyAsDevApp(source, copy, { home: dir }), /already exists/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('retargetToDevIdentity refuses an app inside ~/Applications and leaves it unchanged', { skip: !darwin }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'sf-identity-installed-'));
  try {
    await mkdir(join(home, 'Applications'));
    const app = await fakeProductionApp(join(home, 'Applications'));
    assert.throws(() => retargetToDevIdentity(app, { home }), /Refusing to modify/);
    assert.equal(bundleIdentifier(app), 'ai.stoneforge.desktop');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('package:mac rejects an invalid or conflicting identity before packaging anything', () => {
  const run = (args, env) => spawnSync(process.execPath, [join(desktop, 'scripts/package.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, [RELEASE_VERSION_ENV]: '', [IDENTITY_ENV]: '', ...env } });
  let result = run([], { [IDENTITY_ENV]: 'bogus' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /package:mac: Invalid STONEFORGE_DESKTOP_IDENTITY="bogus"/);
  result = run(['--version', 'v1.2.3'], { [IDENTITY_ENV]: 'dev' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /package:mac: Release builds use the production identity/);
});
