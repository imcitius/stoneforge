/**
 * el-4f7pc9: a spawn that fails after the provider returned a handle must
 * release that handle. The rejected spawn returns no session to its caller, so
 * no later terminate() can be expected to clean it up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@stoneforge/core';
import { SpawnerServiceImpl } from './spawner.js';
import { AsyncQueue } from '../providers/opencode/async-queue.js';
import type { AgentMessage, AgentProvider, HeadlessSession, InteractiveSession } from '../providers/types.js';

const agent = 'el-test' as EntityId;
const TIMEOUT = 1000;

function fixture() {
  let exit: (code: number) => void = () => {};
  let exitRegistered = false;
  const queue = new AsyncQueue<AgentMessage>();
  const interactive = {
    write: vi.fn(), requestExit: vi.fn(), resize: vi.fn(),
    // A real PTY reports exit asynchronously after kill.
    kill: vi.fn(() => { queueMicrotask(() => exit(0)); }),
    onData: vi.fn(), onExit: vi.fn((cb: (code: number) => void) => { exit = cb; exitRegistered = true; }),
    getSessionId: vi.fn((): string | null => 'provider-id'),
  } satisfies InteractiveSession;
  const headless = {
    sendMessage: vi.fn(), interrupt: vi.fn(async () => {}),
    // Like the Claude/Codex providers, close ends the message stream.
    close: vi.fn(() => queue.close()),
    [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
  } satisfies HeadlessSession;
  const provider: AgentProvider = {
    name: 'isolated',
    interactive: { name: 'isolated', spawn: async () => interactive, isAvailable: async () => true },
    headless: { name: 'isolated', spawn: async () => headless, isAvailable: async () => true },
    isAvailable: async () => true, getInstallInstructions: () => '', listModels: async () => [],
  };
  const service = new SpawnerServiceImpl({ provider, workingDirectory: '/unused', timeout: TIMEOUT });
  return {
    service, interactive, headless, queue,
    exitRegistered: () => exitRegistered,
    finish: () => exit(0),
    spawn: (mode: 'headless' | 'interactive') => service.spawn(agent, 'worker', { mode }),
  };
}

const resumeFailure: AgentMessage = {
  type: 'result', subtype: 'error_during_execution',
  raw: { errors: ['No conversation found with session ID: stale'] },
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('headless init failure after handle acquisition', () => {
  it('closes the handle when init times out on a silent stream', async () => {
    const f = fixture();
    const spawn = f.spawn('headless').catch(e => e);
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    const error = await spawn;
    expect(error).toEqual(new Error(`Timeout waiting for agent init (${TIMEOUT}ms)`));
    expect(f.headless.close).toHaveBeenCalledTimes(1);
    expect(f.headless.interrupt).not.toHaveBeenCalled();
    const [session] = f.service.listAllSessions();
    expect(session.status).toBe('terminated');
    // The closed stream lets the reader finish and schedule normal retention.
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.service.listAllSessions()).toHaveLength(0);
  });

  it('closes the handle when resume fails but the stream stays open', async () => {
    const f = fixture();
    f.queue.push(resumeFailure);
    const error = await f.spawn('headless').catch(e => e);
    expect(error).toEqual(new Error('Session resume failed: No conversation found with session ID: stale'));
    expect(f.headless.close).toHaveBeenCalledTimes(1);
  });

  it('closes a handle whose stream ended before init (output end is not handle cleanup)', async () => {
    const f = fixture();
    f.queue.close();
    const error = await f.spawn('headless').catch(e => e);
    expect(error).toEqual(new Error('Session exited before init'));
    expect(f.headless.close).toHaveBeenCalledTimes(1);
  });

  it('does not repeat the automatic close after a provider error message before init', async () => {
    const f = fixture();
    f.queue.push({ type: 'error', content: 'provider failed', raw: {} });
    const error = await f.spawn('headless').catch(e => e);
    expect(error).toEqual(new Error('Session exited before init'));
    expect(f.headless.close).toHaveBeenCalledTimes(1);
  });

  it('keeps the original init error when close throws, and a later terminate retries close', async () => {
    const f = fixture();
    const closeError = new Error('close failed');
    f.headless.close.mockImplementationOnce(() => { throw closeError; });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spawn = f.spawn('headless').catch(e => e);
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    expect(await spawn).toEqual(new Error(`Timeout waiting for agent init (${TIMEOUT}ms)`));
    warn.mockRestore();
    const [session] = f.service.listAllSessions();
    expect(session.status).toBe('terminated');
    await f.service.terminate(session.id);
    await f.service.terminate(session.id);
    expect(f.headless.close).toHaveBeenCalledTimes(2);
    expect(f.headless.interrupt).not.toHaveBeenCalled();
  });
});

describe('interactive failure after handle acquisition', () => {
  it('kills the PTY when post-spawn setup throws, preserving the original error', async () => {
    const f = fixture();
    const error = new Error('getSessionId failed');
    f.interactive.getSessionId.mockImplementationOnce(() => { throw error; });
    expect(await f.spawn('interactive').catch(e => e)).toBe(error);
    expect(f.interactive.kill).toHaveBeenCalledTimes(1);
    expect(f.interactive.requestExit).not.toHaveBeenCalled();
    expect(f.service.listAllSessions()[0].status).toBe('terminated');
  });

  it('kills the PTY when exit-handler registration fails', async () => {
    const f = fixture();
    const error = new Error('onExit failed');
    f.interactive.onExit.mockImplementationOnce(() => { throw error; });
    expect(await f.spawn('interactive').catch(e => e)).toBe(error);
    expect(f.interactive.kill).toHaveBeenCalledTimes(1);
  });

  it('keeps the original error when the cleanup kill also throws', async () => {
    const f = fixture();
    const error = new Error('onData failed');
    f.interactive.onData.mockImplementationOnce(() => { throw error; });
    f.interactive.kill.mockImplementationOnce(() => { throw new Error('kill failed'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await f.spawn('interactive').catch(e => e)).toBe(error);
    warn.mockRestore();
    expect(f.interactive.kill).toHaveBeenCalledTimes(1);
    expect(f.service.listAllSessions()[0].status).toBe('terminated');
  });

  it('does not signal a PTY that already exited during setup', async () => {
    const f = fixture();
    // Provider replays an already-observed exit synchronously on registration;
    // the following starting->running transition then fails.
    f.interactive.onExit.mockImplementationOnce((cb: (code: number) => void) => { cb(1); });
    const error = await f.spawn('interactive').catch(e => e);
    expect(error).toEqual(new Error('Invalid status transition: terminated -> running'));
    expect(f.interactive.kill).not.toHaveBeenCalled();
  });

  it('successful spawn is unaffected', async () => {
    const f = fixture();
    const { session } = await f.spawn('interactive');
    expect(session.status).toBe('running');
    expect(f.interactive.kill).not.toHaveBeenCalled();
    expect(f.exitRegistered()).toBe(true);
  });
});
