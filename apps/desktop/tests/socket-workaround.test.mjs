import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { installSocketWorkaround } from '../dist/socket-workaround.js';

test('macOS workaround preserves socket calls and suppresses only the reported native error', () => {
  let failure;
  const calls = [];
  const prototype = { setTypeOfService(value) {
    calls.push([this, value]);
    if (failure) throw failure;
    return this;
  } };
  installSocketWorkaround(prototype, 'darwin');
  const wrapped = prototype.setTypeOfService;
  installSocketWorkaround(prototype, 'darwin');
  assert.equal(prototype.setTypeOfService, wrapped);
  const socket = Object.create(prototype);
  assert.equal(socket.setTypeOfService(16), socket);
  assert.deepEqual(calls, [[socket, 16]]);
  failure = Object.assign(new Error('setTypeOfService EINVAL'), { code: 'EINVAL', syscall: 'setTypeOfService' });
  assert.equal(socket.setTypeOfService(0), socket);
  for (const error of [new Error('unrelated'),
    Object.assign(new Error('other code'), { code: 'EBADF', syscall: 'setTypeOfService' }),
    Object.assign(new Error('other syscall'), { code: 'EINVAL', syscall: 'connect' })]) {
    failure = error;
    assert.throws(() => socket.setTypeOfService(0), (caught) => caught === error);
  }
});

test('other platforms and runtimes without setTypeOfService are unchanged', () => {
  const original = () => {};
  const prototype = { setTypeOfService: original };
  installSocketWorkaround(prototype, 'linux');
  assert.equal(prototype.setTypeOfService, original);
  const oldRuntime = {};
  installSocketWorkaround(oldRuntime, 'darwin');
  assert.deepEqual(oldRuntime, {});
});

test('Electron fetch survives injected macOS EINVAL on fresh and reused HTTP sockets', { skip: process.platform !== 'darwin' }, () => {
  const require = createRequire(import.meta.url);
  const electron = require('electron');
  const workaround = new URL('../dist/socket-workaround.js', import.meta.url).href;
  const script = `
    const assert = require('node:assert/strict');
    const { Socket } = require('node:net');
    const { createServer } = require('node:http');
    const { once } = require('node:events');
    (async () => {
      let calls = 0;
      Socket.prototype.setTypeOfService = function () {
        calls++;
        throw Object.assign(new Error('setTypeOfService EINVAL'), { code: 'EINVAL', syscall: 'setTypeOfService' });
      };
      if (process.env.SOCKET_WORKAROUND === '1') await import(${JSON.stringify(workaround)});
      const server = createServer((req, res) => res.end('healthy'));
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        for (let n = 0; n < 4; n++) {
          const response = await fetch('http://127.0.0.1:' + server.address().port);
          assert.equal(await response.text(), 'healthy');
        }
        assert(calls > 0, 'The injected socket failure must actually be exercised');
      } finally { server.closeAllConnections(); server.close(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const run = (enabled) => spawnSync(electron, ['-e', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SOCKET_WORKAROUND: enabled ? '1' : '0' },
    encoding: 'utf8', timeout: 15_000,
  });
  const baseline = run(false);
  assert.notEqual(baseline.status, 0, 'Unpatched Electron must reproduce the defect');
  assert.match(baseline.stderr, /setTypeOfService EINVAL/);
  const fixed = run(true);
  assert.equal(fixed.status, 0, fixed.stderr || String(fixed.error));
});
