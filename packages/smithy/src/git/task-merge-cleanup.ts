import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Clean up a merged task without discarding work. The caller must first fetch
 * and verify the remote target and record the successful merge in task state.
 * Failures are deliberately propagated: a merged task can need manual cleanup.
 */
export async function cleanupMergedTask(options: {
  workspaceRoot: string;
  sourceBranch: string;
  targetBranch: string;
  worktreePath?: string;
}): Promise<void> {
  const { workspaceRoot, sourceBranch, targetBranch, worktreePath } = options;
  const git = async (...args: string[]) =>
    (await execFileAsync('git', args, { cwd: workspaceRoot, encoding: 'utf8' })).stdout;
  const canonicalPath = (value: string) => {
    const absolute = path.resolve(workspaceRoot, value);
    return existsSync(absolute) ? realpathSync(absolute) : absolute;
  };
  const sourceRef = `refs/heads/${sourceBranch}`;
  const targetRef = `refs/remotes/origin/${targetBranch}`;

  await git('check-ref-format', sourceRef);
  await git('check-ref-format', `refs/heads/${targetBranch}`);
  if (sourceBranch === targetBranch) {
    throw new Error(`Refusing to clean up target branch ${sourceBranch}`);
  }

  const localRefs = await git('for-each-ref', '--format=%(refname)', sourceRef);
  const localExists = localRefs.split('\n').includes(sourceRef);
  const requireMerged = async (ref: string) => {
    try {
      await git('merge-base', '--is-ancestor', ref, targetRef);
    } catch (err) {
      throw new Error(
        `Retaining ${sourceBranch}: cannot verify ${ref} is fully merged into origin/${targetBranch}. ` +
        `Squash merges do not establish ancestry. ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };
  if (localExists) await requireMerged(sourceRef);

  // Inspect the actual remote tip too: a remote branch may have advanced since
  // the merge. An absent branch is a no-op, but a failed lookup is not.
  const remoteRefs = await git('ls-remote', '--heads', 'origin', sourceRef);
  const remoteTip = remoteRefs.split('\n')
    .map(line => line.split('\t'))
    .find(([, ref]) => ref === sourceRef)?.[0];
  if (remoteTip) await requireMerged(remoteTip);

  // -z avoids Git's quoting of paths containing spaces, tabs or newlines.
  const worktrees = (await git('worktree', 'list', '--porcelain', '-z'))
    .split('\0\0').filter(Boolean).map(record => {
      const fields = record.split('\0');
      return {
        path: fields.find(field => field.startsWith('worktree '))!.slice(9),
        branch: fields.find(field => field.startsWith('branch '))?.slice(7),
      };
    });
  const ownedPath = worktreePath ? canonicalPath(worktreePath) : undefined;
  const owned = worktrees.find(tree => canonicalPath(tree.path) === ownedPath);
  if (owned && (owned === worktrees[0] || owned.branch !== sourceRef)) {
    throw new Error(`Retaining worktree ${owned.path}: it is not an owned task worktree for ${sourceBranch}`);
  }
  const other = worktrees.find(tree => tree.branch === sourceRef && tree !== owned);
  if (other) {
    throw new Error(`Retaining ${sourceBranch}: still checked out in worktree ${other.path}`);
  }
  if (!owned && ownedPath && existsSync(ownedPath)) {
    throw new Error(`Retaining ${ownedPath}: task worktree path exists but is not registered with this repository`);
  }

  // Git refuses dirty or locked worktrees. Never force removal, and never try
  // deleting the branch if removing its worktree failed.
  if (owned) await git('worktree', 'remove', '--', owned.path);
  if (localExists) await git('branch', '-d', '--', sourceBranch);
  if (remoteTip) await git('push', 'origin', '--delete', sourceRef);
}
