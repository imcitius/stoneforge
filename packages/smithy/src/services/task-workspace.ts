/**
 * Task workspace resolution shared by every path that starts a worker on a task
 * (automatic dispatch, orphan recovery and explicit start).
 *
 * Contract (el-5jwe6q, extended to explicit start by el-2q3e2y): a task's
 * recorded branch is always preserved. The recorded worktree is reused when it
 * is still registered on that branch; otherwise a worktree that has the branch
 * checked out is reused; otherwise a new worktree path is attached to the SAME
 * branch (local as-is, or from origin's tip). Only a task without a recorded
 * branch gets a new branch from the target. A recorded branch that exists
 * neither locally nor on origin is refused, unless the task carries no evidence
 * that a worker ever ran on it (an assignment that only recorded a generated
 * branch name); then that same name is created from the target.
 *
 * @module
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Task } from '@stoneforge/core';
import type { WorktreeManager, CreateWorktreeResult } from '../git/worktree-manager.js';
import { getOrchestratorTaskMeta, type OrchestratorTaskMeta } from '../types/task-meta.js';
import type { OperationLogService } from './operation-log-service.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('task-workspace');
const execFileForGit = promisify(execFile);

/** Raised when a task's recorded branch cannot be found locally or on origin. */
export class TaskBranchUnavailableError extends Error {
  constructor(readonly taskId: string, readonly branch: string) {
    super(`Task ${taskId} records branch ${branch}, which no longer exists locally or on origin. ` +
      'Refusing to start a fresh branch from the target; restore the branch or reset the task explicitly.');
    this.name = 'TaskBranchUnavailableError';
  }
}

export function sameBranchName(a: string | undefined, b: string | undefined): boolean {
  const normalize = (value: string | undefined) => value?.replace(/^refs\/heads\//, '');
  return !!a && !!b && normalize(a) === normalize(b);
}

/**
 * Branch/worktree a (re)started worker must continue from. A pending handoff
 * wins over the current assignment; the worktree is paired with its branch.
 */
export function recordedTaskWorkspace(meta: OrchestratorTaskMeta | undefined): { branch?: string; worktree?: string } {
  return {
    branch: meta?.handoffBranch ?? meta?.branch,
    worktree: meta?.handoffBranch ? meta?.handoffWorktree ?? meta?.worktree : meta?.worktree ?? meta?.handoffWorktree,
  };
}

/**
 * True when the task records any trace of a worker having run on (or completed)
 * its branch. Without such a trace, a recorded branch that does not exist is a
 * name an assignment generated but never materialized, not a lost branch.
 */
export function taskHasWorkEvidence(meta: OrchestratorTaskMeta | undefined): boolean {
  return !!meta && (
    (meta.sessionHistory?.length ?? 0) > 0 ||
    (meta.handoffHistory?.length ?? 0) > 0 ||
    !!meta.handoffBranch ||
    !!meta.sessionId ||
    !!meta.lastCommitHash ||
    !!meta.completionOperation ||
    (meta.completionHistory?.length ?? 0) > 0 ||
    meta.mergeRequestId !== undefined
  );
}

export async function localBranchExists(worktreeManager: WorktreeManager, branch: string): Promise<boolean> {
  // Managers without branch inspection (test doubles) cannot disprove the branch.
  if (typeof worktreeManager.branchExists !== 'function') return true;
  try { return await worktreeManager.branchExists(branch); } catch { return false; }
}

export async function readGitCommit(worktreeManager: WorktreeManager, ref: string): Promise<string | undefined> {
  const repositoryRoot = worktreeManager.getRepositoryRoot?.();
  if (!repositoryRoot) return undefined;
  try {
    const { stdout } = await execFileForGit('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], {
      cwd: repositoryRoot, encoding: 'utf8', timeout: 30_000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Reads `refs/remotes/origin/<branch>`; undefined when absent or not a Git repository. */
export function remoteBranchCommit(worktreeManager: WorktreeManager, branch: string): Promise<string | undefined> {
  return readGitCommit(worktreeManager, `refs/remotes/origin/${branch}`);
}

/** How the recorded branch is attached when no reusable worktree exists. */
export interface AttachBranch {
  readonly branch: string;
  /** Start point: undefined checks out the local branch, `<branch>` uses origin's tip, else the target. */
  readonly baseBranch?: string;
  /** True when the branch does not exist yet and is created from the target. */
  readonly create?: boolean;
}

export interface ResolveTaskWorkspaceParams {
  readonly task: Task;
  readonly worktreeManager: WorktreeManager;
  readonly recordedBranch?: string;
  readonly recordedWorktree?: string;
  /** Creates a worktree; with `attach`, a new path attached to that branch. */
  readonly createWorktree: (attach?: AttachBranch) => Promise<CreateWorktreeResult>;
  readonly operationLog?: OperationLogService;
}

export interface ResolvedTaskWorkspace {
  readonly path: string;
  readonly branch: string;
  /** Set when a worktree was created (attached or new). */
  readonly created?: CreateWorktreeResult;
}

export async function resolveTaskWorkspace(params: ResolveTaskWorkspaceParams): Promise<ResolvedTaskWorkspace> {
  const { task, worktreeManager, recordedBranch, recordedWorktree, createWorktree, operationLog } = params;
  if (recordedWorktree && await worktreeManager.worktreeExists(recordedWorktree)) {
    let info: Awaited<ReturnType<WorktreeManager['getWorktree']>>;
    try { info = await worktreeManager.getWorktree(recordedWorktree); } catch { info = undefined; }
    const branch = recordedBranch ?? info?.branch;
    if (branch && (!info?.branch || !recordedBranch || sameBranchName(info.branch, recordedBranch))) {
      return { path: recordedWorktree, branch: branch.replace(/^refs\/heads\//, '') };
    }
    if (branch) {
      logger.warn(`Worktree ${recordedWorktree} for task ${task.id} is on ${info?.branch}, not recorded branch ${recordedBranch}; not reusing it`);
    }
  }

  if (recordedBranch) {
    let checkedOut: Awaited<ReturnType<WorktreeManager['listWorktrees']>> = [];
    try { checkedOut = await worktreeManager.listWorktrees(); } catch { checkedOut = []; }
    const holder = checkedOut.find((w) => sameBranchName(w.branch, recordedBranch));
    if (holder) {
      logger.info(`Reusing worktree ${holder.path} that has task ${task.id} branch ${recordedBranch} checked out`);
      return { path: holder.path, branch: recordedBranch };
    }
    const local = await localBranchExists(worktreeManager, recordedBranch);
    const remote = !local && !!(await remoteBranchCommit(worktreeManager, recordedBranch));
    if (!local && !remote) {
      if (taskHasWorkEvidence(getOrchestratorTaskMeta(task.metadata as Record<string, unknown> | undefined))) {
        throw new TaskBranchUnavailableError(task.id, recordedBranch);
      }
      logger.info(`Task ${task.id} branch ${recordedBranch} was recorded but never created; creating it from the target`);
      const created = await createWorktree({ branch: recordedBranch, create: true });
      return { path: created.path, branch: created.branch, created };
    }
    logger.warn(`Worktree for task ${task.id} is missing; re-attaching recorded branch ${recordedBranch}${local ? '' : ' from origin'}`);
    operationLog?.write('warn', 'dispatch', `Re-attached recorded branch ${recordedBranch} for task ${task.id} in a new worktree`, { taskId: task.id, branch: recordedBranch, previousWorktree: recordedWorktree });
    const created = await createWorktree({ branch: recordedBranch, baseBranch: local ? undefined : recordedBranch });
    return { path: created.path, branch: created.branch, created };
  }

  const created = await createWorktree();
  return { path: created.path, branch: created.branch, created };
}
