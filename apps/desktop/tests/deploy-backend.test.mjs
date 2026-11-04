// el-6d52r2: package:mac's backend `pnpm deploy` must not create anything outside
// the checkout. pnpm 8.15.5 writes its root modules manifest at
// <root>/<relative(project, deployDir/node_modules)>, two levels above the
// checkout for packages/smithy -> apps/desktop/dist/stage/resources/backend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixtureEnv } from './fixture-env.mjs';
import { DEPLOY_SCRATCH, deployBackend, deployPlan, isInside, pnpmRootModulesDir } from '../scripts/deploy-backend.mjs';

const STAGE = 'apps/desktop/dist/stage/resources/backend';

test('models the pnpm root-modules path: old target escapes the checkout, staging stays inside', () => {
  const root = '/work/.worktrees/core/wt';
  const project = join(root, 'packages/smithy');
  assert.equal(pnpmRootModulesDir(root, project, join(root, STAGE)), `/work/.worktrees/${STAGE}/node_modules`);
  assert.equal(isInside(root, pnpmRootModulesDir(root, project, join(root, STAGE))), false);
  const staging = join(project, 'node_modules', DEPLOY_SCRATCH);
  assert.equal(pnpmRootModulesDir(root, project, staging), join(root, 'node_modules', DEPLOY_SCRATCH, 'node_modules'));
  assert.equal(isInside(root, pnpmRootModulesDir(root, project, staging)), true);
  assert.equal(isInside(root, root), false);
  assert.equal(isInside(root, `${root}-sibling/x`), false);
  assert.throws(() => deployPlan({ root: tmpdir(), project: 'p', target: 'relative/backend' }), /must be absolute/);
});

// Environment for nested pnpm: drop agent-session and outer pnpm/npm run config.
const pnpmEnv = () => {
  const env = fixtureEnv();
  for (const key of Object.keys(env)) if (/^(npm_|pnpm_)/i.test(key)) delete env[key];
  return env;
};

function listTree(dir, skip) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (path === skip) continue;
      out.push(relative(dir, path));
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(dir);
  return out.sort();
}

// <base>/outer/inner/checkout, realpath-spelled like pnpm's own workspace dir
// (macOS tmpdir is /var -> /private/var; a symlinked spelling hides the bug).
function fixtureWorkspace() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sf-deploy-')));
  const checkout = join(base, 'outer/inner/checkout');
  const write = (path, value) => {
    mkdirSync(join(checkout, path, '..'), { recursive: true });
    writeFileSync(join(checkout, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  };
  write('package.json', { name: 'fixture-root', private: true, packageManager: 'pnpm@8.15.5' });
  write('pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n  - "apps/*"\n');
  write('packages/lib/package.json', { name: '@fixture/lib', version: '1.0.0', main: 'index.js' });
  write('packages/lib/index.js', 'module.exports = "lib-ok";\n');
  write('packages/smithy/package.json', { name: '@fixture/smithy', version: '1.0.0', main: 'dist/index.js', files: ['dist'], dependencies: { '@fixture/lib': 'workspace:*' } });
  write('packages/smithy/dist/index.js', 'module.exports = require("@fixture/lib");\n');
  write('apps/desktop/package.json', { name: '@fixture/desktop', version: '1.0.0', private: true });
  const env = pnpmEnv();
  execFileSync('pnpm', ['install', '--offline'], { cwd: checkout, env, stdio: 'pipe' });
  const version = execFileSync('pnpm', ['--version'], { cwd: checkout, env, encoding: 'utf8' }).trim();
  return { base, checkout, env, version };
}

test('deployBackend from a nested checkout creates nothing outside it', { timeout: 120_000 }, async (t) => {
  const { base, checkout, env, version } = fixtureWorkspace();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const outsideBefore = listTree(base, checkout);
  const target = join(checkout, STAGE);

  const plan = await deployBackend({ root: checkout, project: 'packages/smithy', filter: '@fixture/smithy', target, env, stdio: 'pipe' });

  assert.deepEqual(listTree(base, checkout), outsideBefore, `pnpm ${version} wrote outside the checkout`);
  assert.equal(plan.target, target);
  assert.ok(existsSync(join(target, 'dist/index.js')), 'deployed package files');
  assert.equal(execFileSync(process.execPath, ['-p', 'require("./dist/index.js")'], { cwd: target, encoding: 'utf8' }).trim(), 'lib-ok');
  assert.equal(existsSync(join(checkout, 'packages/smithy/node_modules', DEPLOY_SCRATCH)), false, 'staging removed');
  assert.equal(existsSync(join(checkout, 'node_modules', DEPLOY_SCRATCH)), false, 'pnpm root scratch removed');

  // Repackaging over an existing stage replaces it and still stays inside.
  writeFileSync(join(target, 'stale.txt'), 'old');
  await deployBackend({ root: checkout, project: 'packages/smithy', filter: '@fixture/smithy', target, env, stdio: 'pipe' });
  assert.equal(existsSync(join(target, 'stale.txt')), false);
  assert.ok(existsSync(join(target, 'dist/index.js')));
  assert.deepEqual(listTree(base, checkout), outsideBefore);
});

test('negative control: plain pnpm deploy to the stage path writes above the checkout', { timeout: 120_000 }, (t) => {
  const { base, checkout, env, version } = fixtureWorkspace();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  if (version !== '8.15.5') return t.skip(`control models pnpm 8.15.5, found ${version}`);
  const outsideBefore = listTree(base, checkout);

  execFileSync('pnpm', ['--filter', '@fixture/smithy', 'deploy', '--prod', join(checkout, STAGE)], { cwd: checkout, env, stdio: 'pipe' });

  const stray = join(base, 'outer', STAGE, 'node_modules/.modules.yaml');
  assert.ok(existsSync(stray), 'old command must reproduce the stray manifest');
  assert.notDeepEqual(listTree(base, checkout), outsideBefore);
  assert.equal(existsSync(join(checkout, STAGE, 'node_modules/.modules.yaml')), false, 'manifest missing from the real target');
});
