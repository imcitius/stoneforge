import { execFile, fork, type ChildProcess } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { realpath, readFile, writeFile, mkdir, access, rename, lstat, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { findExternalServer, externalServerAlive, type ExternalServer } from './external.js';

const runFile = promisify(execFile);
export type WorkflowPreset = 'auto' | 'review' | 'approve';

export interface Project {
  id: string;
  name: string;
  root: string;
  state: 'stopped' | 'starting' | 'ready' | 'stopping' | 'error';
  error?: string;
  needsInput?: boolean;
}
export interface Instance {
  projectId: string;
  instanceId: string;
  secret: string;
  endpoint?: string;
  child?: ChildProcess;
  external?: ExternalServer;
  monitor?: ReturnType<typeof setInterval>;
  ready: Promise<Instance>;
  exited: Promise<void>;
  stopping?: Promise<void>;
  /** Set when the manager itself stops a failed startup; the project then stays in `error`. */
  failure?: string;
}
export interface ManagerOptions {
  dataDir: string;
  node: string;
  entry: string;
  webRoot: string;
  binDir: string;
}

/**
 * Canonical project root: the parent of the realpath'd `.stoneforge` directory.
 * Worktrees may share the data directory through a symlink, and the managed
 * backend reports realpath roots (for example /private/var rather than /var on
 * macOS), so every stored root and identity comparison uses this form.
 */
export async function canonicalProjectRoot(path: string): Promise<string> {
  return dirname(await realpath(join(path, '.stoneforge')));
}

/** Electron-independent supervisor; each workspace has its own child and identity. */
export class ProjectManager extends EventEmitter {
  readonly projects = new Map<string, Project>();
  readonly instances = new Map<string, Instance>();
  readonly logs = new Map<string, string>();
  private saving: Promise<void> = Promise.resolve();
  private logWrites: Promise<void> = Promise.resolve();
  private starts = new Map<string, Promise<Instance>>();
  constructor(readonly options: ManagerOptions) { super(); }

  async load(): Promise<void> {
    await mkdir(join(this.options.dataDir, 'logs'), { recursive: true });
    let entries: unknown;
    try { entries = JSON.parse(await readFile(join(this.options.dataDir, 'projects.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!Array.isArray(entries)) throw new Error('Invalid project registry');
    let migrated = false;
    for (const item of entries) {
      if (!item || typeof item.id !== 'string' || !/^[a-f0-9-]{36}$/.test(item.id) || typeof item.root !== 'string' || typeof item.name !== 'string') {
        throw new Error('Invalid project registry entry');
      }
      // Older registries may hold non-canonical roots (/var vs /private/var,
      // symlinked folders). Migrate them; an unavailable folder keeps its stored
      // root and reports a clear error when it is opened.
      let root = item.root;
      try { root = await canonicalProjectRoot(item.root); }
      catch (error) { console.warn(`[desktop] Project folder unavailable, keeping stored root: ${item.root} (${(error as NodeJS.ErrnoException).code ?? error})`); }
      // Aliases of one workspace collapse into the first entry, keeping its ID
      // (session partition, logs and preferences are keyed by it).
      if ([...this.projects.values()].some((p) => p.root === root)) { migrated = true; continue; }
      if (root !== item.root) migrated = true;
      this.projects.set(item.id, { id: item.id, root, name: item.name, state: 'stopped' });
    }
    if (migrated) await this.save();
  }
  list(): Project[] { return [...this.projects.values()].map((p) => ({ ...p })); }
  setNeedsInput(id: string, needsInput: boolean): void {
    const project = this.projects.get(id);
    if (!project || !!project.needsInput === needsInput) return;
    project.needsInput = needsInput; this.changed();
  }
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
    const root = await canonicalProjectRoot(path);
    await access(join(root, '.stoneforge', 'stoneforge.db'));
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
    // Finder launches without a locale. macOS pbcopy then interprets UTF-8
    // from terminal agents as MacRoman, corrupting Cyrillic and other Unicode.
    const characterLocale = env.LC_ALL || env.LC_CTYPE || env.LANG;
    if (!characterLocale || !/utf-?8/i.test(characterLocale)) {
      if (env.LC_ALL) env.LC_ALL = 'en_US.UTF-8';
      env.LC_CTYPE = 'en_US.UTF-8';
    }
    env.STONEFORGE_ROOT = root;
    return env;
  }
  start(id: string): Promise<Instance> {
    const existing = this.instances.get(id);
    if (existing) return existing.ready;
    const pending = this.starts.get(id);
    if (pending) return pending;
    const starting = this.connectOrStart(id).finally(() => this.starts.delete(id));
    this.starts.set(id, starting);
    return starting;
  }
  private async connectOrStart(id: string): Promise<Instance> {
    const project = this.projects.get(id);
    if (!project) throw new Error('Unknown project');
    project.state = 'starting'; delete project.error; this.changed();
    try {
      await this.canonicalize(project);
      const external = await findExternalServer(project.root);
      if (!external) return await this.spawn(id);
      const instance: Instance = {
        projectId: external.credentials?.projectId ?? id, instanceId: external.credentials?.instanceId ?? randomUUID(),
        secret: external.credentials?.secret ?? '', endpoint: external.endpoint, external,
        ready: undefined as unknown as Promise<Instance>, exited: Promise.resolve(),
      };
      instance.ready = Promise.resolve(instance);
      this.instances.set(id, instance);
      this.logs.set(id, `Connected to existing workspace server (PID ${external.pid}) at ${external.endpoint}.\n`);
      instance.monitor = setInterval(() => { void this.isCurrent(id, instance); }, 2000);
      instance.monitor.unref();
      project.state = 'ready'; this.changed(); return instance;
    } catch (error) {
      project.state = 'error'; project.error = error instanceof Error ? error.message : String(error); this.changed(); throw error;
    }
  }
  /** Re-resolve the root before every start: a symlink may have been retargeted since load. */
  private async canonicalize(project: Project): Promise<void> {
    let root: string;
    try { root = await canonicalProjectRoot(project.root); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(`Project folder is unavailable: ${project.root}${code ? ` (${code})` : ''}. Check that it exists and contains .stoneforge, or remove the project.`);
    }
    if (root === project.root) return;
    const other = [...this.projects.values()].find((p) => p !== project && p.root === root);
    if (other) throw new Error(`${project.root} now resolves to ${root}, which is already open as project "${other.name}".`);
    this.appendLog(project.id, `[desktop] Project root ${project.root} resolves to ${root}; using the canonical path.\n`);
    project.root = root; await this.save();
  }
  private appendLog(id: string, text: string): void {
    const tail = ((this.logs.get(id) ?? '') + text).slice(-128_000);
    this.logs.set(id, tail);
    this.logWrites = this.logWrites.catch(() => {}).then(() =>
      writeFile(join(this.options.dataDir, 'logs', id + '.log'), tail, { mode: 0o600 }));
  }
  /** Stop a startup that failed after the child was spawned, keeping the project in `error` with a visible reason. */
  private fail(id: string, instance: Instance, error: Error, rejectReady: (error: Error) => void): void {
    instance.failure ??= error.message;
    this.appendLog(id, `[desktop] Startup failed, stopping backend: ${error.message}\n`);
    console.error(`[desktop] Project ${id} startup failed: ${error.message}`);
    rejectReady(error);
    this.stop(id).catch(() => { /* stop() records its own error state */ });
  }
  async isCurrent(id: string, instance: Instance): Promise<boolean> {
    if (this.instances.get(id) !== instance) return false;
    const alive = !instance.external || await externalServerAlive(instance.external);
    if (this.instances.get(id) !== instance) return false;
    if (alive) return true;
    clearInterval(instance.monitor); this.instances.delete(id);
    const project = this.projects.get(id)!;
    project.state = instance.stopping ? 'stopped' : 'error';
    if (!instance.stopping) project.error = 'The external server stopped. Select the project to start it again.';
    project.needsInput = false; this.emit('stopped', id); this.changed(); return false;
  }
  private spawn(id: string): Promise<Instance> {
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
    const timer = setTimeout(() => this.fail(id, instance, new Error('Backend startup timed out'), rejectReady), 45_000);
    const append = (chunk: Buffer) => this.appendLog(id, chunk.toString().replaceAll(instance.secret, '[redacted]'));
    child.stdout?.on('data', append); child.stderr?.on('data', append);
    child.on('error', (error) => {
      clearTimeout(timer); rejectReady(error);
      if (!child.pid && this.instances.get(id) === instance) {
        this.instances.delete(id); project.state = 'error'; project.error = error.message;
        project.needsInput = false; this.emit('stopped', id); this.changed();
      }
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (this.instances.get(id) !== instance) return;
      this.instances.delete(id);
      project.state = instance.stopping && !instance.failure ? 'stopped' : 'error';
      if (instance.failure) project.error = instance.failure;
      else if (!instance.stopping) project.error ??= `Backend exited (${signal ?? code}); open Logs for details`;
      rejectReady(new Error(project.error ?? 'Backend stopped'));
      project.needsInput = false; this.emit('stopped', id); this.changed();
    });
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const msg = message as Record<string, unknown>;
      if (msg.type === 'error') {
        project.error = String(msg.error); rejectReady(new Error(project.error));
      }
      if (msg.type !== 'ready') return;
      void (async () => {
        const problems = identityProblems(msg, { projectId: id, instanceId: instance.instanceId, projectRoot: project.root });
        if (msg.pid !== child.pid) problems.push(`PID ${String(msg.pid)} (expected ${String(child.pid)})`);
        if (msg.protocolVersion !== 1) problems.push(`protocol ${String(msg.protocolVersion)} (expected 1)`);
        if (typeof msg.port !== 'number' || msg.port < 1 || msg.port > 65535) problems.push(`port ${String(msg.port)}`);
        if (problems.length) throw new Error(`Backend identity mismatch: ${problems.join('; ')}`);
        instance.endpoint = `http://127.0.0.1:${msg.port}`;
        const response = await fetch(instance.endpoint + '/api/desktop/identity', { headers: this.headers(instance), signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`Endpoint identity mismatch: HTTP ${response.status}`);
        const health = identityProblems(await response.json() as Record<string, unknown>, { projectId: id, instanceId: instance.instanceId, projectRoot: project.root });
        if (health.length) throw new Error(`Endpoint identity mismatch: ${health.join('; ')}`);
        if (instance.stopping) throw new Error('Backend stopped during startup');
        clearTimeout(timer); project.state = 'ready'; this.changed(); resolveReady(instance);
      })().catch((error) => { clearTimeout(timer); this.fail(id, instance, error instanceof Error ? error : new Error(String(error)), rejectReady); });
    });
    child.send({ type: 'start', projectRoot: project.root, projectId: id, instanceId: instance.instanceId, secret: instance.secret, webRoot: this.options.webRoot });
    void ready.catch((error: Error) => { project.error = error.message; if (project.state !== 'stopped') project.state = 'error'; this.changed(); });
    return ready;
  }
  headers(instance: Instance): Record<string, string> {
    if (instance.external && !instance.external.credentials) return {};
    return { 'x-stoneforge-project': instance.projectId, 'x-stoneforge-instance': instance.instanceId, 'x-stoneforge-secret': instance.secret };
  }
  async stop(id: string): Promise<void> {
    await this.starts.get(id)?.catch(() => {});
    const instance = this.instances.get(id);
    if (!instance) return;
    if (instance.stopping) return instance.stopping;
    const project = this.projects.get(id)!;
    project.state = 'stopping'; project.needsInput = false; this.changed();
    instance.stopping = (async () => {
      if (instance.external) {
        const external = instance.external;
        for (const path of ['/api/daemon/stop', '/api/sessions/stop-all']) {
          if (!await this.isCurrent(id, instance)) return;
          const response = await fetch(instance.endpoint + path, { method: 'POST',
            headers: { ...this.headers(instance), 'Content-Type': 'application/json' },
            body: JSON.stringify({ graceful: true }), signal: AbortSignal.timeout(30_000), redirect: 'error' });
          if (!response.ok) {
            if (path === '/api/daemon/stop' && response.status === 503) {
              const status = await fetch(instance.endpoint + '/api/daemon/status', { headers: this.headers(instance), signal: AbortSignal.timeout(3000), redirect: 'error' });
              if (status.ok && (await status.json() as { available?: boolean }).available === false) continue;
            }
            throw new Error(`Could not stop external server sessions (${response.status})`);
          }
        }
        if (await this.isCurrent(id, instance)) process.kill(external.pid, 'SIGTERM');
        for (let attempt = 0; attempt < 100; attempt++) {
          if (!await this.isCurrent(id, instance)) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error('External server did not stop. Check its terminal.');
      }
      // Disconnect also handles shutdown if sending the stop message fails.
      if (instance.child!.connected) instance.child!.send({ type: 'stop' });
      const timeout = setTimeout(() => instance.child!.kill('SIGTERM'), 46_000);
      const forceTimeout = setTimeout(() => instance.child!.kill('SIGKILL'), 51_000);
      try { await instance.exited; } finally { clearTimeout(timeout); clearTimeout(forceTimeout); }
    })();
    try { await instance.stopping; } catch (error) { instance.stopping = undefined; project.state = 'error'; project.error = String(error); this.changed(); throw error; }
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.starts.values()]);
    await Promise.all([...this.instances.keys()].map((id) => this.stop(id))); await this.logWrites;
  }
}

/** Human-readable differences between a reported and an expected backend identity (never includes secrets). */
function identityProblems(reported: Record<string, unknown>, expected: { projectId: string; instanceId: string; projectRoot: string }): string[] {
  const problems: string[] = [];
  if (reported.projectRoot !== expected.projectRoot) problems.push(`backend serves ${JSON.stringify(reported.projectRoot)} but the project is ${JSON.stringify(expected.projectRoot)}`);
  if (reported.projectId !== expected.projectId) problems.push('project ID differs');
  if (reported.instanceId !== expected.instanceId) problems.push('instance ID differs');
  return problems;
}
