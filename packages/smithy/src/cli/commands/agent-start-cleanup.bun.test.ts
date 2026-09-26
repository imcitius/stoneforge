/** Real source CLI in isolated children: temporary SQLite and inert spawn/API boundaries. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createEntity, createTask, EntityTypeValue, type EntityId, type Task } from '@stoneforge/core';
import { createOrchestratorAPI, type OrchestratorAPI } from '../../api/orchestrator-api.js';

let root: string, storage: StorageBackend, api: OrchestratorAPI, task: Task, agent: EntityId, successor: EntityId;
beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'sf-cli-cleanup-'));
  mkdirSync(path.join(root, '.stoneforge'));
  storage = createStorage({ path: path.join(root, '.stoneforge/stoneforge.db') }); initializeSchema(storage);
  api = createOrchestratorAPI(storage);
  const raw = await createEntity({ name: 'fixture', entityType: EntityTypeValue.SYSTEM, createdBy: 'system:test' as EntityId });
  const creator = (await api.create(raw as unknown as Parameters<OrchestratorAPI['create']>[0])).id as unknown as EntityId;
  agent = (await api.registerWorker({ name: 'owner', workerMode: 'ephemeral', createdBy: creator })).id as unknown as EntityId;
  successor = (await api.registerWorker({ name: 'successor', workerMode: 'ephemeral', createdBy: creator })).id as unknown as EntityId;
  const rawTask = await createTask({ title: 'CLI cleanup', createdBy: creator });
  task = await api.create<Task>(rawTask as unknown as Parameters<OrchestratorAPI['create']>[0]);
});
afterEach(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
const events = () => storage.query('SELECT * FROM events ORDER BY id');
function cli(scenario: string, flags: string[] = [], withTask = true) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(STONEFORGE_|SF_|ORCHESTRATOR_URL$|ELECTRON_RUN_AS_NODE$)/.test(key)) delete env[key];
  Object.assign(env, { STONEFORGE_ROOT: root, CLEANUP_FIXTURE_ROOT: root, CLEANUP_FIXTURE_TASK: task.id, CLEANUP_FIXTURE_AGENT: agent, CLEANUP_FIXTURE_SUCCESSOR: successor, CLEANUP_FIXTURE_SCENARIO: scenario });
  const result = spawnSync(process.execPath, ['--preload', path.resolve(import.meta.dir, '../../../tests/fixtures/cli-start-cleanup-preload.ts'), path.resolve(import.meta.dir, '../../bin/sf.ts'), 'agent', 'start', agent, ...(withTask ? ['--taskId', task.id] : []), ...flags], { cwd: root, env, encoding: 'utf8', timeout: 20000 });
  expect(result.error).toBeUndefined();
  return { ...result, output: result.stdout + result.stderr, effects: JSON.parse(readFileSync(path.join(root, 'effects.json'), 'utf8')) };
}
for (const scenario of ['reject', 'closed', 'deferred', 'human', 'competitor', 'same-agent', 'unknown']) {
  test(`assignment ${scenario}: terminate own internal session only, preserve winning task/events`, async () => {
    const result = cli(scenario, ['--json']);
    expect(result.status).toBe(1);
    expect(result.output).toContain(scenario === 'unknown' ? 'outcome unknown' : scenario === 'reject' ? 'primary assignment failure' : 'modified');
    expect(result.effects).toEqual({ spawns: 1, assignments: 1, stops: [{ id: 'own-internal', graceful: false }], ownRunning: false, successorRunning: true });
    const winner = JSON.parse(readFileSync(path.join(root, 'winner.json'), 'utf8'));
    expect(await api.get(task.id)).toEqual(winner.task); expect(events()).toEqual(winner.events);
  });
}
for (const [scenario, diagnostic] of [['cleanup-throw', 'fixture close threw'], ['cleanup-timeout', 'termination unconfirmed'], ['cleanup-hang', 'timed out']]) {
  test(`${scenario}: original failure remains primary and unresolved cleanup is explicit`, async () => {
    const result = cli(scenario, ['--json']);
    expect(result.status).toBe(1);
    expect(result.output).toContain('primary assignment failure');
    expect(result.output).toContain('Cleanup failed for session own-internal');
    expect(result.output).toContain(diagnostic);
    expect(result.output.indexOf('primary assignment failure')).toBeLessThan(result.output.indexOf('Cleanup failed'));
    expect(result.effects).toEqual({ spawns: 1, assignments: 1, stops: [{ id: 'own-internal', graceful: false }], ownRunning: true, successorRunning: true });
    const winner = JSON.parse(readFileSync(path.join(root, 'winner.json'), 'utf8'));
    expect(await api.get(task.id)).toEqual(winner.task); expect(events()).toEqual(winner.events);
  }, 25000);
}
for (const flags of [[], ['--json'], ['--quiet'], ['--stream']]) {
  test(`failure output ${flags.join(' ') || 'default'} does not report success or stream`, () => {
    const result = cli('reject', flags);
    expect(result.status).toBe(1); expect(result.output).toContain('primary assignment failure');
    expect(result.output).not.toContain('Spawned agent'); expect(result.output).not.toContain('fixture streamed output');
    expect(result.effects.ownRunning).toBe(false);
  });
}
for (const flags of [[], ['--json'], ['--quiet'], ['--stream'], ['--stream', '--mode', 'interactive']]) {
  test(`successful start ${flags.join(' ') || 'default'} keeps normal output and session`, async () => {
    const result = cli('success', flags);
    expect(result.status).toBe(0); expect(result.effects.stops).toEqual([]); expect(result.effects.assignments).toBe(1);
    expect((await api.get<Task>(task.id))!.assignee).toBe(agent);
    if (flags.includes('--json')) expect(JSON.parse(result.stdout).data.sessionId).toBe('own-internal');
    else if (flags.includes('--quiet')) expect(result.stdout.trim()).toBe('own-internal');
    else if (flags.includes('--stream')) expect(result.output).toContain(flags.includes('interactive') ? 'fixture interactive output' : 'fixture streamed output');
    else expect(result.output).toContain('Spawned agent');
  });
}
test('start without a task does not assign or stop', () => {
  const result = cli('success', ['--json'], false);
  expect(result.status).toBe(0); expect(result.effects.assignments).toBe(0); expect(result.effects.stops).toEqual([]);
});
test('spawn failure before receipt never assigns or discovers a cleanup target', async () => {
  const before = events(); const result = cli('spawn-failure');
  expect(result.status).toBe(1); expect(result.output).toContain('spawn failed before receipt');
  expect(result.effects.assignments).toBe(0); expect(result.effects.stops).toEqual([]);
  expect(await api.get(task.id)).toEqual(task); expect(events()).toEqual(before);
});
