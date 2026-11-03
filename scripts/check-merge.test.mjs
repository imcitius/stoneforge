import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkEnvironment, checkRuntime, mergeChecks, requiredBunTests, runChecks, runMergeGate } from './check-merge.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

function runtimeFixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "sf gate's runtime-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const write = (file, content, mode) => {
    const path = join(cwd, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { mode });
  };
  // Pin the test's actual runtime, so these tests need no globally installed version.
  write('apps/desktop/package.json', JSON.stringify({ devDependencies: { node: process.versions.node } }));
  for (const tool of ['pnpm', 'bun']) write(`bin/${tool}`, '#!/bin/sh\necho fixture-version\n', 0o755);
  symlinkSync(process.execPath, join(cwd, 'bin/node'));
  write('packages/storage/node_modules/better-sqlite3/index.js', `
    module.exports = class {
      constructor(name) {
        if (name !== ':memory:') throw new Error('Expected in-memory probe');
        require('node:fs').writeFileSync(${JSON.stringify(join(cwd, 'opened'))}, 'yes');
      }
      close() { require('node:fs').writeFileSync(${JSON.stringify(join(cwd, 'closed'))}, 'yes'); }
    };
  `);
  write('packages/smithy/node_modules/node-pty/index.js', 'module.exports = {};');
  const logs = [];
  return { cwd, write, logs, options: { cwd, env: checkEnvironment({ PATH: join(cwd, 'bin') }), log: line => logs.push(line) } };
}

test('preflight accepts the manifest runtime and loads package-local native modules in children', t => {
  const fixture = runtimeFixture(t);
  assert.equal(checkRuntime(fixture.options), 0);
  assert(existsSync(join(fixture.cwd, 'opened')));
  assert(existsSync(join(fixture.cwd, 'closed')));
  const output = fixture.logs.join('\n');
  for (const value of [process.version, process.versions.modules, process.execPath, 'pnpm=fixture-version', 'bun=fixture-version', 'node-pty loaded']) {
    assert(output.includes(value), value);
  }
});

function assertFailsBeforeSteps(fixture, options = fixture.options) {
  let called = false;
  assert.equal(runMergeGate(options, () => { called = true; return [child('must not run', 'process.exit(0)')]; }), 1);
  assert.equal(called, false, 'must not even discover gate steps');
  const output = fixture.logs.join('\n');
  assert.match(output, /PREFLIGHT FAILED; no gate steps ran/);
  assert(output.includes(join(fixture.cwd, 'apps/desktop/node_modules/node/bin/node')));
  assert.match(output, /export PATH='/);
  assert.match(output, /':"\$PATH"/);
  assert.match(output, /rerun pnpm check:merge/);
  return output;
}

test('a mismatched Node major fails before native probes or gate steps', t => {
  const fixture = runtimeFixture(t);
  fixture.write('apps/desktop/package.json', JSON.stringify({ devDependencies: { node: '999.0.0' } }));
  assert.match(assertFailsBeforeSteps(fixture), /does not match validated Node 999.x/);
  assert.equal(existsSync(join(fixture.cwd, 'opened')), false);
});

test('a runner and PATH Node ABI mismatch cannot run steps with a different runtime', t => {
  const fixture = runtimeFixture(t);
  const runtime = { version: process.version, versions: { ...process.versions, modules: 'different-ABI' }, execPath: process.execPath };
  assert.match(assertFailsBeforeSteps(fixture, { ...fixture.options, runtime }), /PATH Node.*differs from the validated runner/);
});

test('a deferred SQLite ABI load error fails before any gate step', t => {
  const fixture = runtimeFixture(t);
  fixture.write('packages/storage/node_modules/better-sqlite3/index.js', `
    module.exports = class { constructor() { throw new Error('ERR_DLOPEN_FAILED: NODE_MODULE_VERSION mismatch'); } };
  `);
  const output = assertFailsBeforeSteps(fixture);
  assert.match(output, /Cannot load better-sqlite3/);
  assert.match(output, /ERR_DLOPEN_FAILED: NODE_MODULE_VERSION mismatch/);
});

test('an unloadable PTY addon fails before any gate step', t => {
  const fixture = runtimeFixture(t);
  fixture.write('packages/smithy/node_modules/node-pty/index.js', "throw new Error('PTY addon unavailable');");
  assert.match(assertFailsBeforeSteps(fixture), /Cannot load node-pty[\s\S]*PTY addon unavailable/);
});

test('missing tools and invalid manifest pins fail closed', t => {
  const fixture = runtimeFixture(t);
  rmSync(join(fixture.cwd, 'bin/bun'));
  fixture.write('apps/desktop/package.json', '{"devDependencies":{"node":"^22.0.0"}}');
  const output = assertFailsBeforeSteps(fixture);
  assert.match(output, /Cannot read bun version/);
  assert.match(output, /must pin an exact version/);
});

test('a successful preflight proceeds to the requested checks and preserves their failure', t => {
  const fixture = runtimeFixture(t);
  assert.equal(runMergeGate(fixture.options, () => [child('intentional failure', 'process.exit(17)')]), 1);
  assert.match(fixture.logs.join('\n'), /FAILED exit=17: intentional failure/);
  const logDirectory = fixture.logs.find(line => line.includes('Full logs and results.json: ')).split('Full logs and results.json: ')[1];
  t.after(() => rmSync(logDirectory, { recursive: true, force: true }));
});

test('check:ci accepts no filtering or skip flags', () => {
  const script = fileURLToPath(new URL('./check-ci.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--skip', 'anything'], { encoding: 'utf8', env: checkEnvironment() });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: pnpm check:ci \(no filtering or skip flags\)/);
});

test('required contract suites run as isolated per-file Bun steps', () => {
  const checks = mergeChecks();
  assert(requiredBunTests.includes('packages/smithy/src/server/daemon-lifecycle.bun.test.ts'));
  for (const file of requiredBunTests) {
    const steps = checks.filter(check => check.name === file);
    assert.deepEqual(steps.map(step => [step.command, ...step.args]), [['bun', 'test', `./${file}`]]);
  }
});

test('a missing required contract suite fails the step list closed', () => {
  assert.throws(() => mergeChecks({ required: ['packages/smithy/src/server/missing-contract.bun.test.ts'] }),
    /Required gate tests not found: packages\/smithy\/src\/server\/missing-contract\.bun\.test\.ts/);
});
