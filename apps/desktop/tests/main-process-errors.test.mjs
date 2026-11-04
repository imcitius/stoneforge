import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { openSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MAIN_ERROR_EXIT, mainProcessErrors, inspectMainProcess, trapMainProcessErrors } from '../scripts/main-process-errors.mjs';

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

test('rethrow reports the trapped exception instead of the step failure, and passes a step failure through otherwise', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'main-errors-'));
  try {
    const trap = mainProcessErrors(join(dir, 'main-process-errors.jsonl'));
    const step = new Error('Target page, context or browser has been closed\nCall log: ...');
    // Negative control: nothing recorded, so the step's own error is the failure.
    await assert.rejects(trap.rethrow(step), (error) => error === step);
    await writeFile(trap.file, JSON.stringify('TypeError: Object has been destroyed\n    at BrowserWindow.visibilityChanged') + '\n');
    await assert.rejects(trap.rethrow(step), /^Error: Main process uncaught exception \(app exited with 70\):\nTypeError: Object has been destroyed\n.*visibilityChanged\n\(the harness step then failed with: Target page, context or browser has been closed\)$/s);
    // A step that already failed with the trapped report (assertNone) is not reported twice.
    const report = await trap.assertNone().catch((error) => error);
    await assert.rejects(trap.rethrow(report), (error) => error === report && !/harness step/.test(error.message));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// LaunchServices path: the app is not a Playwright launch, so the trap goes in through the main
// process's Node inspector. A child Node with --inspect=0 stands in; it throws once a listener exists.
const inspected = (stderrFile) => {
  const child = spawn(process.execPath, ['--inspect=0', '-e', `
    const ready = setInterval(() => {
      if (!process.listenerCount('uncaughtException')) return;
      clearInterval(ready);
      setTimeout(() => { throw new TypeError('Object has been destroyed (inspector path)'); });
    }, 20);
    setTimeout(() => { console.log('still running'); process.exit(99); }, 20_000);
  `], { stdio: ['ignore', 'pipe', openSync(stderrFile, 'w')] });
  let stdout = ''; child.stdout.on('data', (data) => { stdout += data; });
  return { child, exited: new Promise((resolve) => child.once('exit', (code) => resolve({ code, stdout }))) };
};
const stubElectron = '({ app: { exit: (code) => process.exit(code) } })';

test('inspector path: the trap installed through --inspect records the exception and exits with a failure code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'main-errors-'));
  try {
    const stderrFile = join(dir, 'stderr.log');
    const { exited } = inspected(stderrFile);
    const trap = mainProcessErrors(join(dir, 'main-process-errors.jsonl'));
    const inspector = await inspectMainProcess(stderrFile, { electron: stubElectron });
    assert.equal(await inspector.evaluate((_electron, arg) => arg.n + 1, { n: 41 }), 42, 'evaluate passes its argument and returns the value');
    await trap.install(inspector);
    inspector.close();
    const { code, stdout } = await exited;
    assert.equal(code, MAIN_ERROR_EXIT);
    assert.doesNotMatch(stdout, /still running/);
    assert.match(await readFile(stderrFile, 'utf8'), /\[main-process uncaughtException\] .*TypeError: Object has been destroyed \(inspector path\)/);
    await assert.rejects(trap.assertNone(), /Main process uncaught exception \(app exited with 70\):\nTypeError: Object has been destroyed \(inspector path\)/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('inspector path: a missing inspector URL fails with the captured stderr instead of waiting forever', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'main-errors-'));
  try {
    const stderrFile = join(dir, 'stderr.log');
    await writeFile(stderrFile, 'bad option: --project=/tmp/x\n');
    await assert.rejects(inspectMainProcess(stderrFile, { timeout: 300 }), /No main-process inspector URL in .*stderr\.log after 300 ms:\nbad option: --project=\/tmp\/x/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Every check script that launches Electron installs the trap after each launch and reports it.
// Scripts that run only under the bundled (plain) Node have no Electron main process: an uncaught
// exception there exits non-zero by itself. Helpers run inside check-app's trapped launch.
const desktop = resolve(import.meta.dirname, '..');
const noElectron = new Map([
  ['check-safeguards.mjs', 'bundled Node only (production modules in-process)'],
  ['check-terminal-color.mjs', 'bundled Node only (provider PTYs)'],
  ['check-pty.mjs', 'bundled Node only (PTY spawn)'],
  ['check-logs.mjs', 'helper inside check-app (trapped launch)'],
  ['check-onboarding.mjs', 'helper inside check-app (trapped launch)'],
]);
function trapViolations(name, source) {
  const problems = [];
  const launches = [...source.matchAll(/_electron\.launch\(/g)].map((match) => match.index);
  const opens = [...source.matchAll(/execFileSync\('\/usr\/bin\/open'/g)].map((match) => match.index);
  if (!launches.length && !opens.length) return noElectron.has(name) ? [] : [`${name}: launches no Electron app; classify it in noElectron`];
  for (const index of launches) {
    // The statement that follows the launch must install the trap in that application.
    const end = source.indexOf(';', index);
    if (!/^\s*await mainErrors\.install\(electron\);/.test(source.slice(end + 1))) problems.push(`${name}: _electron.launch without an immediately following mainErrors.install(electron)`);
  }
  for (const index of opens) {
    const call = source.slice(index, source.indexOf(';', index));
    if (!call.includes("'--inspect=0'")) problems.push(`${name}: /usr/bin/open launch without --inspect=0 for the trap`);
  }
  if (opens.length && !/await mainErrors\.install\(inspector\)/.test(source)) problems.push(`${name}: no trap installed through inspectMainProcess()`);
  if (!/mainProcessErrors\(join\(temp, 'main-process-errors\.jsonl'\)\)/.test(source)) problems.push(`${name}: no main-process-errors.jsonl in its fixture directory`);
  if (!/catch \(error\) \{[^}]*await mainErrors\.rethrow\(error\);/.test(source)) problems.push(`${name}: failures are not reported through mainErrors.rethrow`);
  if (!/await mainErrors\.assertNone\(\);/.test(source)) problems.push(`${name}: a passing run does not assert that no exception was trapped`);
  return problems;
}

test('every check script that launches Electron traps main-process exceptions after each launch', async () => {
  const names = (await readdir(join(desktop, 'scripts'))).filter((name) => /^check-.*\.mjs$/.test(name));
  const launching = [];
  for (const name of names) {
    const source = await readFile(join(desktop, 'scripts', name), 'utf8');
    assert.deepEqual(trapViolations(name, source), []);
    if (!noElectron.has(name)) launching.push(name);
  }
  assert.deepEqual(launching.sort(), ['check-app.mjs', 'check-attention.mjs', 'check-clipboard.mjs',
    'check-getting-started.mjs', 'check-launch-services.mjs', 'check-tabs.mjs']);
  // Negative controls: the same scan rejects each trap element removed from a real check.
  const tabs = await readFile(join(desktop, 'scripts/check-tabs.mjs'), 'utf8');
  assert.match(trapViolations('check-tabs.mjs', tabs.replace('  await mainErrors.install(electron);\n', '')).join('\n'), /without an immediately following mainErrors\.install/);
  assert.match(trapViolations('check-tabs.mjs', tabs.replace('await mainErrors.rethrow(error);', '')).join('\n'), /not reported through mainErrors\.rethrow/);
  assert.match(trapViolations('check-tabs.mjs', tabs.replace('await mainErrors.assertNone();', '')).join('\n'), /does not assert/);
  const services = await readFile(join(desktop, 'scripts/check-launch-services.mjs'), 'utf8');
  assert.match(trapViolations('check-launch-services.mjs', services.replace("'--inspect=0', ", '')).join('\n'), /without --inspect=0/);
  assert.match(trapViolations('check-launch-services.mjs', services.replace('await mainErrors.install(inspector)', '')).join('\n'), /no trap installed through inspectMainProcess/);
  assert.match(trapViolations('check-new.mjs', 'const electron = await _electron.launch({});\n').join('\n'), /without an immediately following/);
  assert.match(trapViolations('check-plain.mjs', 'console.log(1);\n').join('\n'), /classify it in noElectron/);
});
