import { collectBuildInfo } from './build-info.mjs';
import { resolveReleaseVersion, assertReleaseTree, gitHead, RELEASE_ARCH } from './release.mjs';
import { deployBackend } from './deploy-backend.mjs';
import { packager } from '@electron/packager';
import { cp, mkdir, rm, writeFile, chmod, readdir, readlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '../..');
const stage = join(desktop, 'dist/stage');
const bundle = join(stage, 'app');
const resources = join(stage, 'resources');
// Release mode: `--version v1.26.0` or STONEFORGE_RELEASE_VERSION=v1.26.0 (strict semver, leading v stripped).
// Without either, local builds keep using package.json's version and allow modified trees.
const fail = (message) => { console.error(`package:mac: ${message}`); process.exit(1); };
let releaseVersion;
try { releaseVersion = resolveReleaseVersion(process.argv.slice(2), process.env); } catch (error) { fail(error.message); }
const version = releaseVersion ?? require('../package.json').version;
const build = collectBuildInfo(root, version);
if (releaseVersion) {
  if (process.arch !== RELEASE_ARCH) fail(`Release builds are ${RELEASE_ARCH} only; this Node runs on ${process.arch}`);
  try { assertReleaseTree(build, gitHead(root)); } catch (error) { fail(error.message); }
  build.release = true;
  console.log(`Release build ${version} from ${build.commit}`);
  // Compiled outputs are ignored by Git, so a clean tree does not prove they match HEAD.
  // Rebuild everything the app copies from (Desktop main process, discovery module, backend).
  execFileSync('pnpm', ['--filter', '@stoneforge/smithy...', 'build'], { cwd: root, stdio: 'inherit' });
  execFileSync('pnpm', ['--filter', '@stoneforge/desktop', 'build'], { cwd: root, stdio: 'inherit' });
}
await rm(stage, { recursive: true, force: true });
await mkdir(bundle, { recursive: true });
await mkdir(resources, { recursive: true });
for (const name of ['main.js', 'socket-workaround.js', 'manager.js', 'attention.js', 'preload.cjs', 'shell.html', 'shell.css', 'shell.js', 'tab-layout.js', 'tabs.js', 'lifecycle.js', 'logs.js', 'logs-window.js', 'logs-preload.cjs', 'preferences.js']) {
  await cp(join(desktop, 'dist', name), join(bundle, name));
}
// The discovery module has only Node built-ins; copy it without pulling SDK/native code into Electron.
await cp(join(root, 'packages/quarry/dist/cli/server-discovery.js'), join(bundle, 'external.js'));
await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'stoneforge-desktop', productName: 'Stoneforge Desktop', version, type: 'module', main: 'main.js' }));
await writeFile(join(bundle, 'build-info.json'), JSON.stringify(build, null, 2) + '\n');
// Build the UI immediately before deployment so a cached SDK build cannot ship stale assets.
execFileSync('pnpm', ['--filter', '@stoneforge/smithy-web', 'build:web'], { cwd: root, stdio: 'inherit' });
// Staged inside the checkout: plain `pnpm deploy` writes pnpm state above it (see deploy-backend.mjs).
await deployBackend({ root, project: 'packages/smithy', filter: '@stoneforge/smithy', target: join(resources, 'backend') });
// pnpm deploy can copy spawn-helper from its store without executable permissions.
// Workspace postinstall hooks do not repair the deployed copy.
execFileSync(require.resolve('node/bin/node'), [join(resources, 'backend/scripts/fix-node-pty-permissions.cjs')], { cwd: join(resources, 'backend'), stdio: 'inherit' });
// Build native SQLite for the shipped Node ABI, regardless of the developer's system Node.
const bundledNode = require.resolve('node/bin/node');
const nativeEnv = { ...process.env, PATH: dirname(bundledNode) + ':' + (process.env.PATH ?? '') };
execFileSync('pnpm', ['rebuild', 'better-sqlite3'], { cwd: join(resources, 'backend'), env: nativeEnv, stdio: 'inherit' });
execFileSync(bundledNode, ['--input-type=module', '-e', "import { createStorage } from '@stoneforge/storage'; const db = createStorage({ path: ':memory:' }); db.close();"], { cwd: join(resources, 'backend'), env: nativeEnv, stdio: 'inherit' });
await mkdir(join(resources, 'runtime'));
await cp(require.resolve('node/bin/node'), join(resources, 'runtime/node'));
await writeFile(join(resources, 'runtime/sf'), '#!/bin/sh\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$SCRIPT_DIR/node" "$SCRIPT_DIR/../backend/dist/bin/sf.js" "$@"\n');
await chmod(join(resources, 'runtime/sf'), 0o755);
const paths = await packager({
  dir: bundle, out: join(desktop, 'dist/mac'), name: 'Stoneforge Desktop',
  platform: 'darwin', arch: process.arch, electronVersion: '44.4.5',
  appBundleId: 'ai.stoneforge.desktop', appCategoryType: 'public.app-category.developer-tools',
  asar: false, prune: false, overwrite: true,
  // Info.plist CFBundleShortVersionString/CFBundleVersion. Local builds keep packager's
  // default (the staged package.json version), so their behavior is unchanged.
  ...(releaseVersion ? { appVersion: version, buildVersion: version } : {}),
});
// packager's extraResource copier turns relative pnpm symlinks into absolute
// staging paths. Copy these resources verbatim so the app remains relocatable.
for (const output of paths) {
  const appPath = join(output, 'Stoneforge Desktop.app');
  const destination = join(appPath, 'Contents/Resources');
  await cp(join(resources, 'backend'), join(destination, 'backend'), { recursive: true, verbatimSymlinks: true });
  await cp(join(resources, 'runtime'), join(destination, 'runtime'), { recursive: true, verbatimSymlinks: true });
  async function verifyLinks(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = resolve(directory, await readlink(path));
        if (!target.startsWith(appPath + '/')) throw new Error('Nonportable bundle symlink: ' + path);
      } else if (entry.isDirectory()) await verifyLinks(path);
    }
  }
  await verifyLinks(appPath);
  execFileSync(join(destination, 'runtime/node'), [join(desktop, 'scripts/check-pty.mjs'), destination], { stdio: 'inherit' });
  // UNUserNotificationCenter requires a signed final app identity, including
  // its Info.plist. Local ad-hoc signing needs no Developer ID or account changes.
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--identifier', 'ai.stoneforge.desktop', appPath], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  if (releaseVersion) {
    const plist = join(appPath, 'Contents/Info.plist');
    for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
      const value = execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim();
      if (value !== version) fail(`Info.plist ${key} is ${value}, expected ${version}`);
    }
  }
}
if (releaseVersion) {
  // Packaging takes minutes; refuse a release whose source changed underneath it.
  const after = collectBuildInfo(root, version);
  if (after.commit !== build.commit || after.dirty) {
    fail(`Refusing release ${version}: source changed during packaging (HEAD ${build.commit} -> ${after.commit}, dirty=${after.dirty})`);
  }
}
console.log('Packaged:', paths.join('\n'));
