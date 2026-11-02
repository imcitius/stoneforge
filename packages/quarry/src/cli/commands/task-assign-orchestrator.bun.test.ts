/**
 * `sf task assign` keeps metadata.orchestrator coherent (el-4y870m).
 *
 * A bare assignee write left metadata.orchestrator.assignedAgent pointing at
 * a previous agent, so the orchestrator rejected the task on start. Without a
 * plugin task assigner Quarry releases the stale ownership in the same write;
 * with one (the orchestrator plugin) the command delegates to it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createTask, type ElementId, type EntityId, type Task } from '@stoneforge/core';
import { createQuarryAPI } from '../../api/quarry-api.js';
import type { QuarryAPI } from '../../api/types.js';
import type { GlobalOptions } from '../types.js';
import { ExitCode } from '../types.js';
import { clearTaskAssigner, getTaskAssigner, registerTaskAssigner, type CliTaskAssigner } from '../task-assigner.js';
import { isValidCLIPlugin } from '../plugin-types.js';
import { registerPluginCommands } from '../plugin-registry.js';
import { assignCommand } from './task.js';

let root: string;
let dbPath: string;
let backend: StorageBackend;
let api: QuarryAPI;
let taskId: ElementId;

const options = (extra: Record<string, unknown> = {}): GlobalOptions => ({
  db: dbPath, actor: 'test-user', json: true, quiet: false, verbose: false, help: false, version: false, ...extra,
});
const saved = async () => (await api.get<Task>(taskId))!;
const orchestrator = (task: Task) => (task.metadata as Record<string, unknown>).orchestrator as Record<string, unknown>;

beforeEach(async () => {
  clearTaskAssigner();
  root = mkdtempSync(join(tmpdir(), 'sf-task-assign-orch-'));
  dbPath = join(root, 'stoneforge.db');
  backend = createStorage({ path: dbPath, create: true });
  initializeSchema(backend);
  api = createQuarryAPI(backend);
  const task = await createTask({
    title: 'Assigned to worker-a by the orchestrator',
    createdBy: 'el-creator' as EntityId,
    assignee: 'el-worker-a' as EntityId,
    metadata: {
      keep: 'yes',
      orchestrator: {
        assignedAgent: 'el-worker-a', sessionId: 'session-a', worktree: '/wt/a', startedAt: '2026-11-02T00:00:00.000Z',
        branch: 'agent/worker-a/task', repositoryId: 'core', mergeStatus: 'pending',
      },
    },
  });
  taskId = (await api.create<Task>(task as unknown as Record<string, unknown>)).id;
});

afterEach(() => {
  clearTaskAssigner();
  backend.close();
  rmSync(root, { recursive: true, force: true });
});

describe('sf task assign without a plugin task assigner', () => {
  test('reassigning releases the previous agent ownership and keeps the rest', async () => {
    const result = await assignCommand.handler([taskId, 'el-operator'], options());
    expect(result.exitCode).toBe(ExitCode.SUCCESS);

    const task = await saved();
    expect(task.assignee).toBe('el-operator' as EntityId);
    const meta = orchestrator(task);
    expect(meta.assignedAgent).toBeUndefined();
    expect(meta.sessionId).toBeUndefined();
    expect(meta.worktree).toBeUndefined();
    expect(meta.startedAt).toBeUndefined();
    expect(meta.branch).toBe('agent/worker-a/task');
    expect(meta.repositoryId).toBe('core');
    expect((task.metadata as Record<string, unknown>).keep).toBe('yes');
  });

  test('--unassign releases the agent ownership too', async () => {
    const result = await assignCommand.handler([taskId], options({ unassign: true }));
    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    const task = await saved();
    expect(task.assignee).toBeUndefined();
    expect(orchestrator(task).assignedAgent).toBeUndefined();
    expect(orchestrator(task).sessionId).toBeUndefined();
  });

  test('re-assigning the coherent current agent leaves the orchestrator metadata untouched', async () => {
    const result = await assignCommand.handler([taskId, 'el-worker-a'], options());
    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    const meta = orchestrator(await saved());
    expect(meta.assignedAgent).toBe('el-worker-a');
    expect(meta.sessionId).toBe('session-a');
    expect(meta.worktree).toBe('/wt/a');
  });
});

describe('sf task assign with a plugin task assigner', () => {
  test('delegates to the registered assigner instead of writing the assignee', async () => {
    const calls: Array<[ElementId, EntityId | null, string | undefined]> = [];
    const assigner: CliTaskAssigner = async (id, assignee, opts) => {
      calls.push([id, assignee, opts.db]);
      return saved();
    };
    expect(registerPluginCommands({ name: 'orchestrator-test', version: '0', commands: [], taskAssigner: assigner }).pluginName)
      .toBe('orchestrator-test');
    expect(getTaskAssigner()).toBe(assigner);

    expect((await assignCommand.handler([taskId, 'el-worker-b'], options())).exitCode).toBe(ExitCode.SUCCESS);
    expect((await assignCommand.handler([taskId], options({ unassign: true }))).exitCode).toBe(ExitCode.SUCCESS);

    expect(calls).toEqual([[taskId, 'el-worker-b' as EntityId, dbPath], [taskId, null, dbPath]]);
    // Nothing written by Quarry itself.
    const task = await saved();
    expect(task.assignee).toBe('el-worker-a' as EntityId);
    expect(orchestrator(task).assignedAgent).toBe('el-worker-a');
  });

  test('assigner errors are reported as a failed assignment', async () => {
    registerTaskAssigner('orchestrator-test', async () => { throw new Error('Assignee not found: el-nobody'); });
    const result = await assignCommand.handler([taskId, 'el-nobody'], options());
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.error).toContain('Assignee not found: el-nobody');
  });

  test('the first registered assigner wins and plugin validation checks the field', () => {
    const first: CliTaskAssigner = async () => { throw new Error('first'); };
    const second: CliTaskAssigner = async () => { throw new Error('second'); };
    expect(registerTaskAssigner('a', first)).toBe(true);
    expect(registerTaskAssigner('b', second)).toBe(false);
    expect(getTaskAssigner()).toBe(first);

    expect(isValidCLIPlugin({ name: 'p', version: '1', commands: [], taskAssigner: first })).toBe(true);
    expect(isValidCLIPlugin({ name: 'p', version: '1', commands: [], taskAssigner: 'nope' })).toBe(false);
  });
});
