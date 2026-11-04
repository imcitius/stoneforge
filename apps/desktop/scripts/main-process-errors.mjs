/**
 * Test-side trap for uncaught exceptions in the packaged app's main process.
 *
 * Without a listener, Electron shows a modal "A JavaScript error occurred in the main process"
 * box, which blocks the main thread: every pending Playwright call then waits forever and the
 * check hangs instead of failing (el-64nnhq). Electron skips that box when the application has
 * its own 'uncaughtException' listener, so this one records the error synchronously to a file
 * in the check's fixture directory and to stderr, then exits the app with MAIN_ERROR_EXIT.
 * The harness reports the recorded error as the failure cause instead of the resulting
 * "Target page, context or browser has been closed". No production code or IPC is involved.
 *
 * Every packaged check that launches the app installs it right after each launch (el-5n2sf4):
 *   const mainErrors = mainProcessErrors(join(temp, 'main-process-errors.jsonl'));
 *   electron = await _electron.launch(...); await mainErrors.install(electron);
 *   try { ...; await mainErrors.assertNone(); } catch (error) { await mainErrors.rethrow(error); }
 * An app started outside Playwright (LaunchServices `open`) gets the same trap through its
 * Node inspector: see inspectMainProcess(). Exceptions before installation are not covered.
 */
import { readFile } from 'node:fs/promises';

export const MAIN_ERROR_EXIT = 70;
const MARK = '[main-process uncaughtException] ';

/** Recorded main-process exceptions of one check (all launches append to the same file). */
export function mainProcessErrors(file) {
  const recorded = async () => {
    const text = await readFile(file, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  };
  const assertNone = async () => {
    const errors = await recorded();
    if (errors.length) {
      throw Object.assign(new Error(`Main process uncaught exception (app exited with ${MAIN_ERROR_EXIT}):\n${errors.join('\n---\n')}`), { mainProcessException: true });
    }
  };
  return {
    file,
    recorded,
    /** Throws if the main process had an uncaught exception (the app has then exited). */
    assertNone,
    /** Installs the trap in a launched app: Playwright's ElectronApplication or inspectMainProcess(). */
    async install(electron) {
      await electron.evaluate(({ app, BrowserWindow }, { file, mark, code }) => {
        const { appendFileSync, writeSync } = process.getBuiltinModule('fs');
        // Diagnostics for el-5n2sf4 ("Object has been destroyed at BrowserWindow.visibilityChanged"):
        // the recent window lifecycle/visibility events, and any event emitted on a destroyed window.
        // Pass-through: the wrapper only records. Installed once per process.
        const events = (globalThis.__mainErrorWindowEvents ??= []);
        const watched = new Set(['show', 'hide', 'minimize', 'maximize', 'restore', 'close', 'closed', 'focus', 'blur']);
        const label = (window) => {
          window.__mainErrorLabel = `#${window.id} "${window.getTitle()}"${window.getParentWindow() ? ` child of #${window.getParentWindow().id}` : ''}`;
        };
        if (BrowserWindow && !BrowserWindow.prototype.__mainErrorEmit) {
          for (const window of BrowserWindow.getAllWindows()) try { label(window); } catch {}
          app.on('browser-window-created', (_event, window) => { try { label(window); } catch {} });
          const emit = BrowserWindow.prototype.__mainErrorEmit = BrowserWindow.prototype.emit;
          BrowserWindow.prototype.emit = function (event, ...args) {
            if (watched.has(event)) try {
              const destroyed = this.isDestroyed();
              if (!destroyed) label(this);
              events.push(`${new Date().toISOString()} ${event} ${this.__mainErrorLabel ?? '(unlabelled)'}${destroyed ? ' DESTROYED' : ''}` +
                (destroyed && event !== 'closed' ? `\n${new Error('emit on a destroyed window').stack.split('\n').slice(2, 8).join('\n')}` : ''));
              if (events.length > 40) events.shift();
            } catch {}
            return emit.call(this, event, ...args);
          };
        }
        process.on('uncaughtException', (error) => {
          const text = String(error?.stack ?? error) + (events.length ? `\nRecent window events (oldest first):\n${events.join('\n')}` : '');
          // Synchronous writes: app.exit() does not wait for asynchronous pipe output.
          try { appendFileSync(file, JSON.stringify(text) + '\n'); } catch {}
          try { writeSync(2, mark + JSON.stringify(text) + '\n'); } catch {}
          app.exit(code);
        });
      }, { file, mark: MARK, code: MAIN_ERROR_EXIT });
    },
    /**
     * Rethrows a failed check step. The trapped exception exits the app, so the step usually
     * fails with a closed target; report the recorded exception instead, naming the step error.
     */
    async rethrow(error) {
      if (error?.mainProcessException) throw error;
      await assertNone().catch((crash) => {
        crash.message += `\n(the harness step then failed with: ${String(error?.message ?? error).split('\n')[0]})`;
        throw crash;
      });
      throw error;
    },
  };
}

export async function trapMainProcessErrors(electron, file) {
  const trap = mainProcessErrors(file);
  await trap.install(electron);
  return trap;
}

/**
 * A Playwright-like `evaluate(fn, arg)` for an app launched with `--inspect=0` outside
 * Playwright, whose stderr is redirected to `stderrFile`: it reads the inspector URL that Node
 * prints there and runs `fn(electronModule, arg)` in the main process through the inspector's
 * Runtime.evaluate. `electron` is the expression for the first argument (tests substitute a stub).
 */
export async function inspectMainProcess(stderrFile, { timeout = 30_000, electron = "require('electron')" } = {}) {
  const deadline = Date.now() + timeout;
  let url;
  while (!url) {
    const text = await readFile(stderrFile, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
    url = text.match(/Debugger listening on (ws:\/\/\S+)/)?.[1];
    if (url) break;
    if (Date.now() > deadline) throw new Error(`No main-process inspector URL in ${stderrFile} after ${timeout} ms:\n${text}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`Could not connect to the main-process inspector ${url}`)), { once: true });
  });
  let next = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`Inspector ${message.error.message}`)); else request.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) request.reject(new Error('Main-process inspector closed'));
    pending.clear();
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    async evaluate(fn, arg) {
      const { result, exceptionDetails } = await send('Runtime.evaluate', {
        expression: `(${fn})(${electron}, ${JSON.stringify(arg)})`,
        // The command-line API provides `require` in the main process's global scope.
        includeCommandLineAPI: true, awaitPromise: true, returnByValue: true,
      });
      if (exceptionDetails) throw new Error(`Main-process evaluate failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
      return result.value;
    },
    close() { socket.close(); },
  };
}
