import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@stoneforge/core';
import { SpawnerServiceImpl } from './spawner.js';
import { AsyncQueue } from '../providers/opencode/async-queue.js';
import type { AgentMessage, AgentProvider, HeadlessSession, InteractiveSession } from '../providers/types.js';

const agent = 'el-test' as EntityId;
function fixture(mode: 'interactive' | 'headless' = 'interactive') {
  let exit: (code: number) => void = () => {};
  const queue = new AsyncQueue<AgentMessage>();
  queue.push({ type: 'system', subtype: 'init', sessionId: 'reused-provider-id', raw: {} });
  const interactive = {
    write: vi.fn(), requestExit: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    onData: vi.fn(), onExit: (cb: (code: number) => void) => { exit = cb; },
    getSessionId: () => 'reused-provider-id',
  } satisfies InteractiveSession;
  const headless = {
    sendMessage: vi.fn(), interrupt: vi.fn(async () => {}), close: vi.fn(),
    [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
  } satisfies HeadlessSession;
  const provider: AgentProvider = {
    name: 'isolated',
    interactive: { name: 'isolated', spawn: async () => interactive, isAvailable: async () => true },
    headless: { name: 'isolated', spawn: async () => headless, isAvailable: async () => true },
    isAvailable: async () => true, getInstallInstructions: () => '', listModels: async () => [],
  };
  const service = new SpawnerServiceImpl({ provider, workingDirectory: '/unused' });
  return { service, interactive, headless, provider, queue,
    finish: () => mode === 'interactive' ? exit(0) : queue.close(),
    spawn: () => service.spawn(agent, 'worker', { mode }),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('Spawner termination ownership and retry', () => {
  it.each(['interactive', 'headless'] as const)('retries a throwing %s handle and shares its concurrent failure', async mode => {
    const f = fixture(mode);
    const { session, events } = await f.spawn();
    const method = mode === 'interactive' ? f.interactive.kill : f.headless.close;
    const error = new Error('transient provider failure');
    method.mockImplementationOnce(() => { throw error; }).mockImplementation(() => f.finish());
    const results = await Promise.allSettled([
      f.service.terminate(session.id, false), f.service.terminate(session.id, false),
    ]);
    expect(results).toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
    expect(f.service.getSession(session.id)?.status).toBe('terminating');
    expect(events.listenerCount('exit')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await f.service.terminate(session.id, false);
    expect(method).toHaveBeenCalledTimes(2);
    expect(f.service.getSession(session.id)?.status).toBe('terminated');
    await f.service.terminate(session.id);
    expect(method).toHaveBeenCalledTimes(2);
  });

  it('concurrent force call joins graceful attempt until the exit callback', async () => {
    const f = fixture();
    const { session, events } = await f.spawn();
    let completed = 0;
    const first = f.service.terminate(session.id).then(() => completed++);
    const second = f.service.terminate(session.id, false).then(() => completed++);
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(0);
    expect(f.interactive.requestExit).toHaveBeenCalledTimes(1);
    expect(f.interactive.kill).not.toHaveBeenCalled();
    f.finish();
    await Promise.all([first, second]);
    expect(completed).toBe(2);
    expect(events.listenerCount('exit')).toBe(0);
    expect(vi.getTimerCount()).toBe(1); // existing session-retention timer only
  });

  it('retry uses the original handle and leaves a successor with reused provider ID untouched', async () => {
    const f = fixture();
    const own = await f.spawn();
    f.interactive.kill.mockImplementationOnce(() => { throw new Error('kill failed'); });
    await expect(f.service.terminate(own.session.id, false)).rejects.toThrow('kill failed');
    const successor = fixture();
    const next = await f.service.spawn(agent, 'worker', { mode: 'interactive', provider: successor.provider });
    f.interactive.kill.mockImplementation(f.finish);
    await f.service.terminate(own.session.id, false);
    expect(f.service.getSession(own.session.id)?.status).toBe('terminated');
    expect(f.interactive.kill).toHaveBeenCalledTimes(2);
    expect(f.service.getSession(next.session.id)?.status).toBe('running');
    expect(successor.interactive.kill).not.toHaveBeenCalled();
    expect(successor.interactive.requestExit).not.toHaveBeenCalled();
  });
});


describe('termination steps and confirmation', () => {
  it.each(['requestExit', 'write'] as const)('retries throwing graceful %s, then observes synchronous exit', async method => {
    const f = fixture();
    if (method === 'write') delete (f.interactive as InteractiveSession).requestExit;
    const { session, events } = await f.spawn();
    const error = new Error(method);
    f.interactive[method].mockImplementationOnce(() => { throw error; }).mockImplementation(f.finish);
    await expect(f.service.terminate(session.id)).rejects.toBe(error);
    expect(events.listenerCount('exit')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await f.service.terminate(session.id);
    expect(f.interactive[method]).toHaveBeenCalledTimes(2);
    expect(f.interactive.kill).not.toHaveBeenCalled();
    expect(f.service.getSession(session.id)?.status).toBe('terminated');
  });

  it('rejects fallback kill errors without losing them in a timer callback; retry skips completed grace period', async () => {
    const f = fixture();
    const { session, events } = await f.spawn();
    const error = new Error('fallback kill');
    f.interactive.kill.mockImplementationOnce(() => { throw error; }).mockImplementation(f.finish);
    const result = f.service.terminate(session.id).catch(e => e);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toBe(error);
    expect(events.listenerCount('exit')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await f.service.terminate(session.id);
    expect(f.interactive.requestExit).toHaveBeenCalledTimes(1);
    expect(f.interactive.kill).toHaveBeenCalledTimes(2);
  });

  it.each(['interactive', 'headless'] as const)('does not report %s termination without exit, or repeat an accepted force request', async mode => {
    const f = fixture(mode);
    const { session, events } = await f.spawn();
    const method = mode === 'interactive' ? f.interactive.kill : f.headless.close;
    const result = f.service.terminate(session.id, false).catch(e => e);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toEqual(new Error(`Session termination unconfirmed: ${session.id}`));
    expect(f.service.getSession(session.id)?.status).toBe('terminating');
    expect(f.service.getSession(session.id)?.endedAt).toBeUndefined();
    expect(f.service.listActiveSessions()).toHaveLength(1);
    expect(events.listenerCount('exit')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const retry = f.service.terminate(session.id); // even graceful must not repeat accepted force
    await vi.advanceTimersByTimeAsync(0);
    expect(method).toHaveBeenCalledTimes(1);
    expect(f.interactive.requestExit).not.toHaveBeenCalled();
    expect(f.headless.interrupt).not.toHaveBeenCalled();
    f.finish();
    await retry;
    expect(f.service.getSession(session.id)?.status).toBe('terminated');
    expect(events.listenerCount('exit')).toBe(0);
  });

  it('retries close without repeating successful interrupt', async () => {
    const f = fixture('headless');
    const { session } = await f.spawn();
    const error = new Error('close');
    f.headless.close.mockImplementationOnce(() => { throw error; }).mockImplementation(f.finish);
    await expect(f.service.terminate(session.id)).rejects.toBe(error);
    await f.service.terminate(session.id);
    expect(f.headless.interrupt).toHaveBeenCalledTimes(1);
    expect(f.headless.close).toHaveBeenCalledTimes(2);
  });

  it('preserves interrupt error for both callers and permits force retry', async () => {
    const f = fixture('headless');
    const { session } = await f.spawn();
    const error = new Error('interrupt');
    f.headless.interrupt.mockRejectedValueOnce(error);
    expect(await Promise.allSettled([f.service.terminate(session.id), f.service.terminate(session.id, false)]))
      .toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
    expect(f.headless.close).not.toHaveBeenCalled();
    f.headless.close.mockImplementation(f.finish);
    await f.service.terminate(session.id, false);
    expect(f.headless.interrupt).toHaveBeenCalledTimes(1);
    expect(f.headless.close).toHaveBeenCalledTimes(1);
  });

  it('preserves provider error even when the same request synchronously reports exit', async () => {
    const f = fixture();
    const { session } = await f.spawn();
    const error = new Error('after exit');
    f.interactive.kill.mockImplementation(() => { f.finish(); throw error; });
    expect(await Promise.allSettled([f.service.terminate(session.id, false), f.service.terminate(session.id, false)]))
      .toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
    await f.service.terminate(session.id, false);
    expect(f.interactive.kill).toHaveBeenCalledTimes(1);
  });

  it('already exited sessions return success without sending commands', async () => {
    const f = fixture();
    const { session } = await f.spawn();
    f.finish();
    await f.service.terminate(session.id);
    expect(f.interactive.requestExit).not.toHaveBeenCalled();
    expect(f.interactive.kill).not.toHaveBeenCalled();
  });

  it('force retry after graceful request failure never repeats the graceful command', async () => {
    const f = fixture();
    const { session } = await f.spawn();
    f.interactive.requestExit.mockImplementation(() => { throw new Error('request'); });
    await expect(f.service.terminate(session.id)).rejects.toThrow('request');
    f.interactive.kill.mockImplementation(f.finish);
    await f.service.terminate(session.id, false);
    expect(f.interactive.requestExit).toHaveBeenCalledTimes(1);
    expect(f.interactive.kill).toHaveBeenCalledTimes(1);
  });

  it('legacy process fixture treats killed as signal delivery, cleans listeners, and retries failed SIGKILL', async () => {
    const f = fixture();
    const { session } = await f.spawn();
    // No current spawn path creates this deprecated handle. Seed only this
    // legacy branch with an inert EventEmitter, never an OS process or PID.
    const process = Object.assign(new EventEmitter(), { killed: false, kill: vi.fn() });
    const internal = (f.service as unknown as { sessions: Map<string, {
      interactiveSession?: InteractiveSession; process?: ChildProcess;
    }> }).sessions.get(session.id)!;
    internal.interactiveSession = undefined;
    internal.process = process as unknown as ChildProcess;
    const error = new Error('SIGKILL');
    process.kill.mockImplementationOnce(() => { process.killed = true; return true; })
      .mockImplementationOnce(() => { throw error; })
      .mockImplementation(() => { process.emit('exit', 0); return true; });
    const result = f.service.terminate(session.id).catch(e => e);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toBe(error);
    expect(process.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(process.listenerCount('exit')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await f.service.terminate(session.id, false);
    expect(process.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL'], ['SIGKILL']]);
    expect(f.service.getSession(session.id)?.status).toBe('terminated');
    await f.service.terminate(session.id);
    expect(process.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL'], ['SIGKILL']]);
    expect(process.listenerCount('exit')).toBe(0);
  });
});


describe('headless output completion versus handle cleanup', () => {
  it('closes an independently ended stream once without interrupting or changing its ended state', async () => {
    const f = fixture('headless');
    const { session, events } = await f.spawn();
    const exit = new Promise<void>(resolve => events.once('exit', resolve));
    f.finish();
    await exit;
    const endedAt = f.service.getSession(session.id)!.endedAt;
    await Promise.all([f.service.terminate(session.id), f.service.terminate(session.id, false)]);
    await f.service.terminate(session.id);
    expect(f.headless.close).toHaveBeenCalledTimes(1);
    expect(f.headless.interrupt).not.toHaveBeenCalled();
    expect(f.service.getSession(session.id)).toMatchObject({ status: 'terminated', endedAt });
    expect(f.service.listActiveSessions()).toHaveLength(0);
  });

  it('keeps repeated cleanup errors observable after output end and protects a same-agent successor', async () => {
    const f = fixture('headless');
    const own = await f.spawn();
    const exit = new Promise<void>(resolve => own.events.once('exit', resolve));
    f.finish(); await exit;
    const successor = fixture('headless');
    const next = await f.service.spawn(agent, 'worker', { mode: 'headless', provider: successor.provider });
    for (const error of [new Error('first'), new Error('second')]) {
      f.headless.close.mockImplementationOnce(() => { throw error; });
      expect(await Promise.allSettled([f.service.terminate(own.session.id), f.service.terminate(own.session.id)]))
        .toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
      expect(f.service.getSession(own.session.id)?.status).toBe('terminated');
    }
    await f.service.terminate(own.session.id);
    await f.service.terminate(own.session.id);
    expect(f.headless.close).toHaveBeenCalledTimes(3);
    expect(f.headless.interrupt).not.toHaveBeenCalled();
    expect(f.service.getSession(next.session.id)?.status).toBe('running');
    expect(successor.headless.close).not.toHaveBeenCalled();
    expect(successor.headless.interrupt).not.toHaveBeenCalled();
  });

  it('retries close that ends output before throwing, with concurrent callers sharing the error', async () => {
    const f = fixture('headless');
    const { session, events } = await f.spawn();
    const exit = new Promise<void>(resolve => events.once('exit', resolve));
    const error = new Error('close after end');
    f.headless.close.mockImplementationOnce(() => { f.finish(); throw error; });
    expect(await Promise.allSettled([f.service.terminate(session.id, false), f.service.terminate(session.id)]))
      .toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
    await exit;
    await f.service.terminate(session.id);
    expect(f.headless.close).toHaveBeenCalledTimes(2);
    expect(f.headless.interrupt).not.toHaveBeenCalled();
    expect(events.listenerCount('exit')).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('still closes when output ends during an awaited interrupt', async () => {
    const f = fixture('headless');
    const { session, events } = await f.spawn();
    f.headless.interrupt.mockImplementation(async () => {
      const exit = new Promise<void>(resolve => events.once('exit', resolve));
      f.finish(); await exit;
    });
    await f.service.terminate(session.id);
    expect(f.headless.close).toHaveBeenCalledTimes(1);
    expect(f.headless.interrupt).toHaveBeenCalledTimes(1);
  });

  it('does not repeat output-driven close while an explicit graceful attempt awaits interrupt', async () => {
    const f = fixture('headless');
    const { session, events } = await f.spawn();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    f.headless.interrupt.mockImplementation(() => barrier);
    const stop = f.service.terminate(session.id);
    await vi.advanceTimersByTimeAsync(0);
    const exit = new Promise<void>(resolve => events.once('exit', resolve));
    f.queue.push({ type: 'result', subtype: 'success', raw: {} });
    await exit;
    const concurrent = f.service.terminate(session.id);
    release();
    await Promise.all([stop, concurrent]);
    expect(f.headless.close).toHaveBeenCalledTimes(1);
    expect(f.headless.interrupt).toHaveBeenCalledTimes(1);
    expect(f.service.getSession(session.id)?.status).toBe('terminated');
  });

  it.each(['result', 'error'] as const)('does not repeat automatic successful %s cleanup', async type => {
    const f = fixture('headless');
    const { session, events } = await f.spawn();
    const exit = new Promise<void>(resolve => events.once('exit', resolve));
    f.queue.push({ type, subtype: 'success', raw: {} });
    await exit;
    await f.service.terminate(session.id);
    expect(f.headless.close).toHaveBeenCalledTimes(1);
    expect(f.headless.interrupt).not.toHaveBeenCalled();
  });

  it.each(['result', 'error'] as const)('retries automatic failed %s cleanup after stream end', async type => {
    const f = fixture('headless');
    const { session, events } = await f.spawn();
    const error = new Error('automatic close');
    const errors: unknown[] = [];
    events.on('error', e => errors.push(e));
    f.headless.close.mockImplementationOnce(() => { throw error; });
    const exit = new Promise<void>(resolve => events.once('exit', resolve));
    f.queue.push({ type, subtype: 'success', raw: {} });
    await exit;
    expect(errors).toEqual([error]);
    await f.service.terminate(session.id);
    await f.service.terminate(session.id);
    expect(f.headless.close).toHaveBeenCalledTimes(2);
  });

  it('preserves the five-second retention bound even when cleanup remains incomplete', async () => {
    const f = fixture('headless');
    const { session, events } = await f.spawn();
    const exit = new Promise<void>(resolve => events.once('exit', resolve));
    f.finish(); await exit;
    await vi.advanceTimersByTimeAsync(5000);
    await expect(f.service.terminate(session.id)).rejects.toThrow('Session not found');
    expect(f.headless.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
