/** Subprocess-only fixture: real CLI/API/SQLite, inert process boundary. */
import { mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createStorage } from '@stoneforge/storage';
import { createOrchestratorAPI, OrchestratorAPIImpl } from '../../src/api/orchestrator-api.js';
import type { Element, ElementId, Task } from '@stoneforge/core';
import type { GetOptions } from '@stoneforge/quarry';

const root = process.env.ASSIGNMENT_FIXTURE_ROOT!;
if (!root || !path.basename(root).startsWith('sf-api-assignment-')) throw new Error('Isolated fixture root required');
const effects = { spawns: 0, terminations: 0 };
const record = () => writeFileSync(path.join(root, 'spawn.json'), JSON.stringify(effects));
const runtime = await import('../../src/runtime/index.js');
mock.module('../../src/runtime/index.js', () => ({ ...runtime, createSpawnerService: () => ({
  async spawn(agentId: string) {
    ++effects.spawns; record();
    return { session: { id: 'fixture-spawn', agentId, status: 'running', mode: 'headless' }, events: new EventEmitter() };
  },
  async terminate() { ++effects.terminations; record(); },
}) }));

if (process.env.ASSIGNMENT_FIXTURE_RACE === 'true') {
  const storage = createStorage({ path: path.join(root, '.stoneforge/stoneforge.db') });
  const competitor = createOrchestratorAPI(storage);
  const get = OrchestratorAPIImpl.prototype.get;
  let injected = false;
  OrchestratorAPIImpl.prototype.get = async function <T extends Element>(id: ElementId, options?: GetOptions): Promise<T | null> {
    const result = await get.call(this, id, options);
    if (this !== competitor && id === process.env.ASSIGNMENT_FIXTURE_TASK && !injected) {
      injected = true;
      const winner = await competitor.update<Task>(id, { status: 'closed', closeReason: 'fixture competing operator' });
      writeFileSync(path.join(root, 'winner.json'), JSON.stringify({ task: winner, events: storage.query('SELECT * FROM events ORDER BY id') }));
    }
    return result as T | null;
  };
}
