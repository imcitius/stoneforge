/**
 * macOS app identity (bundle ID + product name) of packaged Stoneforge Desktop builds.
 *
 * macOS keys privacy (TCC) decisions such as Files and Folders > Desktop by bundle ID,
 * and Electron derives userData, and with it the single-instance lock, from the product
 * name. Builds that share both with the installed app interfere with it: a TCC decision
 * on a test copy revoked the installed app's Desktop access (all agents got EPERM, el-4fxwb9),
 * and a second copy hands its launch to the running one (`second-instance`).
 *
 *   production  ai.stoneforge.desktop      "Stoneforge Desktop"      release builds; opt-in for
 *                                                                    an installed-app update candidate
 *   dev         ai.stoneforge.desktop.dev  "Stoneforge Desktop Dev"  every other package and every
 *                                                                    copy re-signed for a test/mutant
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IDENTITIES = Object.freeze({
  production: Object.freeze({ name: 'production', bundleId: 'ai.stoneforge.desktop', productName: 'Stoneforge Desktop' }),
  dev: Object.freeze({ name: 'dev', bundleId: 'ai.stoneforge.desktop.dev', productName: 'Stoneforge Desktop Dev' }),
});
export const IDENTITY_ENV = 'STONEFORGE_DESKTOP_IDENTITY';
export const PRODUCTION_IDENTITY_FLAG = '--production-identity';

/**
 * Identity for package:mac. Release builds are always production. Other builds are dev unless
 * `--production-identity` or STONEFORGE_DESKTOP_IDENTITY=production explicitly asks for the
 * installed app's identity (an update candidate that must keep its userData/project registry).
 */
export function resolveIdentity({ release = false, argv = [], env = {} } = {}) {
  const raw = env[IDENTITY_ENV] ? String(env[IDENTITY_ENV]).trim() : '';
  if (raw && !Object.hasOwn(IDENTITIES, raw)) {
    throw new Error(`Invalid ${IDENTITY_ENV}="${raw}": expected "production" or "dev"`);
  }
  const flag = argv.includes(PRODUCTION_IDENTITY_FLAG);
  if (flag && raw === 'dev') throw new Error(`Conflicting identity: ${PRODUCTION_IDENTITY_FLAG} but ${IDENTITY_ENV}=dev`);
  if (release) {
    if (raw === 'dev') throw new Error(`Release builds use the production identity; unset ${IDENTITY_ENV}=dev`);
    return IDENTITIES.production;
  }
  return flag || raw === 'production' ? IDENTITIES.production : IDENTITIES.dev;
}

/** package:mac output for an identity: dist/mac/<product>-darwin-<arch>/<product>.app */
export function packagedAppPath(desktop, identity, arch = process.arch) {
  return join(desktop, 'dist/mac', `${identity.productName}-darwin-${arch}`, `${identity.productName}.app`);
}

/**
 * App under test for check scripts: DESKTOP_APP, else the most recently packaged of the
 * dev/production outputs in dist/mac (package:mac removes the other one, so normally one exists).
 */
export function defaultApp(desktop, env = process.env, arch = process.arch) {
  if (env.DESKTOP_APP) return resolve(env.DESKTOP_APP);
  const candidates = Object.values(IDENTITIES).map((identity) => packagedAppPath(desktop, identity, arch))
    .filter((path) => existsSync(join(path, 'Contents/Info.plist')))
    .sort((a, b) => statSync(join(b, 'Contents/Info.plist')).mtimeMs - statSync(join(a, 'Contents/Info.plist')).mtimeMs);
  return candidates[0] ?? packagedAppPath(desktop, IDENTITIES.dev, arch);
}

export function plistValue(app, key) {
  return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
}

/** Main executable of an app bundle (its name follows the product name). */
export function appExecutable(app) {
  return join(app, 'Contents/MacOS', plistValue(app, 'CFBundleExecutable'));
}

export function bundleIdentifier(app) {
  return plistValue(app, 'CFBundleIdentifier');
}

/**
 * Launch guard (el-3qg5my). Check scripts that start a packaged app refuse production-identity
 * bundles: macOS keys TCC decisions by bundle ID, so a locally launched copy with the installed
 * app's ID can change the installed app's privacy grants (the Desktop-folder EPERM of el-4fxwb9).
 * Only the release path (scripts/ci-release.sh, on a GitHub runner) sets this opt-in to "1".
 */
export const ALLOW_PRODUCTION_IDENTITY_ENV = 'STONEFORGE_DESKTOP_ALLOW_PRODUCTION_IDENTITY';

/**
 * Whether a launch candidate has the production identity, from its Info.plist CFBundleIdentifier
 * (`bundleId`, null when unreadable) and build-info.json (`buildInfo`, null when missing).
 * Either source saying production is enough. An unreadable bundle ID and builds before el-4fxwb9
 * (no `identity` field in build-info) count as production: they cannot be shown to differ.
 */
export function launchIdentity({ bundleId = null, buildInfo = null } = {}) {
  const production = IDENTITIES.production;
  const reasons = [];
  if (!bundleId) reasons.push('its Info.plist bundle ID could not be read');
  else if (bundleId === production.bundleId) reasons.push(`its bundle ID is ${production.bundleId}`);
  if (!buildInfo || buildInfo.identity === undefined) reasons.push('its build-info.json has no identity (a build before el-4fxwb9)');
  else if (buildInfo.identity === production.name || buildInfo.bundleId === production.bundleId) reasons.push('its build-info.json identity is production');
  return { production: reasons.length > 0, bundleId: bundleId || buildInfo?.bundleId || production.bundleId, reasons };
}

/** Refusal message for launching `app`, or null when the launch is allowed. Pure; see launchIdentity. */
export function launchRefusal({ app, bundleId = null, buildInfo = null, env = {} }) {
  const identity = launchIdentity({ bundleId, buildInfo });
  if (!identity.production) return null;
  const optIn = env[ALLOW_PRODUCTION_IDENTITY_ENV];
  if (optIn === '1') return null;
  return [
    `Refusing to launch ${app}: it has the production identity (bundle ID ${identity.bundleId}; ${identity.reasons.join('; ')}).`,
    `macOS privacy (TCC) decisions are keyed by bundle ID, so launching it here can change the installed Stoneforge Desktop's grants (el-4fxwb9).`,
    `Use a dev-identity build instead: a plain \`pnpm --filter @stoneforge/desktop package:mac\`, or \`node apps/desktop/scripts/app-identity.mjs copy-dev <app> <copy.app>\` and DESKTOP_APP=<copy.app>.`,
    `Release verification only (scripts/ci-release.sh sets it): ${ALLOW_PRODUCTION_IDENTITY_ENV}=1` +
      (optIn === undefined || optIn === '' ? '.' : ` (it is set to "${optIn}", which is not "1").`),
  ].join('\n');
}

/** Read `app`'s identity and throw the launchRefusal message unless the launch is allowed. */
export function assertLaunchAllowed(app, { env = process.env } = {}) {
  let bundleId = null, buildInfo = null;
  try { bundleId = bundleIdentifier(app); } catch { /* unreadable: counts as production */ }
  try { buildInfo = JSON.parse(readFileSync(join(app, 'Contents/Resources/app/build-info.json'), 'utf8')); } catch { /* missing */ }
  const refusal = launchRefusal({ app, bundleId, buildInfo, env });
  if (refusal) throw new Error(refusal);
  const identity = launchIdentity({ bundleId, buildInfo });
  if (identity.production) console.warn(`[launch guard] launching production-identity app ${app} (${identity.bundleId}): ${ALLOW_PRODUCTION_IDENTITY_ENV}=1`);
  return identity;
}

/** For check scripts: assertLaunchAllowed, printing the refusal and exiting 1 instead of throwing. */
export function requireLaunchAllowed(app, options) {
  try { return assertLaunchAllowed(app, options); } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

/** Real path of the nearest existing ancestor plus the rest (/var -> /private/var even for new paths). */
function canonical(path) {
  const parts = [];
  let current = resolve(path);
  while (!existsSync(current) && dirname(current) !== current) { parts.unshift(basename(current)); current = dirname(current); }
  return join(existsSync(current) ? realpathSync(current) : current, ...parts);
}

/** Refuse to modify anything in an Applications folder (the installed app is never a test object). */
export function assertNotInstalledLocation(app, home = homedir()) {
  const real = canonical(app);
  for (const folder of ['/Applications', join(home, 'Applications')]) {
    const prefix = canonical(folder);
    if (real === prefix || real.startsWith(prefix + sep)) throw new Error(`Refusing to modify ${app}: it is inside ${folder}`);
  }
}

function setPlist(plist, key, value) {
  execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, plist]);
}

/**
 * Rewrite an app copy (a test copy or mutant, never an installed app) to the dev identity and
 * ad-hoc re-sign it, so macOS and Electron treat it as a different app from the installed one.
 * Executable, CFBundleName and helper names are kept; bundle IDs, display name, the Electron product name
 * (userData + single-instance lock) and build-info identity change. Must run before signing.
 */
export function retargetToDevIdentity(app, { home = homedir() } = {}) {
  assertNotInstalledLocation(app, home);
  const dev = IDENTITIES.dev;
  const plist = join(app, 'Contents/Info.plist');
  const previous = plistValue(app, 'CFBundleIdentifier');
  setPlist(plist, 'CFBundleIdentifier', dev.bundleId);
  // CFBundleName stays: Electron finds Frameworks/"<CFBundleName> Helper.app" by it ("Unable to find helper app").
  setPlist(plist, 'CFBundleDisplayName', dev.productName);
  // Helpers (GPU, Renderer, Plugin, login item) carry `<app id>.helper...` identifiers.
  const frameworks = join(app, 'Contents/Frameworks');
  for (const entry of existsSync(frameworks) ? readdirSync(frameworks) : []) {
    const helperPlist = join(frameworks, entry, 'Contents/Info.plist');
    if (!entry.endsWith('.app') || !existsSync(helperPlist)) continue;
    const id = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', helperPlist], { encoding: 'utf8' }).trim();
    if (id === previous || id.startsWith(previous + '.')) setPlist(helperPlist, 'CFBundleIdentifier', dev.bundleId + id.slice(previous.length));
  }
  const appDir = join(app, 'Contents/Resources/app');
  const pkgPath = join(appDir, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    writeFileSync(pkgPath, JSON.stringify({ ...pkg, productName: dev.productName }));
  }
  const infoPath = join(appDir, 'build-info.json');
  if (existsSync(infoPath)) {
    const info = JSON.parse(readFileSync(infoPath, 'utf8'));
    writeFileSync(infoPath, JSON.stringify({ ...info, identity: dev.name, bundleId: dev.bundleId, productName: dev.productName }, null, 2) + '\n');
  }
  signApp(app, dev.bundleId);
  const now = bundleIdentifier(app);
  if (now !== dev.bundleId) throw new Error(`${app} still has bundle ID ${now}`);
  return dev;
}

/** Ad-hoc sign the final bundle (UNUserNotificationCenter needs a signed identity) and verify it. */
export function signApp(app, bundleId) {
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--identifier', bundleId, app], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
}

/** Copy an app for mutation/testing and give the copy the dev identity before anything runs it. */
export function copyAsDevApp(source, destination, { home = homedir() } = {}) {
  if (existsSync(destination)) throw new Error(`Destination ${destination} already exists`);
  assertNotInstalledLocation(destination, home);
  if (!existsSync(dirname(destination))) throw new Error(`Destination folder ${dirname(destination)} does not exist`);
  // ditto preserves symlinks, modes and extended attributes like Finder copies do.
  execFileSync('/usr/bin/ditto', [source, destination]);
  return retargetToDevIdentity(destination, { home });
}

// CLI: show an app's identity, or make a dev-identity test copy (use this for mutants).
//   node scripts/app-identity.mjs show <app>
//   node scripts/app-identity.mjs copy-dev <source.app> <destination.app>
//   node scripts/app-identity.mjs retarget-dev <copy.app>
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, first, second] = process.argv.slice(2);
  try {
    if (command === 'show' && first) {
      const info = JSON.parse(readFileSync(join(first, 'Contents/Resources/app/build-info.json'), 'utf8'));
      console.log(JSON.stringify({ bundleId: bundleIdentifier(first), name: plistValue(first, 'CFBundleName'),
        executable: appExecutable(first), identity: info.identity ?? 'unknown', productName: info.productName ?? 'unknown' }, null, 2));
    } else if (command === 'copy-dev' && first && second) {
      console.log(`Dev-identity copy: ${second} (${copyAsDevApp(resolve(first), resolve(second)).bundleId})`);
    } else if (command === 'retarget-dev' && first) {
      console.log(`Retargeted ${first} to ${retargetToDevIdentity(resolve(first)).bundleId}`);
    } else {
      console.error('Usage: app-identity.mjs show <app> | copy-dev <source.app> <destination.app> | retarget-dev <copy.app>');
      process.exit(2);
    }
  } catch (error) {
    console.error(`app-identity: ${error.message}`);
    process.exit(1);
  }
}
