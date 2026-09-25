/** Verify LaunchServices launch with a Finder-like environment and no source-tree runtime. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = resolve(process.env.DESKTOP_APP ?? join(desktop, 'dist/mac/Stoneforge Desktop-darwin-arm64/Stoneforge Desktop.app'));
const resources = join(bundle, 'Contents/Resources');
const temp = await mkdtemp(join(tmpdir(), 'stoneforge-launch-'));
const workspace = join(temp, 'Проект with spaces'); await mkdir(workspace);
const env = { ...process.env }; delete env.STONEFORGE_ROOT;
execFileSync(join(resources, 'runtime/node'), [join(resources, 'backend/dist/bin/sf.js'), 'init', '--preset', 'auto', '--name', 'launch-fixture'], { cwd: workspace, env, stdio: 'pipe' });
const stdout = join(temp, 'stdout.log'), stderr = join(temp, 'stderr.log');
execFileSync('/usr/bin/open', ['-n', '--env', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin', '--env', `STONEFORGE_DESKTOP_TEST_DATA=${join(temp, 'app-data')}`, '--stdout', stdout, '--stderr', stderr, bundle, '--args', `--project=${workspace}`]);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
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
  assert(backendPid && appPid, `Launch did not start a managed child. Diagnostics: ${temp}`);
  // Let the UI finish loading. No inspector or terminal-provided Node is used.
  await pause(2000);
  process.kill(backendPid, 0);
  console.log(`LaunchServices + packaged runtime + Unicode path: passed. Diagnostics: ${temp}`);
} finally {
  if (appPid) process.kill(appPid, 'SIGKILL');
  if (backendPid) {
    let exited = false;
    for (let attempt = 0; attempt < 250; attempt++) {
      try { process.kill(backendPid, 0); } catch { exited = true; break; }
      await pause(200);
    }
    assert(exited, 'Backend must exit after losing its parent');
    await assert.rejects(access(join(workspace, '.stoneforge/server.lock')));
    console.log('Parent exit shuts down backend and releases workspace: passed');
  }
}
