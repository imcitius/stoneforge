import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkEnvironment, runChecks } from './check-merge.mjs';

const options = { log: () => {}, stdio: 'pipe' };
const child = (name, code) => ({ name, command: process.execPath, args: ['-e', code] });

test('a failure at any position survives later successful checks', () => {
  for (let failing = 0; failing < 3; failing++) {
    const logs = [];
    const checks = [0, 1, 2].map(index => child(`check-${index}`, `process.exit(${index === failing ? 17 : 0})`));
    assert.equal(runChecks(checks, { ...options, log: line => logs.push(line) }), 1);
    assert(logs.some(line => line.includes('3 checks, 1 failed')));
    assert(logs.some(line => line.includes(`FAILED exit=17: check-${failing}`)));
  }
});

test('only a nonempty set of successful checks passes', () => {
  assert.equal(runChecks([child('pass', 'process.exit(0)')], options), 0);
  assert.equal(runChecks([], options), 1);
});

test('missing executables and signals fail closed', () => {
  assert.equal(runChecks([{ name: 'missing', command: '/nonexistent/stoneforge-check', args: [] }], options), 1);
  assert.equal(runChecks([child('signal', "process.kill(process.pid, 'SIGTERM')")], options), 1);
});

test('file-backed logs preserve failures and do not overflow a captured output buffer', () => {
  const logDirectory = mkdtempSync(join(tmpdir(), 'sf-gate-test-'));
  try {
    const checks = [child('large failure', "console.log('x'.repeat(2 * 1024 * 1024)); console.error('failure-marker'); process.exit(9)")];
    const messages = [];
    assert.equal(runChecks(checks, { logDirectory, log: line => messages.push(line) }), 1);
    const [result] = JSON.parse(readFileSync(join(logDirectory, 'results.json'), 'utf8'));
    assert.equal(result.code, 9);
    assert.match(readFileSync(result.logFile, 'utf8'), /failure-marker/);
    assert(messages.join('\n').length < 5000);
  } finally {
    rmSync(logDirectory, { recursive: true, force: true });
  }
});

test('worker routing and live-provider opt-in cannot leak into fixtures', () => {
  const original = { PATH: '/bin', STONEFORGE_ROOT: '/live', SF_ENTITY_ID: 'worker', ORCHESTRATOR_URL: 'http://live', RUN_INTEGRATION_TESTS: 'true' };
  assert.deepEqual(checkEnvironment(original), { PATH: '/bin', RUN_INTEGRATION_TESTS: 'false' });
  assert.equal(original.STONEFORGE_ROOT, '/live');
});
