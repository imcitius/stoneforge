import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packages = ['core', 'storage', 'quarry', 'smithy'];

function bunTests(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? bunTests(path) : path.endsWith('.bun.test.ts') ? [path] : [];
  }).sort();
}

export function checkEnvironment(source = process.env) {
  const env = { ...source };
  // Fixtures must not inherit the worker's live project, actor or server routing.
  for (const key of Object.keys(env)) {
    if (/^(STONEFORGE_|SF_)/.test(key) || key === 'ORCHESTRATOR_URL') delete env[key];
  }
  env.RUN_INTEGRATION_TESTS = 'false'; // Real provider calls are a separate opt-in check.
  return env;
}

export function mergeChecks() {
  const checks = [
    { name: 'gate regression tests', command: 'node', args: ['--test', 'scripts/check-merge.test.mjs'] },
    { name: 'workspace typecheck (uncached)', command: 'pnpm', args: ['typecheck', '--force'] },
    { name: 'Desktop build', command: 'pnpm', args: ['--filter', '@stoneforge/desktop', 'build'] },
  ];
  for (const name of packages) {
    const files = bunTests(`packages/${name}/src`);
    if (!files.length) throw new Error(`No Bun tests found for ${name}`);
    // Bun module mocks can leak across files. Fresh processes keep fixtures isolated.
    for (const file of files) checks.push({ name: file, command: 'bun', args: ['test', `./${file}`] });
  }
  checks.push(
    { name: 'Smithy Node/Vitest', command: 'pnpm', args: ['--filter', '@stoneforge/smithy', 'test:node'] },
    { name: 'Desktop Node backend integration', command: 'pnpm', args: ['--filter', '@stoneforge/desktop', 'test'] },
  );
  return checks;
}

export function runChecks(checks, { cwd = root, env = checkEnvironment(), log = console.log, stdio = 'inherit', logDirectory } = {}) {
  const started = performance.now();
  const results = [];
  for (const check of checks) {
    log(`\n[check:merge] ${check.name}: ${[check.command, ...check.args].join(' ')}`);
    const start = performance.now();
    const logFile = logDirectory && join(logDirectory, `${String(results.length + 1).padStart(3, '0')}.log`);
    const fd = logFile ? openSync(logFile, 'w') : undefined;
    let result;
    try {
      result = spawnSync(check.command, check.args, { cwd, env, stdio: fd === undefined ? stdio : ['ignore', fd, fd] });
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    const code = result.status ?? 1;
    const seconds = ((performance.now() - start) / 1000).toFixed(2);
    log(`[check:merge] exit=${code} duration=${seconds}s${result.signal ? ` signal=${result.signal}` : ''}${result.error ? ` error=${result.error.message}` : ''}`);
    if (logFile) {
      log(`[check:merge] log=${logFile}`);
      if (code !== 0) log(readFileSync(logFile).subarray(-4000).toString());
    }
    results.push({ ...check, code, seconds, logFile });
  }
  const failures = results.filter(result => result.code !== 0);
  log(`\n[check:merge] ${results.length} checks, ${failures.length} failed, duration=${((performance.now() - started) / 1000).toFixed(2)}s`);
  for (const failure of failures) log(`[check:merge] FAILED exit=${failure.code}: ${failure.name}`);
  if (logDirectory) writeFileSync(join(logDirectory, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  return failures.length || !checks.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'darwin') throw new Error('check:merge includes macOS Desktop server-adoption tests; run on macOS.');
  if (process.argv.length !== 2) throw new Error('Usage: pnpm check:merge (no filtering or skip flags)');
  const logDirectory = mkdtempSync(join(tmpdir(), 'stoneforge-merge-check-'));
  console.log(`[check:merge] Full logs and results.json: ${logDirectory}`);
  process.exitCode = runChecks(mergeChecks(), { logDirectory });
}
