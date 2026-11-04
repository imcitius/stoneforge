/** Verify LaunchServices launch with a Finder-like environment and no source-tree runtime. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureEnv } from '../tests/fixture-env.mjs';
import { mainProcessErrors, inspectMainProcess } from './main-process-errors.mjs';
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = resolve(process.env.DESKTOP_APP ?? join(desktop, 'dist/mac/Stoneforge Desktop-darwin-arm64/Stoneforge Desktop.app'));
const resources = join(bundle, 'Contents/Resources');
const temp = await mkdtemp(join(tmpdir(), 'stoneforge-launch-'));
const workspace = join(temp, 'Проект with spaces'); await mkdir(workspace);
const env = fixtureEnv();
execFileSync(join(resources, 'runtime/node'), [join(resources, 'backend/dist/bin/sf.js'), 'init', '--preset', 'auto', '--name', 'launch-fixture'], { cwd: workspace, env, stdio: 'pipe' });
const stdout = join(temp, 'stdout.log'), stderr = join(temp, 'stderr.log');
// `open` forwards its own environment to the launched app. An agent session's
// ELECTRON_RUN_AS_NODE would make the executable run as plain Node ("bad option:
// --project=...") and its STONEFORGE_*/SF_* routing would reach the app, so launch
// with the same stripped fixture environment a Finder-like launch would have.
// `--inspect=0` only lets the check install the test-side main-process exception trap (Electron's
// modal error box would otherwise leave a blocked app behind a passing check). The launch itself
// is verified through ps and the workspace lock, never through the inspector.
execFileSync('/usr/bin/open', ['-n', '--env', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin', '--env', `STONEFORGE_DESKTOP_TEST_DATA=${join(temp, 'app-data')}`, '--stdout', stdout, '--stderr', stderr, bundle, '--args', '--inspect=0', `--project=${workspace}`], { env });
const mainErrors = mainProcessErrors(join(temp, 'main-process-errors.jsonl'));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
const launchLog = async () => `\n--- app stderr.log ---\n${await readFile(stderr, 'utf8').catch((error) => `<unreadable: ${error.message}>`)}`;
let backendPid, appPid;
const launchedApp = () => {
  const processes = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n');
  const main = processes.find((line) => line.includes(join(bundle, 'Contents/MacOS/Stoneforge Desktop')) && line.includes(`--project=${workspace}`));
  return main ? Number(main.trim().split(/\s+/, 1)[0]) : undefined;
};
try {
  const inspector = await inspectMainProcess(stderr).catch(async (error) => { throw new Error(`${error.message}${await launchLog()}`); });
  try { await mainErrors.install(inspector); } finally { inspector.close(); }
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await mainErrors.recorded()).length) break;
    try {
      // Capture our own main process even if backend startup fails before its lock.
      appPid = launchedApp() ?? appPid;
      backendPid = JSON.parse(await readFile(join(workspace, '.stoneforge/server.lock/owner.json'), 'utf8')).pid;
      appPid = Number(execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(backendPid)], { encoding: 'utf8' }).trim());
      const command = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(appPid)], { encoding: 'utf8' }).trim();
      assert(command.startsWith(join(bundle, 'Contents/MacOS/Stoneforge Desktop')), command);
      break;
    } catch { await pause(200); }
  }
  assert(backendPid && appPid, `Launch did not start a managed child. Diagnostics: ${temp}${await launchLog()}`);
  // Let the UI finish loading. No terminal-provided Node is used; the inspector only installed the trap.
  await pause(2000);
  await mainErrors.assertNone();
  assert(alive(appPid), `App exited after starting its backend. Diagnostics: ${temp}${await launchLog()}`);
  assert(alive(backendPid), `Backend exited during startup. Diagnostics: ${temp}${await launchLog()}`);
  console.log(`LaunchServices + packaged runtime + Unicode path: passed. Diagnostics: ${temp}`);
} catch (error) {
  // A trapped main-process exception exits the app; report it rather than the resulting failure.
  await mainErrors.rethrow(error);
} finally {
  // A failure before the launch loop (e.g. no inspector) must not leave the app running.
  appPid ??= launchedApp();
  // The app may already have exited (a failed launch); that must not mask the real error.
  if (appPid) {
    try { process.kill(appPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  if (backendPid) {
    let exited = false;
    for (let attempt = 0; attempt < 250; attempt++) {
      if (!alive(backendPid)) { exited = true; break; }
      await pause(200);
    }
    assert(exited, 'Backend must exit after losing its parent');
    await assert.rejects(access(join(workspace, '.stoneforge/server.lock')));
    console.log('Parent exit shuts down backend and releases workspace: passed');
  }
}
