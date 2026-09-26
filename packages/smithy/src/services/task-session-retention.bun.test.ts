/** Bounded metadata is not an exhaustive identity/audit ledger. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createQuarryAPI, type QuarryAPI } from '@stoneforge/quarry';
import { createEntity, createTask, createDocument, EntityTypeValue, TaskStatus, type Document, type EntityId, type Task } from '@stoneforge/core';
import { appendTaskSessionHistory, closeTaskSessionHistory, getOrchestratorTaskMeta, type TaskSessionHistoryEntry } from '../types/task-meta.js';
import { createTaskAssignmentService } from './task-assignment-service.js';

let storage: StorageBackend, api: QuarryAPI, task: Task, owner: EntityId;
beforeEach(async () => {
  storage = createStorage({ path: ':memory:' }); initializeSchema(storage);
  api = createQuarryAPI(storage);
  const entity = await createEntity({ name: 'retention-fixture', entityType: EntityTypeValue.SYSTEM, createdBy: 'system:test' as EntityId });
  owner = (await api.create(entity as unknown as Parameters<QuarryAPI['create']>[0])).id as unknown as EntityId;
  const doc = await createDocument({ content: 'Preserved retention evidence', contentType: 'markdown', createdBy: owner });
  const saved = await api.create<Document>(doc as unknown as Parameters<QuarryAPI['create']>[0]);
  const raw = await createTask({ title: 'Isolated retention fixture', createdBy: owner, descriptionRef: saved.id as Task['descriptionRef'] });
  task = await api.create<Task>(raw as unknown as Parameters<QuarryAPI['create']>[0]);
});
afterEach(() => storage.close());
const history = (metadata: Record<string, unknown>) => getOrchestratorTaskMeta(metadata)!.sessionHistory!;
function entry(i: number, providerSessionId = `provider-${i}`): TaskSessionHistoryEntry {
  return { sessionId: `internal-${i}`, providerSessionId, agentId: owner, agentName: 'fixture', agentRole: 'worker', startedAt: task.createdAt };
}
async function seed(count: number, reused = false) {
  let metadata: Record<string, unknown> = { orchestrator: { assignedAgent: owner, sessionId: reused ? 'reused' : `provider-${count}` } };
  for (let i = 1; i <= count; i++) metadata = appendTaskSessionHistory(metadata, entry(i, reused && (i === 1 || i === count) ? 'reused' : `provider-${i}`));
  task = await api.update<Task>(task.id, { status: TaskStatus.IN_PROGRESS, assignee: owner, metadata });
  return metadata;
}
test('50/51 retains insertion order, evicts unfinished oldest, and leaves claim reference intact', async () => {
  const metadata = await seed(50);
  expect(history(metadata)).toHaveLength(50);
  const claim = { operationId: 'fixture-claim', sessionId: 'internal-1', phase: 'unknown' };
  const withClaim = { ...metadata, orchestrator: { ...getOrchestratorTaskMeta(metadata), completionOperation: claim } };
  const next = appendTaskSessionHistory(withClaim, entry(51));
  expect(history(next).map(e => e.sessionId)).toEqual(Array.from({ length: 50 }, (_, i) => `internal-${i + 2}`));
  expect(history(metadata)[0].endedAt).toBeUndefined();
  expect((next.orchestrator as Record<string, unknown>).completionOperation).toEqual(claim);
  expect(closeTaskSessionHistory(next, 'internal-1', task.updatedAt)).toEqual(next);
});
test('eviction is available in ordinary API audit snapshots, but absent from current metadata', async () => {
  const metadata = await seed(50);
  task = await api.update<Task>(task.id, { metadata: appendTaskSessionHistory(metadata, entry(51)) });
  expect(history(task.metadata).some(e => e.sessionId === 'internal-1')).toBe(false);
  const events = await api.getEvents(task.id);
  const eviction = events.find(e => e.oldValue?.metadata && getOrchestratorTaskMeta(e.oldValue.metadata as Record<string, unknown>)?.sessionHistory?.length === 50);
  expect(history(eviction!.oldValue!.metadata as Record<string, unknown>)[0].sessionId).toBe('internal-1');
  expect(history(eviction!.newValue!.metadata as Record<string, unknown>)[0].sessionId).toBe('internal-2');
  expect(await api.getEvents(task.id, { limit: 1 })).toHaveLength(1);
  // Event export is explicitly unsupported; ordinary JSONL still omits audit snapshots.
  await expect(api.export({ includeEvents: true })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const exported = await api.export();
  expect(typeof exported).toBe('string');
  expect(exported).not.toContain('internal-1\"');
  expect(exported).toContain('internal-51');
});
for (const count of [2, 50, 51, 100]) {
  test(`current internal identity succeeds at ${count}; evicted/stale internal identity rejects`, async () => {
    await seed(count);
    await expect(createTaskAssignmentService(api).handoffTask(task.id, { sessionId: 'internal-1', agentId: owner, message: 'stale' })).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
    expect(await api.get(task.id)).toEqual(task);
    const result = await createTaskAssignmentService(api).handoffTask(task.id, { sessionId: `internal-${count}`, agentId: owner, message: 'current' });
    expect(history(result.metadata).at(-1)!.endedAt).toBeDefined();
  });
}
for (const count of [2, 50, 51, 100]) {
  test(`provider reuse cannot authorize handoff at ${count} entries`, async () => {
    await seed(count, true);
    const description = await api.get(task.descriptionRef!);
    const events = await api.getEvents(task.id);
    const action = createTaskAssignmentService(api).handoffTask(task.id, { sessionId: 'reused', agentId: owner, message: 'legacy provider caller' });
    await expect(action).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
    expect(await api.get(task.id)).toEqual(task);
    expect(await api.get(task.descriptionRef!)).toEqual(description);
    expect(await api.getEvents(task.id)).toEqual(events);
  });
}

import { TaskCompletionProtocol } from './task-completion.js';
for (const count of [1, 2, 50, 51]) {
 test(`recovery claim internal-1 with ${count} entries`, async () => {
  await seed(count);
  const op = { operationId: 'claim', phase: 'claimed', mode: 'worker', agentId: owner, sessionId: 'internal-1', owner, assignedAgent: owner, push: false, createMR: false, taskVersion: task.updatedAt, baseBranch: 'main', title: task.title, body: 'isolated fixture' };
  task = await api.update<Task>(task.id, { metadata: { ...task.metadata, orchestrator: { ...getOrchestratorTaskMeta(task.metadata), completionOperation: op } } });
  const result = new TaskCompletionProtocol(api).reconcile(task.id, { operationId: 'claim', operatorId: owner, reason: 'isolated fixture' });
  if (count === 1) expect((await result).task.status).toBe(TaskStatus.REVIEW);
  else { await expect(result).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' }); expect(await api.get(task.id)).toEqual(task); }
 });
}
for (const count of [50, 51]) {
 test(`complete current internal identity at ${count}`, async () => {
  await seed(count);
  const result = await new TaskCompletionProtocol(api).complete(task.id, { agentId: owner, sessionId: `internal-${count}`, createMergeRequest: false });
  expect(result.task.status).toBe(TaskStatus.REVIEW);
  expect(history(result.task.metadata).at(-1)!.endedAt).toBeDefined();
 });
}
