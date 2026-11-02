import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ErrorCode, StoneforgeError } from '@stoneforge/core';

const execFileAsync = promisify(execFile);

/** Keep identity failures distinct from Git's unstructured conflict output. */
export class GitIdentityError extends StoneforgeError {}

export interface GitIdentityContext {
  operation: string;
  source: string;
  taskId?: string;
  sourceWorktree?: string;
}

/** Let Git resolve config (including includes/worktree config) and inherited env.
 * Do not parse identities, substitute a previous author, or print environment values.
 */
export async function assertGitIdentity(cwd: string, context: GitIdentityContext): Promise<void> {
  const failures: string[] = [];
  let cause: Error | undefined;
  for (const role of ['AUTHOR', 'COMMITTER']) {
    try {
      await execFileAsync('git', ['var', `GIT_${role}_IDENT`], { cwd, encoding: 'utf8' });
    } catch (error) {
      const gitError = error as Error & { stderr?: string };
      cause ??= gitError;
      failures.push(`git var GIT_${role}_IDENT:\n${gitError.stderr || gitError.message}`);
    }
  }
  if (!failures.length) return;
  throw new GitIdentityError(
    `Git identity preflight failed for ${context.operation}; source=${context.source}` +
    (context.taskId ? `; task=${context.taskId}` : '') +
    `; worktree=${cwd}` +
    (context.sourceWorktree ? `; source worktree=${context.sourceWorktree}` : '') +
    '. No integration merge/commit was attempted.\n' +
    'Ask the repository owner for the intended author and committer. Configure approved ' +
    'repository-local user.name/user.email, or pass approved GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL ' +
    'and GIT_COMMITTER_NAME/GIT_COMMITTER_EMAIL for this command only. ' +
    'Verify both git var GIT_AUTHOR_IDENT and git var GIT_COMMITTER_IDENT in this worktree ' +
    'and invocation environment. No config was changed.\n' + failures.join('\n'),
    ErrorCode.INVALID_INPUT,
    { ...context, worktree: cwd, gitErrors: failures },
    cause,
  );
}

/** No-op and ordinary fast-forward syncs do not create commits. */
export async function syncNeedsIdentity(cwd: string, targetCommit: string): Promise<boolean> {
  const git = async (...args: string[]) =>
    (await execFileAsync('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
  const ancestor = async (a: string, b: string) => {
    try { await git('merge-base', '--is-ancestor', '--', a, b); return true; }
    catch (error) {
      if ((error as { code?: number }).code === 1) return false;
      throw error;
    }
  };
  if (await ancestor(targetCommit, 'HEAD')) return false;

  // Respect the standard Git controls that suppress commits or force --no-ff.
  const config = async (key: string) => {
    try { return await git('config', '--get', key); }
    catch (error) {
      if ((error as { code?: number }).code === 1) return undefined;
      throw error;
    }
  };
  const branch = await git('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '');
  const options = splitMergeOptions(branch ? await config(`branch.${branch}.mergeOptions`) ?? '' : '');
  // Invalid quoting is Git's own parse error, before any integration changes.
  if (!options) return false;
  const configuredFF = await config('merge.ff');
  let ff: 'allow' | 'only' | 'never' = configuredFF === 'only' ? 'only'
    : configuredFF !== undefined && /^(false|no|off|0|)$/i.test(configuredFF) ? 'never' : 'allow';
  let commit = true;
  let squash = false;
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    // Values such as -m '--no-commit' are data, not merge controls.
    if (['-m', '--message', '-F', '--file', '-s', '--strategy', '-X', '--strategy-option', '--into-name', '--cleanup'].includes(option)) {
      i++;
      continue;
    }
    if (option === '--ff') ff = 'allow';
    if (option === '--ff-only') ff = 'only';
    if (option === '--no-ff') ff = 'never';
    if (option === '--commit') commit = true;
    if (option === '--no-commit') commit = false;
    if (option === '--squash') squash = true;
    if (option === '--no-squash') squash = false;
  }
  if (!commit || squash || ff === 'only') return false;
  return ff === 'never' || !await ancestor('HEAD', targetCommit);
}

/** Git's branch.mergeOptions uses split_cmdline quoting, without shell expansion. */
function splitMergeOptions(value: string): string[] | undefined {
  const words: string[] = [];
  let word = '', quote = '', started = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (!quote && /[ \t\n\r\v\f]/.test(char)) {
      if (started) words.push(word);
      word = ''; started = false;
    } else if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? '' : char; started = true;
    } else if (char === '\\' && quote !== "'") {
      if (++i === value.length) return undefined;
      word += value[i]; started = true;
    } else {
      word += char; started = true;
    }
  }
  if (quote) return undefined;
  if (started) words.push(word);
  return words;
}
