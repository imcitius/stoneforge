/**
 * Real SQLite regression (el-4htfn) for element factories that previously
 * generated IDs without QuarryAPI.getIdGeneratorConfig(): an occupied nonce-0
 * candidate must be skipped instead of failing the insert with a duplicate
 * elements.id, and the existing element must remain unchanged.
 *
 * Same technique as agent-id-collision.bun.test.ts (el-2zj6n): only the
 * nonce-0 ID digest is forced to a fixed value; other candidates keep native
 * SHA-256, and the generator, collision lookup and SQLite are real.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createQuarryAPI, InboxService, type QuarryAPI } from '@stoneforge/quarry';
import {
  createChannelRoutes,
  createDocumentRoutes,
  createLibraryRoutes,
  createMessageRoutes,
  createPlanRoutes,
} from '@stoneforge/shared-routes';
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
  type ElementId,
  type EntityId,
  type ChannelId,
} from '@stoneforge/core';
import { createAgentRegistry, type AgentRegistry } from './agent-registry.js';
import { createDispatchService } from './dispatch-service.js';
import { createTaskAssignmentService } from './task-assignment-service.js';
import { createAgentPoolService } from './agent-pool-service.js';
import { createRoleDefinitionService } from './role-definition-service.js';
import { createMergeStewardService } from './merge-steward-service.js';
import { createHandoffService } from '../runtime/handoff.js';
import type { SessionManager } from '../runtime/session-manager.js';
import { createTaskRoutes } from '../server/routes/tasks.js';
import { createWorkflowRoutes } from '../server/routes/workflows.js';
import type { Services } from '../server/services.js';

const creator = 'el-0000' as EntityId;
const FORCED = new Uint8Array(32).fill(0x42);

/** Forces every nonce-0 ID digest (`identifier|createdBy|timestampNs|nonce`). */
function forceNonceZeroCollisions() {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const counts = { forced: 0, retried: 0 };
  const spy = spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    const parts = new TextDecoder().decode(data as ArrayBuffer).split('|');
    const isIdInput = parts.length >= 4 && /^\d+$/.test(parts.at(-2)!) && /^\d+$/.test(parts.at(-1)!);
    if (isIdInput && parts.at(-1) === '0') {
      counts.forced++;
      return FORCED.buffer.slice(0);
    }
    if (isIdInput) counts.retried++;
    return digest(algorithm, data as ArrayBuffer);
  });
  return { spy, counts };
}

describe('Element factory ID collisions (el-4htfn)', () => {
  let directory: string;
  let storage: StorageBackend;
  let api: QuarryAPI;
  let registry: AgentRegistry;
  let force: ReturnType<typeof forceNonceZeroCollisions>;
  let occupied: Element[];

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'factory-id-collision-'));
    storage = createStorage(join(directory, 'test.db'));
    initializeSchema(storage);
    api = createQuarryAPI(storage);
    registry = createAgentRegistry(api);
    force = forceNonceZeroCollisions();
    // Occupy the forced nonce-0 candidate at every length (3..8). Since
    // el-4rgbi0 the length-L candidate is the low-order digits D mod 36^L of
    // the digest, so this covers the unconfigured default length (6) and any
    // adaptive length QuarryAPI's config selects; a length change alone cannot
    // pass: the generator must consult SQLite and advance the nonce.
    const seed = await createEntity({ name: 'occupied', entityType: EntityTypeValue.SYSTEM, createdBy: creator });
    expect(seed.id).toBe(`el-${toBase36Digits(FORCED, DEFAULT_HASH_LENGTH)}`);
    occupied = [];
    for (let length = MIN_HASH_LENGTH; length <= MAX_HASH_LENGTH; length++) {
      const id = `el-${toBase36Digits(FORCED, length)}` as typeof seed.id;
      occupied.push(await api.create({ ...seed, id, name: `occupied-${length}` }));
    }
    force.counts.retried = 0;
  });

  afterEach(() => {
    force.spy.mockRestore();
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function expectOccupiedPreserved(created: Array<{ id: string }>) {
    for (const element of occupied) expect(await api.get(element.id)).toEqual(element);
    const ids = new Set([...occupied.map((e) => e.id), ...created.map((e) => e.id)]);
    expect(ids.size).toBe(occupied.length + created.length);
    expect(force.counts.retried).toBeGreaterThan(0);
  }

  async function createPersistedEntity(name: string) {
    const entity = await createEntity({ name, entityType: EntityTypeValue.AGENT, createdBy: creator }, api.getIdGeneratorConfig());
    return api.create(entity as unknown as Record<string, unknown> & { createdBy: EntityId });
  }

  test('QuarryAPI.findOrCreateDirectChannel skips an occupied channel ID', async () => {
    const a = await createPersistedEntity('alice');
    const b = await createPersistedEntity('bob');
    const { channel, created } = await api.findOrCreateDirectChannel(a.id as unknown as EntityId, b.id as unknown as EntityId, a.id as unknown as EntityId);
    expect(created).toBe(true);
    await expectOccupiedPreserved([a, b, channel]);
  });

  test('DispatchService notification document and message skip occupied IDs', async () => {
    const agent = await registry.registerWorker({ name: 'dispatch-target', createdBy: creator, workerMode: 'ephemeral' });
    const dispatch = createDispatchService(api, createTaskAssignmentService(api), registry);
    const message = await dispatch.notifyAgent(agent.id as unknown as EntityId, 'task-assignment', 'hello');
    const saved = await api.get(message.id as unknown as ElementId);
    expect(saved).not.toBeNull();
    await expectOccupiedPreserved([agent, message, { id: message.contentRef }]);
  });

  test('HandoffService self-handoff document and message skip occupied IDs', async () => {
    const agent = await registry.registerWorker({ name: 'handoff-agent', createdBy: creator, workerMode: 'ephemeral' });
    const session = { id: 's1', agentId: agent.id, status: 'running', providerSessionId: 'p1' };
    const sessionManager = {
      getSession: () => session,
      suspendSession: async () => undefined,
    } as unknown as SessionManager;
    const result = await createHandoffService(sessionManager, registry, api).selfHandoff(
      agent.id as unknown as EntityId, 's1', { contextSummary: 'ctx' }
    );
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    await expectOccupiedPreserved([agent, { id: result.handoffDocumentId! }, { id: result.messageId! }]);
  });

  test('HandoffService agent-to-agent document and message skip occupied IDs', async () => {
    const from = await registry.registerWorker({ name: 'handoff-from', createdBy: creator, workerMode: 'ephemeral' });
    // The handoff message is sent by `from` into `to`'s agent channel, a direct
    // channel between `to` and its creator, so `from` creates `to`.
    const to = await registry.registerWorker({ name: 'handoff-to', createdBy: from.id as unknown as EntityId, workerMode: 'ephemeral' });
    const session = { id: 's1', agentId: from.id, status: 'running', providerSessionId: 'p1' };
    const sessionManager = {
      getSession: () => session,
      suspendSession: async () => undefined,
    } as unknown as SessionManager;
    const result = await createHandoffService(sessionManager, registry, api).handoffToAgent(
      from.id as unknown as EntityId, to.id as unknown as EntityId, 's1', { contextSummary: 'ctx' }
    );
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    await expectOccupiedPreserved([from, to, { id: result.handoffDocumentId! }, { id: result.messageId! }]);
  });

  test('smithy server task, reopen, workflow and playbook routes skip occupied IDs', async () => {
    const services = { api, storageBackend: storage, agentRegistry: registry } as unknown as Services;
    const tasks = createTaskRoutes(services);
    const workflows = createWorkflowRoutes(services);
    const request = async (app: { request: (path: string, init: RequestInit) => Response | Promise<Response> }, path: string, body: unknown) => {
      const res = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json() as Record<string, any>;
      expect({ ok: res.ok, json }).toMatchObject({ ok: true });
      return json;
    };
    const closed = await api.create(
      (await createTask({ title: 'closed', status: TaskStatus.CLOSED, createdBy: creator }, api.getIdGeneratorConfig())) as unknown as Record<string, unknown> & { createdBy: EntityId }
    );
    const task = (await request(tasks, '/api/tasks', { title: 'routed', createdBy: creator })).task;
    const reopened = (await request(tasks, `/api/tasks/${closed.id}/reopen`, { message: 'again' })).task;
    const reopenedTask = await api.get<Element & { descriptionRef?: string }>(closed.id);
    expect(reopenedTask?.descriptionRef).toBeDefined();
    expect(reopened.id).toBe(closed.id);
    const workflow = await request(workflows, '/api/workflows', { title: 'wf' });
    const playbook = await request(workflows, '/api/playbooks', { name: 'pb', title: 'Playbook' });
    await expectOccupiedPreserved([
      closed, { id: task.id }, { id: reopenedTask!.descriptionRef! },
      { id: (workflow.workflow ?? workflow).id }, { id: (playbook.playbook ?? playbook).id },
    ]);
  });

  test('AgentPoolService, RoleDefinitionService and MergeSteward fix tasks skip occupied IDs', async () => {
    const pool = await createAgentPoolService(api, {} as SessionManager, registry).createPool({ name: 'pool', maxSize: 1, createdBy: creator });
    const role = await createRoleDefinitionService(api).createRoleDefinition({ role: 'worker', name: 'Worker', systemPrompt: 'prompt', createdBy: creator });
    const original = await api.create(
      (await createTask({ title: 'original', status: TaskStatus.REVIEW, createdBy: creator }, api.getIdGeneratorConfig())) as unknown as Record<string, unknown> & { createdBy: EntityId }
    );
    const steward = createMergeStewardService(
      api, createTaskAssignmentService(api),
      createDispatchService(api, createTaskAssignmentService(api), registry),
      registry, { workspaceRoot: directory }
    );
    const fixId = await steward.createFixTask(original.id as ElementId, { type: 'test_failure', errorDetails: 'failed' });
    expect(await api.get(fixId)).not.toBeNull();
    await expectOccupiedPreserved([pool, { id: role.id }, { id: role.systemPromptDocId }, original, { id: fixId }]);
  });

  test('shared-routes POST handlers skip occupied IDs', async () => {
    const inboxService = new InboxService(storage);
    const services = { api, inboxService, storageBackend: storage };
    const request = async (app: { request: (path: string, init: RequestInit) => Response | Promise<Response> }, path: string, body: unknown) => {
      const res = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json() as Record<string, any>;
      expect({ ok: res.ok, json }).toMatchObject({ ok: true });
      return json;
    };
    const sender = await createPersistedEntity('sender');
    const other = await createPersistedEntity('other');
    const created: Array<{ id: string }> = [sender, other];

    const doc = await request(createDocumentRoutes(services), '/api/documents', { createdBy: creator, content: 'body' });
    const clone = await request(createDocumentRoutes(services), `/api/documents/${doc.id}/clone`, { createdBy: creator });
    const library = await request(createLibraryRoutes(services), '/api/libraries', { name: 'lib', createdBy: creator });
    const group = await request(createChannelRoutes(services), '/api/channels', { channelType: 'group', name: 'group', createdBy: sender.id, members: [sender.id, other.id] });
    const direct = await request(createChannelRoutes(services), '/api/channels', { channelType: 'direct', createdBy: sender.id, entityA: sender.id, entityB: other.id });
    const message = await request(createMessageRoutes(services), '/api/messages', { channelId: group.id as ChannelId, sender: sender.id, content: 'hi' });
    const plan = await request(createPlanRoutes(services), '/api/plans', { title: 'plan', createdBy: creator, initialTask: { title: 'first' } });
    created.push(doc, clone, library, group, direct, message, { id: message.contentRef }, plan);
    const planTasks = await api.getTasksInPlan(plan.id as ElementId);
    expect(planTasks).toHaveLength(1);
    created.push(planTasks[0]);
    await expectOccupiedPreserved(created);
  });
});
