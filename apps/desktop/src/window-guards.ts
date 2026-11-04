import type { BrowserWindow } from 'electron';

/** Events on which Electron's own BrowserWindow listener (`visibilityChanged`) calls `isVisible()`. */
export const VISIBILITY_EVENTS = ['show', 'hide', 'minimize', 'maximize', 'restore'] as const;

/**
 * Packaged check-app runs crashed with "Uncaught Exception: TypeError: Object has been destroyed
 * at BrowserWindow.visibilityChanged" shortly after a Logs viewer (a child window) had closed
 * (el-64nnhq, el-5n2sf4). The stack has no JavaScript caller: Electron emitted a native visibility
 * event on the already destroyed window, and its internal listener then called `isVisible()`.
 * Nothing needs a closed window's visibility (its web contents are gone), so drop those listeners
 * when it closes. Without a handler the exception becomes a modal main-process error box.
 */
export function dropVisibilityListenersOnClose(window: BrowserWindow): void {
  window.once('closed', () => {
    for (const event of VISIBILITY_EVENTS) window.removeAllListeners(event);
  });
}
