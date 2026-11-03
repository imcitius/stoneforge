/**
 * Playbook endpoint helper tests
 *
 * Regression coverage for GET /api/playbooks/:name, which previously spread an
 * un-awaited createPlaybook() Promise into the response, so the JSON body only
 * contained filePath/directory and none of the playbook fields.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Hono } from 'hono';

import { getPlaybookDetail } from './playbooks.js';

const playbookYaml = `
name: deploy-app
title: Deploy App
version: 2
variables:
  - name: environment
    type: string
    required: true
    description: Target environment
  - name: runTests
    type: boolean
    required: false
    default: true
steps:
  - id: build
    title: Build for {{environment}}
  - id: test
    title: Run tests
    depends_on:
      - build
    condition: "{{runTests}}"
`;

describe('getPlaybookDetail', () => {
  let tmpDir: string;
  let playbooksDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quarry-playbooks-'));
    playbooksDir = path.join(tmpDir, '.stoneforge', 'playbooks');
    fs.mkdirSync(playbooksDir, { recursive: true });
    fs.writeFileSync(path.join(playbooksDir, 'deploy-app.playbook.yaml'), playbookYaml);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns the resolved playbook fields together with file location', async () => {
    const detail = await getPlaybookDetail('deploy-app', [playbooksDir]);

    expect(detail).not.toBeNull();
    expect(detail).not.toBeInstanceOf(Promise);
    expect(detail!.name).toBe('deploy-app');
    expect(detail!.title).toBe('Deploy App');
    expect(detail!.version).toBe(2);
    expect(detail!.type).toBe('playbook');
    expect(detail!.steps.map((s) => s.id)).toEqual(['build', 'test']);
    expect(detail!.steps[1].dependsOn).toEqual(['build']);
    expect(detail!.variables.map((v) => v.name)).toEqual(['environment', 'runTests']);
    expect(detail!.filePath).toBe(path.join(playbooksDir, 'deploy-app.playbook.yaml'));
    expect(detail!.directory).toBe(playbooksDir);
  });

  test('matches playbook names case-insensitively', async () => {
    const detail = await getPlaybookDetail('DEPLOY-App', [playbooksDir]);
    expect(detail?.name).toBe('deploy-app');
  });

  test('returns null when no playbook matches', async () => {
    const detail = await getPlaybookDetail('missing', [playbooksDir]);
    expect(detail).toBeNull();
  });

  test('JSON response body includes name, steps and variables', async () => {
    // Mirror the GET /api/playbooks/:name route wiring in server/index.ts
    const app = new Hono();
    app.get('/api/playbooks/:name', async (c) => {
      const playbook = await getPlaybookDetail(c.req.param('name'), [playbooksDir]);
      if (!playbook) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'Playbook not found' } }, 404);
      }
      return c.json(playbook);
    });

    const res = await app.request('/api/playbooks/deploy-app');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.name).toBe('deploy-app');
    expect(body.title).toBe('Deploy App');
    expect(Array.isArray(body.steps)).toBe(true);
    expect((body.steps as unknown[]).length).toBe(2);
    expect(Array.isArray(body.variables)).toBe(true);
    expect((body.variables as unknown[]).length).toBe(2);
    expect(body.filePath).toBe(path.join(playbooksDir, 'deploy-app.playbook.yaml'));
    expect(body.directory).toBe(playbooksDir);

    const missing = await app.request('/api/playbooks/missing');
    expect(missing.status).toBe(404);
  });
});
