/** Project-level repository registry. Project data and Git roots are independent. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, realpathSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { Task } from '@stoneforge/core';
import type { QuarryAPI } from '@stoneforge/quarry';
import { getOrchestratorTaskMeta, updateOrchestratorTaskMeta } from '../types/task-meta.js';
import { createWorktreeManager, type WorktreeManager, type CreateWorktreeOptions, type RemoveWorktreeOptions } from './worktree-manager.js';
const exec = promisify(execFile);

export interface ProjectRepository {
  id: string;
  path: string;
  targetBranch?: string;
  testCommand?: string;
  /** Local Git identity, shared by all linked worktrees of this repository. */
  gitCommonDir: string;
}

export class ProjectRepositories implements WorktreeManager {
  private managers = new Map<string, Promise<WorktreeManager>>();
  private initialized = false;
  readonly manifest: string;
  readonly root: string;
  constructor(root: string, private readonly api?: QuarryAPI) {
    this.root = realpathSync(root);
    this.manifest = path.join(this.root, '.stoneforge/repositories.json');
  }
  private async git(directory: string, args: string[]): Promise<string> {
    return (await exec('git', args, { cwd: directory, timeout: 10000 })).stdout.trim();
  }
  private async inspect(directory: string): Promise<string> {
    // Do not accidentally register a plain subdirectory of its parent's Git.
    if (!existsSync(path.join(directory, '.git'))) throw new Error(`No Git checkout at ${directory}`);
    await this.git(directory, ['rev-parse', '--verify', 'HEAD']);
    return realpathSync(await this.git(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  }
  async list(): Promise<ProjectRepository[]> {
    if (existsSync(this.manifest)) {
      const data = JSON.parse(readFileSync(this.manifest, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.repositories)) throw new Error('Invalid repository registry');
      const ids = new Set<string>();
      const identities = new Set<string>();
      for (const repo of data.repositories) {
        if (!repo || typeof repo.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(repo.id) || typeof repo.path !== 'string' || typeof repo.gitCommonDir !== 'string') throw new Error('Invalid repository entry');
        const identity = repo.gitCommonDir;
        if (ids.has(repo.id) || identities.has(identity)) throw new Error('Duplicate repository or linked worktree registration');
        ids.add(repo.id); identities.add(identity);
      }
      return data.repositories;
    }
    // Legacy single-repository projects need no migration or new config file.
    try { return [{ id: 'default', path: '.', gitCommonDir: await this.inspect(this.root) }]; }
    catch { return []; }
  }
  async add(input: { id: string; path: string; targetBranch?: string; testCommand?: string }): Promise<ProjectRepository> {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(input.id)) throw new Error('Repository ID must contain lowercase letters, digits, - or _');
    const directory = realpathSync(path.resolve(this.root, input.path));
    const gitCommonDir = await this.inspect(directory);
    if (input.targetBranch) await this.git(directory, ['rev-parse', '--verify', `${input.targetBranch}^{commit}`]);
    return this.mutate(async repos => {
      if (repos.some(r => r.id === input.id)) throw new Error(`Repository ID ${input.id} already exists`);
      if (repos.some(r => r.gitCommonDir === gitCommonDir)) throw new Error('This repository is already registered (possibly through another worktree)');
      const repo = { ...input, path: path.relative(this.root, directory) || '.', gitCommonDir };
      repos.push(repo);
      return repo;
    });
  }
  async remove(id: string): Promise<void> {
    await this.mutate(async repos => {
      if (this.api) {
        const tasks = await this.api.list<Task>({ type: 'task' });
        if (tasks.some(t => getOrchestratorTaskMeta(t.metadata)?.repositoryId === id)) throw new Error('Repository is referenced by tasks; keep its registration for history and recovery');
      }
      const index = repos.findIndex(r => r.id === id);
      if (index < 0) throw new Error(`Unknown repository: ${id}`);
      const manager = await this.manager(repos[index]);
      const worktrees = await manager.listWorktrees();
      if (worktrees.some(w => w.path.startsWith(path.join(this.root, '.stoneforge/.worktrees', id) + path.sep))) throw new Error('Repository still has managed worktrees');
      repos.splice(index, 1);
    });
  }
  private async mutate<T>(fn: (repos: ProjectRepository[]) => Promise<T>): Promise<T> {
    mkdirSync(path.dirname(this.manifest), { recursive: true });
    const lock = this.manifest + '.lock';
    writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
    try {
      const repos = await this.list();
      const result = await fn(repos);
      const temporary = this.manifest + '.tmp';
      writeFileSync(temporary, JSON.stringify({ version: 1, repositories: repos }, null, 2) + '\n');
      renameSync(temporary, this.manifest);
      return result;
    } finally { unlinkSync(lock); }
  }
  async resolve(id?: string): Promise<ProjectRepository> {
    const repos = await this.list();
    if (id) {
      const repo = repos.find(r => r.id === id);
      if (!repo) throw new Error(`Unknown repository: ${id}`);
      await this.validate(repo);
      return repo;
    }
    if (repos.length !== 1) throw new Error(repos.length ? 'Choose a repository for this task (sf task update <id> --repository <repository-id>)' : 'No code repositories registered. Add one in Desktop or with sf repo add.');
    await this.validate(repos[0]);
    return repos[0];
  }
  async forDirectory(directory: string, id?: string): Promise<ProjectRepository> {
    if (id || realpathSync(directory) === this.root) return this.resolve(id);
    const identity = realpathSync(await this.git(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    const repo = (await this.list()).find(r => r.gitCommonDir === identity);
    if (!repo) throw new Error('Current directory belongs to an unregistered repository');
    await this.validate(repo);
    return repo;
  }

  async repositoryForTask(task: Task): Promise<ProjectRepository> {
    const meta = getOrchestratorTaskMeta(task.metadata);
    const repo = await this.resolve(meta?.repositoryId);
    if (meta?.worktree || meta?.handoffWorktree) {
      const directory = path.resolve(this.root, meta.worktree ?? meta.handoffWorktree!);
      if (existsSync(directory) && await this.inspect(directory) !== repo.gitCommonDir) throw new Error(`Task ${task.id} worktree belongs to another repository`);
    }
    return repo;
  }
  async forTask(task: Task): Promise<WorktreeManager> {
    const repo = await this.repositoryForTask(task);
    const manager = await this.manager(repo);
    const meta = getOrchestratorTaskMeta(task.metadata);
    if (!meta?.repositoryLocked && this.api) {
      const metadata = updateOrchestratorTaskMeta(task.metadata, {
        repositoryId: repo.id, repositoryLocked: true,
        ...(meta?.targetBranch ? {} : { targetBranch: repo.targetBranch ?? await manager.getDefaultBranch() }),
      });
      const updated = await this.api.update(task.id, { metadata }, { expectedUpdatedAt: task.updatedAt });
      Object.assign(task, { metadata: updated.metadata, updatedAt: updated.updatedAt });
    }
    return manager;
  }
  async validate(repo: ProjectRepository): Promise<void> {
    const identity = await this.inspect(path.resolve(this.root, repo.path));
    if (identity !== repo.gitCommonDir) throw new Error(`Repository ${repo.id} moved or was replaced; repair its registration before dispatch`);
  }
  async describe(): Promise<Array<ProjectRepository & { error?: string }>> {
    return Promise.all((await this.list()).map(async repo => {
      try { await this.validate(repo); return repo; }
      catch (error) { return { ...repo, error: String(error) }; }
    }));
  }
  async manager(repo: ProjectRepository): Promise<WorktreeManager> {
    await this.validate(repo);
    const key = JSON.stringify(repo);
    let pending = this.managers.get(key);
    if (!pending) {
      pending = (async () => {
        const manager = createWorktreeManager({ workspaceRoot: this.root, repositoryRoot: path.resolve(this.root, repo.path), worktreeDir: repo.id === 'default' && repo.path === '.' ? '.stoneforge/.worktrees' : `.stoneforge/.worktrees/${repo.id}`, defaultBaseBranch: repo.targetBranch });
        await manager.initWorkspace();
        return manager;
      })();
      this.managers.set(key, pending);
      pending.catch(() => this.managers.delete(key));
    }
    return pending;
  }
  private async forPath(value: string): Promise<WorktreeManager> {
    const directory = path.resolve(this.root, value);
    const repos = await this.list();
    if (existsSync(directory)) {
      const identity = await this.inspect(directory);
      const repo = repos.find(r => r.gitCommonDir === identity);
      if (!repo) throw new Error('Worktree is not part of this project');
      return this.manager(repo);
    }
    const repo = repos.find(r => directory.startsWith(path.join(this.root, '.stoneforge/.worktrees', r.id) + path.sep));
    return this.manager(repo ?? await this.resolve());
  }
  async initWorkspace() { await this.list(); this.initialized = true; }
  isInitialized() { return this.initialized; }
  getWorkspaceRoot() { return this.root; }
  async createWorktree(options: CreateWorktreeOptions) {
    const task = this.api && await this.api.get<Task>(options.taskId);
    const manager = task ? await this.forTask(task) : await this.manager(await this.resolve());
    return manager.createWorktree(options);
  }
  async createReadOnlyWorktree(options: { agentName: string; purpose: string }) { return (await this.manager(await this.resolve())).createReadOnlyWorktree(options); }
  async removeWorktree(value: string, options?: RemoveWorktreeOptions) {
    const directory = path.resolve(this.root, value);
    if (!directory.startsWith(path.join(this.root, '.stoneforge/.worktrees') + path.sep)) throw new Error('Only project-managed worktrees may be removed');
    return (await this.forPath(value)).removeWorktree(value, options);
  }
  async suspendWorktree(value: string) { return (await this.forPath(value)).suspendWorktree(value); }
  async resumeWorktree(value: string) { return (await this.forPath(value)).resumeWorktree(value); }
  async listWorktrees(includeMain?: boolean) { return (await Promise.all((await this.list()).map(async r => { try { return await (await this.manager(r)).listWorktrees(includeMain); } catch { return []; } }))).flat(); }
  async getWorktree(value: string) { return (await this.forPath(value)).getWorktree(value); }
  getWorktreePath(_agentName: string, _title?: string): string { throw new Error('Select a repository manager before computing a worktree path'); }
  async getWorktreesForAgent(agentName: string) { return (await Promise.all((await this.list()).map(async r => (await this.manager(r)).getWorktreesForAgent(agentName)))).flat(); }
  async worktreeExists(value: string) { if (!existsSync(path.resolve(this.root, value))) return false; return (await this.forPath(value)).worktreeExists(value); }
  async ensureWorktreeRemote(value: string, remote?: string) { return (await this.forPath(value)).ensureWorktreeRemote(value, remote); }
  async getCurrentBranch() { return (await this.manager(await this.resolve())).getCurrentBranch(); }
  async getDefaultBranch() { return (await this.manager(await this.resolve())).getDefaultBranch(); }
  async branchExists(branch: string) { return (await this.manager(await this.resolve())).branchExists(branch); }
}

export async function taskWorktreeManager(manager: WorktreeManager, task: Task): Promise<WorktreeManager> {
  return manager.forTask ? manager.forTask(task) : manager;
}
