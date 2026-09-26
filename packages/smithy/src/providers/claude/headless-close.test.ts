import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EntityId } from '@stoneforge/core';
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
