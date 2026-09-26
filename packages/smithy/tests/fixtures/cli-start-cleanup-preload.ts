/** Child-process-only fixture: real CLI, API and temporary SQLite; inert spawner. */
import { mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createStorage } from '@stoneforge/storage';
import { createOrchestratorAPI, OrchestratorAPIImpl } from '../../src/api/orchestrator-api.js';
import { updateOrchestratorTaskMeta } from '../../src/types/task-meta.js';
import { ValidationError, ErrorCode, type Element, type ElementId, type Task } from '@stoneforge/core';
import type { GetOptions } from '@stoneforge/quarry';

const root = process.env.CLEANUP_FIXTURE_ROOT!;
if (!root || !path.basename(root).startsWith('sf-cli-cleanup-')) throw new Error('Isolated fixture root required');
const scenario = process.env.CLEANUP_FIXTURE_SCENARIO!;
const taskId = process.env.CLEANUP_FIXTURE_TASK as ElementId;
const storage = createStorage({ path: path.join(root, '.stoneforge/stoneforge.db') });
const other = createOrchestratorAPI(storage);
const effects = { spawns: 0, assignments: 0, stops: [] as unknown[], ownRunning: false, successorRunning: true };
const record = () => writeFileSync(path.join(root, 'effects.json'), JSON.stringify(effects));
const snapshot = async () => writeFileSync(path.join(root, 'winner.json'), JSON.stringify({ task: await other.get(taskId), events: storage.query('SELECT * FROM events ORDER BY id') }));
record();
const runtime = await import('../../src/runtime/index.js');
mock.module('../../src/runtime/index.js', () => ({ ...runtime, createSpawnerService: () => ({
  async spawn(agentId: string, _role: string, options: { mode?: string }) {
    ++effects.spawns; record();
    if (scenario === 'spawn-failure') throw new Error('fixture spawn failed before receipt');
    effects.ownRunning = true; record();
    const events = new EventEmitter();
    // Emit only once the actual CLI stream has subscribed; no timing assumptions.
    events.on('newListener', (name: string) => {
      if (name === 'exit') queueMicrotask(() => {
        events.emit('event', { type: 'assistant', message: 'fixture streamed output' });
        events.emit('pty-data', 'fixture interactive output');
        events.emit('exit', 0, null);
      });
    });
    return { session: { id: 'own-internal', providerSessionId: 'reused-provider', agentId, status: 'running', mode: options.mode ?? 'headless', pid: 123 }, events };
  },
  async terminate(id: string, graceful: boolean) {
    effects.stops.push({ id, graceful }); record();
    if (id !== 'own-internal') { effects.successorRunning = false; record(); throw new Error('touched successor'); }
    if (scenario === 'cleanup-throw') throw new Error('fixture close threw');
    if (scenario === 'cleanup-timeout') throw new Error('Session termination unconfirmed: own-internal');
    if (scenario === 'cleanup-hang') return new Promise<void>(() => {});
    effects.ownRunning = false; record();
  },
  getSession() { throw new Error('must not discover current session'); },
  getActiveSession() { throw new Error('must not discover successor'); },
}) }));
const assign = OrchestratorAPIImpl.prototype.assignTaskToAgent;
OrchestratorAPIImpl.prototype.assignTaskToAgent = async function (...args) {
  ++effects.assignments; record();
  if (['cleanup-throw', 'cleanup-timeout', 'cleanup-hang', 'reject'].includes(scenario)) {
    await snapshot(); throw new ValidationError('fixture primary assignment failure', ErrorCode.INVALID_INPUT);
  }
  const result = await assign.apply(this, args);
  if (scenario === 'unknown') { await snapshot(); throw new Error('fixture outcome unknown after commit'); }
  return result;
};
const get = OrchestratorAPIImpl.prototype.get;
let injected = false;
OrchestratorAPIImpl.prototype.get = async function <T extends Element>(id: ElementId, options?: GetOptions): Promise<T | null> {
  const result = await get.call(this, id, options);
  if (this !== other && id === taskId && !injected && ['closed', 'deferred', 'human', 'competitor', 'same-agent'].includes(scenario)) {
    injected = true;
    const current = (await other.get<Task>(id))!;
    if (scenario === 'closed' || scenario === 'deferred') {
      await other.update<Task>(id, { status: scenario, ...(scenario === 'closed' ? { closeReason: 'operator finished' } : {}) });
    } else {
      const owner = scenario === 'human' ? 'human:operator' : scenario === 'same-agent' ? process.env.CLEANUP_FIXTURE_AGENT! : process.env.CLEANUP_FIXTURE_SUCCESSOR!;
      await other.update<Task>(id, { assignee: owner, metadata: updateOrchestratorTaskMeta(current.metadata, {
        assignedAgent: owner, sessionId: 'reused-provider', sessionHistory: [{ sessionId: 'successor-internal', providerSessionId: 'reused-provider', agentId: owner, agentName: 'successor', agentRole: 'worker', startedAt: current.updatedAt }],
      }) });
    }
    await snapshot();
  }
  return result as T | null;
};
