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

export function checkRuntime({ cwd = root, env = checkEnvironment(), log = console.log, runtime = process } = {}) {
  const pinnedBin = join(cwd, 'apps/desktop/node_modules/node/bin');
  const failures = [];
  const probe = (command, args) => spawnSync(command, args, {
    cwd, env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
  });
  const failed = result => result.status !== 0 || result.error || result.signal;
  const detail = result => [result.error?.message, result.signal, result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join('\n');
  log(`[check:merge] preflight: node -v=${runtime.version} process.versions.modules=${runtime.versions.modules} execPath=${runtime.execPath}`);
  for (const tool of ['pnpm', 'bun']) {
    const result = probe(tool, ['--version']);
    log(`[check:merge] preflight: ${tool}=${failed(result) ? detail(result) || 'unavailable' : result.stdout.trim()}`);
    if (failed(result)) failures.push(`Cannot read ${tool} version.`);
  }
  try {
    const pinnedVersion = JSON.parse(readFileSync(join(cwd, 'apps/desktop/package.json'), 'utf8')).devDependencies.node;
    if (!/^\d+\.\d+\.\d+$/.test(pinnedVersion)) throw new Error('Desktop devDependencies.node must pin an exact version.');
    const major = pinnedVersion.split('.')[0];
    log(`[check:merge] preflight: validated Node ${major}.x (Desktop pin ${pinnedVersion})`);
    if (runtime.versions.node.split('.')[0] !== major) {
      failures.push(`Active Node ${runtime.version} (ABI ${runtime.versions.modules}) does not match validated Node ${major}.x.`);
    }
    // Steps and their nested CLI fixtures resolve node from PATH, not execPath.
    const pathNode = probe('node', ['-p', 'JSON.stringify({ version: process.version, abi: process.versions.modules, execPath: process.execPath })']);
    if (failed(pathNode)) throw new Error(`Cannot execute node from PATH: ${detail(pathNode)}`);
    const active = JSON.parse(pathNode.stdout);
    log(`[check:merge] preflight: PATH node=${active.version} ABI=${active.abi} execPath=${active.execPath}`);
    if (active.version.split('.')[0] !== `v${major}` || active.abi !== runtime.versions.modules) {
      failures.push(`PATH Node ${active.version} (ABI ${active.abi}) differs from the validated runner runtime; select Node for the entire command via PATH.`);
    }
  } catch (error) {
    failures.push(error.message);
  }
  // Reject a wrong runtime before loading addons. Never rebuild or switch Node here.
  if (!failures.length) {
    const modules = [
      ['better-sqlite3', 'packages/storage', "const Database = packageRequire('better-sqlite3'); const db = new Database(':memory:'); db.close();"],
      ['node-pty', 'packages/smithy', "packageRequire('node-pty');"],
    ];
    for (const [name, directory, code] of modules) {
      // Resolve through the owning package, including pnpm's package-local links.
      const manifest = join(cwd, directory, 'package.json');
      const result = probe(runtime.execPath, ['--input-type=commonjs', '-e',
        `const packageRequire = require('node:module').createRequire(${JSON.stringify(manifest)}); ${code}`]);
      if (failed(result)) {
        failures.push(`Cannot load ${name} under Node ${runtime.version} (ABI ${runtime.versions.modules}):\n${detail(result)}`);
        break;
      }
      log(`[check:merge] preflight: ${name} loaded`);
    }
  }
  if (!failures.length) return 0;
  log(`[check:merge] PREFLIGHT FAILED; no gate steps ran.\n${failures.join('\n')}`);
  log(`[check:merge] Pinned runtime: ${join(pinnedBin, 'node')}`);
  // Shell-quote the absolute path so the diagnostic also works in spaced worktrees.
  log(`[check:merge] Select it, then rerun pnpm check:merge:\nexport PATH='${pinnedBin.replaceAll("'", "'\\''")}':"$PATH"`);
  log('[check:merge] If the pinned runtime is missing, run pnpm install --frozen-lockfile. If native loading still fails under it, inspect the addon error and apps/desktop/README.md development setup. No automatic runtime switch or native rebuild was performed.');
  return 1;
}

// Contract suites that must remain gate steps. Discovery already adds every
// *.bun.test.ts; this list fails closed if one is moved, renamed or deleted.
export const requiredBunTests = [
  'packages/smithy/src/server/daemon-lifecycle.bun.test.ts',
];

export function mergeChecks({ required = requiredBunTests } = {}) {
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
  const missing = required.filter(file => !checks.some(check => check.name === file));
  if (missing.length) throw new Error(`Required gate tests not found: ${missing.join(', ')}`);
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

export function runMergeGate(options = {}, checks = mergeChecks) {
  if (checkRuntime(options) !== 0) return 1;
  const logDirectory = mkdtempSync(join(tmpdir(), 'stoneforge-merge-check-'));
  (options.log ?? console.log)(`[check:merge] Full logs and results.json: ${logDirectory}`);
  return runChecks(checks(), { ...options, logDirectory });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'darwin') throw new Error('check:merge includes macOS Desktop server-adoption tests; run on macOS.');
  if (process.argv.length !== 2) throw new Error('Usage: pnpm check:merge (no filtering or skip flags)');
  process.exitCode = runMergeGate();
}
