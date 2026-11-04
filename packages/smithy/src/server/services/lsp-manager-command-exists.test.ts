/**
 * LSP Manager — commandExists argv safety regressions (el-q5hq59)
 *
 * commandExists() used to run `which ${cmd}` through a shell. It now runs
 * `which` with the command name as one argv element. These tests check that
 * a name containing shell metacharacters is looked up literally (nothing is
 * executed), that ordinary found/not-found lookups keep working, and — as a
 * negative control — that the old shell-string implementation fails the same
 * assertions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { commandExists } from './lsp-manager.js';

/** Previous implementation, kept only as a negative control. */
async function oldCommandExists(cmd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    execSync(`which ${cmd}`, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe', env });
    return true;
  } catch {
    return false;
  }
}

type Impl = (cmd: string, env: NodeJS.ProcessEnv) => Promise<boolean>;

describe('lsp-manager commandExists argv safety', () => {
  let tmp: string;
  let binDir: string;
  let env: NodeJS.ProcessEnv;

  // A real executable whose name contains shell metacharacters.
  const LITERAL_NAME = 'fake-lsp;$(echo x)`echo y`';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-which-'));
    binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir);
    const exe = path.join(binDir, LITERAL_NAME);
    fs.writeFileSync(exe, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(exe, 0o755);
    env = { ...process.env, PATH: [binDir, '/usr/bin', '/bin'].join(path.delimiter) };
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function hostileNames(): Array<{ name: string; sentinel: string }> {
    const s = (tag: string) => path.join(tmp, `PWN_${tag}`);
    return [
      { name: `lsp-missing-q5hq59;touch ${s('semicolon')}`, sentinel: s('semicolon') },
      { name: `$(touch ${s('subst')})`, sentinel: s('subst') },
      { name: `\`touch ${s('tick')}\``, sentinel: s('tick') },
      { name: `lsp-missing-q5hq59 && touch ${s('and')}`, sentinel: s('and') },
      { name: `lsp-missing-q5hq59 || touch ${s('or')}`, sentinel: s('or') },
    ];
  }

  /** Runs every behavioural assertion against an implementation; returns failures. */
  async function violations(impl: Impl): Promise<string[]> {
    const failures: string[] = [];
    for (const { name, sentinel } of hostileNames()) {
      const result = await impl(name, env);
      if (result !== false) failures.push(`${name}: returned ${result}`);
      if (fs.existsSync(sentinel)) failures.push(`${name}: executed (${path.basename(sentinel)} created)`);
    }
    if ((await impl(LITERAL_NAME, env)) !== true) failures.push('literal metacharacter name not found');
    if ((await impl('sh', env)) !== true) failures.push('sh not found');
    if ((await impl('lsp-missing-q5hq59', env)) !== false) failures.push('missing command reported found');
    return failures;
  }

  it('treats shell metacharacters literally and never executes them', async () => {
    for (const { name, sentinel } of hostileNames()) {
      expect(await commandExists(name, env), name).toBe(false);
      expect(fs.existsSync(sentinel), `${path.basename(sentinel)} created`).toBe(false);
    }
  });

  it('finds an executable whose name contains shell metacharacters', async () => {
    expect(await commandExists(LITERAL_NAME, env)).toBe(true);
  });

  it('keeps normal found / not-found behaviour', async () => {
    expect(await commandExists('sh', env)).toBe(true);
    expect(await commandExists('lsp-missing-q5hq59', env)).toBe(false);
    // Default env (process.env) still works.
    expect(await commandExists('lsp-missing-q5hq59')).toBe(false);
  });

  it('current implementation passes every assertion', async () => {
    expect(await violations(commandExists)).toEqual([]);
  });

  it('negative control: old shell-string implementation fails the same assertions', async () => {
    const failures = await violations(oldCommandExists);
    expect(failures.some((f) => f.includes('executed'))).toBe(true);
    expect(failures).toContain('literal metacharacter name not found');
  });
});
