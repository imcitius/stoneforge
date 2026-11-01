/**
 * Repository delivery mode.
 *
 * `remote` (default) publishes task branches and merge results to `origin`.
 * `local` keeps task branches and merges on this machine: task completion,
 * merge, cleanup and sync never push to or delete refs on any remote. It is
 * configured per repository in `.stoneforge/repositories.json`
 * (`"delivery": "local"`), e.g. for a public fork whose task branches must not
 * be published. Fetching remains allowed; it never publishes anything.
 *
 * This module deliberately reads the manifest directly (no ProjectRepositories
 * import) so low-level Git helpers can depend on it without import cycles.
 *
 * @module
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type RepositoryDelivery = 'remote' | 'local';

export const REPOSITORY_DELIVERY_MODES: readonly RepositoryDelivery[] = ['remote', 'local'];

export function isRepositoryDelivery(value: unknown): value is RepositoryDelivery {
  return value === 'remote' || value === 'local';
}

/** Candidate project roots: explicit hint, STONEFORGE_ROOT, then every ancestor. */
function candidateRoots(directory: string, projectRoot?: string): string[] {
  const roots: string[] = [];
  const push = (value: string | undefined) => {
    if (!value) return;
    const resolved = path.resolve(value);
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  push(projectRoot);
  push(process.env.STONEFORGE_ROOT);
  let current = path.resolve(directory);
  for (;;) {
    push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

function realpathOrSelf(value: string): string {
  try { return realpathSync(value); } catch { return value; }
}

/**
 * Delivery mode configured for the registered repository that owns
 * `directory` (a checkout or any linked worktree). Unregistered directories,
 * non-Git directories and unreadable registries use the default `remote`.
 */
export async function deliveryForDirectory(directory: string, projectRoot?: string): Promise<RepositoryDelivery> {
  let identity: string;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: directory, encoding: 'utf8', timeout: 10_000,
    });
    identity = realpathOrSelf(stdout.trim());
  } catch {
    // A project data root need not be a Git checkout: it is local-only when
    // every repository it registers is configured for local delivery.
    return projectDelivery(directory);
  }
  for (const root of candidateRoots(realpathOrSelf(directory), projectRoot)) {
    const manifest = path.join(root, '.stoneforge', 'repositories.json');
    if (!existsSync(manifest)) continue;
    try {
      const data = JSON.parse(readFileSync(manifest, 'utf8')) as { repositories?: Array<{ gitCommonDir?: unknown; delivery?: unknown }> };
      const repo = data.repositories?.find(r => typeof r?.gitCommonDir === 'string' && realpathOrSelf(r.gitCommonDir) === identity);
      if (repo) return repo.delivery === 'local' ? 'local' : 'remote';
    } catch {
      // Unreadable registry: keep searching, then fall back to the default.
    }
  }
  return 'remote';
}

function projectDelivery(projectRoot: string): RepositoryDelivery {
  try {
    const manifest = path.join(projectRoot, '.stoneforge', 'repositories.json');
    const data = JSON.parse(readFileSync(manifest, 'utf8')) as { repositories?: Array<{ delivery?: unknown }> };
    const repos = data.repositories ?? [];
    return repos.length > 0 && repos.every(r => r?.delivery === 'local') ? 'local' : 'remote';
  } catch {
    return 'remote';
  }
}

/** True when `directory` belongs to a repository configured for local-only delivery. */
export async function isLocalDelivery(directory: string, projectRoot?: string): Promise<boolean> {
  return (await deliveryForDirectory(directory, projectRoot)) === 'local';
}

/**
 * Whether delivery may use `origin` for `directory`: an origin remote exists
 * and the repository is not configured for local-only delivery. Pass a known
 * `delivery` to skip the registry lookup.
 */
export async function hasDeliveryRemote(directory: string, delivery?: RepositoryDelivery): Promise<boolean> {
  if ((delivery ?? await deliveryForDirectory(directory)) === 'local') return false;
  try {
    await execFileAsync('git', ['remote', 'get-url', '--', 'origin'], { cwd: directory, encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}
