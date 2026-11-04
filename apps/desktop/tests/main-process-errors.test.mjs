import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAIN_ERROR_EXIT, trapMainProcessErrors } from '../scripts/main-process-errors.mjs';

const moduleURL = new URL('../scripts/main-process-errors.mjs', import.meta.url).href;

// A child Node process stands in for the Electron main process: `evaluate` runs the trap there,
// with `app.exit` as process.exit, and the child then throws outside any handler.
const child = (file) => spawnSync(process.execPath, ['--input-type=module', '-e', `
  const { trapMainProcessErrors } = await import(${JSON.stringify(moduleURL)});
  const electron = { evaluate: async (fn, arg) => fn({ app: { exit: (code) => process.exit(code) } }, arg) };
  await trapMainProcessErrors(electron, ${JSON.stringify(file)});
  setTimeout(() => { throw new TypeError('Object has been destroyed'); });
  setTimeout(() => { console.log('still running'); }, 2000);
`], { encoding: 'utf8', timeout: 20_000 });

test('an uncaught main-process exception is recorded and exits with a failure code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'main-errors-'));
  try {
    const file = join(dir, 'main-process-errors.jsonl');
    const result = child(file);
    assert.equal(result.status, MAIN_ERROR_EXIT);
    assert.doesNotMatch(result.stdout, /still running/);
    assert.match(result.stderr, /\[main-process uncaughtException\] .*TypeError: Object has been destroyed/);
    // The harness side reads the same file after the app exited.
    const trap = await trapMainProcessErrors({ evaluate: async () => {} }, file);
    const recorded = await trap.recorded();
    assert.equal(recorded.length, 1);
    assert.match(recorded[0], /^TypeError: Object has been destroyed\n\s+at /);
    await assert.rejects(trap.assertNone(), /Main process uncaught exception \(app exited with 70\):\nTypeError: Object has been destroyed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('no recorded exception passes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'main-errors-'));
  try {
    const trap = await trapMainProcessErrors({ evaluate: async () => {} }, join(dir, 'none.jsonl'));
    assert.deepEqual(await trap.recorded(), []);
    await trap.assertNone();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
