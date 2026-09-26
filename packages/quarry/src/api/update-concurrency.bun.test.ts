import { afterEach, beforeEach, expect, test, setSystemTime } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createTask, createDocument, type Task, type Document, type EntityId } from '@stoneforge/core';
import { createQuarryAPI } from './quarry-api.js';

let root: string, storage: StorageBackend, second: StorageBackend;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'sf-cas-'));
  storage = createStorage({ path: path.join(root, 'test.db') }); initializeSchema(storage);
  second = createStorage({ path: path.join(root, 'test.db') });
});
afterEach(() => { setSystemTime(); storage.close(); second.close(); rmSync(root, { recursive: true, force: true }); });

test('same-millisecond and backwards-clock updates invalidate stale tokens', async () => {
  setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  const api = createQuarryAPI(storage);
  const raw = await createTask({ title: 'Original', createdBy: 'el-test' as EntityId });
  const task = await api.create<Task>(raw as unknown as Parameters<typeof api.create>[0]);
  const updated = await api.update<Task>(task.id, { title: 'Current' }, { expectedUpdatedAt: task.updatedAt });
  expect(updated.updatedAt > task.updatedAt).toBe(true);
  await expect(api.update<Task>(task.id, { title: 'Stale' }, { expectedUpdatedAt: task.updatedAt })).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
  setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
  const next = await api.update<Task>(task.id, { title: 'Next' }, { expectedUpdatedAt: updated.updatedAt });
  expect(next.updatedAt > updated.updatedAt).toBe(true);
});

test('SQL CAS rejects a competing connection after API read and rolls back document versions/events/tags', async () => {
  const api = createQuarryAPI(storage), other = createQuarryAPI(second);
  const raw = await createDocument({ content: 'Original', contentType: 'markdown', createdBy: 'el-test' as EntityId });
  const doc = await api.create<Document>(raw as unknown as Parameters<typeof api.create>[0]);
  const get = api.get.bind(api);
  let winner: Document;
  let events: unknown[], versions: unknown[], tags: unknown[];
  api.get = async (...args) => {
    const result = await get(...args);
    api.get = get;
    winner = await other.update<Document>(doc.id, { content: 'Winning edit', tags: ['winner'] });
    events = storage.query('SELECT * FROM events ORDER BY id');
    versions = storage.query('SELECT * FROM document_versions');
    tags = storage.query('SELECT * FROM tags');
    return result;
  };
  await expect(api.update<Document>(doc.id, { content: 'Stale content', tags: ['stale'] }, { expectedUpdatedAt: doc.updatedAt })).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
  expect(await api.get(doc.id)).toEqual(winner!);
  expect(storage.query('SELECT * FROM events ORDER BY id')).toEqual(events!);
  expect(storage.query('SELECT * FROM document_versions')).toEqual(versions!);
  expect(storage.query('SELECT * FROM tags')).toEqual(tags!);
});
