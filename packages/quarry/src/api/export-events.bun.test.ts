import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTask, ErrorCode, StoneforgeError, type EntityId, type Task } from '@stoneforge/core';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { QuarryAPIImpl } from './quarry-api.js';

describe('Quarry export event boundary', () => {
  let dir: string;
  let backend: StorageBackend;
  let api: QuarryAPIImpl;
  let task: Task;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'quarry-export-events-'));
    backend = createStorage({ path: join(dir, 'fixture.db') });
    initializeSchema(backend);
    api = new QuarryAPIImpl(backend);
    const input = await createTask({ title: 'Before audit update', createdBy: 'user:export-test' as EntityId });
    task = await api.create<Task>(input as unknown as Parameters<QuarryAPIImpl['create']>[0]);
    const blocker = await createTask({ title: 'Blocker', createdBy: task.createdBy });
    await api.create(blocker as unknown as Parameters<QuarryAPIImpl['create']>[0]);
    await api.addDependency({ blockedId: task.id, blockerId: blocker.id, type: 'blocks' });
    await api.update<Task>(task.id, { title: 'After audit update' });
    const events = await api.getEvents(task.id);
    expect(events.some(event => event.oldValue?.title === 'Before audit update'
      && event.newValue?.title === 'After audit update')).toBe(true);
    expect(backend.getDirtyElements().length).toBeGreaterThan(0);
  });

  afterEach(() => {
    backend?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function snapshot() {
    return {
      elements: backend.query('SELECT * FROM elements ORDER BY id'),
      dependencies: backend.query('SELECT * FROM dependencies ORDER BY blocked_id, blocker_id'),
      events: backend.query('SELECT * FROM events ORDER BY id'),
      dirty: backend.getDirtyElements(),
    };
  }

  for (const mode of ['string', 'new directory', 'existing directory'] as const) {
    it(`rejects includeEvents:true before output or state changes (${mode})`, async () => {
      const outputPath = mode === 'string' ? undefined : join(dir, 'export');
      if (mode === 'existing directory') {
        mkdirSync(outputPath!);
        writeFileSync(join(outputPath!, 'elements.jsonl'), 'existing elements\n');
        writeFileSync(join(outputPath!, 'dependencies.jsonl'), 'existing dependencies\n');
      }
      const before = snapshot();
      let caught: unknown;
      try {
        await api.export({ includeEvents: true, outputPath });
      } catch (error) {
        caught = error;
      }
      // On the old implementation this fails: export silently succeeds.
      expect(caught).toBeInstanceOf(StoneforgeError);
      expect((caught as StoneforgeError).code).toBe(ErrorCode.INVALID_INPUT);
      expect((caught as Error).message).toContain('includeEvents');
      expect(snapshot()).toEqual(before);
      if (mode === 'new directory') expect(existsSync(outputPath!)).toBe(false);
      if (mode === 'existing directory') {
        expect(readdirSync(outputPath!).sort()).toEqual(['dependencies.jsonl', 'elements.jsonl']);
        expect(readFileSync(join(outputPath!, 'elements.jsonl'), 'utf8')).toBe('existing elements\n');
        expect(readFileSync(join(outputPath!, 'dependencies.jsonl'), 'utf8')).toBe('existing dependencies\n');
      }
      expect(await api.get<Task>(task.id)).toMatchObject({ title: 'After audit update' });
    });
  }

  it('preserves default/false string and directory JSONL, excluding audit snapshots', async () => {
    const before = snapshot();
    const jsonl = await api.export();
    expect(await api.export({ includeEvents: false })).toBe(jsonl);
    const rows = (jsonl as string).split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(3);
    expect(rows.filter(row => row.type === 'task')).toHaveLength(2);
    expect(rows.filter(row => row.blockedId === task.id)).toHaveLength(1);
    expect(jsonl).not.toContain('Before audit update');
    expect(rows.every(row => !('oldValue' in row) && !('newValue' in row))).toBe(true);
    for (const includeEvents of [undefined, false]) {
      const outputPath = join(dir, String(includeEvents));
      expect(await api.export({ outputPath, includeEvents })).toBeUndefined();
      expect(readdirSync(outputPath).sort()).toEqual(['dependencies.jsonl', 'elements.jsonl']);
      const elements = readFileSync(join(outputPath, 'elements.jsonl'), 'utf8');
      const dependencies = readFileSync(join(outputPath, 'dependencies.jsonl'), 'utf8');
      expect(elements.trimEnd() + '\n' + dependencies.trimEnd()).toBe(jsonl);
    }
    expect(snapshot()).toEqual(before);
  });
});
