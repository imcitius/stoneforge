import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { ProjectManager } from '../dist/manager.js';
import { findExternalServer } from '../dist/external.js';
import { projectStatus, tabMenuModel } from '../dist/tabs.js';
import { fixtureEnv } from './fixture-env.mjs';
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../../..');
const node = require.resolve('node/bin/node');
const cli = join(root, 'packages/smithy/dist/bin/sf.js');

for (const mode of ['managed', 'external', 'legacy']) for (const paused of [false, true]) {
  const external = mode !== 'managed';
  test(`${mode} project restart preserves ${paused ? 'explicit user pause' : 'automatic task processing'}`, { timeout: 60_000 }, async () => {
    const temp = await mkdtemp(join(tmpdir(), 'sf-daemon-lifecycle-'));
    const projectRoot = join(temp, 'project'); await mkdir(projectRoot);
    const manager = new ProjectManager({ dataDir: join(temp, 'registry'), node,
      entry: join(root, 'packages/smithy/dist/server/managed.js'),
      webRoot: join(root, 'packages/smithy/web'), binDir: join(root, 'apps/desktop/scripts/bin') });
    const env = fixtureEnv({ STONEFORGE_ROOT: projectRoot, DAEMON_AUTO_START: 'true' });
    let child, exited;
    const originalFetch = globalThis.fetch;
    try {
      await manager.load();
      const project = await manager.initialize(projectRoot, 'approve');
      if (external) {
        // Keep the process alive briefly after the server socket closes. Restart
        // must await process exit rather than mistake socket loss for full cleanup.
        const delay = join(temp, 'delay-exit.cjs');
        await writeFile(delay, 'const exit = process.exit.bind(process); process.exit = code => setTimeout(() => exit(code), 300);');
        child = spawn(node, [cli, 'serve', '--no-open', '--host', '127.0.0.1', '--port', '0'], { cwd: projectRoot, env: { ...env, NODE_OPTIONS: `--require=${delay}` }, stdio: 'ignore' });
        exited = new Promise(resolve => child.once('exit', resolve));
        let found;
        for (let i = 0; i < 80; i++) {
          found = await findExternalServer(project.root);
          if (found) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert(found, 'external server ready');
        if (paused) execFileSync(node, [cli, 'daemon', 'stop', '--force'], { cwd: project.root, env, stdio: 'pipe' });
        if (mode === 'legacy') {
          // The old status shape lacks transient-stop support and pause metadata.
          // Any daemon stop HTTP request would overwrite its preference: forbid it.
          globalThis.fetch = async (url, options) => {
            assert(!String(url).includes('/api/daemon/stop'), 'legacy stop endpoint must never be called');
            const response = await originalFetch(url, options);
            if (!String(url).endsWith('/api/daemon/status')) return response;
            const status = await response.json();
            delete status.pausedByUser; delete status.supportsTransientStop;
            return Response.json(status, { status: response.status });
          };
        }
      }
      let instance = await manager.start(project.id);
      assert.equal(!!instance.external, external);
      const request = async (path, method = 'GET', body) => {
        const response = await fetch(instance.endpoint + path, { method,
          headers: { ...manager.headers(instance), 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined });
        assert(response.ok, await response.clone().text());
        return response.json();
      };
      assert.equal((await request('/api/daemon/status')).isRunning, !(external && paused), 'Start respects an existing user pause');
      // Config and preference must survive Stop, Restart, Resume and Remove.
      await request('/api/daemon/config', 'PATCH', { directorInboxForwardingEnabled: false });
      if (paused && !external) {
        execFileSync(node, [cli, 'daemon', 'stop', '--force'], { cwd: project.root,
          env: { ...env, ...(external ? {} : { STONEFORGE_DESKTOP_INSTANCE_ID: instance.instanceId }) }, stdio: 'pipe' });
      }
      await manager.refreshTaskProcessing(project.id);
      assert.equal(project.taskProcessingPaused, paused);
      assert.equal(projectStatus(project).label, paused ? 'Task processing paused' : 'Running');
      const menu = tabMenuModel({ ...project, running: true }, undefined, 0, 1);
      assert.equal(menu.some(item => item.id === 'resume-processing' && item.enabled), paused);
      const stateFile = join(project.root, '.stoneforge/daemon-state.json');
      const before = await readFile(stateFile, 'utf8');
      await manager.stop(project.id);
      if (exited) {
        assert.notEqual(child.exitCode, null, 'Stop waits past socket closure until process exit');
        await exited;
      }
      globalThis.fetch = originalFetch;
      assert.equal(await readFile(stateFile, 'utf8'), before, 'shutdown never changes preference');
      instance = await manager.start(project.id);
      assert.equal((await request('/api/daemon/status')).isRunning, !paused);
      assert.equal((await request('/api/daemon/status')).pausedByUser, paused);
      assert.equal(await readFile(stateFile, 'utf8'), before, 'restart never rewrites preference');
      assert.equal(project.taskProcessingPaused, paused);
      if (paused) {
        await manager.resumeTaskProcessing(project.id);
        assert.equal((await request('/api/daemon/status')).isRunning, true);
        assert.equal(project.taskProcessingPaused, false);
        assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).configOverrides.directorInboxForwardingEnabled, false);
        await manager.stop(project.id); instance = await manager.start(project.id);
        assert.equal((await request('/api/daemon/status')).isRunning, true, 'Resume survives restart');
      }
      const beforeRemove = await readFile(stateFile, 'utf8');
      await manager.remove(project.id);
      assert.equal(await readFile(stateFile, 'utf8'), beforeRemove, 'Remove preserves preference and project data');
    } finally {
      globalThis.fetch = originalFetch;
      await manager.close();
      if (child && child.exitCode === null) child.kill('SIGTERM');
      if (exited) await exited;
      await rm(temp, { recursive: true, force: true });
    }
  });
}
