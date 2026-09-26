import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Resolve a target without discarding either local or remote history. */
export async function resolveTarget(
  repositoryRoot: string,
  branch: string,
  fetch: 'required' | 'best-effort' | 'none' = 'best-effort',
): Promise<{ ref: string; commit: string; localCommit?: string; remoteCommit?: string }> {
  const git = async (...args: string[]) =>
    (await execFileAsync('git', args, { cwd: repositoryRoot, encoding: 'utf8', timeout: 60_000 })).stdout.trim();
  await git('check-ref-format', `refs/heads/${branch}`);
  if (fetch !== 'none') {
    try {
      await git('fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
    } catch (error) {
      if (fetch === 'required') throw error;
    }
  }
  const localRef = `refs/heads/${branch}`;
  const remoteRef = `refs/remotes/origin/${branch}`;
  const read = (ref: string) => git('rev-parse', '--verify', `${ref}^{commit}`).catch(() => undefined);
  const [localCommit, remoteCommit] = await Promise.all([read(localRef), read(remoteRef)]);
  const ancestor = async (a: string, b: string) => {
    try { await git('merge-base', '--is-ancestor', a, b); return true; }
    catch (error) {
      if ((error as { code?: number }).code === 1) return false;
      throw error;
    }
  };
  let ref: string;
  let commit: string;
  if (localCommit && (!remoteCommit || await ancestor(remoteCommit, localCommit))) {
    ref = localRef; commit = localCommit;
  } else if (remoteCommit && (!localCommit || await ancestor(localCommit, remoteCommit))) {
    ref = remoteRef; commit = remoteCommit;
  } else if (localCommit && remoteCommit) {
    throw new Error(`Target ${branch} has diverged: local ${localCommit}, origin ${remoteCommit}. Reconcile the target histories explicitly before retrying.`);
  } else {
    throw new Error(`Target branch ${branch} does not exist locally or on origin.`);
  }
  return { ref, commit, localCommit, remoteCommit };
}

/** Remote delivery must never publish unpublished target history as a side effect. */
export function requireRemoteTarget(target: Awaited<ReturnType<typeof resolveTarget>>, branch: string): void {
  if (target.localCommit && target.localCommit !== target.remoteCommit && target.commit === target.localCommit) {
    throw new Error(`Local target ${branch} is ahead of origin (or absent there). Refusing to publish local target commits. Use explicit local delivery (sf task merge --local), or reconcile the target separately.`);
  }
}
