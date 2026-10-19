/**
 * Project Node selection.
 *
 * Stoneforge itself (backend, `sf`, native SQLite) runs on its own pinned
 * runtime — in Desktop that is the bundled Node. Code repositories managed by
 * a project may require a different Node (package.json `engines.node`,
 * `.nvmrc`, `.node-version`). This module selects a compatible Node executable
 * for project work — dependency installation, worker sessions and project
 * checks — without changing the runtime used by Stoneforge itself.
 *
 * Rules:
 * - A repository without a Node requirement is left untouched.
 * - An explicitly configured executable is authoritative: it is validated and
 *   never silently replaced by a discovered one.
 * - Otherwise only already installed executables are considered (PATH and
 *   common version-manager directories). Nothing is downloaded or installed.
 * - When no compatible executable exists, callers receive a
 *   {@link ProjectNodeError} with actionable guidance before anything runs.
 *
 * The selected Node is exposed through a private shim directory prepended to
 * PATH. The shim links only `node` and its package-manager tools (`npm`,
 * `npx`, `corepack`, `pnpm`, `yarn`) from the selected Node's directory —
 * never `sf` — so the Stoneforge CLI keeps resolving to its own runtime.
 *
 * @module
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Node toolchain executables exposed from the selected Node's directory.
 * Only these are linked: a Node in a shared directory such as
 * /opt/homebrew/bin must not reorder unrelated tools (agent CLIs, git) or
 * shadow Stoneforge's own `sf`, which keeps resolving to its runtime.
 */
const TOOLCHAIN_EXECUTABLES = new Set(['npm', 'npx', 'corepack', 'pnpm', 'pnpx', 'yarn', 'yarnpkg']);

// ============================================================================
// Version ranges (subset of npm semver sufficient for engines.node)
// ============================================================================

type Version = [number, number, number];
type Comparator = { op: '>=' | '<' | '<=' | '>' | '='; version: Version };

interface Partial {
  major: number | null;
  minor: number | null;
  patch: number | null;
}

function parsePartial(text: string): Partial | null {
  const match = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(text.trim());
  if (!match) return null;
  const part = (value: string | undefined) => (value === undefined || /^[xX*]$/.test(value) ? null : Number(value));
  const major = part(match[1]);
  const minor = major === null ? null : part(match[2]);
  const patch = minor === null ? null : part(match[3]);
  return { major, minor, patch };
}

/** Parses "v24.22.0" (or "24.22.0") into a numeric triple. */
export function parseNodeVersion(text: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function floor(p: Partial): Version {
  return [p.major ?? 0, p.minor ?? 0, p.patch ?? 0];
}

/** Exclusive upper bound of a partial version ("24" → 25.0.0, "24.1" → 24.2.0). */
function ceiling(p: Partial): Version | null {
  if (p.major === null) return null;
  if (p.minor === null) return [p.major + 1, 0, 0];
  if (p.patch === null) return [p.major, p.minor + 1, 0];
  return null;
}

function expand(token: string): Comparator[] {
  const operator = /^(>=|<=|>|<|=|\^|~)?\s*(.*)$/.exec(token)!;
  const op = operator[1] ?? '';
  const p = parsePartial(operator[2]);
  if (!p) throw new Error(`Unsupported version token "${token}"`);
  if (p.major === null) return op === '<' || op === '>' ? [{ op: '<', version: [0, 0, 0] }] : [];
  const low = floor(p);
  const high = ceiling(p);
  switch (op) {
    case '':
    case '=':
      return high ? [{ op: '>=', version: low }, { op: '<', version: high }] : [{ op: '=', version: low }];
    case '>=':
      return [{ op: '>=', version: low }];
    case '>':
      return high ? [{ op: '>=', version: high }] : [{ op: '>', version: low }];
    case '<':
      return [{ op: '<', version: low }];
    case '<=':
      return high ? [{ op: '<', version: high }] : [{ op: '<=', version: low }];
    case '~':
      return [{ op: '>=', version: low }, { op: '<', version: p.minor === null ? [low[0] + 1, 0, 0] : [low[0], low[1] + 1, 0] }];
    case '^': {
      let upper: Version;
      if (low[0] > 0 || p.minor === null) upper = [low[0] + 1, 0, 0];
      else if (low[1] > 0 || p.patch === null) upper = [0, low[1] + 1, 0];
      else upper = [0, 0, low[2] + 1];
      return [{ op: '>=', version: low }, { op: '<', version: upper }];
    }
    default:
      throw new Error(`Unsupported version token "${token}"`);
  }
}

function parseRange(range: string): Comparator[][] {
  return range.split('||').map((set) => {
    const text = set.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1');
    if (text === '' || text === '*' || /^[xX]$/.test(text)) return [];
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
    if (hyphen) {
      const from = parsePartial(hyphen[1]);
      const to = parsePartial(hyphen[2]);
      if (!from || !to) throw new Error(`Unsupported version range "${range}"`);
      const upper = ceiling(to);
      return [
        { op: '>=', version: floor(from) },
        ...(to.major === null ? [] : [upper ? { op: '<' as const, version: upper } : { op: '<=' as const, version: floor(to) }]),
      ];
    }
    return text.split(/\s+/).flatMap(expand);
  });
}

/** Whether `version` satisfies an npm-style range such as ">=24.22.0 <25". */
export function satisfiesNodeRange(version: string | Version, range: string): boolean {
  const v = typeof version === 'string' ? parseNodeVersion(version) : version;
  if (!v) return false;
  return parseRange(range).some((set) => set.every(({ op, version: bound }) => {
    const c = compare(v, bound);
    return op === '>=' ? c >= 0 : op === '>' ? c > 0 : op === '<' ? c < 0 : op === '<=' ? c <= 0 : c === 0;
  }));
}

/** Throws when a range cannot be interpreted. */
export function validateNodeRange(range: string): void {
  parseRange(range);
}

// ============================================================================
// Requirements
// ============================================================================

export interface NodeRequirement {
  /** package.json engines.node */
  readonly engines?: string;
  /** Version from .nvmrc / .node-version (numeric only) */
  readonly versionFile?: { readonly file: string; readonly version: string };
  /** Version-file aliases that cannot be resolved without a version manager */
  readonly ignored?: string;
}

/** Reads the Node requirement declared by a checkout; undefined when there is none. */
export function readNodeRequirement(directory: string): NodeRequirement | undefined {
  let engines: string | undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')) as { engines?: { node?: unknown } };
    if (typeof pkg.engines?.node === 'string' && pkg.engines.node.trim()) engines = pkg.engines.node.trim();
  } catch {
    // Missing or unreadable package.json: no engines requirement.
  }
  let versionFile: NodeRequirement['versionFile'];
  let ignored: string | undefined;
  for (const file of ['.nvmrc', '.node-version']) {
    let content: string;
    try { content = fs.readFileSync(path.join(directory, file), 'utf8'); } catch { continue; }
    const value = content.split(/\r?\n/)[0]?.trim() ?? '';
    if (!value) continue;
    if (parsePartial(value) && /^v?\d/.test(value)) versionFile = { file, version: value.replace(/^v/, '') };
    else ignored = `${file} "${value}"`;
    break;
  }
  if (!engines && !versionFile) return undefined;
  return { engines, versionFile, ...(ignored ? { ignored } : {}) };
}

function describeRequirement(req: NodeRequirement): string {
  const parts: string[] = [];
  if (req.engines) parts.push(`package.json engines.node "${req.engines}"`);
  if (req.versionFile) parts.push(`${req.versionFile.file} ${req.versionFile.version}`);
  return parts.join(', ');
}

/**
 * Whether a version is acceptable. engines.node is the binding constraint
 * (it is what package managers enforce); a version file alone is used when
 * no engines range is declared.
 */
function acceptable(version: Version, req: NodeRequirement): boolean {
  if (req.engines) return satisfiesNodeRange(version, req.engines);
  return req.versionFile ? satisfiesNodeRange(version, req.versionFile.version) : true;
}

function preferred(version: Version, req: NodeRequirement): boolean {
  return req.versionFile ? satisfiesNodeRange(version, req.versionFile.version) : false;
}

// ============================================================================
// Resolution
// ============================================================================

export type ProjectNodeSource = 'explicit' | 'path' | 'version-manager';

export interface ProjectNodeCandidate {
  readonly path: string;
  readonly source: ProjectNodeSource;
  readonly version?: string;
  readonly error?: string;
}

export type ProjectNodeResolution =
  | { readonly status: 'unconstrained' }
  | {
      readonly status: 'selected';
      readonly node: string;
      readonly version: string;
      readonly source: ProjectNodeSource;
      readonly requirement: NodeRequirement;
    };

export class ProjectNodeError extends Error {
  readonly code = 'PROJECT_NODE_INCOMPATIBLE';
  constructor(
    message: string,
    readonly directory: string,
    readonly requirement: NodeRequirement | undefined,
    readonly candidates: readonly ProjectNodeCandidate[],
  ) {
    super(message);
    this.name = 'ProjectNodeError';
  }
}

export interface ResolveProjectNodeOptions {
  /** Explicitly configured executable (absolute path). Authoritative when set. */
  readonly explicitNode?: string;
  /** Environment used for PATH discovery and HOME (default: process.env). */
  readonly env?: NodeJS.ProcessEnv;
  /** Installation prefixes that may contain Homebrew `opt/node@N` (default /opt/homebrew, /usr/local). */
  readonly systemPrefixes?: readonly string[];
  /** Hint for the remediation message, e.g. the repository ID. */
  readonly repositoryId?: string;
}

function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function listDir(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function discoverCandidates(env: NodeJS.ProcessEnv, prefixes: readonly string[]): Array<{ path: string; source: ProjectNodeSource }> {
  const found: Array<{ path: string; source: ProjectNodeSource }> = [];
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir && path.isAbsolute(dir)) found.push({ path: path.join(dir, 'node'), source: 'path' });
  }
  const home = env.HOME ?? '';
  const managed: string[] = [];
  const versions = (root: string, suffix: string) => {
    for (const name of listDir(root)) managed.push(path.join(root, name, suffix));
  };
  if (home) {
    versions(path.join(env.NVM_DIR || path.join(home, '.nvm'), 'versions/node'), 'bin/node');
    versions(path.join(home, '.local/share/fnm/node-versions'), 'installation/bin/node');
    versions(path.join(home, 'Library/Application Support/fnm/node-versions'), 'installation/bin/node');
    versions(path.join(home, '.volta/tools/image/node'), 'bin/node');
    versions(path.join(home, '.asdf/installs/nodejs'), 'bin/node');
    versions(path.join(home, '.local/share/mise/installs/node'), 'bin/node');
  }
  for (const prefix of prefixes) {
    for (const name of listDir(path.join(prefix, 'opt'))) {
      if (/^node(@\d+)?$/.test(name)) managed.push(path.join(prefix, 'opt', name, 'bin/node'));
    }
    versions(path.join(prefix, 'n/versions/node'), 'bin/node');
  }
  for (const file of managed) found.push({ path: file, source: 'version-manager' });
  return found;
}

async function probeVersion(node: string): Promise<{ version?: string; error?: string }> {
  try {
    const { stdout } = await execFileAsync(node, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '' },
    });
    const version = stdout.trim();
    return parseNodeVersion(version) ? { version } : { error: `unrecognized --version output "${version.slice(0, 80)}"` };
  } catch (error) {
    return { error: (error as Error).message.split('\n')[0] };
  }
}

/** Validates an explicitly configured Node executable and returns its version. */
export async function validateNodeExecutable(node: string): Promise<string> {
  if (!path.isAbsolute(node)) throw new Error(`Node path must be absolute: ${node}`);
  if (!isExecutableFile(node)) throw new Error(`Node path is not an executable file: ${node}`);
  const probe = await probeVersion(node);
  if (!probe.version) throw new Error(`Could not run ${node} --version: ${probe.error}`);
  return probe.version;
}

/**
 * Selects the Node executable for project work in `directory`.
 * Throws {@link ProjectNodeError} when the project declares a requirement and
 * no compatible executable is available.
 */
export async function resolveProjectNode(directory: string, options: ResolveProjectNodeOptions = {}): Promise<ProjectNodeResolution> {
  const requirement = readNodeRequirement(directory);
  const env = options.env ?? process.env;
  if (!requirement && !options.explicitNode) return { status: 'unconstrained' };
  const req = requirement ?? {};
  if (req.engines) {
    try { validateNodeRange(req.engines); }
    catch (error) {
      throw new ProjectNodeError(
        `Project at ${directory} declares engines.node "${req.engines}", which Stoneforge cannot interpret (${(error as Error).message}). Fix the range or run the work manually.`,
        directory, requirement, []);
    }
  }

  const fail = (candidates: ProjectNodeCandidate[], explicit: boolean): never => {
    const tried = candidates.length
      ? candidates.map((c) => `  - ${c.path} (${c.version ?? c.error ?? 'unknown'}${c.source === 'explicit' ? ', configured' : ''})`).join('\n')
      : '  (no Node executables found)';
    const repo = options.repositoryId ?? '<repository-id>';
    const versionHint = req.versionFile?.version ?? (req.engines ? `a version matching "${req.engines}"` : 'a compatible version');
    const lines = [
      explicit
        ? `Configured Node for project at ${directory} is not usable for ${describeRequirement(req) || 'this project'}.`
        : `Project at ${directory} requires Node ${describeRequirement(req)}, but no compatible Node executable is installed.`,
      'Checked:',
      tried,
      ...(req.ignored ? [`Ignored ${req.ignored} (aliases need a version manager).`] : []),
      "Stoneforge's own runtime is used only for Stoneforge itself; it is not substituted for project commands.",
      'Fix: install ' + versionHint + ' (for example with nvm, fnm, Volta or Homebrew), or configure it explicitly:',
      `  sf repo update ${repo} --node-path /absolute/path/to/bin/node`,
      'Dependency installation and worker start were not attempted.',
    ];
    throw new ProjectNodeError(lines.join('\n'), directory, requirement, candidates);
  };

  if (options.explicitNode) {
    const node = options.explicitNode;
    if (!path.isAbsolute(node) || !isExecutableFile(node)) {
      fail([{ path: node, source: 'explicit', error: 'not an absolute path to an executable file' }], true);
    }
    const probe = await probeVersion(node);
    const candidate: ProjectNodeCandidate = { path: node, source: 'explicit', ...probe };
    const version = probe.version ? parseNodeVersion(probe.version) : null;
    if (!version || !acceptable(version, req)) fail([candidate], true);
    return { status: 'selected', node, version: probe.version!, source: 'explicit', requirement: req };
  }

  const seen = new Set<string>();
  const unique: Array<{ path: string; source: ProjectNodeSource }> = [];
  for (const candidate of discoverCandidates(env, options.systemPrefixes ?? ['/opt/homebrew', '/usr/local'])) {
    if (!isExecutableFile(candidate.path)) continue;
    let real: string;
    try { real = fs.realpathSync(candidate.path); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    unique.push(candidate);
  }
  const probed: ProjectNodeCandidate[] = await Promise.all(unique.map(async (c) => ({ ...c, ...(await probeVersion(c.path)) })));
  const compatible = probed
    .map((c, index) => ({ c, index, version: c.version ? parseNodeVersion(c.version) : null }))
    .filter((entry): entry is { c: ProjectNodeCandidate; index: number; version: Version } => !!entry.version && acceptable(entry.version, req));
  if (!compatible.length) fail(probed, false);
  compatible.sort((a, b) =>
    Number(preferred(b.version, req)) - Number(preferred(a.version, req)) ||
    // PATH order expresses the user's preference; managers follow, newest first.
    Number(b.c.source === 'path') - Number(a.c.source === 'path') ||
    (a.c.source === 'path' ? a.index - b.index : compare(b.version, a.version)));
  const best = compatible[0].c;
  return { status: 'selected', node: best.path, version: best.version!, source: best.source, requirement: req };
}

// ============================================================================
// Environment
// ============================================================================

function shimDirectoryRoot(stoneforgeRoot?: string): string {
  if (stoneforgeRoot) return path.join(stoneforgeRoot, '.stoneforge', '.runtime', 'node-shims');
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  return path.join(os.tmpdir(), `stoneforge-node-shims-${uid}`);
}

/**
 * Creates (or reuses) a directory of links exposing the selected Node and its
 * sibling package-manager tools.
 */
export function ensureNodeShimDirectory(node: string, stoneforgeRoot?: string): string {
  const binDir = path.dirname(node);
  const links = new Map<string, string>([['node', node]]);
  for (const name of listDir(binDir)) {
    if (!TOOLCHAIN_EXECUTABLES.has(name)) continue;
    const file = path.join(binDir, name);
    if (isExecutableFile(file)) links.set(name, file);
  }
  const manifest = JSON.stringify([...links.entries()].sort());
  const root = shimDirectoryRoot(stoneforgeRoot);
  const target = path.join(root, createHash('sha256').update(node).digest('hex').slice(0, 16));
  try {
    if (fs.readFileSync(path.join(target, '.manifest.json'), 'utf8') === manifest) return target;
  } catch {
    // Missing or stale shim directory; rebuild below.
  }
  fs.mkdirSync(root, { recursive: true });
  if (stoneforgeRoot) {
    // Generated links must never show up as untracked files when the project
    // root is itself a Git checkout.
    const ignore = path.join(stoneforgeRoot, '.stoneforge', '.runtime', '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  }
  const staging = `${target}.${randomBytes(6).toString('hex')}`;
  fs.mkdirSync(staging);
  for (const [name, file] of links) fs.symlinkSync(file, path.join(staging, name));
  fs.writeFileSync(path.join(staging, '.manifest.json'), manifest);
  try {
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    // A concurrent caller may have installed an identical directory first.
    try { if (fs.readFileSync(path.join(target, '.manifest.json'), 'utf8') === manifest) return target; } catch { /* fall through */ }
    throw error;
  }
  return target;
}

/**
 * Environment overrides that make project commands use the selected Node.
 * Returns an empty object for unconstrained projects.
 */
export function projectNodeEnvironment(
  resolution: ProjectNodeResolution,
  basePath: string | undefined,
  stoneforgeRoot?: string,
): Record<string, string> {
  if (resolution.status !== 'selected') return {};
  const shim = ensureNodeShimDirectory(resolution.node, stoneforgeRoot);
  const rest = (basePath ?? '').split(path.delimiter).filter((dir) => dir && dir !== shim);
  return {
    PATH: [shim, ...rest].join(path.delimiter),
    STONEFORGE_PROJECT_NODE: resolution.node,
  };
}
