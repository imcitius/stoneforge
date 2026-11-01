/**
 * Onboarding tour state is a workspace setting (SQLite), so it survives backend
 * restarts on a different port and stays isolated between workspaces.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createStorage, initializeSchema } from '@stoneforge/storage';
import { createSettingsService } from '../../services/settings-service.js';
import type { Services } from '../services.js';
import { createSettingsRoutes } from './settings.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function workspaceDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-settings-'));
  dirs.push(dir);
  return path.join(dir, 'stoneforge.db');
}

/** A fresh backend process for the given workspace database. */
function boot(dbPath: string) {
  const storage = createStorage({ path: dbPath });
  initializeSchema(storage);
  const app = createSettingsRoutes({ settingsService: createSettingsService(storage) } as unknown as Services);
  const request = async (method: 'GET' | 'PUT', body?: unknown) => {
    const response = await app.request('/api/settings/onboarding-tour', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  };
  return { request, close: () => storage.close() };
}

describe('onboarding tour settings route', () => {
  test('fresh workspace is not completed', async () => {
    const server = boot(workspaceDb());
    expect((await server.request('GET')).json).toEqual({ completed: false, status: null, updatedAt: null });
    server.close();
  });

  test('dismissal and completion persist across backend restart', async () => {
    const db = workspaceDb();
    for (const status of ['dismissed', 'completed'] as const) {
      const first = boot(db);
      const put = await first.request('PUT', { status });
      expect(put.status).toBe(200);
      expect(put.json).toMatchObject({ completed: true, status });
      first.close();

      const restarted = boot(db);
      const get = await restarted.request('GET');
      expect(get.json).toMatchObject({ completed: true, status });
      expect(typeof get.json.updatedAt).toBe('string');
      restarted.close();
    }
  });

  test('explicit restart (null) clears the record durably', async () => {
    const db = workspaceDb();
    const first = boot(db);
    await first.request('PUT', { status: 'dismissed' });
    expect((await first.request('PUT', { status: null })).json).toMatchObject({ completed: false, status: null });
    first.close();
    const restarted = boot(db);
    expect((await restarted.request('GET')).json.completed).toBe(false);
    restarted.close();
  });

  test('workspaces are isolated', async () => {
    const a = boot(workspaceDb());
    const b = boot(workspaceDb());
    await a.request('PUT', { status: 'completed' });
    expect((await a.request('GET')).json.completed).toBe(true);
    expect((await b.request('GET')).json.completed).toBe(false);
    a.close(); b.close();
  });

  test('rejects invalid input without changing state', async () => {
    const server = boot(workspaceDb());
    await server.request('PUT', { status: 'dismissed' });
    for (const body of [{}, { status: 'active' }, { status: true }, '{not json']) {
      const response = await server.request('PUT', body);
      expect(response.status).toBe(400);
      expect(response.json).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    }
    expect((await server.request('GET')).json).toMatchObject({ completed: true, status: 'dismissed' });
    server.close();
  });
});
