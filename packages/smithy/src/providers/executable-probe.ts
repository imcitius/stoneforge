/**
 * Executable availability probe shared by the interactive providers.
 *
 * Runs `<executablePath> --version` and reports whether it exited successfully.
 * On POSIX hosts the executable path is passed as an argv entry via
 * `execFileSync`, so paths containing spaces or shell metacharacters such as
 * `$(...)`, `;` or backticks are neither split nor interpreted by a shell.
 *
 * Windows keeps a `cmd.exe` invocation so `.cmd`/`.bat` shims installed by
 * npm (e.g. `claude.cmd`) still resolve; Node refuses to run those without a
 * shell. The path is quoted with the platform-aware {@link shellQuote}, matching
 * how the interactive providers compose their PTY commands.
 *
 * @module
 */

import { shellQuote } from './shell-quote.js';

/**
 * Resolves true when `<executablePath> --version` exits with status 0.
 *
 * `node:child_process` is imported lazily so test suites that replace that
 * module with a partial mock (e.g. only `spawn`) can still load the providers.
 */
export async function isExecutableAvailable(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  try {
    const { execFileSync, execSync } = await import('node:child_process');
    if (platform === 'win32') {
      execSync(`${shellQuote(executablePath, platform)} --version`, { stdio: 'ignore' });
    } else {
      execFileSync(executablePath, ['--version'], { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}
