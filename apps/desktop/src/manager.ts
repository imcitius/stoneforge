import { execFile, fork, type ChildProcess } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { realpath, readFile, writeFile, mkdir, access, rename, lstat, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
export type WorkflowPreset = 'auto' | 'review' | 'approve';

export interface Project {
  id: string;
  name: string;
  root: string;
  state: 'stopped' | 'starting' | 'ready' | 'stopping' | 'error';
  error?: string;
}
export interface Instance {
  projectId: string;
  instanceId: string;
  secret: string;
  endpoint?: string;
  child: ChildProcess;
  ready: Promise<Instance>;
  exited: Promise<void>;
  stopping?: Promise<void>;
}
export interface ManagerOptions {
  dataDir: string;
  node: string;
  entry: string;
  webRoot: string;
  binDir: string;
}

/** Electron-independent supervisor; each workspace has its own child and identity. */
export class ProjectManager extends EventEmitter {
  readonly projects = new Map<string, Project>();
  readonly instances = new Map<string, Instance>();
  readonly logs = new Map<string, string>();
  private saving: Promise<void> = Promise.resolve();
  private logWrites: Promise<void> = Promise.resolve();
  constructor(readonly options: ManagerOptions) { super(); }

  async load(): Promise<void> {
    await mkdir(join(this.options.dataDir, 'logs'), { recursive: true });
    let entries: unknown;
    try { entries = JSON.parse(await readFile(join(this.options.dataDir, 'projects.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!Array.isArray(entries)) throw new Error('Invalid project registry');
    for (const item of entries) {
      if (!item || typeof item.id !== 'string' || !/^[a-f0-9-]{36}$/.test(item.id) || typeof item.root !== 'string' || typeof item.name !== 'string') {
        throw new Error('Invalid project registry entry');
      }
      this.projects.set(item.id, { id: item.id, root: item.root, name: item.name, state: 'stopped' });
    }
  }
  list(): Project[] { return [...this.projects.values()].map((p) => ({ ...p })); }
  private changed(): void { this.emit('changed'); }
  private save(): Promise<void> {
    const data = JSON.stringify(this.list().map(({ id, name, root }) => ({ id, name, root })), null, 2);
    this.saving = this.saving.catch(() => {}).then(async () => {
      const file = join(this.options.dataDir, 'projects.json');
      await writeFile(file + '.tmp', data, { mode: 0o600 });
      await rename(file + '.tmp', file);
    });
    return this.saving;
  }
  async inspect(path: string): Promise<{ root: string; initialized: boolean; hasConfig: boolean }> {
    let root = await realpath(path);
    if (!(await stat(root)).isDirectory()) throw new Error('Choose a project folder.');
    const dataPath = join(root, '.stoneforge');
    // Only a genuinely missing directory is a new workspace. Broken links and
    // permission errors must not trigger initialization in a different location.
    try { await lstat(dataPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { root, initialized: false, hasConfig: false };
      throw error;
    }
    const dataRoot = await realpath(dataPath);
    if (!(await stat(dataRoot)).isDirectory()) throw new Error('.stoneforge must be a directory.');
    root = dirname(dataRoot);
    const exists = async (file: string) => {
      try { await access(file); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    };
    return { root, initialized: await exists(join(dataRoot, 'stoneforge.db')), hasConfig: await exists(join(dataRoot, 'config.yaml')) };
  }
  async initialize(path: string, preset: WorkflowPreset = 'review'): Promise<Project> {
    if (!['auto', 'review', 'approve'].includes(preset)) throw new Error('Invalid workflow preset');
    const workspace = await this.inspect(path);
    if (!workspace.initialized) {
      // Use the shipped CLI/runtime, never a potentially unrelated global sf.
      const cli = join(dirname(this.options.entry), '../bin/sf.js');
      const args = [cli, 'init'];
      // A cloned/partially initialized workspace keeps its existing configuration.
      if (!workspace.hasConfig) args.push('--preset', preset);
      try {
        await runFile(this.options.node, args, { cwd: workspace.root, env: this.environment(workspace.root), timeout: 120_000, maxBuffer: 1024 * 1024 });
      } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string; killed?: boolean };
        const detail = (failure.stderr || failure.stdout || failure.message).trim().slice(-8000);
        throw new Error(`Could not initialize ${workspace.root}.\n${failure.killed ? 'Initialization timed out.\n' : ''}${detail}`);
      }
    }
    return this.add(workspace.root);
  }
  async add(path: string): Promise<Project> {
    // realpath the data directory too: worktrees can share it through a symlink.
    const dataRoot = await realpath(join(path, '.stoneforge'));
    await access(join(dataRoot, 'stoneforge.db'));
    const root = dirname(dataRoot);
    const previous = this.list().find((p) => p.root === root);
    if (previous) return this.projects.get(previous.id)!;
    const project: Project = { id: randomUUID(), name: basename(root), root, state: 'stopped' };
    this.projects.set(project.id, project);
    await this.save(); this.changed(); return project;
  }
  async remove(id: string): Promise<void> {
    await this.stop(id);
    this.projects.delete(id); await this.save(); this.changed();
  }
  private environment(root: string): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('STONEFORGE_') || key.startsWith('SF_') || key.startsWith('ELECTRON_') ||
          ['NODE_OPTIONS', 'NODE_PATH', 'CLAUDECODE', 'PORT', 'HOST', 'ORCHESTRATOR_PORT',
           'CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_CI', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
           'CODEX_MCP_NODE_PATH', 'CODEX_PERMISSION_PROFILE', 'CODEX_SESSION_ID',
           'CODEX_SHELL', 'CODEX_THREAD_ID', 'CODEX_VERSION'].includes(key)) delete env[key];
    }
    // Finder's PATH omits common CLI installations. Bundled sf and Node take precedence.
    env.PATH = [this.options.binDir, dirname(this.options.node), join(process.env.HOME ?? '', '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', env.PATH ?? '/usr/bin:/bin'].join(':');
    env.STONEFORGE_ROOT = root;
    return env;
  }
  start(id: string): Promise<Instance> {
    const existing = this.instances.get(id);
    if (existing) return existing.ready;
    const project = this.projects.get(id);
    if (!project) return Promise.reject(new Error('Unknown project'));
    project.state = 'starting'; delete project.error; this.changed();
    const env = this.environment(project.root);
    const child = fork(this.options.entry, [], { execPath: this.options.node, execArgv: [], cwd: project.root, env, silent: true });
    let resolveReady!: (instance: Instance) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<Instance>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
    const instance: Instance = { projectId: id, instanceId: randomUUID(), secret: randomBytes(32).toString('hex'), child, ready, exited };
    this.instances.set(id, instance);
    const timer = setTimeout(() => { rejectReady(new Error('Backend startup timed out')); void this.stop(id); }, 45_000);
    const append = (chunk: Buffer) => {
      const text = chunk.toString().replaceAll(instance.secret, '[redacted]');
      const tail = ((this.logs.get(id) ?? '') + text).slice(-128_000);
      this.logs.set(id, tail);
      this.logWrites = this.logWrites.catch(() => {}).then(() =>
        writeFile(join(this.options.dataDir, 'logs', id + '.log'), tail, { mode: 0o600 }));
    };
    child.stdout?.on('data', append); child.stderr?.on('data', append);
    child.on('error', (error) => {
      clearTimeout(timer); rejectReady(error);
      if (!child.pid && this.instances.get(id) === instance) {
        this.instances.delete(id); project.state = 'error'; project.error = error.message;
        this.emit('stopped', id); this.changed();
      }
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (this.instances.get(id) !== instance) return;
      this.instances.delete(id);
      project.state = instance.stopping ? 'stopped' : 'error';
      if (!instance.stopping) project.error ??= `Backend exited (${signal ?? code}); open Logs for details`;
      rejectReady(new Error(project.error ?? 'Backend stopped'));
      this.emit('stopped', id); this.changed();
    });
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const msg = message as Record<string, unknown>;
      if (msg.type === 'error') {
        project.error = String(msg.error); rejectReady(new Error(project.error));
      }
      if (msg.type !== 'ready') return;
      void (async () => {
        if (msg.projectId !== id || msg.instanceId !== instance.instanceId || msg.projectRoot !== project.root ||
            msg.pid !== child.pid || msg.protocolVersion !== 1 || typeof msg.port !== 'number' || msg.port < 1 || msg.port > 65535) {
          throw new Error('Backend identity mismatch');
        }
        instance.endpoint = `http://127.0.0.1:${msg.port}`;
        const response = await fetch(instance.endpoint + '/api/desktop/identity', { headers: this.headers(instance), signal: AbortSignal.timeout(5000) });
        const health = await response.json() as Record<string, unknown>;
        if (!response.ok || health.projectId !== id || health.instanceId !== instance.instanceId || health.projectRoot !== project.root) {
          throw new Error('Endpoint identity mismatch');
        }
        if (instance.stopping) throw new Error('Backend stopped during startup');
        clearTimeout(timer); project.state = 'ready'; this.changed(); resolveReady(instance);
      })().catch((error) => { rejectReady(error); void this.stop(id); });
    });
    child.send({ type: 'start', projectRoot: project.root, projectId: id, instanceId: instance.instanceId, secret: instance.secret, webRoot: this.options.webRoot });
    void ready.catch((error: Error) => { project.error = error.message; if (project.state !== 'stopped') project.state = 'error'; this.changed(); });
    return ready;
  }
  headers(instance: Instance): Record<string, string> {
    return { 'x-stoneforge-project': instance.projectId, 'x-stoneforge-instance': instance.instanceId, 'x-stoneforge-secret': instance.secret };
  }
  async stop(id: string): Promise<void> {
    const instance = this.instances.get(id);
    if (!instance) return;
    if (instance.stopping) return instance.stopping;
    const project = this.projects.get(id)!;
    project.state = 'stopping'; this.changed();
    instance.stopping = (async () => {
      // Disconnect also handles shutdown if sending the stop message fails.
      if (instance.child.connected) instance.child.send({ type: 'stop' });
      const timeout = setTimeout(() => instance.child.kill('SIGTERM'), 46_000);
      const forceTimeout = setTimeout(() => instance.child.kill('SIGKILL'), 51_000);
      try { await instance.exited; } finally { clearTimeout(timeout); clearTimeout(forceTimeout); }
    })();
    return instance.stopping;
  }
  async close(): Promise<void> { await Promise.all([...this.instances.keys()].map((id) => this.stop(id))); await this.logWrites; }
}
