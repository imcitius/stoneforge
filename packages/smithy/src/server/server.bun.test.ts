import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import { startServer } from './server.js';
import type { Services } from './services.js';

describe('server transport', () => {
  test('port zero reports the bound port and the same guard covers HTTP and WebSocket upgrades', async () => {
    const app = new Hono();
    app.get('/api/probe', (c) => c.json({ ok: true }));
    let close: (() => Promise<void>) | undefined;
    const port = await startServer(app, {} as Services, undefined, {
      host: '127.0.0.1', port: 0,
      authorize: (headers) => headers.get('x-project') === 'project-a',
      onListening: (handle) => { close = handle.close; },
    });
    try {
      expect(port).toBeGreaterThan(0);
      expect((await fetch(`http://127.0.0.1:${port}/api/probe`)).status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${port}/api/probe`, { headers: { 'x-project': 'project-a' } })).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/ws`, {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' },
      })).status).toBe(401);
    } finally { await close?.(); }
  });
});
