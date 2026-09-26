/** Run with the selected app's bundled Node. All production imports come from that app. */
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

assert(process.env.DESKTOP_APP, 'DESKTOP_APP must name the exact relocated app');
const resources = join(realpathSync(process.env.DESKTOP_APP), 'Contents/Resources');
assert.equal(realpathSync(process.execPath), realpathSync(join(resources, 'runtime/node')),
  'Use the bundled Node, not the developer runtime');
for (const key of Object.keys(process.env)) {
  if (/^(STONEFORGE_|SF_)/.test(key) || ['ORCHESTRATOR_URL', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete process.env[key];
}
const backend = join(resources, 'backend');
const require = createRequire(join(backend, 'package.json'));
const bundled = path => import(pathToFileURL(join(backend, 'dist', path)).href);
const pkg = name => import(pathToFileURL(require.resolve(name)).href);
const { createStorage, initializeSchema } = await pkg('@stoneforge/storage');
const { createQuarryAPI } = await pkg('@stoneforge/quarry');
const { createTask, createEntity } = await pkg('@stoneforge/core');
const { ProjectRepositories } = await bundled('git/project-repositories.js');
const { resolveTarget } = await bundled('git/target.js');
const { mergeBranch } = await bundled('git/merge.js');
const { verifyMergeStatus } = await bundled('cli/commands/task.js');
const { createAgentRoutes } = await bundled('server/routes/agents.js');
const { createAgentRegistry } = await bundled('services/agent-registry.js');
const { createTaskAssignmentService } = await bundled('services/task-assignment-service.js');
const { createMetricsRoutes } = await bundled('server/routes/metrics.js');
const { createMetricsService } = await bundled('services/metrics-service.js');
const { createCostService } = await bundled('services/cost-service.js');
const { SessionMetricsTracker } = await bundled('services/session-metrics.js');
const { CodexEventMapper } = await bundled('providers/codex/event-mapper.js');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const root = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-safeguards-')));
const cli = (cwd, ...args) => execFileSync(process.execPath, [join(backend, 'dist/bin/sf.js'), ...args], {
  cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, STONEFORGE_ROOT: cwd }, timeout: 30000,
});
let count = 0;
const pass = label => { count++; console.log(`PASS ${label}`); };
const stores = [];
function database(path = ':memory:') {
  const storage = createStorage({ path }); initializeSchema(storage); stores.push(storage); return storage;
}
function commit(repo, file) {
  writeFileSync(join(repo, file), file); git(repo, 'add', file); git(repo, 'commit', '-qm', file);
  return git(repo, 'rev-parse', 'HEAD');
}
function repository(name) {
  const repo = join(root, name), remote = join(root, name + '.git'); mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.com'); git(repo, 'config', 'commit.gpgsign', 'false');
  const initial = commit(repo, 'README');
  git(root, 'clone', '--bare', '--', repo, remote); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'fetch', 'origin');
  return { repo, remote, initial };
}
try {
  // Actual bundled worktree manager and CLI sync, not source modules under Bun.
  const { repo, remote, initial } = repository('ancestry');
  mkdirSync(join(root, '.stoneforge'));
  const api = createQuarryAPI(database(join(root, '.stoneforge/stoneforge.db')));
  const repositories = new ProjectRepositories(root, api);
  await repositories.add({ id: 'core', path: repo, targetBranch: 'main' });
  const local = commit(repo, 'DESKTOP');
  let task = await api.create(await createTask({ title: 'Bundled ancestry fixture', createdBy: 'user:test',
    metadata: { orchestrator: { repositoryId: 'core', targetBranch: 'main' } } }));
  const manager = await repositories.forTask(task);
  const worktree = await manager.createWorktree({ agentName: 'fixture', taskId: task.id, customBranch: 'feature/fixture', baseBranch: 'main' });
  assert.equal(git(worktree.path, 'rev-parse', 'HEAD'), local);
  const triage = await manager.createReadOnlyWorktree({ agentName: 'triage', purpose: 'fixture' });
  assert.equal(git(triage.path, 'rev-parse', 'HEAD'), local);
  pass('bundled creation and triage choose local descendant of origin');
  task = await api.update(task.id, { status: 'in_progress' });
  task = await api.update(task.id, { status: 'review', metadata: { ...task.metadata,
    orchestrator: { ...task.metadata.orchestrator, branch: worktree.branch, worktree: worktree.path, mergeStatus: 'pending' } } });
  const target = commit(repo, 'TARGET'), source = commit(worktree.path, 'TASK');
  cli(root, 'task', 'sync', task.id);
  git(worktree.path, 'merge-base', '--is-ancestor', target, 'HEAD');
  git(worktree.path, 'merge-base', '--is-ancestor', source, 'HEAD');
  pass('bundled CLI sync preserves source and incorporates local target');
  assert.throws(() => cli(root, 'task', 'merge', task.id), /Refusing to publish/);
  assert.equal((await api.get(task.id)).status, 'review');
  assert.equal(git(remote, 'rev-parse', 'main'), initial);
  pass('remote delivery refuses unpublished local target');
  writeFileSync(join(repo, 'README'), 'user work');
  assert.throws(() => cli(root, 'task', 'merge', task.id, '--local'), /Local delivery/);
  assert.equal((await api.get(task.id)).status, 'review'); assert(existsSync(worktree.path));
  assert.equal(git(repo, 'rev-parse', 'main'), target);
  pass('failed local delivery retains REVIEW, source worktree and target');

  for (const mergeStrategy of ['squash', 'merge']) {
    const { repo, remote, initial } = repository('argv-' + mergeStrategy);
    const marker = join(root, mergeStrategy + '-marker');
    const branch = `feature/$(touch\${IFS}${marker})`;
    const source = join(root, 'source-' + mergeStrategy);
    git(repo, 'worktree', 'add', '-b', branch, '--', source, 'main'); commit(source, 'TASK');
    const message = `  "quoted" 'single' \\ $HOME; & |\n$(touch '${marker}') \`touch '${marker}'\`  `;
    const result = await mergeBranch({ workspaceRoot: repo, sourceBranch: branch, targetBranch: 'main',
      localOnly: true, mergeStrategy, commitMessage: message });
    assert(result.success, result.error);
    const raw = execFileSync('git', ['cat-file', 'commit', result.commitHash], { cwd: repo, encoding: 'utf8' });
    assert.equal(raw.split('\n\n').slice(1).join('\n\n'), message + (mergeStrategy === 'squash' ? '\n' : ''));
    assert.equal(git(repo, 'rev-parse', 'main'), result.commitHash);
    assert.equal(git(remote, 'rev-parse', 'main'), initial); assert(!existsSync(marker));
    pass(`bundled ${mergeStrategy} literal argv and verified local delivery`);
  }

  const statusFixture = repository('status');
  const marker = join(root, 'status-marker'), branch = `feature/$(touch\${IFS}${marker})`;
  git(statusFixture.repo, 'branch', branch);
  const verify = params => verifyMergeStatus({ workspaceRoot: statusFixture.repo, branch,
    effectiveTarget: 'main', execFileAsync: promisify(execFile), ...params });
  assert.equal((await verify({})).status, 'ok');
  commit(statusFixture.repo, 'LOCAL'); git(statusFixture.repo, 'branch', '-f', branch, 'HEAD');
  assert.equal((await verify({ force: true })).status, 'error');
  assert.equal((await verify({ branch: 'deleted', mergeCommitHash: `${statusFixture.initial}; touch '${marker}'` })).status, 'error');
  assert(!existsSync(marker)); pass('bundled merge-status literal refs/hash and remote verification');
  await assert.rejects(resolveTarget(statusFixture.repo, 'main').then(async () => {
    const other = join(root, 'other'); git(root, 'clone', statusFixture.remote, other);
    git(other, 'config', 'user.name', 'Fixture'); git(other, 'config', 'user.email', 'fixture@example.com');
    commit(other, 'REMOTE'); git(other, 'push', 'origin', 'main'); return resolveTarget(statusFixture.repo, 'main');
  }), /diverged/); pass('bundled ancestry rejects divergent targets');

  for (const [metadata, limit] of [[{ maxConcurrentTasks: 1 }, 1], [{ maxConcurrentTasks: 4 }, 4], [{}, 1],
    [{ maxConcurrentTasks: 1, capabilities: { maxConcurrentTasks: 9 } }, 1], [{ capabilities: { maxConcurrentTasks: 9 } }, 1]]) {
    const api = createQuarryAPI(database());
    const agent = await api.create(await createEntity({ name: 'fixture-worker', entityType: 'agent', createdBy: 'user:test',
      metadata: { agent: { agentRole: 'worker', workerMode: 'ephemeral', ...metadata } } }));
    await api.create(await createTask({ title: 'Active fixture', createdBy: 'user:test', assignee: agent.id,
      status: 'in_progress', metadata: { orchestrator: { assignedAgent: agent.id, startedAt: agent.createdAt } } }));
    const routes = createAgentRoutes({ agentRegistry: createAgentRegistry(api), taskAssignmentService: createTaskAssignmentService(api) });
    const response = await routes.request(`/api/agents/${agent.id}/workload`); assert.equal(response.status, 200);
    const value = await response.json(); assert.equal(value.maxConcurrentTasks, limit);
    assert.equal(value.hasCapacity, limit > 1); assert.equal(value.workload.inProgressCount, 1);
    pass(`bundled workload/capacity ${JSON.stringify(metadata)}`);
  }

  const metricsStorage = database(), metricsService = createMetricsService(metricsStorage);
  const metrics = createMetricsRoutes({ metricsService, costService: createCostService(metricsStorage) });
  const record = (sessionId, tracker) => metricsService.upsert({ ...tracker.snapshot(), sessionId, durationMs: 100, outcome: 'completed' });
  const readMetric = async id => {
    const response = await metrics.request('/api/provider-metrics?sessionId=' + id); assert.equal(response.status, 200);
    return (await response.json()).metrics[0];
  };
  record('missing', new SessionMetricsTracker('codex', 'gpt-6-astra'));
  assert.equal((await readMetric('missing')).usageStatus, 'unavailable');
  const zero = new SessionMetricsTracker('claude-code', 'claude-sonnet-4');
  zero.observe({ type: 'result', raw: { usage: { input_tokens: 0, output_tokens: 0 } } }); record('zero', zero);
  assert.equal((await readMetric('zero')).usageStatus, 'available');
  pass('bundled metrics distinguishes missing usage and measured zero');
  const mapper = new CodexEventMapper(), tracker = new SessionMetricsTracker('codex', 'gpt-6-astra');
  const event = { method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: {
    total: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 60, cacheWriteInputTokens: 20,
      reasoningOutputTokens: 2, totalTokens: 110 }, last: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 60, totalTokens: 110 },
  } } };
  for (const update of [event, event]) for (const mapped of mapper.mapNotification(update, 'thread-1')) tracker.observe(mapped);
  record('codex', tracker); const metric = await readMetric('codex');
  assert.equal(metric.totalInputTokens, 20); assert.equal(metric.totalCacheReadTokens, 60);
  assert.equal(metric.totalCacheCreationTokens, 20); assert.equal(metric.totalOutputTokens, 10);
  assert.equal(metric.usageStatus, 'available'); assert.equal(metric.estimatedCostStatus, 'unavailable');
  assert.deepEqual(new CodexEventMapper(false).mapNotification(event, 'thread-1'), []);
  pass('bundled Codex deduplication, cache categories, unknown pricing and resume limitation');
  console.log(JSON.stringify({ checks: count, node: process.execPath, backend, fixture: root }));
} finally {
  for (const storage of stores) storage.close();
  rmSync(root, { recursive: true, force: true });
}
