import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createEntity, EntityTypeValue, type EntityId } from '@stoneforge/core';
import { createStorageAsync, initializeSchema } from '@stoneforge/storage';
import { createQuarryAPI } from '@stoneforge/quarry';
import { createAgentRegistry } from '../../services/agent-registry.js';
import { createSessionManager } from '../../runtime/session-manager.js';
import type { AgentProvider } from '../types.js';
import { AsyncQueue } from '../opencode/async-queue.js';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query }));
import { ClaudeHeadlessProvider } from './headless.js';
import { SpawnerServiceImpl } from '../../runtime/spawner.js';

function sdkFixture() {
  const output = new AsyncQueue<SDKMessage>();
  const close = vi.fn(() => output.close());
  const interrupt = vi.fn(async () => {});
  let input: AsyncIterator<SDKUserMessage>;
  query.mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
    input = prompt[Symbol.asyncIterator]();
    return { close, interrupt, [Symbol.asyncIterator]: () => output[Symbol.asyncIterator]() };
  });
  return { output, close, interrupt, input: () => input! };
}
const spawn = () => new ClaudeHeadlessProvider().spawn({ workingDirectory: '/unused', initialPrompt: 'initial' });
const message = { type: 'system', subtype: 'init', session_id: 'reused-id' } as SDKMessage;
beforeEach(() => query.mockReset());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('Claude adapter cleanup retry with isolated SDK queries', () => {
  it('propagates the first close error, retries cleanup, and leaves completed close idempotent', async () => {
    const f = sdkFixture();
    const session = await spawn();
    const error = new Error('close once');
    f.close.mockImplementationOnce(() => { throw error; });
    expect(() => session.close()).toThrow(error);
    session.close();
    session.close();
    expect(f.close).toHaveBeenCalledTimes(2);
    expect(f.interrupt).not.toHaveBeenCalled();
  });

  it('preserves each repeated error until the same query cleanup succeeds', async () => {
    const f = sdkFixture();
    const session = await spawn();
    const first = new Error('first');
    const second = new Error('second');
    f.close.mockImplementationOnce(() => { throw first; }).mockImplementationOnce(() => { throw second; });
    expect(() => session.close()).toThrow(first);
    expect(() => session.close()).toThrow(second);
    session.close();
    session.close();
    expect(f.close).toHaveBeenCalledTimes(3);
  });

  it('ends waiting input on failure and never accepts messages during or after cleanup retries', async () => {
    const f = sdkFixture();
    const session = await spawn();
    expect((await f.input().next()).value.message.content).toBe('initial');
    const waiting = f.input().next();
    f.close.mockImplementationOnce(() => {
      session.sendMessage('during close');
      throw new Error('close');
    });
    expect(() => session.close()).toThrow('close');
    expect((await waiting).done).toBe(true);
    session.sendMessage('after failure');
    expect((await f.input().next()).done).toBe(true);
    session.close();
    session.sendMessage('after success');
    expect((await f.input().next()).done).toBe(true);
  });

  it('preserves pre-close queued input ordering without reopening input', async () => {
    const f = sdkFixture();
    const session = await spawn();
    session.sendMessage('queued');
    session.close();
    session.sendMessage('discarded');
    expect((await f.input().next()).value.message.content).toBe('initial');
    expect((await f.input().next()).value.message.content).toBe('queued');
    expect((await f.input().next()).done).toBe(true);
  });

  it('stops yielding SDK messages after failed close but does not treat iterator end as cleanup success', async () => {
    const f = sdkFixture();
    const session = await spawn();
    const iterator = session[Symbol.asyncIterator]();
    f.output.push(message);
    expect((await iterator.next()).value.sessionId).toBe('reused-id');
    const waiting = iterator.next();
    f.close.mockImplementationOnce(() => { throw new Error('close'); });
    expect(() => session.close()).toThrow('close');
    f.output.push(message);
    expect((await waiting).done).toBe(true);
    session.close();
    expect(f.close).toHaveBeenCalledTimes(2);
  });

  it('still cleans up a query whose output ended naturally', async () => {
    const f = sdkFixture();
    const session = await spawn();
    f.output.close();
    expect((await session[Symbol.asyncIterator]().next()).done).toBe(true);
    session.close();
    session.close();
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it('keeps interrupt separate, propagates its error and permits more input', async () => {
    const f = sdkFixture();
    const session = await spawn();
    const error = new Error('interrupt');
    f.interrupt.mockRejectedValueOnce(error);
    await expect(session.interrupt()).rejects.toBe(error);
    await session.interrupt();
    session.sendMessage('after interrupt');
    expect((await f.input().next()).value.message.content).toBe('initial');
    expect((await f.input().next()).value.message.content).toBe('after interrupt');
    expect(f.close).not.toHaveBeenCalled();
    session.close();
    expect(f.interrupt).toHaveBeenCalledTimes(2);
  });

  it('retains AbortError iterator semantics without marking cleanup complete', async () => {
    const f = sdkFixture();
    query.mockReset();
    query.mockReturnValue({ close: f.close, interrupt: f.interrupt,
      async *[Symbol.asyncIterator]() { throw Object.assign(new Error('abort'), { name: 'AbortError' }); },
    });
    const session = await spawn();
    expect((await session[Symbol.asyncIterator]().next()).done).toBe(true);
    session.close();
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it('composes Spawner retries with the original Claude query, preserving a same-ID successor', async () => {
    vi.useFakeTimers();
    const old = sdkFixture();
    const provider = {
      name: 'isolated-claude', headless: new ClaudeHeadlessProvider(),
      isAvailable: async () => true, getInstallInstructions: () => '', listModels: async () => [],
    } satisfies AgentProvider;
    const service = new SpawnerServiceImpl({ provider, workingDirectory: '/unused' });
    old.output.push(message);
    const own = await service.spawn('el-test' as EntityId, 'worker', { mode: 'headless' });
    const error = new Error('SDK close');
    old.close.mockImplementationOnce(() => { throw error; });
    expect(await Promise.allSettled([service.terminate(own.session.id), service.terminate(own.session.id)]))
      .toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
    expect(service.getSession(own.session.id)?.status).toBe('terminating');
    const successor = sdkFixture();
    successor.output.push(message);
    const next = await service.spawn('el-test' as EntityId, 'worker', { mode: 'headless' });
    const retry = service.terminate(own.session.id).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(old.close).toHaveBeenCalledTimes(2);
    expect(await retry).toBeUndefined();
    expect(old.interrupt).toHaveBeenCalledTimes(1);
    expect(service.getSession(own.session.id)?.status).toBe('terminated');
    await service.terminate(own.session.id);
    expect(old.close).toHaveBeenCalledTimes(2);
    expect(service.getSession(next.session.id)?.status).toBe('running');
    expect(successor.close).not.toHaveBeenCalled();
    expect(successor.interrupt).not.toHaveBeenCalled();
    await service.terminate(next.session.id, false);
  });
});


const isolatedProvider = (): AgentProvider => ({
  name: 'isolated-claude', headless: new ClaudeHeadlessProvider(),
  isAvailable: async () => true, getInstallInstructions: () => '', listModels: async () => [],
});

describe('retained Spawner cleanup after Claude output completion', () => {
  it.each(['before-close', 'during-throw'] as const)('retries the captured SDK query when output ends %s', async timing => {
    vi.useFakeTimers();
    const old = sdkFixture();
    old.output.push(message);
    const service = new SpawnerServiceImpl({ provider: isolatedProvider(), workingDirectory: '/unused' });
    const own = await service.spawn('el-test' as EntityId, 'worker', { mode: 'headless' });
    const exit = new Promise<void>(resolve => own.events.once('exit', resolve));
    if (timing === 'before-close') { old.output.close(); await exit; }
    const error = new Error('SDK cleanup after end');
    old.close.mockImplementationOnce(() => { old.output.close(); throw error; });
    expect(await Promise.allSettled([service.terminate(own.session.id, false), service.terminate(own.session.id)]))
      .toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
    await exit;
    const successor = sdkFixture(); successor.output.push(message);
    const next = await service.spawn('el-test' as EntityId, 'worker', { mode: 'headless' });
    await service.terminate(own.session.id);
    await service.terminate(own.session.id);
    expect(old.close).toHaveBeenCalledTimes(2);
    expect(old.interrupt).not.toHaveBeenCalled();
    expect(service.getSession(own.session.id)?.status).toBe('terminated');
    expect(service.getSession(next.session.id)?.status).toBe('running');
    expect(successor.close).not.toHaveBeenCalled();
    expect(successor.interrupt).not.toHaveBeenCalled();
    await service.terminate(next.session.id, false);
  });

  it('composes SessionManager stop retry and successor CAS with real Spawner/Claude and isolated SQLite', async () => {
    vi.useFakeTimers();
    const db = await createStorageAsync({ path: ':memory:' });
    initializeSchema(db);
    try {
      const api = createQuarryAPI(db);
      const creator = (await api.create(await createEntity({ name: 'test-system', entityType: EntityTypeValue.SYSTEM,
        createdBy: 'system:test' as EntityId }) as never)).id as unknown as EntityId;
      const registry = createAgentRegistry(api);
      const worker = await registry.registerWorker({ name: 'test-worker', workerMode: 'ephemeral', createdBy: creator });
      const service = new SpawnerServiceImpl({ provider: isolatedProvider(), workingDirectory: '/unused' });
      const manager = createSessionManager(service, api, registry);
      const old = sdkFixture(); old.output.push(message);
      const own = await manager.startSession(worker.id as unknown as EntityId);
      const exit = new Promise<void>(resolve => own.events.once('exit', resolve));
      const error = new Error('SDK close ends output then throws');
      old.close.mockImplementationOnce(() => { old.output.close(); throw error; });
      expect(await Promise.allSettled([manager.stopSession(own.session.id), manager.stopSession(own.session.id)]))
        .toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
      await exit;
      expect(service.getSession(own.session.id)?.status).toBe('terminated');
      expect((await manager.getSessionHistory(worker.id as unknown as EntityId))).toHaveLength(0);
      const successor = sdkFixture(); successor.output.push(message);
      const next = await manager.startSession(worker.id as unknown as EntityId);
      await Promise.all([manager.stopSession(own.session.id), manager.stopSession(own.session.id)]);
      await manager.stopSession(own.session.id);
      expect(old.close).toHaveBeenCalledTimes(2);
      expect(old.interrupt).toHaveBeenCalledTimes(1);
      expect(manager.getActiveSession(worker.id as unknown as EntityId)?.id).toBe(next.session.id);
      expect(await registry.getAgent(worker.id as unknown as EntityId)).toMatchObject({ metadata: { agent: {
        currentSessionId: next.session.id, sessionId: 'reused-id', sessionStatus: 'running',
      } } });
      const history = await manager.getSessionHistory(worker.id as unknown as EntityId);
      expect(history.filter(entry => entry.id === own.session.id)).toHaveLength(1);
      expect(successor.close).not.toHaveBeenCalled();
      expect(successor.interrupt).not.toHaveBeenCalled();
      await manager.stopSession(next.session.id, { graceful: false });
    } finally { db.close(); }
  });
});
