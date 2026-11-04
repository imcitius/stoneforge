/**
 * Create distributable release archives from the final signed app produced by
 * `package:mac` in release mode, then verify what users will actually unpack.
 *
 *   node scripts/release-artifacts.mjs [--version v1.26.0] [--app PATH] [--out DIR] [--no-smoke]
 *
 * Outputs (default apps/desktop/dist/release, recreated on each run):
 *   Stoneforge-Desktop-<version>-arm64.zip  ditto -c -k --sequesterRsrc --keepParent
 *   Stoneforge-Desktop-<version>-arm64.dmg  hdiutil UDZO with an /Applications link
 *   SHA256SUMS.txt                          `shasum -a 256 -c SHA256SUMS.txt` compatible
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, readlink, rm, stat, symlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { artifactNames, formatChecksums, resolveReleaseVersion, RELEASE_ARCH } from './release.mjs';
import { IDENTITIES, appExecutable } from './app-identity.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_NAME = 'Stoneforge Desktop.app';
const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1];
  return argv.find(a => a.startsWith(name + '='))?.slice(name.length + 1);
};
const fail = (message) => { console.error(`release-artifacts: ${message}`); process.exit(1); };
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
const sha256 = (file) => new Promise((resolvePromise, reject) => {
  const hash = createHash('sha256');
  createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolvePromise(hash.digest('hex')));
});

const app = resolve(option('--app') ?? process.env.DESKTOP_APP ?? join(desktop, `dist/mac/Stoneforge Desktop-darwin-${RELEASE_ARCH}/${APP_NAME}`));
const out = resolve(option('--out') ?? join(desktop, 'dist/release'));
const smoke = !argv.includes('--no-smoke');

// ---- Inputs: only a release-mode, clean, arm64, validly signed app is archived.
let requested;
try { requested = resolveReleaseVersion(argv, process.env); } catch (error) { fail(error.message); }
const build = JSON.parse(await readFile(join(app, 'Contents/Resources/app/build-info.json'), 'utf8').catch(() => fail(`No packaged app at ${app}`)));
if (build.release !== true || build.dirty !== false) fail(`${app} is not a release build (build-info release=${build.release}, dirty=${build.dirty}); run package:mac with --version/STONEFORGE_RELEASE_VERSION`);
const version = build.version;
if (requested && requested !== version) fail(`Requested version ${requested} but the app was packaged as ${version}`);
const names = artifactNames(version);
const plist = join(app, 'Contents/Info.plist');
const plistValue = (path, key) => run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path]).trim();
for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
  if (plistValue(plist, key) !== version) fail(`Info.plist ${key} is ${plistValue(plist, key)}, expected ${version}`);
}
// Releases keep the installed app's identity; dev/test packages use ai.stoneforge.desktop.dev (el-4fxwb9).
const production = IDENTITIES.production;
if (plistValue(plist, 'CFBundleIdentifier') !== production.bundleId) fail(`Info.plist CFBundleIdentifier is ${plistValue(plist, 'CFBundleIdentifier')}, expected ${production.bundleId}`);
if (build.identity !== undefined && build.identity !== production.name) fail(`build-info identity is ${build.identity}, expected ${production.name}`);
const executable = appExecutable(app);
if (executable !== join(app, 'Contents/MacOS', production.productName)) fail(`Main executable is ${executable}, expected ${production.productName}`);
const archs = run('/usr/bin/lipo', ['-archs', executable]).trim();
if (archs !== RELEASE_ARCH) fail(`Main executable architectures are "${archs}", expected ${RELEASE_ARCH} only`);

// codesign reports on stderr; return both streams and fail on a nonzero exit.
function runMerged(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.signal}): ${output}`);
  return output;
}
function verifySignature(path, label) {
  const output = runMerged('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', path]);
  console.log(`[verify] codesign --verify --deep --strict (${label}): OK\n  ${output.split('\n').join('\n  ')}`);
}
function signatureSummary(path) {
  return runMerged('/usr/bin/codesign', ['-dv', path]).split('\n')
    .filter(line => /^(Identifier|Format|Signature|CodeDirectory|TeamIdentifier)/.test(line)).join('; ');
}
verifySignature(app, 'source app');
console.log(`[verify] source signature: ${signatureSummary(app)}`);
console.log(`Release ${version} from commit ${build.commit} (${build.branch}, built ${build.builtAt}), app ${app}`);

// ---- Archives. The output directory is owned by this script and recreated deterministically.
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const zip = join(out, names.zip);
const dmg = join(out, names.dmg);
const temp = await realpath(await mkdtemp(join(tmpdir(), 'stoneforge-release-')));
let mountpoint;
try {
  // ditto keeps extended attributes/resource forks in AppleDouble form so the signature survives.
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);

  const dmgRoot = join(temp, 'dmg-root');
  await mkdir(dmgRoot);
  run('/usr/bin/ditto', [app, join(dmgRoot, APP_NAME)]);
  await symlink('/Applications', join(dmgRoot, 'Applications'));
  run('/usr/bin/hdiutil', ['create', '-volname', names.volumeName, '-srcfolder', dmgRoot, '-fs', 'HFS+', '-format', 'UDZO', '-ov', dmg]);

  const entries = [];
  for (const name of [names.zip, names.dmg]) entries.push({ name, sha256: await sha256(join(out, name)), size: (await stat(join(out, name))).size });
  await writeFile(join(out, names.sums), formatChecksums(entries));
  run('/usr/bin/shasum', ['-a', '256', '-c', names.sums], { cwd: out });
  console.log(`[verify] shasum -a 256 -c ${names.sums}: OK`);

  // ---- Verify the archives as a user receives them.
  const manifest = join(temp, 'source-manifest.json');
  const manifestTool = join(desktop, 'scripts/bundle-manifest.mjs');
  run(process.execPath, [manifestTool, 'create', app, manifest]);

  const unzipped = join(temp, 'zip');
  await mkdir(unzipped);
  run('/usr/bin/ditto', ['-x', '-k', zip, unzipped]);
  const zipApp = join(unzipped, APP_NAME);
  verifySignature(zipApp, 'extracted zip app');
  console.log(`[verify] extracted zip inventory matches source app: ${run(process.execPath, [manifestTool, 'verify', zipApp, manifest]).trim()}`);

  mountpoint = join(temp, 'dmg-mount');
  await mkdir(mountpoint);
  run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mountpoint, dmg]);
  if (await readlink(join(mountpoint, 'Applications')) !== '/Applications') throw new Error('DMG Applications link does not point to /Applications');
  const dmgApp = join(mountpoint, APP_NAME);
  verifySignature(dmgApp, 'mounted dmg app');
  console.log(`[verify] mounted dmg inventory matches source app: ${run(process.execPath, [manifestTool, 'verify', dmgApp, manifest]).trim()}`);
  for (const [label, path] of [['zip', zipApp], ['dmg', dmgApp]]) {
    const packaged = JSON.parse(await readFile(join(path, 'Contents/Resources/app/build-info.json'), 'utf8'));
    if (packaged.version !== version || packaged.commit !== build.commit) throw new Error(`${label} app build-info does not match the source app`);
    if (plistValue(join(path, 'Contents/Info.plist'), 'CFBundleShortVersionString') !== version) throw new Error(`${label} app Info.plist version mismatch`);
    if (plistValue(join(path, 'Contents/Info.plist'), 'CFBundleIdentifier') !== production.bundleId) throw new Error(`${label} app bundle ID is not ${production.bundleId}`);
  }
  run('/usr/bin/hdiutil', ['detach', mountpoint]);
  mountpoint = undefined;

  if (smoke) {
    console.log(`[verify] running scripts/check-app.mjs against the extracted zip app`);
    execFileSync(process.execPath, [join(desktop, 'scripts/check-app.mjs')], { stdio: 'inherit', env: { ...process.env, DESKTOP_APP: zipApp } });
    console.log('[verify] check-app.mjs on extracted zip app: OK');
  } else {
    console.log('[verify] check-app.mjs smoke skipped (--no-smoke); not release acceptance');
  }

  console.log(`\nRelease artifacts (${out}):`);
  for (const { name, size, sha256: digest } of entries) console.log(`  ${name}  ${size} bytes  sha256 ${digest}`);
  console.log(`  ${names.sums}`);
} catch (error) {
  process.exitCode = 1;
  console.error(`release-artifacts: ${error.message}`);
} finally {
  if (mountpoint) { try { run('/usr/bin/hdiutil', ['detach', '-force', mountpoint]); } catch { /* reported by the original failure */ } }
  await rm(temp, { recursive: true, force: true });
}
