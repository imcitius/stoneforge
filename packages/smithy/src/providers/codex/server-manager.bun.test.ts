import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { serverManager } from './server-manager.js';

function fakeServer(failInitialize: boolean) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: mock(() => true),
  });
  child.stdin.on('data', data => {
    const request = JSON.parse(data.toString());
    if (request.id === undefined) return;
    const response = request.method === 'initialize' && failInitialize
      ? { id: request.id, error: { message: 'unsupported protocol' } }
      : { id: request.id, result: request.method === 'model/list' ? { data: [] } : {} };
    child.stdout.write(JSON.stringify(response) + '\n');
  });
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

describe('Codex shared server lifecycle', () => {
  let spawn: ReturnType<typeof spyOn>;
  let children: ReturnType<typeof fakeServer>[];
  let failInitialize: boolean;

  beforeEach(() => {
    serverManager.shutdown();
    children = [];
    failInitialize = false;
    spawn = spyOn(childProcess, 'spawn').mockImplementation(() => {
      const child = fakeServer(failInitialize);
      children.push(child);
      return child as unknown as childProcess.ChildProcess;
    });
  });
  afterEach(() => { serverManager.shutdown(); spawn.mockRestore(); });

  it('shares startup and stops only after the last session releases it', async () => {
    const [first, second] = await Promise.all([serverManager.acquire(), serverManager.acquire()]);
    expect(first).toBe(second);
    expect(children).toHaveLength(1);
    serverManager.release();
    expect(children[0].kill).not.toHaveBeenCalled();
    serverManager.release();
    expect(children[0].kill).toHaveBeenCalledTimes(1);
  });

  it('cleans up failed initialization and both concurrent references', async () => {
    failInitialize = true;
    const results = await Promise.allSettled([serverManager.acquire(), serverManager.acquire()]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    failInitialize = false;
    await serverManager.acquire();
    serverManager.release();
    expect(children[1].kill).toHaveBeenCalledTimes(1);
  });

  it('does not lose a new server when the previous process exits late', async () => {
    await serverManager.acquire();
    serverManager.release();
    const current = await serverManager.acquire();
    children[0].emit('exit', 0);
    expect(await serverManager.acquire()).toBe(current);
    expect(children).toHaveLength(2);
    expect(await current.model.list()).toEqual({ data: [] });
    serverManager.release();
    serverManager.release();
    expect(children[1].kill).toHaveBeenCalledTimes(1);
  });
});
