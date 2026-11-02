/**
 * Real SQLite regression (el-4htfn) for the smithy-server task and workflow
 * routes: POST /api/tasks, POST /api/tasks/:id/reopen (description document),
 * POST /api/workflows and POST /api/playbooks must pass
 * QuarryAPI.getIdGeneratorConfig() to core factories, so an occupied ID
 * candidate is skipped instead of failing with a duplicate elements.id.
 *
 * Only the nonce-0 ID digest is forced (see
 * packages/smithy/src/services/factory-id-collision.bun.test.ts); other
 * candidates keep native SHA-256, and the generator, lookup and SQLite are real.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createQuarryAPI, type QuarryAPI } from '@stoneforge/quarry';
import {
  createEntity,
  createTask,
  DEFAULT_HASH_LENGTH,
  EntityTypeValue,
  MAX_HASH_LENGTH,
  MIN_HASH_LENGTH,
  TaskStatus,
  toBase36Digits,
  type Element,
  type EntityId,
} from '@stoneforge/core';
import type { Services } from '../services.js';
import { createTaskRoutes } from './tasks.js';
import { createWorkflowRoutes } from './workflows.js';

const creator = 'el-0000' as EntityId;
const FORCED = new Uint8Array(32).fill(0x42);

type App = { request: (path: string, init: RequestInit) => Response | Promise<Response> };

describe('smithy-server route ID collisions (el-4htfn)', () => {
  let directory: string;
  let storage: StorageBackend;
  let api: QuarryAPI;
  let spy: ReturnType<typeof spyOn>;
  let retried: number;
  let occupied: Element[];

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'smithy-server-id-collision-'));
    storage = createStorage(join(directory, 'test.db'));
    initializeSchema(storage);
    api = createQuarryAPI(storage);
    retried = 0;
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    spy = spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      const parts = new TextDecoder().decode(data as ArrayBuffer).split('|');
      const isIdInput = parts.length >= 4 && /^\d+$/.test(parts.at(-2)!) && /^\d+$/.test(parts.at(-1)!);
      if (isIdInput && parts.at(-1) === '0') return FORCED.buffer.slice(0);
      if (isIdInput) retried++;
      return digest(algorithm, data as ArrayBuffer);
    });
    // Occupy the forced nonce-0 candidate at every length (3..8): the
    // length-L candidate is D mod 36^L (el-4rgbi0), so this covers the
    // unconfigured default (6) and whatever adaptive length the config picks.
    const seed = await createEntity({ name: 'occupied', entityType: EntityTypeValue.SYSTEM, createdBy: creator });
    expect(seed.id).toBe(`el-${toBase36Digits(FORCED, DEFAULT_HASH_LENGTH)}`);
    occupied = [];
    for (let length = MIN_HASH_LENGTH; length <= MAX_HASH_LENGTH; length++) {
      const id = `el-${toBase36Digits(FORCED, length)}` as typeof seed.id;
      occupied.push(await api.create({ ...seed, id, name: `occupied-${length}` }));
    }
  });

  afterEach(() => {
    spy.mockRestore();
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function request(app: App, path: string, body: unknown) {
    const res = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json() as Record<string, any>;
    expect({ ok: res.ok, json }).toMatchObject({ ok: true });
    return json;
  }

  test('task, reopen, workflow and playbook routes skip occupied IDs', async () => {
    const services = { api, storageBackend: storage } as unknown as Services;
    const tasks = createTaskRoutes(services);
    const workflows = createWorkflowRoutes(services);
    const closed = await api.create(
      (await createTask({ title: 'closed', status: TaskStatus.CLOSED, createdBy: creator }, api.getIdGeneratorConfig())) as unknown as Record<string, unknown> & { createdBy: EntityId }
    );
    retried = 0;

    const task = (await request(tasks, '/api/tasks', { title: 'routed', createdBy: creator })).task;
    await request(tasks, `/api/tasks/${closed.id}/reopen`, { message: 'again' });
    const reopened = await api.get<Element & { descriptionRef?: string }>(closed.id);
    expect(reopened?.descriptionRef).toBeDefined();
    const workflow = await request(workflows, '/api/workflows', { title: 'wf' });
    const playbook = await request(workflows, '/api/playbooks', { name: 'pb', title: 'Playbook' });

    for (const element of occupied) expect(await api.get(element.id)).toEqual(element);
    const created = [
      closed.id, task.id, reopened!.descriptionRef!,
      (workflow.workflow ?? workflow).id, (playbook.playbook ?? playbook).id,
    ];
    for (const id of created) expect(typeof id).toBe('string');
    expect(new Set([...occupied.map((e) => e.id), ...created]).size).toBe(occupied.length + created.length);
    expect(retried).toBeGreaterThan(0);
  });
});
