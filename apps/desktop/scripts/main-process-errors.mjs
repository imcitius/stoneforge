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
 */
import { readFile } from 'node:fs/promises';

export const MAIN_ERROR_EXIT = 70;
const MARK = '[main-process uncaughtException] ';

export async function trapMainProcessErrors(electron, file) {
  await electron.evaluate(({ app }, { file, mark, code }) => {
    const { appendFileSync, writeSync } = process.getBuiltinModule('fs');
    process.on('uncaughtException', (error) => {
      const text = String(error?.stack ?? error);
      // Synchronous writes: app.exit() does not wait for asynchronous pipe output.
      try { appendFileSync(file, JSON.stringify(text) + '\n'); } catch {}
      try { writeSync(2, mark + JSON.stringify(text) + '\n'); } catch {}
      app.exit(code);
    });
  }, { file, mark: MARK, code: MAIN_ERROR_EXIT });
  const recorded = async () => {
    const text = await readFile(file, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  };
  return {
    recorded,
    /** Throws if the main process had an uncaught exception (the app has then exited). */
    async assertNone() {
      const errors = await recorded();
      if (errors.length) {
        throw new Error(`Main process uncaught exception (app exited with ${MAIN_ERROR_EXIT}):\n${errors.join('\n---\n')}`);
      }
    },
  };
}
