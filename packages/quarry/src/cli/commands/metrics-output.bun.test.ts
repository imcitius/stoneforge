import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createStorage, initializeSchema } from '@stoneforge/storage';

const repository = resolve(import.meta.dir, '../../../../..');
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(STONEFORGE_|SF_)/.test(key) || key === 'ORCHESTRATOR_URL') delete env[key];
}
let workspace: string;
let database: string;

beforeAll(() => {
  execFileSync('pnpm', ['--filter', '@stoneforge/quarry...', 'build'], {
    cwd: repository, env, stdio: 'pipe', timeout: 120_000,
  });
  workspace = mkdtempSync(join(tmpdir(), 'sf-metrics-output-'));
  mkdirSync(join(workspace, '.stoneforge'));
  database = join(workspace, '.stoneforge/stoneforge.db');
  env.STONEFORGE_ROOT = workspace;
  const db = createStorage({ path: database });
  initializeSchema(db);
  // Preserve nonzero legacy counters, and distinguish observed zero from absent usage/pricing.
  const rows: [string, string | null, number, number | null, string?][] = [
    ['measured-zero', 'claude-sonnet-4', 0, 1],
    ['unavailable', 'claude-sonnet-4', 0, 0],
    ['legacy', 'claude-sonnet-4', 123, null],
    ['unpriced', 'model-without-price', 20, 1],
    ['partial', 'claude-sonnet-4', 1000, 1],
    ['partial', 'model-without-price', 2000, 1],
    ['partial', null, 0, 0],
    ['partial', 'claude-sonnet-4', 77, null],
    ['outside-range', 'claude-sonnet-4', 999999, 1, '2000-01-01T00:00:00.000Z'],
  ];
  rows.forEach(([provider, model, tokens, usage, timestamp], i) => db.run(
    `INSERT INTO provider_metrics
      (id, timestamp, provider, model, session_id, input_tokens, usage_available, duration_ms, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1000, 'completed')`,
    [`pm-${i}`, timestamp ?? new Date().toISOString(), provider, model, `s-${i}`, tokens, usage],
  ));
  db.close();
}, 120_000);

afterAll(() => { if (workspace) rmSync(workspace, { recursive: true, force: true }); });

function run(...args: string[]) {
  const result = spawnSync('node', [join(repository, 'packages/quarry/dist/bin/sf.js'),
    'metrics', '--db', database, ...args], { cwd: workspace, env, encoding: 'utf8', timeout: 15_000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return result.stdout;
}

for (const grouping of ['provider', 'model']) {
  test(`real CLI ${grouping}: measured zero stays zero`, () => {
    const output = run('--group-by', grouping, '--provider', 'measured-zero');
    expect(output).toMatch(/Total tokens:\s+0\n/);
    expect(output).toMatch(/Estimated cost:\s+\$0\.00\n/);
    expect(output).toContain('Usage observed: 1/1 metric records; legacy unknown: 0; priced: 1/1');
  });
  for (const [provider, status] of [['unavailable', 'unavailable'], ['legacy', 'unknown']]) {
    test(`real CLI ${grouping}: ${status} never renders as measured zero`, () => {
      const output = run('--group-by', grouping, '--provider', provider);
      expect(output).toMatch(new RegExp(`Total tokens:\\s+${status}\\n`));
      expect(output).toMatch(/Estimated cost:\s+unavailable\n/);
      expect(output).not.toContain('$0.00');
      const { data } = JSON.parse(run('--group-by', grouping, '--provider', provider, '--json'));
      expect(data.totals.totalTokens).toBe(provider === 'legacy' ? 123 : 0);
      expect(data.totals.usageStatus).toBe(status);
      expect(data.totals.estimatedCost.totalCost).toBe(0);
      expect(data.totals.estimatedCostStatus).toBe('unavailable');
    });
  }
  test(`real CLI ${grouping}: partial subtotal honors provider filter and historical numbers`, () => {
    const output = run('--group-by', grouping, '--provider', 'partial');
    expect(output).toMatch(/Total tokens:\s+3,077 \(partial; recorded subtotal\)/);
    expect(output).toContain('(partial; priced subtotal)');
    expect(output).toContain('Usage observed: 2/4 metric records; legacy unknown: 1; priced: 1/4');
    const { data } = JSON.parse(run('--group-by', grouping, '--provider', 'partial', '--json'));
    expect(data.totals.totalInputTokens).toBe(3077);
    expect(data.totals.totalOutputTokens).toBe(0);
    expect(data.totals.estimatedCost.totalCost).toBeCloseTo(0.003, 8);
    expect(data.totals.pricedSessionCount).toBe(1);
    expect(data.totals.legacySessionCount).toBe(1);
    expect(data.totals.usageStatus).toBe('partial');
    for (const metric of data.metrics) expect(typeof metric.totalTokens).toBe('number');
  });
}

test('observed usage without model pricing is not free; date filtering and empty coverage', () => {
  const output = run('--provider', 'unpriced');
  expect(output).toMatch(/Total tokens:\s+20\n/);
  expect(output).toMatch(/Estimated cost:\s+unavailable\n/);
  expect(output).not.toContain('$0.00');
  const { data } = JSON.parse(run('--json'));
  expect(data.totals.sessionCount).toBe(8);
  expect(data.metrics.some((m: { group: string }) => m.group === 'outside-range')).toBe(false);
  const empty = JSON.parse(run('--provider', 'missing', '--json')).data;
  expect(empty.totals).toMatchObject({ sessionCount: 0, totalTokens: 0,
    usageStatus: 'unavailable', estimatedCostStatus: 'unavailable', pricedSessionCount: 0 });
});
