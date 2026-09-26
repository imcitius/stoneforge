/**
 * Codex Interactive Provider
 *
 * Implements the InteractiveProvider interface by spawning the `codex` CLI
 * in a PTY. Mirrors the OpenCode interactive provider pattern.
 *
 * @module
 */

import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type {
  InteractiveProvider,
  InteractiveSession,
  InteractiveSpawnOptions,
  ProviderSessionId,
} from '../types.js';
import { shellQuote } from '../shell-quote.js';

// ============================================================================
// Helpers
// ============================================================================

type CodexInteractiveArgOptions = Pick<
  InteractiveSpawnOptions,
  'resumeSessionId' | 'workingDirectory' | 'model' | 'stoneforgeRoot' | 'environmentVariables'
>;

const CODEX_RESUME_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_CONTINUE_SESSION_PATTERN =
  /To continue this session,\s+run\s+codex\s+resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const ANSI_ESCAPE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const MAX_CODEX_OUTPUT_BUFFER = 4096;

export function isCodexResumeSessionId(value: string): value is ProviderSessionId {
  return CODEX_RESUME_SESSION_ID_PATTERN.test(value);
}

export function extractCodexResumeSessionId(output: string): ProviderSessionId | undefined {
  const normalizedOutput = output.replace(ANSI_ESCAPE_PATTERN, '');
  return normalizedOutput.match(CODEX_CONTINUE_SESSION_PATTERN)?.[1];
}

export function createCodexResumeSessionIdDetector(
  maxBufferLength = MAX_CODEX_OUTPUT_BUFFER,
): (chunk: string) => ProviderSessionId | undefined {
  let buffer = '';

  return (chunk: string) => {
    buffer = (buffer + chunk).slice(-maxBufferLength);
    return extractCodexResumeSessionId(buffer);
  };
}

export function writeCodexExitCommand(
  write: (data: string) => void,
  scheduleEnter: (callback: () => void) => void = (callback) => {
    setTimeout(callback, 50);
  },
): void {
  write('/exit');
  scheduleEnter(() => write('\r'));
}

export function buildCodexInteractiveArgs(
  options: CodexInteractiveArgOptions,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const quote = (value: string) => shellQuote(value, platform);
  const args: string[] = [];

  if (options.resumeSessionId) {
    if (!isCodexResumeSessionId(options.resumeSessionId)) {
      throw new Error(`Invalid Codex resume session ID: ${options.resumeSessionId}`);
    }
    args.push('resume', quote(options.resumeSessionId), '--sandbox', 'workspace-write');
  } else {
    args.push('--sandbox', 'workspace-write', '--cd', quote(options.workingDirectory));
  }

  if (options.model) {
    args.push('--model', quote(options.model));
  }

  if (options.stoneforgeRoot) {
    // Pin command-tool context as well as the Codex process environment. Login
    // profiles and a persisted shell snapshot can otherwise restore an old PATH.
    const environment = {
      PATH: options.environmentVariables?.PATH ?? process.env.PATH ?? '',
      ...options.environmentVariables,
      STONEFORGE_ROOT: options.stoneforgeRoot,
      ...(process.env.STONEFORGE_DESKTOP_INSTANCE_ID ? { STONEFORGE_DESKTOP_INSTANCE_ID: process.env.STONEFORGE_DESKTOP_INSTANCE_ID } : {}),
    };
    args.push('-c', quote('allow_login_shell=false'), '-c', quote('features.shell_snapshot=false'));
    if (process.env.STONEFORGE_DESKTOP_INSTANCE_ID) {
      // sf daemon/agent commands reach this session's authenticated loopback API.
      args.push('-c', quote('sandbox_workspace_write.network_access=true'));
    }
    for (const [key, value] of Object.entries(environment)) {
      if (['PATH', 'SF_ENTITY_ID', 'STONEFORGE_ROOT', 'STONEFORGE_DESKTOP_INSTANCE_ID'].includes(key)) {
        args.push('-c', quote(`shell_environment_policy.set.${key}=${JSON.stringify(value)}`));
      }
    }
    // Agent worktrees share workspace data with the project root.
    args.push('--add-dir', quote(options.stoneforgeRoot));
  }

  return args;
}

// ============================================================================
// Codex Interactive Session
// ============================================================================

class CodexInteractiveSession implements InteractiveSession {
  private ptyProcess: IPty;
  private sessionId: ProviderSessionId | undefined;
  private readonly detectResumeSessionId = createCodexResumeSessionIdDetector();

  readonly pid?: number;

  constructor(ptyProcess: IPty, resumeSessionId?: ProviderSessionId) {
    this.ptyProcess = ptyProcess;
    this.pid = ptyProcess.pid;
    this.sessionId = resumeSessionId;

    // Listen for Codex's continuation footer and auto-respond to terminal queries.
    // Codex sends DSR (Device Status Report) \x1b[6n on startup to query cursor
    // position. When no terminal emulator (e.g. xterm.js) is connected to respond,
    // codex times out and exits. We auto-respond with a default cursor position
    // so codex can start regardless of whether a terminal client is attached.
    this.ptyProcess.onData((data: string) => {
      if (data.includes('\x1b[6n')) {
        this.ptyProcess.write('\x1b[1;1R');
      }

      if (!this.sessionId) {
        const detectedSessionId = this.detectResumeSessionId(data);
        if (detectedSessionId) {
          this.sessionId = detectedSessionId;
        }
      }
    });
  }

  write(data: string): void {
    this.ptyProcess.write(data);
  }

  requestExit(): void {
    writeCodexExitCommand((data) => this.ptyProcess.write(data));
  }

  resize(cols: number, rows: number): void {
    this.ptyProcess.resize(cols, rows);
  }

  kill(): void {
    this.ptyProcess.kill();
  }

  onData(callback: (data: string) => void): void {
    this.ptyProcess.onData(callback);
  }

  onExit(callback: (code: number, signal?: number) => void): void {
    this.ptyProcess.onExit((e) => callback(e.exitCode, e.signal));
  }

  getSessionId(): ProviderSessionId | undefined {
    return this.sessionId;
  }
}

// ============================================================================
// Codex Interactive Provider
// ============================================================================

/**
 * Codex interactive provider that spawns the `codex` CLI in a PTY.
 */
export class CodexInteractiveProvider implements InteractiveProvider {
  readonly name = 'codex-interactive';
  private readonly executablePath: string;

  constructor(executablePath = 'codex') {
    this.executablePath = executablePath;
  }

  async spawn(options: InteractiveSpawnOptions): Promise<InteractiveSession> {
    const args = buildCodexInteractiveArgs(options);

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...options.environmentVariables,
      // This process renders in xterm.js, not in the parent server's log pipe.
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };
    delete env.NO_COLOR;
    if (options.stoneforgeRoot) {
      env.STONEFORGE_ROOT = options.stoneforgeRoot;
    }

    const cols = options.cols ?? 120;
    const rows = options.rows ?? 30;

    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';

    // Build the CLI command string (simple args only — not the prompt).
    // Use `exec` so the CLI replaces the shell process.
    const codexCommand = (process.platform === 'win32' ? '' : `unset NO_COLOR; export TERM=xterm-256color COLORTERM=truecolor PATH=${shellQuote(env.PATH ?? '')}; exec `) + [shellQuote(this.executablePath), ...args].join(' ');

    // Spawn PTY using bash -l -c to run the command in a login shell.
    // When an initial prompt is provided, it's passed as a bash positional
    // parameter ($1) via the process argv — bypasses shell parsing entirely.
    const shellArgs: string[] = process.platform === 'win32'
      ? []
      : options.initialPrompt
        ? ['-l', '-c', codexCommand + ' "$1"', '_', options.initialPrompt]
        : ['-l', '-c', codexCommand];

    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: options.workingDirectory,
      env,
    });

    const resumeSessionId = options.resumeSessionId && isCodexResumeSessionId(options.resumeSessionId)
      ? options.resumeSessionId
      : undefined;
    const session = new CodexInteractiveSession(ptyProcess, resumeSessionId);

    // On Windows, write the command to cmd.exe stdin (bash -c handles this on Unix)
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          ptyProcess.write(codexCommand + '\r');
          resolve();
        }, 100);
      });
    }

    return session;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { execSync } = await import('node:child_process');
      execSync(`${this.executablePath} --version`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

}
