import { test, expect } from 'bun:test';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOrchestratorUrl, orchestratorFetch } from './server-client.js';

test('Desktop CLI authenticates the right instance and fails closed on stale, wrong or missing context', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sf-cli-context-')));
  const savedRoot = process.env.STONEFORGE_ROOT;
  const savedInstance = process.env.STONEFORGE_DESKTOP_INSTANCE_ID;
  let mutations = 0;
  let mode = 'valid';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname === '/api/desktop/identity') {
      if (mode === 'redirect') return new Response(null, { status: 302, headers: { Location: '/mutation' } });
      expect(request.headers.get('x-stoneforge-secret')).toBe('test-secret');
      return Response.json({ projectId: mode === 'wrong' ? 'project-b' : 'project-a', instanceId: 'instance-a', projectRoot: root });
    }
    mutations++;
    return Response.json({ ok: true });
  } });
  try {
    process.env.STONEFORGE_ROOT = root;
    process.env.STONEFORGE_DESKTOP_INSTANCE_ID = 'instance-a';
    const lock = join(root, '.stoneforge/server.lock'); mkdirSync(lock, { recursive: true });
    const endpoint = `http://127.0.0.1:${server.port}`;
    writeFileSync(join(lock, 'desktop.json'), JSON.stringify({ endpoint, projectRoot: root, projectId: 'project-a', instanceId: 'instance-a', secret: 'test-secret' }));
    expect(getOrchestratorUrl()).toBe(endpoint);
    expect(() => getOrchestratorUrl('http://localhost:3457')).toThrow('Cannot override');
    expect((await orchestratorFetch(endpoint + '/mutation', { method: 'POST' })).ok).toBe(true);
    expect(mutations).toBe(1);
    mode = 'wrong';
    await expect(orchestratorFetch(endpoint + '/mutation', { method: 'POST' })).rejects.toThrow('identity mismatch');
    mode = 'redirect';
    await expect(orchestratorFetch(endpoint + '/mutation', { method: 'POST' })).rejects.toThrow();
    expect(mutations).toBe(1);
    process.env.STONEFORGE_DESKTOP_INSTANCE_ID = 'old-instance';
    expect(() => getOrchestratorUrl()).toThrow('does not match');
    rmSync(join(lock, 'desktop.json'));
    expect(() => getOrchestratorUrl()).toThrow('unavailable');
    process.env.STONEFORGE_ROOT = join(root, 'missing');
    expect(() => getOrchestratorUrl()).toThrow('refusing to fall back');
  } finally {
    server.stop(true);
    if (savedRoot === undefined) delete process.env.STONEFORGE_ROOT; else process.env.STONEFORGE_ROOT = savedRoot;
    if (savedInstance === undefined) delete process.env.STONEFORGE_DESKTOP_INSTANCE_ID; else process.env.STONEFORGE_DESKTOP_INSTANCE_ID = savedInstance;
    rmSync(root, { recursive: true, force: true });
  }
});
