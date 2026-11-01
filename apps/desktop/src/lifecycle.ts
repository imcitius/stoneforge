/**
 * Selection and explicit lifecycle commands for Desktop projects, independent of Electron.
 *
 * Selecting a project (tab click, ⌘1…9, ⌃Tab, » menu, notification) only shows it: a running
 * project gets its dashboard view attached, a stopped one shows its state page. Nothing here
 * starts a backend except the explicit `start`/`restart` commands. Each project has at most one
 * lifecycle command in progress (including its confirmation dialog); further requests for that
 * project are ignored until it settles, while other projects stay independent.
 */
import { projectActions, type LifecycleAction, type ProjectState } from './tabs.js';

export interface LifecycleProject { id: string; name: string; state: ProjectState }
export interface LifecycleManager<I> {
  readonly projects: ReadonlyMap<string, LifecycleProject>;
  readonly instances: ReadonlyMap<string, I>;
  start(id: string): Promise<I>;
  stop(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}
export interface LifecycleHooks<I> {
  /** Stop/Restart/Remove confirmation. Start needs none (it is the explicit action itself). */
  confirm(action: Exclude<LifecycleAction, 'start'>, project: LifecycleProject): Promise<boolean>;
  /** Attach (or reuse) the dashboard view for a running instance. Must never start a backend. */
  attach(id: string, instance: I): Promise<void>;
  /** Selection or pending state changed; re-render the shell and native view visibility. */
  changed(): void;
}

export class ProjectLifecycle<I> {
  active: string | undefined;
  private readonly pending = new Map<string, LifecycleAction>();
  constructor(private readonly manager: LifecycleManager<I>, private readonly hooks: LifecycleHooks<I>) {}

  pendingAction(id: string): LifecycleAction | undefined { return this.pending.get(id); }
  actions(id: string) {
    const project = this.manager.projects.get(id);
    if (!project) return undefined;
    return projectActions({ state: project.state, running: this.manager.instances.has(id) }, this.pending.get(id));
  }

  /**
   * Shows `id`. A running (ready) project gets its existing or a new view for its current
   * instance; any other state shows the project's state page. Never calls `manager.start`.
   */
  async select(id: string): Promise<void> {
    if (!this.manager.projects.has(id)) throw new Error('Unknown project');
    if (this.active !== id) { this.active = id; this.hooks.changed(); }
    await this.attachIfRunning(id);
  }

  private async attachIfRunning(id: string): Promise<void> {
    const instance = this.manager.instances.get(id);
    if (instance === undefined || this.manager.projects.get(id)?.state !== 'ready') return;
    await this.hooks.attach(id, instance);
  }

  /**
   * Runs one explicit lifecycle command. Returns false when it does not apply in the current
   * state, another command for this project is in progress, or the user cancelled.
   */
  async run(action: LifecycleAction, id: string): Promise<boolean> {
    const project = this.manager.projects.get(id);
    if (!project) throw new Error('Unknown project');
    if (this.pending.has(id) || !this.actions(id)?.[action]) return false;
    this.pending.set(id, action); this.hooks.changed();
    try {
      if (action !== 'start' && !await this.hooks.confirm(action, project)) return false;
      // The project may have been removed or changed state while the dialog was open.
      if (!this.manager.projects.has(id)) return false;
      if (action === 'stop') await this.manager.stop(id);
      else if (action === 'remove') {
        await this.manager.remove(id);
        if (this.active === id) this.active = undefined;
      } else {
        if (action === 'restart') await this.manager.stop(id);
        await this.hooks.attach(id, await this.manager.start(id));
      }
      return true;
    } finally {
      this.pending.delete(id); this.hooks.changed();
    }
  }
}
