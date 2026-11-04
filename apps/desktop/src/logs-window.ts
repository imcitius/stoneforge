import { BrowserWindow, screen } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logsBounds, logsHTML } from './logs.js';

const viewers = new WeakMap<BrowserWindow, { projectId: string; window: BrowserWindow; closed: Promise<void> }>();

export async function showLogs(owner: BrowserWindow, projectId: string, name: string, logs?: string): Promise<void> {
  const existing = viewers.get(owner);
  if (existing) {
    if (existing.projectId === projectId) {
      if (!existing.window.isDestroyed()) existing.window.focus();
      return existing.closed;
    }
    if (!existing.window.isDestroyed()) existing.window.close();
    await existing.closed;
    return showLogs(owner, projectId, name, logs);
  }
  const viewer = new BrowserWindow({
    ...logsBounds(screen.getDisplayMatching(owner.getBounds()).workArea),
    // A child window stays above WebContentsViews and retains native close chrome.
    // A macOS modal sheet would let AppKit choose its position instead of these bounds.
    parent: owner, show: false, resizable: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    title: `${name} — Logs`, backgroundColor: '#0f172a',
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), 'logs-preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  });
  // Focus returns explicitly to the owner: when the viewer closes, AppKit gives key status to
  // the frontmost other app window (e.g. detached DevTools), not necessarily to the owner.
  // The owner keeps its own first responder, so its previously focused contents (the shell that
  // opened Logs) regain focus with it. Only a viewer that is key when it closes restores focus:
  // if the user has already moved to the owner or another window, it must not pull focus back.
  let restoreFocus = false;
  viewer.on('close', () => { restoreFocus = !viewer.isDestroyed() && viewer.isFocused(); });
  const closed = new Promise<void>((resolve) => viewer.once('closed', () => {
    viewers.delete(owner);
    if (restoreFocus && !owner.isDestroyed() && owner.isVisible()) owner.focus();
    resolve();
  }));
  viewers.set(owner, { projectId, window: viewer, closed });
  viewer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  viewer.webContents.on('will-navigate', (event) => event.preventDefault());
  viewer.webContents.ipc.on('logs:close', (event) => {
    if (event.senderFrame === viewer.webContents.mainFrame) viewer.close();
  });
  try {
    // UTF-8 encoding also handles a surrogate pair split by the existing tail limit.
    await viewer.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(logsHTML(name, logs)).toString('base64'));
    if (!viewer.isDestroyed()) viewer.show();
    await closed;
  } catch (error) {
    if (!viewer.isDestroyed()) viewer.destroy();
    throw error;
  }
}
