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
await rm(stage, { recursive: true, force: true });
await mkdir(bundle, { recursive: true });
await mkdir(resources, { recursive: true });
for (const name of ['main.js', 'manager.js', 'preload.cjs', 'shell.html', 'shell.css', 'shell.js']) {
  await cp(join(desktop, 'dist', name), join(bundle, name));
}
await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'stoneforge-desktop', productName: 'Stoneforge Desktop', version: '0.1.0', type: 'module', main: 'main.js' }));
execFileSync('pnpm', ['--filter', '@stoneforge/smithy', 'deploy', '--prod', join(resources, 'backend')], { cwd: root, stdio: 'inherit' });
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
}
console.log('Packaged:', paths.join('\n'));
