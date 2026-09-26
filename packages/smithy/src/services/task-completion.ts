/** Completion's durable claim is a fencing check, not a network transaction.
 * Every continuation uses the exact version it owns. Unknown MR outcomes require
 * explicit reconciliation; neither elapsed time nor reopen authorizes a retry.
 */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { ConflictError, ConflictErrorCode, ElementType, TaskStatus, createTimestamp,
  type Task, type ElementId, type EntityId } from '@stoneforge/core';
import type { QuarryAPI } from '@stoneforge/quarry';
import { getOrchestratorTaskMeta, updateOrchestratorTaskMeta, closeTaskSessionHistory } from '../types/task-meta.js';
import type { CompletionOperation } from '../types/task-meta.js';
import type { CompleteTaskOptions, TaskCompletionResult } from './task-assignment-service.js';
import { ProjectRepositories } from '../git/project-repositories.js';
import { hasRemote } from '../git/merge.js';
import { createGitHubMergeProvider, type MergeRequestProvider } from './merge-request-provider.js';

const exec = promisify(execFile);
function conflict(message: string): never { throw new ConflictError(message, ConflictErrorCode.CONCURRENT_MODIFICATION); }

export interface ReconcileCompletionOptions {
  operationId: string;
  operatorId: EntityId;
  reason: string;
  /** Required for an unknown MR outcome. Evidence must match this operation. */
  mergeRequestId?: number;
}

function identity(task: Task, options: CompleteTaskOptions): string | undefined {
  if (task.status !== TaskStatus.OPEN && task.status !== TaskStatus.IN_PROGRESS) {
    conflict(`Cannot complete task ${task.id}: task is already in '${task.status}' status`);
  }
  if (typeof options.agentId !== 'string' || !options.agentId.trim()) conflict('Completion requires an explicit caller agentId');
  const meta = getOrchestratorTaskMeta(task.metadata);
  const history = meta?.sessionHistory ?? [];
  const current = history[history.length - 1];
  if (options.mode === 'admin' && !current) return undefined;
  if (!current || current.endedAt !== undefined ||
      history.filter(e => e.sessionId === current.sessionId).length !== 1 ||
      !current.sessionId?.trim() ||
      (meta?.sessionId !== current.sessionId && meta?.sessionId !== current.providerSessionId) ||
      current.agentId !== task.assignee || task.assignee !== meta?.assignedAgent || !task.assignee) {
    conflict('Completion requires the unique current unfinished internal history entry and matching owner');
  }
  // Metadata may hold a provider ID, but the caller must name the internal entry.
  if (options.mode !== 'admin' && (options.agentId !== task.assignee || options.sessionId !== current.sessionId)) {
    conflict('Completion caller/session does not own the current task');
  }
  return current.sessionId;
}

export class TaskCompletionProtocol {
  constructor(private api: QuarryAPI, private workspaceRoot?: string, private provider?: MergeRequestProvider) {}

  private async get(id: ElementId): Promise<Task> {
    const task = await this.api.get<Task>(id);
    if (!task || task.type !== ElementType.TASK) throw new Error(`Task not found: ${id}`);
    return task;
  }

  private async providerFor(task: Task): Promise<MergeRequestProvider | undefined> {
    const meta = getOrchestratorTaskMeta(task.metadata);
    if (this.workspaceRoot && meta?.repositoryId && this.provider?.name === 'github') {
      const repo = await new ProjectRepositories(this.workspaceRoot).repositoryForTask(task);
      return createGitHubMergeProvider(resolve(this.workspaceRoot, repo.path));
    }
    return this.provider;
  }

  private operation(task: Task): CompletionOperation {
    const op = getOrchestratorTaskMeta(task.metadata)?.completionOperation;
    if (!op) return conflict('Completion claim is missing');
    return op;
  }

  private validate(task: Task, op: CompletionOperation) {
    const meta = getOrchestratorTaskMeta(task.metadata);
    const session = identity(task, { mode: op.mode, agentId: op.agentId, sessionId: op.sessionId });
    if (session !== op.sessionId || task.assignee !== op.owner || meta?.assignedAgent !== op.assignedAgent ||
        meta?.branch !== op.branch || meta?.worktree !== op.worktree || meta?.repositoryId !== op.repositoryId ||
        this.operation(task).operationId !== op.operationId) conflict('Completion claim or ownership changed');
  }

  private async check(snapshot: Task): Promise<void> {
    const current = await this.get(snapshot.id);
    if (current.updatedAt !== snapshot.updatedAt) conflict('Completion lost its task version; explicit reconciliation required');
    this.validate(current, this.operation(snapshot));
  }

  private async phase(snapshot: Task, updates: Partial<CompletionOperation>): Promise<Task> {
    await this.check(snapshot);
    const op = this.operation(snapshot);
    return this.api.update<Task>(snapshot.id, {
      metadata: updateOrchestratorTaskMeta(snapshot.metadata, { completionOperation: { ...op, ...updates } }),
    }, { expectedUpdatedAt: snapshot.updatedAt, actor: op.agentId });
  }

  async complete(id: ElementId, options: CompleteTaskOptions = {}): Promise<TaskCompletionResult> {
    const task = await this.get(id);
    const meta = getOrchestratorTaskMeta(task.metadata);
    const previous = meta?.completionOperation;
    if (previous?.phase === 'finalized' && task.status === TaskStatus.REVIEW && options.operationId === previous.operationId &&
        options.agentId === previous.agentId && (options.sessionId === previous.sessionId || (options.mode === 'admin' && previous.mode === 'admin'))) return this.result(task);
    const sessionId = identity(task, options);
    if (previous && previous.phase !== 'finalized') conflict(`Completion ${previous.operationId} is ${previous.phase}; reconcile explicitly, never retry MR creation`);
    if (previous && previous.sessionId === sessionId) conflict('Reopened completion requires a new internal session');
    let cwd = meta?.worktree || this.workspaceRoot;
    let base = options.baseBranch || meta?.targetBranch || 'main';
    if (this.workspaceRoot && meta?.repositoryId) {
      const repos = new ProjectRepositories(this.workspaceRoot);
      const repo = await repos.repositoryForTask(task);
      cwd = resolve(this.workspaceRoot, meta.worktree || repo.path);
      if (!options.baseBranch && !meta.targetBranch) base = await (await repos.forTask(task)).getDefaultBranch();
    }
    // Recovery may run in a different process/cwd; persist an absolute Git path.
    if (cwd) cwd = resolve(this.workspaceRoot ?? process.cwd(), cwd);
    let commitOid: string | undefined;
    let push = false;
    if (meta?.branch && (!cwd || !existsSync(cwd))) conflict('Completion branch requires an existing Git worktree');
    if (meta?.branch && cwd) {
      const git = (args: string[]) => exec('git', args, { cwd, encoding: 'utf8' });
      // No remote effects before the CAS. Literal ref validation is retained.
      await git(['check-ref-format', `refs/heads/${meta.branch}`]);
      await git(['check-ref-format', '--branch', meta.branch]);
      commitOid = (await git(['rev-parse', '--verify', '--end-of-options', `refs/heads/${meta.branch}^{commit}`])).stdout.trim();
      push = await hasRemote(cwd);
    }
    const provider = await this.providerFor(task);
    const createMR = Boolean(meta?.branch && provider && options.createMergeRequest !== false);
    if (createMR && !commitOid) conflict('MR completion requires a resolved local commit');
    const operationId = randomUUID();
    const op: CompletionOperation = {
      operationId, taskVersion: task.updatedAt, phase: 'claimed', mode: options.mode === 'admin' ? 'admin' : 'worker',
      agentId: options.agentId!, sessionId, owner: task.assignee, assignedAgent: meta?.assignedAgent,
      branch: meta?.branch, worktree: meta?.worktree, repositoryId: meta?.repositoryId,
      commitOid, cwd, push, createMR, provider: createMR ? provider!.name : undefined, baseBranch: base,
      summary: options.summary, commitHash: options.commitHash,
      title: options.mergeRequestTitle || task.title,
      body: `${options.mergeRequestBody || `## Task\n\n**ID:** ${task.id}\n**Title:** ${task.title}\n\n${options.summary || ''}`}\n\n<!-- stoneforge-completion:${operationId} -->`,
    };
    const claimed = await this.api.update<Task>(id, {
      metadata: updateOrchestratorTaskMeta(task.metadata, {
        completionOperation: op,
        ...(previous ? { completionHistory: [...(meta?.completionHistory ?? []), previous] } : {}),
      }),
    }, { expectedUpdatedAt: task.updatedAt, actor: op.agentId });
    return this.continue(claimed, provider);
  }

  private async continue(snapshot: Task, provider?: MergeRequestProvider): Promise<TaskCompletionResult> {
    let task = snapshot;
    let op = this.operation(task);
    if (op.phase !== 'receipt' && op.phase !== 'pushed') {
      task = await this.phase(task, { phase: 'push_started' });
      if (op.push) {
        await this.check(task);
        try {
          // Pin the source OID, never force. The branch can move during this await.
          await exec('git', ['push', '--', 'origin', `${op.commitOid}:refs/heads/${op.branch}`], { cwd: op.cwd, encoding: 'utf8' });
        } catch (error) {
          task = await this.phase(task, { phase: 'push_failed', error: String(error) });
          throw new Error(`Cannot complete task: push to origin failed; reconcile operation ${op.operationId}: ${String(error)}`);
        }
      }
      task = await this.phase(task, { phase: 'pushed', error: undefined });
    }
    op = this.operation(task);
    if (op.phase !== 'receipt' && op.createMR) {
      if (!provider || provider.name !== op.provider) conflict('Completion provider changed');
      task = await this.phase(task, { phase: 'mr_started' });
      await this.check(task);
      try {
        const receipt = await provider.createMergeRequest(task, {
          title: op.title, body: op.body, sourceBranch: op.branch!, targetBranch: op.baseBranch,
        });
        task = await this.phase(task, { phase: 'receipt', receipt });
      } catch (error) {
        // If ownership/version was lost, this CAS must fail too, preserving winner.
        // mr_started itself is durable evidence of an unknown outcome after restart.
        await this.phase(task, { phase: 'unknown', error: String(error) });
        throw error;
      }
    }
    await this.check(task);
    op = this.operation(task);
    let metadata = task.metadata;
    if (op.sessionId) metadata = closeTaskSessionHistory(metadata, op.sessionId, createTimestamp());
    const updated = await this.api.update<Task>(task.id, {
      status: TaskStatus.REVIEW, assignee: undefined,
      metadata: updateOrchestratorTaskMeta(metadata, {
        completionOperation: { ...op, phase: 'finalized' }, completedAt: createTimestamp(), mergeStatus: 'pending', resumeCount: 0,
        completionSummary: op.summary, lastCommitHash: op.commitOid || op.commitHash,
        mergeRequestUrl: op.receipt?.url, mergeRequestId: op.receipt?.id, mergeRequestProvider: op.receipt?.provider,
      }),
    }, { expectedUpdatedAt: task.updatedAt, actor: op.agentId });
    return this.result(updated);
  }

  /** Explicit SDK operator recovery; never infer an MR's absence from failed lookup.
   * Only the same owner/internal history may resume. Ownership transfers require
   * separate operator investigation; this API cannot adopt another worker's claim.
   */
  async reconcile(id: ElementId, options: ReconcileCompletionOptions): Promise<TaskCompletionResult> {
    let task = await this.get(id);
    const op = this.operation(task);
    if (!options.operatorId?.trim() || !options.reason?.trim() || options.operationId !== op.operationId) conflict('Reconciliation requires operationId, operatorId and reason');
    if (op.phase === 'finalized' && task.status === TaskStatus.REVIEW) return this.result(task);
    this.validate(task, op);
    const provider = await this.providerFor(task);
    let receipt = op.receipt;
    if (op.phase === 'unknown' || op.phase === 'mr_started') {
      if (!options.mergeRequestId || provider?.name !== op.provider || !provider?.getMergeRequestEvidence) conflict('Unknown MR outcome: matching provider evidence required; no create retry');
      const evidence = await provider.getMergeRequestEvidence(options.mergeRequestId);
      if (!evidence || evidence.sourceBranch !== op.branch || evidence.targetBranch !== op.baseBranch ||
          evidence.commitOid !== op.commitOid || !evidence.body.includes(`<!-- stoneforge-completion:${op.operationId} -->`) ||
          evidence.provider !== op.provider || evidence.id !== options.mergeRequestId || !evidence.url || evidence.state !== 'open') {
        conflict('MR evidence does not identify this operation; outcome remains unknown');
      }
      receipt = { id: evidence.id, url: evidence.url, provider: evidence.provider };
    }
    task = await this.phase(task, {
      phase: receipt ? 'receipt' : op.phase === 'pushed' ? 'pushed' : 'claimed', receipt,
      reconciliations: [...(op.reconciliations ?? []), { operatorId: options.operatorId, reason: options.reason, at: createTimestamp(), previousPhase: op.phase, mergeRequestId: options.mergeRequestId }],
    });
    return this.continue(task, provider);
  }

  private result(task: Task): TaskCompletionResult {
    const receipt = this.operation(task).receipt;
    return { task, mergeRequestId: receipt?.id, mergeRequestUrl: receipt?.url };
  }
}
