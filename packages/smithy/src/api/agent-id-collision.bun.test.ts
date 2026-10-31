/** Real SQLite regression for collisions during agent registration. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import { createEntity, EntityTypeValue, type EntityId, type Channel } from '@stoneforge/core';
import { createOrchestratorAPI, getAgentMetadata, type OrchestratorAPI } from './orchestrator-api.js';

describe('Agent registration ID collisions', () => {
  let directory: string;
  let storage: StorageBackend;
  let api: OrchestratorAPI;
  const creator = 'el-0000' as EntityId;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'agent-id-collision-'));
    storage = createStorage(join(directory, 'test.db'));
    initializeSchema(storage);
    api = createOrchestratorAPI(storage);
  });

  afterEach(() => {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test('Quarry still rejects an explicitly supplied duplicate ID without altering the original', async () => {
    const seed = await createEntity({ name: 'occupied', entityType: EntityTypeValue.SYSTEM, createdBy: creator });
    const saved = await api.create(seed);
    await expect(api.create({ ...seed, name: 'different-name' })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    expect(await api.get(seed.id)).toEqual(saved);
    expect(await api.list({ type: 'entity' })).toHaveLength(1);
  });

  for (const role of ['director', 'worker', 'steward'] as const) {
    for (const target of ['entity', 'channel'] as const) {
      test(`${role} preserves an existing element when its ${target} ID collides`, async () => {
        // Force only nonce zero for the seed and target. Other candidates retain
        // native SHA-256; the generator, collision lookup and SQLite are real.
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        let forced = 0;
        let resolvedCandidates = 0;
        const spy = spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
          const input = new TextDecoder().decode(data);
          const [identifier, , , nonce] = input.split('|');
          const isTarget = target === 'entity' ? identifier === 'candidate' : identifier.includes(':candidate') || identifier.startsWith('direct-candidate:');
          if (isTarget && nonce !== '0') resolvedCandidates++;
          if (nonce === '0' && (identifier === 'occupied' || isTarget)) {
            forced++;
            return new Uint8Array(32).fill(0x42).buffer;
          }
          return digest(algorithm, data);
        });
        try {
          const seed = await createEntity({ name: 'occupied', entityType: EntityTypeValue.SYSTEM, createdBy: creator });
          const savedSeed = await api.create(seed);
          // Unconfigured factories use four hash characters; configured small
          // databases use three. Occupy both so changing length cannot by itself
          // satisfy the test: the generator must consult SQLite and advance nonce.
          const shortSeed = { ...seed, id: seed.id.slice(0, -1) as typeof seed.id, name: 'occupied-short' };
          const savedShortSeed = await api.create(shortSeed);
          const input = { name: 'candidate', createdBy: creator };
          const agent = role === 'director' ? await api.registerDirector(input)
            : role === 'worker' ? await api.registerWorker({ ...input, workerMode: 'ephemeral' })
            : await api.registerSteward({ ...input, stewardFocus: 'merge', triggers: [] });
          expect(forced).toBe(2);
          expect(resolvedCandidates).toBeGreaterThan(0);
          const channelId = getAgentMetadata(agent)!.channelId!;
          const channel = await api.get<Channel>(channelId);
          expect(channel).not.toBeNull();
          expect(new Set([seed.id, shortSeed.id, agent.id, channel!.id]).size).toBe(4);
          expect(channel!.members).toContain(agent.id as unknown as EntityId);
          expect(channel!.members).toContain(creator);
          expect(channel!.metadata.agentId).toBe(agent.id);
          expect(await api.get(seed.id)).toEqual(savedSeed);
          expect(await api.get(shortSeed.id)).toEqual(savedShortSeed);
          expect(await api.get(agent.id)).toEqual(agent);
          expect(await api.list({ type: 'entity' })).toHaveLength(3);
          expect(await api.list({ type: 'channel' })).toHaveLength(1);
        } finally {
          spy.mockRestore();
        }
      });
    }
  }
});
