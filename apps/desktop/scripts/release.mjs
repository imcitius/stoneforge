/** Release version, tree-state and artifact naming rules shared by packaging scripts and tests. */
import { execFileSync } from 'node:child_process';

// Semantic Versioning 2.0.0 (semver.org): no leading zeros in numeric identifiers.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export const RELEASE_VERSION_ENV = 'STONEFORGE_RELEASE_VERSION';
export const RELEASE_ARCH = 'arm64';
export const PRODUCT_FILE_NAME = 'Stoneforge-Desktop';

/** Parse a release tag (`v1.26.0`, `v1.26.0-rc.1`) or bare version into a strict semver string. */
export function parseReleaseVersion(input) {
  if (typeof input !== 'string') throw new Error('Release version must be a string such as v1.26.0');
  const raw = input.trim();
  const version = raw.startsWith('v') ? raw.slice(1) : raw;
  if (!SEMVER.test(version)) {
    throw new Error(`Invalid release version "${input}": expected strict semver MAJOR.MINOR.PATCH[-PRERELEASE], optionally prefixed with "v" (e.g. v1.26.0 or v1.26.0-rc.1)`);
  }
  // Build metadata ("+...") is not allowed in artifact names/CFBundleVersion and has no ordering meaning.
  if (version.includes('+')) throw new Error(`Invalid release version "${input}": build metadata (+...) is not supported for Desktop releases`);
  return version;
}

export function isPrerelease(version) {
  return parseReleaseVersion(version).includes('-');
}

/**
 * Release version from `--version X`, `--version=X` or STONEFORGE_RELEASE_VERSION.
 * Returns null when neither is set (local build). Conflicting values are rejected.
 */
export function resolveReleaseVersion(argv = [], env = {}) {
  let fromArgs = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--version') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--version requires a value such as v1.26.0');
      fromArgs = value; i++;
    } else if (arg.startsWith('--version=')) fromArgs = arg.slice('--version='.length);
  }
  const fromEnv = env[RELEASE_VERSION_ENV] ? env[RELEASE_VERSION_ENV] : null;
  if (fromArgs === null && fromEnv === null) return null;
  const parsedArgs = fromArgs === null ? null : parseReleaseVersion(fromArgs);
  const parsedEnv = fromEnv === null ? null : parseReleaseVersion(fromEnv);
  if (parsedArgs && parsedEnv && parsedArgs !== parsedEnv) {
    throw new Error(`Conflicting release versions: --version ${parsedArgs} but ${RELEASE_VERSION_ENV}=${parsedEnv}`);
  }
  return parsedArgs ?? parsedEnv;
}

export function gitHead(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** A release must be built from exactly HEAD of a clean Git tree. Throws a descriptive error otherwise. */
export function assertReleaseTree(build, head) {
  const problems = [];
  if (!head) problems.push('no Git HEAD found (release builds require a Git checkout)');
  if (!build || build.commit === 'unknown') problems.push('build-info has no commit');
  else if (head && build.commit !== head) problems.push(`build-info commit ${build.commit} != HEAD ${head}`);
  if (!build || build.dirty !== false) problems.push('working tree is dirty (commit or remove modified/untracked files; see `git status --porcelain`)');
  if (problems.length) {
    throw new Error(`Refusing to build release ${build?.version ?? '(unknown version)'}: ${problems.join('; ')}`);
  }
}

/** Deterministic release file names for a version. */
export function artifactNames(version, arch = RELEASE_ARCH) {
  const v = parseReleaseVersion(version);
  if (arch !== RELEASE_ARCH) throw new Error(`Unsupported release architecture ${arch}; only ${RELEASE_ARCH} is released`);
  const base = `${PRODUCT_FILE_NAME}-${v}-${arch}`;
  return { zip: `${base}.zip`, dmg: `${base}.dmg`, sums: 'SHA256SUMS.txt', volumeName: `Stoneforge Desktop ${v}` };
}

/** sha256sum/shasum -c compatible lines, sorted by file name. */
export function formatChecksums(entries) {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, sha256 }) => {
      if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Invalid SHA-256 for ${name}`);
      if (name.includes('/') || name.includes('\n')) throw new Error(`Invalid checksum file name ${JSON.stringify(name)}`);
      return `${sha256}  ${name}\n`;
    }).join('');
}
