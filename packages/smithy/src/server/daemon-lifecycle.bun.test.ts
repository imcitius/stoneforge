import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each route factory captures cwd in config.ts. Use isolated subprocesses so these
// tests cannot read or overwrite a real workspace, even in the full Bun suite.
for (const base of [new URL('./', import.meta.url)]) {
  test('daemon preference contract', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sf-daemon-routes-'));
    const script = `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      const state = await import(${JSON.stringify(new URL('daemon-state.ts', base).href)});
      const { createDaemonRoutes } = await import(${JSON.stringify(new URL('routes/daemon.ts', base).href)});
      let running = true;
      const app = createDaemonRoutes({ dispatchDaemon: {
        isRunning: () => running, start: () => { running = true; }, stop: () => { running = false; },
        getConfig: () => ({}), getRateLimitStatus: () => ({}),
      } });
      const read = () => readFileSync('.stoneforge/daemon-state.json', 'utf8');
      assert.equal(state.shouldDaemonAutoStart(), true);
      state.saveDaemonState(false, 'server-shutdown');
      assert.equal(state.shouldDaemonAutoStart(), true, 'shutdown is not a user pause');
      state.saveDaemonState(true, 'user');
      state.saveDaemonConfigOverrides({ directorInboxForwardingEnabled: false });
      for (const paused of [false, true]) {
        if (paused) {
          const response = await app.request('/api/daemon/stop', { method: 'POST' });
          assert.equal(response.status, 200);
          assert.equal(state.shouldDaemonAutoStart(), false);
        }
        const before = read();
        const response = await app.request('/api/daemon/stop?persist=false', { method: 'POST' });
        assert.equal(response.status, 200);
        assert.equal(running, false);
        assert.equal(read(), before, 'transient stop preserves exact state');
        const status = await (await app.request('/api/daemon/status')).json();
        assert.equal(status.pausedByUser, paused);
        assert.equal(status.supportsTransientStop, true);
      }
      await app.request('/api/daemon/start', { method: 'POST' });
      assert.equal(running, true);
      assert.equal(state.shouldDaemonAutoStart(), true);
      assert.equal(state.getDaemonConfigOverrides().directorInboxForwardingEnabled, false);
    `;
    try {
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/^(STONEFORGE_|SF_)/.test(key)) delete env[key];
      const child = Bun.spawn([process.execPath, '-e', script], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, diagnostic: code ? stdout + stderr : '' }).toEqual({ code: 0, diagnostic: '' });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}
