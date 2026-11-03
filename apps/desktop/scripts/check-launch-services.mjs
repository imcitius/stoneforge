/** Verify LaunchServices launch with a Finder-like environment and no source-tree runtime. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureEnv } from '../tests/fixture-env.mjs';
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
execFileSync('/usr/bin/open', ['-n', '--env', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin', '--env', `STONEFORGE_DESKTOP_TEST_DATA=${join(temp, 'app-data')}`, '--stdout', stdout, '--stderr', stderr, bundle, '--args', `--project=${workspace}`], { env });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
const launchLog = async () => `\n--- app stderr.log ---\n${await readFile(stderr, 'utf8').catch((error) => `<unreadable: ${error.message}>`)}`;
let backendPid, appPid;
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      // Capture our own main process even if backend startup fails before its lock.
      const processes = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n');
      const main = processes.find((line) => line.includes(join(bundle, 'Contents/MacOS/Stoneforge Desktop')) && line.includes(`--project=${workspace}`));
      if (main) appPid = Number(main.trim().split(/\s+/, 1)[0]);
      backendPid = JSON.parse(await readFile(join(workspace, '.stoneforge/server.lock/owner.json'), 'utf8')).pid;
      appPid = Number(execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(backendPid)], { encoding: 'utf8' }).trim());
      const command = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(appPid)], { encoding: 'utf8' }).trim();
      assert(command.startsWith(join(bundle, 'Contents/MacOS/Stoneforge Desktop')), command);
      break;
    } catch { await pause(200); }
  }
  assert(backendPid && appPid, `Launch did not start a managed child. Diagnostics: ${temp}${await launchLog()}`);
  // Let the UI finish loading. No inspector or terminal-provided Node is used.
  await pause(2000);
  assert(alive(appPid), `App exited after starting its backend. Diagnostics: ${temp}${await launchLog()}`);
  assert(alive(backendPid), `Backend exited during startup. Diagnostics: ${temp}${await launchLog()}`);
  console.log(`LaunchServices + packaged runtime + Unicode path: passed. Diagnostics: ${temp}`);
} finally {
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
