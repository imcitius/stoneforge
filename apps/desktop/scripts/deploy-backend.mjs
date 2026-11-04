// `pnpm deploy` for the packaged backend, without writes outside the checkout.
//
// pnpm 8.15.5 deploy installs with
//   modulesDir = path.relative(<deployed project dir>, <deploy dir>/node_modules)
// That relative path is correct for the deployed project's own node_modules, but
// pnpm also joins it onto the workspace root (lockfileDir) to read and write the
// root `node_modules/.modules.yaml`. For packages/smithy (two levels below the
// root) and a deploy dir elsewhere in the checkout, the result lies two levels
// ABOVE the checkout: <checkout>/../../apps/desktop/dist/stage/resources/backend/
// node_modules/.modules.yaml. Managed worktrees left a stray tree beside them;
// clones directly under /tmp failed with EACCES on /private/apps.
// (It stays hidden when the deploy path is spelled through a symlink such as
// /tmp -> /private/tmp: path.relative then climbs to / and the join is absolute.)
//
// The only deploy dirs whose relative path has no `..` lie inside the deployed
// project. We therefore deploy into <project>/node_modules/.stoneforge-deploy
// (npm-packlist never copies node_modules, and pnpm does not manage that name),
// which makes pnpm's root manifest land in <root>/node_modules/.stoneforge-deploy,
// then rename the result to the requested target and remove both scratch dirs.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const DEPLOY_SCRATCH = '.stoneforge-deploy';

export const isInside = (parent, child) => {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
};

// Where pnpm 8.15.5 deploy reads/writes the root modules manifest directory.
export function pnpmRootModulesDir(root, projectDir, deployDir) {
  return join(root, relative(projectDir, join(deployDir, 'node_modules')));
}

export function deployPlan({ root, project, target }) {
  if (!isAbsolute(target)) throw new Error(`Deploy target must be absolute: ${target}`);
  // pnpm resolves the workspace through realpath; compute with the same spelling.
  const realRoot = realpathSync(root);
  const projectDir = join(realRoot, project);
  const staging = join(projectDir, 'node_modules', DEPLOY_SCRATCH);
  const rootModulesDir = pnpmRootModulesDir(realRoot, projectDir, staging);
  const rootScratch = join(realRoot, 'node_modules', DEPLOY_SCRATCH);
  for (const [label, path] of [['project', projectDir], ['staging', staging], ['pnpm root modules', rootModulesDir]]) {
    if (!isInside(realRoot, path)) throw new Error(`Deploy ${label} path ${path} is outside the checkout ${realRoot}`);
  }
  if (!isInside(rootScratch, rootModulesDir)) {
    throw new Error(`Unexpected pnpm root modules path ${rootModulesDir}; expected it under ${rootScratch}`);
  }
  return { root: realRoot, projectDir, staging, rootModulesDir, rootScratch, target: resolve(target) };
}

export async function deployBackend({ root, project, filter, target, pnpm = 'pnpm', env = process.env, stdio = 'inherit' }) {
  const plan = deployPlan({ root, project, target });
  const cleanup = async () => {
    await rm(plan.staging, { recursive: true, force: true });
    await rm(plan.rootScratch, { recursive: true, force: true });
  };
  await cleanup();
  try {
    execFileSync(pnpm, ['--filter', filter, 'deploy', '--prod', plan.staging], { cwd: plan.root, env, stdio });
    await rm(plan.target, { recursive: true, force: true });
    await mkdir(dirname(plan.target), { recursive: true });
    await rename(plan.staging, plan.target);
  } finally {
    await cleanup();
  }
  return plan;
}
