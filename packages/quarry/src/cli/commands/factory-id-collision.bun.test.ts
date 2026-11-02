/**
 * Real SQLite regression (el-4htfn): CLI commands that create plans and
 * channels must pass QuarryAPI.getIdGeneratorConfig() to core factories so an
 * occupied ID candidate is skipped instead of failing with a duplicate
 * elements.id. Only the nonce-0 ID digest is forced; see
 * packages/smithy/src/api/agent-id-collision.bun.test.ts (el-2zj6n).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorage, initializeSchema, type StorageBackend } from '@stoneforge/storage';
import {
  createEntity,
  DEFAULT_HASH_LENGTH,
  EntityTypeValue,
  MAX_HASH_LENGTH,
  MIN_HASH_LENGTH,
  toBase36Digits,
  type Element,
  type EntityId,
} from '@stoneforge/core';
import { createQuarryAPI } from '../../api/quarry-api.js';
import type { QuarryAPI } from '../../api/types.js';
import type { GlobalOptions } from '../types.js';
import { ExitCode } from '../types.js';
import { planCommand } from './plan.js';
import { channelCommand } from './channel.js';
import { messageCommand } from './message.js';
import { createDefaultAgents } from './init.js';

const FORCED = new Uint8Array(32).fill(0x42);

describe('CLI factory ID collisions (el-4htfn)', () => {
  let directory: string;
  let dbPath: string;
  let storage: StorageBackend;
  let api: QuarryAPI;
  let spy: ReturnType<typeof spyOn>;
  let retried: number;
  let occupied: Element[];
  let alice: Element;
  let bob: Element;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'cli-factory-id-collision-'));
    mkdirSync(join(directory, '.stoneforge'));
    dbPath = join(directory, '.stoneforge', 'stoneforge.db');
    storage = createStorage({ path: dbPath, create: true });
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
    // Occupy the forced nonce-0 candidate at every length (3..8): since
    // el-4rgbi0 the length-L candidate is D mod 36^L, so this covers the
    // unconfigured default (6) and whatever adaptive length the config picks.
    const seed = await createEntity({ name: 'occupied', entityType: EntityTypeValue.SYSTEM, createdBy: 'el-0000' as EntityId });
    expect(seed.id).toBe(`el-${toBase36Digits(FORCED, DEFAULT_HASH_LENGTH)}`);
    occupied = [];
    for (let length = MIN_HASH_LENGTH; length <= MAX_HASH_LENGTH; length++) {
      const id = `el-${toBase36Digits(FORCED, length)}` as typeof seed.id;
      occupied.push(await api.create({ ...seed, id, name: `occupied-${length}` }));
    }
    const entity = async (name: string) => api.create(
      (await createEntity({ name, entityType: EntityTypeValue.HUMAN, createdBy: 'el-0000' as EntityId }, api.getIdGeneratorConfig())) as unknown as Element & Record<string, unknown>
    );
    alice = await entity('alice');
    bob = await entity('bob');
    // Count only retries made by the command under test.
    retried = 0;
  });

  afterEach(() => {
    spy.mockRestore();
    if (storage.isOpen) storage.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const options = (extra: Record<string, unknown>) => ({
    db: dbPath, actor: alice.id, json: true, quiet: false, verbose: false, help: false, version: false, ...extra,
  }) as GlobalOptions;

  async function run(command: typeof planCommand, sub: string, extra: Record<string, unknown>) {
    const result = await command.subcommands![sub].handler!([], options(extra));
    expect({ exitCode: result.exitCode, error: result.error }).toEqual({ exitCode: ExitCode.SUCCESS, error: undefined });
    return result.data as { id: string; channelId?: string };
  }

  async function expectOccupiedPreserved(created: Array<{ id: string }>) {
    for (const element of occupied) expect(await api.get(element.id)).toEqual(element);
    const ids = new Set([...occupied, alice, bob, ...created].map((e) => e.id));
    expect(ids.size).toBe(occupied.length + 2 + created.length);
    expect(retried).toBeGreaterThan(0);
  }

  test('plan create skips an occupied plan ID', async () => {
    const plan = await run(planCommand, 'create', { title: 'plan' });
    expect(await api.get(plan.id as Element['id'])).not.toBeNull();
    await expectOccupiedPreserved([plan]);
  });

  test('channel create (group and direct) skips occupied channel IDs', async () => {
    const group = await run(channelCommand, 'create', { name: 'group', member: bob.id });
    const direct = await run(channelCommand, 'create', { type: 'direct', direct: bob.id });
    await expectOccupiedPreserved([group, direct]);
  });

  test('message send --to creates its direct channel without an occupied ID', async () => {
    const message = await run(messageCommand, 'send', { to: bob.id, content: 'hi' });
    expect(message.channelId).toBeDefined();
    const saved = await api.get<Element & { contentRef: string }>(message.id as Element['id']);
    await expectOccupiedPreserved([message, { id: message.channelId! }, { id: saved!.contentRef }]);
  });

  test('init default agents and their direct channels skip occupied IDs', async () => {
    const result = await createDefaultAgents(api);
    expect(result.skipped).toBe(0);
    const agents = await api.list<Element & { name: string }>({ type: 'entity' });
    const created = agents.filter((e) => !['alice', 'bob'].includes(e.name) && !occupied.some((o) => o.id === e.id));
    expect(created).toHaveLength(result.created);
    const channels = await api.list<Element>({ type: 'channel' });
    expect(channels).toHaveLength(result.created);
    await expectOccupiedPreserved([...created, ...channels]);
  });
});
