/**
 * Opt-in live orchestration check; uses CLI authentication and model quota.
 * bun scripts/check-agent-orchestration.ts codex|claude-code
 * The argument selects the worker; the other provider directs and reviews.
 * All Git operations use a temporary repository and a LOCAL bare origin.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asEntityId, createEntity, EntityTypeValue, type Task } from '../packages/core/src/index.js';
import { getOrchestratorTaskMeta } from '../packages/smithy/src/types/task-meta.js';
import type { Services } from '../packages/smithy/src/server/services.js';
import type { SpawnedSessionEvent } from '../packages/smithy/src/runtime/spawner.js';
import { serverManager } from '../packages/smithy/src/providers/codex/server-manager.js';

const workerProvider = process.argv[2];
if (workerProvider !== 'codex' && workerProvider !== 'claude-code') {
  throw new Error('Usage: bun scripts/check-agent-orchestration.ts codex|claude-code');
}
const reviewerProvider = workerProvider === 'codex' ? 'claude-code' : 'codex';
const cli = fileURLToPath(new URL('../packages/smithy/src/bin/sf.ts', import.meta.url));
const originalDirectory = process.cwd();
const originalPath = process.env.PATH;
const npmPath = Bun.which('npm');
assert(npmPath, 'npm must be installed');
const workspace = await mkdtemp(join(tmpdir(), `stoneforge-orchestration-${workerProvider}-`));
const auditPath = join(workspace, '.stoneforge/cli-audit.jsonl');
const eventsPath = join(workspace, '.stoneforge/session-events.jsonl');
let services: Services | undefined;
let passed = false;
const failures: string[] = [];
const observedSessions = new Set<string>();
const deadline = Date.now() + 6 * 60_000;

function run(command: string, args: string[], cwd = workspace): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function git(...args: string[]): string { return run('git', args); }
function log(message: string): void { console.log(`[live ${workerProvider}] ${message}`); }
async function waitUntil(predicate: () => Promise<boolean>, label: string): Promise<void> {
  while (Date.now() < deadline) {
    if (failures.length) throw new Error(failures.join('\n'));
    if (await predicate()) return;
    await Bun.sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function observeSessions(): void {
  for (const session of services!.sessionManager.listSessions()) {
    if (observedSessions.has(session.id)) continue;
    observedSessions.add(session.id);
    log(`session ${session.agentRole} ${session.agentId} ${session.id}`);
    services!.sessionManager.getEventEmitter(session.id)?.on('event', (event: SpawnedSessionEvent) => {
      appendFileSync(eventsPath, JSON.stringify({ sessionId: session.id, agentId: session.agentId, event }) + '\n');
      if (event.type === 'error' || (event.type === 'result' && event.subtype && event.subtype !== 'success')) {
        failures.push(`${session.agentId}: ${JSON.stringify(event)}`);
      }
    });
  }
}

try {
  await mkdir(join(workspace, '.stoneforge'), { recursive: true });
  await mkdir(join(workspace, '.test-bin'));
  await writeFile(join(workspace, '.stoneforge/config.yaml'),
    'name: live-orchestration\nbase_branch: main\nmerge:\n  require_approval: false\nagents:\n  permission_model: unrestricted\nsync:\n  auto_export: false\n');
  // Audit the actual CLI calls from agents, without replacing task operations.
  // A private executable avoids depending on a globally installed sf version.
  const runner = join(workspace, '.test-bin/runner.ts');
  await writeFile(runner, `import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const [tool, ...args] = process.argv.slice(2);
const cwd = process.cwd();
const result = tool === 'sf'
  ? spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(cli)}, ...args], { stdio: 'inherit', env: process.env })
  : spawnSync(${JSON.stringify(npmPath)}, args, { stdio: 'inherit', env: process.env });
appendFileSync(${JSON.stringify(auditPath)}, JSON.stringify({ tool, actor: process.env.SF_ENTITY_ID, cwd, args, exitCode: result.status }) + '\\n');
process.exit(result.status ?? 1);
`);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  for (const tool of ['sf', 'npm']) {
    await writeFile(join(workspace, '.test-bin', tool), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(runner)} ${tool} "$@"\n`, { mode: 0o755 });
  }
  process.env.PATH = `${join(workspace, '.test-bin')}${delimiter}${originalPath ?? ''}`;
  process.chdir(workspace);
  await writeFile(join(workspace, '.gitignore'), '.stoneforge/\n.test-bin/\n.test-origin.git/\n.a5c/\nnode_modules/\npnpm-lock.yaml\n');
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'stoneforge-live-fixture', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  await writeFile(join(workspace, 'math.js'), 'export function add(a, b) { return a - b; }\n');
  const tests = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add } from './math.js';
test('adds positive numbers', () => assert.equal(add(2, 3), 5));
test('adds negative numbers', () => assert.equal(add(-2, -3), -5));
test('adds zero', () => assert.equal(add(7, 0), 7));
`;
  await writeFile(join(workspace, 'math.test.js'), tests);
  const guidance = `This is an isolated Stoneforge integration fixture. Work only in this project.
Only a local bare Git origin is configured. Do not use GitHub, other remote services, or external messaging.
For EVERY sf command use this exact executable: ${join(workspace, '.test-bin/sf')}
For EVERY npm command use this exact executable: ${join(workspace, '.test-bin/npm')}
Always use these absolute paths, because login shells can reset PATH to an older global installation.
Use your inherited SF_ENTITY_ID identity. Do not pass --actor or set SF_ENTITY_ID.
Never edit .stoneforge database or status metadata directly.
The acceptance tests in math.test.js are immutable. Fix implementation only. Run npm test using the absolute executable above.
Worker: commit the fix on your assigned branch, then sf task complete TASK_ID.
Merge steward: inspect the diff, run npm test yourself, then sf task merge TASK_ID and stop.
The main checkout and CLI infrastructure are managed by the test runner; do not change them.
This fixture has no workspace documentation library to update.
`;
  await writeFile(join(workspace, 'AGENTS.md'), guidance);
  await writeFile(join(workspace, 'CLAUDE.md'), guidance);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Stoneforge Integration Test');
  git('config', 'user.email', 'integration@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('add', '.');
  git('commit', '-m', 'test: add failing arithmetic fixture');
  git('init', '--bare', '.test-origin.git');
  git('remote', 'add', 'origin', join(workspace, '.test-origin.git'));
  git('push', '-u', 'origin', 'main');
  git('remote', 'set-head', 'origin', 'main');
  const initialCommit = git('rev-parse', 'HEAD');
  assert.throws(() => run('npm', ['test']), 'Fixture must fail before the worker fixes it');
  log(`workspace ${workspace}; baseline tests fail as expected`);

  const { initializeServices } = await import('../packages/smithy/src/server/services.js');
  services = await initializeServices({ projectRoot: workspace, dbPath: join(workspace, '.stoneforge/stoneforge.db') });
  const entity = await createEntity({ name: 'test-operator', entityType: EntityTypeValue.SYSTEM, createdBy: asEntityId('system:test') });
  const operator = await services.api.create({ ...entity });
  const createdBy = asEntityId(operator.id);
  const director = await services.agentRegistry.registerDirector({ name: 'live-director', createdBy, provider: reviewerProvider });
  const worker = await services.agentRegistry.registerWorker({ name: 'live-worker', createdBy, provider: workerProvider, workerMode: 'ephemeral', reportsTo: asEntityId(director.id) });
  const steward = await services.agentRegistry.registerSteward({ name: 'live-steward', createdBy, provider: reviewerProvider, stewardFocus: 'merge', triggers: [] });
  assert(services.dispatchDaemon, 'Production dispatch daemon must be initialized');
  services.dispatchDaemon.updateConfig({ pollIntervalMs: 1000, inboxPollEnabled: false, stewardTriggerPollEnabled: false,
    orphanRecoveryEnabled: false, stuckMergeRecoveryEnabled: false, maxSessionDurationMs: 240_000 });

  const { session, events } = await services.sessionManager.startSession(asEntityId(director.id), {
    workingDirectory: workspace, interactive: false,
    initialPrompt: `Act as the Director in this isolated test project. Read AGENTS.md. Create exactly ONE task using ${join(workspace, '.test-bin/sf')} task create (use --help if needed).
Title: Fix arithmetic addition. Description must ask the worker to fix add(a,b) in math.js so all immutable tests in math.test.js pass, run npm test, commit the fix and finish using sf task complete.
Use your inherited SF_ENTITY_ID identity; do not pass --actor or change environment variables. Do not implement the fix, assign the task, start other agents, or alter its status. The daemon will do the dispatch. After creating the task report its ID and stop.`,
  });
  let directorFinished = false;
  events.on('event', (event: SpawnedSessionEvent) => {
    if (event.type === 'result') directorFinished = true;
  });
  observeSessions();
  await waitUntil(async () => directorFinished, 'Director to create a task');
  await services.sessionManager.stopSession(session.id);
  const tasks = await services.api.list<Task>({ type: 'task' });
  assert.equal(tasks.length, 1, 'Director must create exactly one task');
  assert.equal(tasks[0].createdBy, director.id, 'Director CLI must preserve its agent identity');
  const taskId = tasks[0].id;
  log(`Director created ${taskId}; starting production dispatch`);
  await services.dispatchDaemon.start();
  let lastState = '';
  await waitUntil(async () => {
    observeSessions();
    const task = (await services!.api.get<Task>(taskId))!;
    const meta = getOrchestratorTaskMeta(task.metadata);
    const state = `${task.status}/${meta?.mergeStatus ?? '-'}/${task.assignee ?? '-'}`;
    if (state !== lastState) { log(`task ${state}`); lastState = state; }
    return task.status === 'closed' && meta?.mergeStatus === 'merged';
  }, 'Worker completion and Steward merge');
  await services.dispatchDaemon.stop();
  const finalTask = (await services.api.get<Task>(taskId))!;
  const finalMeta = getOrchestratorTaskMeta(finalTask.metadata)!;
  const mergedCommit = git('rev-parse', 'refs/remotes/origin/main');
  assert.notEqual(mergedCommit, initialCommit, 'Origin must receive a new commit');
  assert.equal(finalMeta.mergeCommitHash, mergedCommit);
  assert.equal(git('rev-parse', 'main'), mergedCommit, 'Main checkout must be synchronized');
  assert.equal(await readFile(join(workspace, 'math.test.js'), 'utf8'), tests, 'Agents must not weaken acceptance tests');
  assert.deepEqual(git('diff', '--name-only', initialCommit, mergedCommit).split('\n'), ['math.js']);
  run('npm', ['test']);
  await waitUntil(async () => {
    observeSessions();
    return services!.sessionManager.listSessions().every(s => s.status === 'terminated');
  }, 'all agent sessions to finish');
  const audit = (await readFile(auditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  for (const [verb, agent] of [['create', director], ['complete', worker], ['merge', steward]] as const) {
    assert(audit.some(call => call.tool === 'sf' && call.actor === agent.id && call.exitCode === 0 && call.args[0] === 'task' && call.args[1] === verb), `${verb} must succeed under the correct agent identity`);
  }
  for (const agent of [worker, steward]) {
    assert(audit.some(call => call.tool === 'npm' && call.actor === agent.id && call.args[0] === 'test' && call.exitCode === 0), `${agent.name} must run passing tests`);
  }
  if (finalMeta.worktree) assert(!existsSync(resolve(workspace, finalMeta.worktree)), 'Merged worktree must be removed');
  log(JSON.stringify({ director: reviewerProvider, worker: workerProvider, steward: reviewerProvider,
    taskId, mergedCommit, tests: 'passed', identities: 'passed', lifecycle: 'passed' }));
  passed = true;
} finally {
  await services?.dispatchDaemon?.stop();
  await services?.stewardScheduler.stop();
  services?.autoExportService.stop();
  for (const session of services?.sessionManager.listSessions() ?? []) {
    if (session.status !== 'terminated') await services!.sessionManager.stopSession(session.id, { graceful: false }).catch(() => {});
  }
  serverManager.shutdown();
  services?.storageBackend.close();
  process.chdir(originalDirectory);
  if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  if (passed && !process.env.SF_KEEP_TEST_WORKSPACE) await rm(workspace, { recursive: true, force: true });
  else console.log(`Diagnostics retained at ${workspace}`);
}
