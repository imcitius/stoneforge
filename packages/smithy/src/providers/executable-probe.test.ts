/**
 * Regression tests for the provider executable probe: configured executable
 * paths must be passed as argv, never interpolated into a shell command.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isExecutableAvailable } from './executable-probe.js';
import { ClaudeInteractiveProvider } from './claude/interactive.js';
import { CodexInteractiveProvider } from './codex/interactive.js';
import { OpenCodeInteractiveProvider } from './opencode/interactive.js';

describe.skipIf(process.platform === 'win32')('isExecutableAvailable (POSIX argv)', () => {
  let root: string;
  let marker: string;
  let argsLog: string;
  let executable: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stoneforge-probe-'));
    marker = join(root, 'injected');
    argsLog = join(root, 'args.log');
    // Directory name contains a space and a command substitution that would
    // create `marker` if the path were ever evaluated by a shell. The marker
    // path comes from the environment because path segments cannot contain '/'.
    process.env.STONEFORGE_PROBE_MARKER = marker;
    const dir = join(root, 'with space $(touch "$STONEFORGE_PROBE_MARKER")');
    mkdirSync(dir);
    executable = join(dir, 'fake-cli');
    writeFileSync(
      executable,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsLog}'\n[ "$1" = "--version" ] && exit 0\nexit 3\n`,
    );
    chmodSync(executable, 0o755);
  });

  afterEach(() => {
    delete process.env.STONEFORGE_PROBE_MARKER;
    rmSync(root, { recursive: true, force: true });
  });

  test('runs an executable whose path has spaces and $(...) without a shell', async () => {
    expect(await isExecutableAvailable(executable)).toBe(true);
    expect(readFileSync(argsLog, 'utf8')).toBe('--version\n');
    expect(existsSync(marker)).toBe(false);
  });

  test('does not execute shell metacharacters in a missing executable path', async () => {
    expect(await isExecutableAvailable('definitely-missing-cli; touch "$STONEFORGE_PROBE_MARKER"')).toBe(false);
    expect(await isExecutableAvailable('$(touch "$STONEFORGE_PROBE_MARKER")')).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  test('reports false when the executable exits non-zero', async () => {
    const failing = join(root, 'failing-cli');
    writeFileSync(failing, '#!/bin/sh\nexit 1\n');
    chmodSync(failing, 0o755);
    expect(await isExecutableAvailable(failing)).toBe(false);
  });

  test.each([
    ['claude', (p: string) => new ClaudeInteractiveProvider(p)],
    ['codex', (p: string) => new CodexInteractiveProvider(p)],
    ['opencode', (p: string) => new OpenCodeInteractiveProvider(p)],
  ])('%s interactive provider isAvailable() uses the argv probe', async (_name, create) => {
    expect(await create(executable).isAvailable()).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(await create('missing-cli $(touch "$STONEFORGE_PROBE_MARKER")').isAvailable()).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });
});
