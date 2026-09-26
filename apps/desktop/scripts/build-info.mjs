import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function collectBuildInfo(root, version) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let commit = 'unknown', branch = 'unknown', dirty = false;
  try {
    commit = git('rev-parse', 'HEAD');
    branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    dirty = !!git('status', '--porcelain', '--untracked-files=normal');
  } catch { /* Source archives have no Git metadata. Never infer an installed build from the user's checkout. */ }
  return { version, commit, branch, dirty, builtAt: new Date().toISOString() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { version } = JSON.parse(readFileSync(resolve(desktop, 'package.json'), 'utf8'));
  writeFileSync(resolve(process.argv[2] ?? resolve(desktop, 'dist/build-info.json')), JSON.stringify(collectBuildInfo(resolve(desktop, '../..'), version), null, 2) + '\n');
}
