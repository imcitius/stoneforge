import { expect, test } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexInteractiveProvider } from './interactive.js';
import type { InteractiveSession } from '../types.js';

test.skipIf(process.platform === 'win32')('interactive Codex gets color capabilities despite a monochrome parent and shell profile', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stoneforge-codex-color-'));
  const originalNoColor = process.env.NO_COLOR;
  let session: InteractiveSession | undefined;
  try {
    const executable = join(directory, 'fake-codex');
    const profile = join(directory, 'profile');
    writeFileSync(profile, 'export NO_COLOR=1 TERM=dumb COLORTERM=\n');
    writeFileSync(executable, `#!/bin/sh
if [ -z "\${NO_COLOR+x}" ] && [ "$TERM" = xterm-256color ] && [ "$COLORTERM" = truecolor ]; then
  printf '\\033[32mCOLOR_READY\\033[0m\\n'
else
  printf 'MONOCHROME\\n'
  exit 1
fi
`, { mode: 0o755 });
    process.env.NO_COLOR = '1';
    session = await new CodexInteractiveProvider(executable).spawn({
      workingDirectory: directory,
      environmentVariables: { BASH_ENV: profile, TERM: 'dumb', COLORTERM: '' },
    });
    const activeSession = session;
    const output = await new Promise<string>((resolve, reject) => {
      let data = '';
      const timeout = setTimeout(() => reject(new Error('PTY did not exit')), 5000);
      activeSession.onData(chunk => { data += chunk; });
      activeSession.onExit(code => {
        clearTimeout(timeout);
        if (code !== 0) reject(new Error(`PTY exited ${code}: ${data}`));
        else resolve(data);
      });
    });
    expect(output).toContain('\x1b[32mCOLOR_READY\x1b[0m');
    expect(process.env.NO_COLOR).toBe('1');
  } finally {
    try { session?.kill(); } catch { /* Already exited. */ }
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    rmSync(directory, { recursive: true, force: true });
  }
}, 10000);
