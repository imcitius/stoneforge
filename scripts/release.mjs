#!/usr/bin/env node
/**
 * `pnpm release <version>` — Desktop release helper. Creates and pushes NOTHING.
 *
 * Releases of imcitius/stoneforge are the macOS Desktop builds produced by
 * .github/workflows/desktop-release.yml when a v* tag is pushed. This helper
 * validates the version with the same strict semver parser as package:mac,
 * checks that the current checkout is a clean commit without that tag, and
 * prints the exact commands to tag and push it. It never publishes npm
 * packages, never creates tags, and never creates GitHub releases (the former
 * scripts/release.ts npm publish / `gh release create v<version>` path was
 * removed so it cannot collide with Desktop tags).
 *
 *   pnpm release v1.26.0          # final release
 *   pnpm release v1.26.0-rc.1     # prerelease (any '-' suffix)
 *   pnpm release v1.26.0 --remote upstream-fork
 *
 * Operates on the Git repository of the current directory. Read-only network
 * checks (`git ls-remote`, `gh release view`) only warn when unavailable.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { parseReleaseVersion } from '../apps/desktop/scripts/release.mjs';

const REPO = 'imcitius/stoneforge';
const fail = (message) => { console.error(`release: ${message}`); process.exit(1); };
const warn = (message) => console.warn(`release: warning: ${message}`);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (...args) => { try { return git(...args); } catch { return null; } };

const argv = process.argv.slice(2);
let input; let remote = 'origin';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--remote') { remote = argv[++i]; if (!remote) fail('--remote requires a value'); }
  else if (argv[i] === '-h' || argv[i] === '--help') { console.log('Usage: pnpm release <vMAJOR.MINOR.PATCH[-PRERELEASE]> [--remote <name>]'); process.exit(0); }
  else if (argv[i].startsWith('-')) fail(`unknown option ${argv[i]} (this helper has no publish options; see apps/desktop/README.md "Releases")`);
  else if (input === undefined) input = argv[i];
  else fail(`unexpected argument ${argv[i]}`);
}
if (!input) fail('usage: pnpm release <vMAJOR.MINOR.PATCH[-PRERELEASE]>, e.g. pnpm release v1.26.0');

let version;
try { version = parseReleaseVersion(input); } catch (error) { fail(error.message); }
const tag = `v${version}`;
const prerelease = version.includes('-');

if (!tryGit('rev-parse', '--show-toplevel')) fail('not inside a Git checkout');
const head = git('rev-parse', 'HEAD');
const subject = git('log', '-1', '--format=%s', head);
const status = git('status', '--porcelain', '--untracked-files=normal');
if (status) fail(`working tree is not clean; tag a committed state only:\n${status}`);
if (tryGit('rev-parse', '-q', '--verify', `refs/tags/${tag}`)) fail(`tag ${tag} already exists locally (${git('rev-parse', `${tag}^{commit}`)}); choose a new version`);

const remoteTags = spawnSync('git', ['ls-remote', '--tags', remote, `refs/tags/${tag}`], { encoding: 'utf8' });
if (remoteTags.status !== 0) warn(`could not query ${remote} for ${tag}: ${(remoteTags.stderr || '').trim()}`);
else if (remoteTags.stdout.trim()) fail(`tag ${tag} already exists on ${remote}; choose a new version`);

const remoteMaster = tryGit('rev-parse', '-q', '--verify', `refs/remotes/${remote}/master`);
if (!remoteMaster) warn(`no ${remote}/master ref; make sure ${head.slice(0, 12)} is pushed before tagging`);
else if (remoteMaster !== head) warn(`HEAD ${head.slice(0, 12)} is not ${remote}/master (${remoteMaster.slice(0, 12)}); push master first or confirm you mean to release this commit`);

const gh = spawnSync('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'tagName'], { encoding: 'utf8' });
if (gh.error) warn('gh not available; the workflow will still refuse an existing release');
else if (gh.status === 0) fail(`GitHub release ${tag} already exists in ${REPO}`);
else if (!/release not found/.test(gh.stderr)) warn(`could not check GitHub release ${tag}: ${gh.stderr.trim()}`);

console.log(`Stoneforge Desktop ${tag} (${prerelease ? 'prerelease' : 'final release'}) from ${head}
  ${subject}

Nothing was created or pushed. To publish, run:

  git tag -a ${tag} -m "Stoneforge Desktop ${tag}" ${head}
  git push ${remote} ${tag}

The push starts .github/workflows/desktop-release.yml, which builds, verifies and
publishes the GitHub Release${prerelease ? ' (marked prerelease)' : ''}. Watch it with:

  gh run list --repo ${REPO} --workflow desktop-release.yml --limit 3
  gh run watch --repo ${REPO} <run-id> --exit-status
`);
