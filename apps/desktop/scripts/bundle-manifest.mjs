/** Record/verify a relocated app's complete file, symlink and permission inventory. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink, writeFile, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const [command, appArgument, manifestArgument] = process.argv.slice(2);
assert(['create', 'verify'].includes(command) && appArgument && manifestArgument,
  'Usage: node bundle-manifest.mjs create|verify APP MANIFEST.json');
const app = await realpath(appArgument);
const manifestPath = resolve(manifestArgument);
assert(!manifestPath.startsWith(app + '/'), 'Keep the manifest outside the app');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const entries = {};
async function visit(directory) {
  for (const name of (await readdir(directory)).sort()) {
    const file = join(directory, name);
    const stat = await lstat(file);
    const key = relative(app, file);
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) {
      const target = await readlink(file);
      assert((await realpath(file)).startsWith(app + '/'), `Escaping symlink: ${key}`);
      entries[key] = { type: 'symlink', mode, target };
    } else if (stat.isDirectory()) {
      entries[key] = { type: 'directory', mode };
      await visit(file);
    } else {
      assert(stat.isFile(), `Unexpected file type: ${key}`);
      entries[key] = { type: 'file', mode, size: stat.size, sha256: hash(await readFile(file)) };
    }
  }
}
await visit(app);
if (command === 'create') {
  // Never silently replace the approved inventory with a different bundle.
  await writeFile(manifestPath, JSON.stringify(entries, null, 2) + '\n', { flag: 'wx' });
} else {
  assert.deepEqual(entries, JSON.parse(await readFile(manifestPath, 'utf8')));
}
console.log(JSON.stringify({ command, app, entries: Object.keys(entries).length,
  manifestSha256: hash(await readFile(manifestPath)) }));
