import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  IDENTITIES, IDENTITY_ENV, resolveIdentity, packagedAppPath, defaultApp, bundleIdentifier, appExecutable,
  assertNotInstalledLocation, retargetToDevIdentity, copyAsDevApp, plistValue,
  ALLOW_PRODUCTION_IDENTITY_ENV, launchIdentity, launchRefusal, assertLaunchAllowed,
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

// Launch guard (el-3qg5my): check scripts refuse production-identity apps unless the release path opts in.
const productionInfo = { identity: 'production', bundleId: 'ai.stoneforge.desktop', productName: 'Stoneforge Desktop' };
const devInfo = { identity: 'dev', bundleId: 'ai.stoneforge.desktop.dev', productName: 'Stoneforge Desktop Dev' };
const legacyInfo = { version: '0.1.0', commit: 'c'.repeat(40) }; // build-info written before el-4fxwb9

test('launch guard: dev allowed, production refused with bundle ID and opt-in named, opt-in "1" allows', () => {
  assert.equal(ALLOW_PRODUCTION_IDENTITY_ENV, 'STONEFORGE_DESKTOP_ALLOW_PRODUCTION_IDENTITY');
  const dev = { app: '/tmp/x/Stoneforge Desktop Dev.app', bundleId: devInfo.bundleId, buildInfo: devInfo };
  assert.equal(launchIdentity(dev).production, false);
  assert.equal(launchRefusal({ ...dev, env: {} }), null);
  assert.equal(launchRefusal({ ...dev, env: { [ALLOW_PRODUCTION_IDENTITY_ENV]: '1' } }), null);
  // Other non-production IDs (e.g. the el-hdh3os .test package) do not share TCC state either.
  assert.equal(launchRefusal({ app: '/tmp/t.app', bundleId: 'ai.stoneforge.desktop.test', buildInfo: { identity: 'test' }, env: {} }), null);

  const production = { app: '/tmp/x/Stoneforge Desktop.app', bundleId: productionInfo.bundleId, buildInfo: productionInfo };
  assert.equal(launchIdentity(production).production, true);
  const refusal = launchRefusal({ ...production, env: {} });
  assert.match(refusal, /^Refusing to launch \/tmp\/x\/Stoneforge Desktop\.app: it has the production identity \(bundle ID ai\.stoneforge\.desktop;/);
  assert.match(refusal, /TCC/);
  assert.match(refusal, /copy-dev/);
  assert.match(refusal, /STONEFORGE_DESKTOP_ALLOW_PRODUCTION_IDENTITY=1\.$/);
  assert.equal(launchRefusal({ ...production, env: { [ALLOW_PRODUCTION_IDENTITY_ENV]: '1' } }), null);
  // Only exactly "1" opts in; anything else is refused and says why.
  for (const value of ['', 'true', 'yes', '0', ' 1']) {
    const message = launchRefusal({ ...production, env: { [ALLOW_PRODUCTION_IDENTITY_ENV]: value } });
    assert.match(message, /^Refusing to launch/, `value ${JSON.stringify(value)}`);
    if (value) assert.match(message, new RegExp(`it is set to "${value}", which is not "1"`));
  }
});

test('launch guard: builds before el-4fxwb9 (no identity fields) and unreadable identities count as production', () => {
  // Old release/package builds: production plist ID and build-info without identity fields.
  const legacy = { app: '/tmp/old/Stoneforge Desktop.app', bundleId: 'ai.stoneforge.desktop', buildInfo: legacyInfo };
  assert.deepEqual(launchIdentity(legacy), { production: true, bundleId: 'ai.stoneforge.desktop', reasons: [
    'its bundle ID is ai.stoneforge.desktop', 'its build-info.json has no identity (a build before el-4fxwb9)'] });
  assert.match(launchRefusal({ ...legacy, env: {} }), /bundle ID ai\.stoneforge\.desktop;.*before el-4fxwb9/);
  assert.equal(launchRefusal({ ...legacy, env: { [ALLOW_PRODUCTION_IDENTITY_ENV]: '1' } }), null);
  // Identity fields missing even though the plist was changed: cannot be shown to differ.
  assert.equal(launchIdentity({ bundleId: devInfo.bundleId, buildInfo: legacyInfo }).production, true);
  assert.equal(launchIdentity({ bundleId: devInfo.bundleId, buildInfo: null }).production, true);
  // Either source saying production is enough.
  assert.equal(launchIdentity({ bundleId: devInfo.bundleId, buildInfo: productionInfo }).production, true);
  assert.equal(launchIdentity({ bundleId: productionInfo.bundleId, buildInfo: devInfo }).production, true);
  // Unreadable Info.plist: the message falls back to the build-info / production bundle ID.
  const unreadable = launchIdentity({ bundleId: null, buildInfo: devInfo });
  assert.equal(unreadable.production, true);
  assert.deepEqual(unreadable.reasons, ['its Info.plist bundle ID could not be read']);
  assert.equal(launchIdentity({}).bundleId, 'ai.stoneforge.desktop');
});

test('assertLaunchAllowed reads the bundle: production and pre-el-4fxwb9 apps refused, dev copies and opt-in allowed', { skip: !darwin }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-launch-guard-'));
  try {
    const production = await fakeProductionApp(dir);
    assert.throws(() => assertLaunchAllowed(production, { env: {} }), /Refusing to launch .*bundle ID ai\.stoneforge\.desktop;/);
    assert.equal(assertLaunchAllowed(production, { env: { [ALLOW_PRODUCTION_IDENTITY_ENV]: '1' } }).production, true);
    const copy = join(dir, 'copy', 'Stoneforge Desktop.app');
    await mkdir(join(dir, 'copy'));
    copyAsDevApp(production, copy, { home: dir });
    assert.equal(assertLaunchAllowed(copy, { env: {} }).production, false);
    // A build before el-4fxwb9: production plist, build-info without identity fields.
    await writeFile(join(production, 'Contents/Resources/app/build-info.json'), JSON.stringify(legacyInfo));
    assert.throws(() => assertLaunchAllowed(production, { env: {} }), /before el-4fxwb9/);
    assert.throws(() => assertLaunchAllowed(join(dir, 'missing.app'), { env: {} }), /could not be read/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Every check script that launches the packaged app guards it before doing anything else.
// check-app is covered by the source scan only: it imports the built quarry CLI at load time.
const unguarded = new Map([['check-clipboard.mjs', 'launches the stock Electron binary, not a packaged app']]);
const launchesApp = (source) => /_electron\.launch\(|execFileSync\('\/usr\/bin\/open'/.test(source);
test('every check script that launches a packaged app calls requireLaunchAllowed(bundle) right after selecting it', async () => {
  const guarded = [];
  for (const name of (await readdir(join(desktop, 'scripts'))).filter((n) => /^check-.*\.mjs$/.test(n)).sort()) {
    const source = await readFile(join(desktop, 'scripts', name), 'utf8');
    if (!launchesApp(source) || unguarded.has(name)) continue;
    const select = source.match(/^const bundle = defaultApp\([^\n]*\);\n(?:\/\/[^\n]*\n)?requireLaunchAllowed\(bundle\);$/m);
    assert(select, `${name}: launches an app without requireLaunchAllowed(bundle) right after defaultApp()`);
    assert.equal(source.indexOf('defaultApp('), source.indexOf(select[0]) + 'const bundle = '.length, `${name}: selects the app only once`);
    guarded.push(name);
  }
  assert.deepEqual(guarded, ['check-app.mjs', 'check-attention.mjs', 'check-getting-started.mjs', 'check-identity.mjs', 'check-launch-services.mjs', 'check-tabs.mjs']);
});

test('check scripts exit 1 with the refusal before any fixture or launch for a production-identity app', { skip: !darwin }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-launch-guard-scripts-'));
  try {
    const app = await fakeProductionApp(dir);
    for (const name of ['check-attention.mjs', 'check-getting-started.mjs', 'check-identity.mjs', 'check-launch-services.mjs', 'check-tabs.mjs']) {
      const result = spawnSync(process.execPath, [join(desktop, 'scripts', name)], { encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, DESKTOP_APP: app, [ALLOW_PRODUCTION_IDENTITY_ENV]: '' } });
      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      assert.match(result.stderr, /^Refusing to launch .*Stoneforge Desktop\.app: it has the production identity \(bundle ID ai\.stoneforge\.desktop;/m, name);
      assert.equal(result.stdout, '', `${name} did nothing before refusing`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
