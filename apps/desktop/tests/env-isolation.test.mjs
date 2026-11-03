import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fixtureEnv } from './fixture-env.mjs';

// Guards the rule in tests/fixture-env.mjs: no Desktop test or check script may
// hand an agent session's STONEFORGE_*/SF_* routing variables to a fixture `sf`
// or backend, because those variables point at the LIVE workspace database.
const require = createRequire(import.meta.url);
const desktop = resolve(import.meta.dirname, '..');
const root = resolve(desktop, '../..');
const node = require.resolve('node/bin/node');
const cli = join(root, 'packages/smithy/dist/bin/sf.js');
const self = 'env-isolation.test.mjs';
const spawnsStoneforge = source => /sf\.js|managed\.js|ProjectManager/.test(source);

const sources = async dir => Promise.all((await readdir(join(desktop, dir)))
  .filter(name => name.endsWith('.mjs') && name !== 'fixture-env.mjs')
  .map(async name => ({ name, path: `${dir}/${name}`, source: await readFile(join(desktop, dir, name), 'utf8') })));

// Files that only mention sf.js without running it as a fixture CLI.
const notFixtureCli = new Map([['scripts/package.mjs', 'build tooling: writes the bundled runtime/sf launcher, never runs it']]);

test('every Desktop test/check script that runs sf builds its env with fixtureEnv()', async () => {
  const files = [...await sources('tests'), ...await sources('scripts')]
    .filter(f => /sf\.js/.test(f.source) && !notFixtureCli.has(f.path));
  assert(files.some(f => f.name === 'canonical-root.test.mjs'), 'Scan must cover the sf fixture tests');
  for (const { path, source } of files) {
    // A plain copy of the parent environment carries the live workspace routing.
    assert.doesNotMatch(source, /\{\s*\.\.\.process\.env\b/, `${path} copies process.env; use fixtureEnv() from tests/fixture-env.mjs`);
    assert.match(source, /\bfixtureEnv\b/, `${path} runs sf without fixtureEnv()`);
  }
});

// Source text of each call `callee(...)` (balanced parentheses; enough for these scripts).
function calls(source, callee) {
  const found = [];
  for (let start = source.indexOf(callee); start !== -1; start = source.indexOf(callee, start + 1)) {
    let depth = 0, end = start + callee.indexOf('(');
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    found.push(source.slice(start, end + 1));
  }
  return found;
}

// Launching the packaged app is a second leak path: `/usr/bin/open` and Playwright's
// `_electron.launch` default to the parent environment, and an agent session's
// ELECTRON_RUN_AS_NODE=1 makes the app executable run as plain Node ("bad option:
// --project=...") while STONEFORGE_*/SF_* reach the app's own process.
test('every Desktop check script that launches the packaged app passes a fixtureEnv() environment', async () => {
  const files = [...await sources('tests'), ...await sources('scripts')].filter(f => f.name !== self);
  const launches = [];
  for (const { path, source } of files) {
    const open = calls(source, "execFileSync('/usr/bin/open'");
    const electron = calls(source, '_electron.launch(').filter(call => call.includes('Contents/MacOS/Stoneforge Desktop'));
    for (const call of open) {
      // Options follow the argv array; `--env` entries inside the array do not count.
      const options = call.slice(call.lastIndexOf(']') + 1);
      assert.match(options, /\benv\b/, `${path}: /usr/bin/open launch must pass { env } (it forwards its environment to the app)`);
    }
    for (const call of electron) assert.match(call, /\benv\s*[:,}]/, `${path}: _electron.launch of the packaged app must pass env`);
    if (open.length + electron.length) {
      launches.push(path);
      assert.match(source, /\bfixtureEnv\b/, `${path} launches the app without fixtureEnv()`);
      assert.doesNotMatch(source, /\{\s*\.\.\.process\.env\b/, `${path} copies process.env; use fixtureEnv() from tests/fixture-env.mjs`);
    }
  }
  assert(launches.includes('scripts/check-launch-services.mjs') && launches.includes('scripts/check-app.mjs'),
    `Scan must cover the LaunchServices and packaged UI checks, found ${launches}`);
});

// Every file, including dot-files and SQLite sidecars, with its size, mtime and hash.
async function snapshot(dir) {
  const entries = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath ?? entry.path, entry.name);
    if (!entry.isFile()) { entries[path] = entry.isDirectory() ? 'dir' : 'other'; continue; }
    const { size, mtimeMs } = await stat(path);
    entries[path] = { size, mtimeMs, sha256: createHash('sha256').update(await readFile(path)).digest('hex') };
  }
  return entries;
}

test('Desktop sf/backend tests never touch an inherited STONEFORGE_DB_PATH/STONEFORGE_ROOT', { timeout: 240_000 }, async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'stoneforge-sentinel-')));
  try {
    // A real initialized workspace stands in for the live one: a leaked fixture
    // CLI or backend would open it successfully and write, not just fail.
    const sentinel = join(temp, 'live-workspace'), uploads = join(temp, 'live-uploads');
    await mkdir(sentinel); await mkdir(uploads);
    execFileSync(node, [cli, 'init', '--preset', 'auto', '--name', 'sentinel-live'], { cwd: sentinel, env: fixtureEnv(), stdio: 'pipe' });
    const db = join(sentinel, '.stoneforge/stoneforge.db');
    await stat(db);
    const before = await snapshot(temp);

    const files = (await sources('tests')).filter(f => f.name.endsWith('.test.mjs') && f.name !== self && spawnsStoneforge(f.source));
    assert(files.length >= 4, `Expected the sf fixture test files, found ${files.map(f => f.name)}`);
    // Agent-session routing variables, all aimed at the sentinel.
    const env = fixtureEnv({
      STONEFORGE_ROOT: sentinel, STONEFORGE_DB_PATH: db, STONEFORGE_UPLOAD_DIR: uploads,
      STONEFORGE_DESKTOP_INSTANCE_ID: randomUUID(), STONEFORGE_SESSION_ID: randomUUID(), SF_ENTITY_ID: 'el-sentinel',
    });
    delete env.NODE_TEST_CONTEXT; // Otherwise the nested runner reports to this one instead of running the files.
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...files.map(f => f.path)],
      { cwd: desktop, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    // Checked first: a changed sentinel is the live-database leak this test exists for.
    assert.deepEqual(await snapshot(temp), before, 'Sentinel workspace, database and uploads must be byte-for-byte unchanged');
    assert.equal(code, 0, `Fixture tests failed under sentinel routing env:\n${output.slice(-8000)}`);
    const passed = Number(/^# pass (\d+)$/m.exec(output)?.[1] ?? 0);
    assert(passed >= files.length && /^# fail 0$/m.test(output), `Fixture tests did not actually run:\n${output.slice(-4000)}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
