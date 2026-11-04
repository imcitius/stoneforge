/**
 * Dev-identity coexistence check (el-4fxwb9). A dev/test package must be a different macOS app
 * from the installed Stoneforge Desktop: its own bundle ID (TCC decisions) and its own default
 * userData (Electron single-instance lock). This launches the dev app WITHOUT
 * STONEFORGE_DESKTOP_TEST_DATA, so it uses its real default userData and lock, and proves:
 *   1. it starts and keeps its window while any installed/production copy runs (no hand-off);
 *   2. its default userData is ".../Application Support/Stoneforge Desktop Dev";
 *   3. control: a second launch of the same dev app does hand off and exit (the lock is real).
 * It opens no project. It refuses production-identity apps: those would hand off to (and focus)
 * the installed app. Run it with an unlocked screen on a copy outside ~/Desktop (see README).
 *
 *   DESKTOP_APP=/tmp/x/Stoneforge\ Desktop\ Dev.app node apps/desktop/scripts/check-identity.mjs
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureEnv } from '../tests/fixture-env.mjs';
import { defaultApp, appExecutable, bundleIdentifier, plistValue, IDENTITIES } from './app-identity.mjs';
import { mainProcessErrors } from './main-process-errors.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { _electron } = createRequire(join(root, 'apps/smithy-web/package.json'))('playwright');
const bundle = defaultApp(join(root, 'apps/desktop'));
const dev = IDENTITIES.dev, production = IDENTITIES.production;
const build = JSON.parse(await readFile(join(bundle, 'Contents/Resources/app/build-info.json'), 'utf8'));
assert.equal(bundleIdentifier(bundle), dev.bundleId, `${bundle} is not a dev-identity app; refusing to launch it next to the installed app`);
assert.equal(build.identity, dev.name, 'build-info identity');
assert.equal(plistValue(bundle, 'CFBundleDisplayName'), dev.productName, 'CFBundleDisplayName');
const executable = appExecutable(bundle);
// Fixture directory and neutral cwd outside protected folders (the checkout may live under ~/Desktop).
const temp = await mkdtemp(join(tmpdir(), 'stoneforge-identity-'));
const cwd = temp;
// A main-process exception must fail this check, not hang it behind Electron's modal error box.
// The trap goes into the first (Playwright) instance, which also runs the 'second-instance'
// hand-off handler for step 2. The second, raw instance is deliberately not trapped: it loses
// the lock and quits before app 'ready', so it has no inspector session to install into; its
// failure modes (a modal error box, no hand-off) surface as the 20 s timeout or a non-zero exit.
const mainErrors = mainProcessErrors(join(temp, 'main-process-errors.jsonl'));
const env = { ...fixtureEnv(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
delete env.STONEFORGE_DESKTOP_TEST_DATA;
// Whatever production-identity copies run now (the installed app, a release download).
const productionRunning = execFileSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' }).split('\n')
  .filter((line) => line.includes(`/Contents/MacOS/${production.productName}`) && !line.includes('Helper') && !line.includes('--type='));
console.log(`Production-identity processes running: ${productionRunning.length}`);
let electron;
try {
  electron = await _electron.launch({ executablePath: executable, args: [], cwd, env, timeout: 30_000 });
  await mainErrors.install(electron);
  const page = await electron.firstWindow();
  await page.waitForSelector('#build');
  const userData = await electron.evaluate(({ app }) => app.getPath('userData'));
  assert.equal(userData, join(homedir(), 'Library/Application Support', dev.productName), 'Dev default userData');
  assert.equal(await electron.evaluate(({ app }) => app.getName()), dev.productName);
  assert.match(await page.locator('#build').textContent(), / · dev$/);
  // Still alive after the window loaded: a lost lock would have quit already.
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, 'Dev app keeps its window');
  console.log(`1. Dev app ${dev.bundleId} runs with its own lock (userData ${userData}) next to ${productionRunning.length} production process(es): passed`);

  // Control: a second dev launch shares that lock, so it must hand off and exit on its own.
  const second = spawn(executable, [], { cwd, env, stdio: 'ignore' });
  const code = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => { second.kill('SIGKILL'); reject(new Error('Second dev instance did not hand off within 20 s')); }, 20_000);
    second.on('exit', (exitCode) => { clearTimeout(timer); resolveExit(exitCode); });
    second.on('error', reject);
  });
  assert.equal(code, 0, 'Second dev instance exits cleanly after hand-off');
  // The first instance handled the hand-off ('second-instance') and must still be alive and clean.
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, 'Dev app keeps its window after the hand-off');
  await mainErrors.assertNone();
  console.log('2. Control: second instance of the same identity hands off and exits: passed');
} catch (error) {
  // A trapped main-process exception exits the app; report it rather than the resulting closed target.
  await mainErrors.rethrow(error);
} finally {
  await electron?.close().catch(() => {});
}
