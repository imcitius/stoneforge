import './socket-workaround.js';
import { app, BrowserWindow, WebContentsView, session, ipcMain, dialog, Menu, Notification, type MenuItemConstructorOptions } from 'electron';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ProjectManager, type Instance, type WorkflowPreset } from './manager.js';
import { showLogs } from './logs-window.js';
import { loadPreferences, savePreferences, projectBounds, type Preferences } from './preferences.js';
import { orderProjects, normalizeOrder, moveProject, projectStatus, tabShortcut, shortcutTarget } from './tabs.js';
import { AttentionMonitor } from './attention.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const build: { version: string; commit: string; branch: string; dirty: boolean; builtAt?: string } = (() => {
  try { return JSON.parse(readFileSync(join(here, 'build-info.json'), 'utf8')); }
  catch { return { version: app.getVersion(), commit: 'unknown', branch: 'unknown', dirty: false }; }
})();
const root = app.isPackaged ? process.resourcesPath : resolve(here, '../../..');
const backend = app.isPackaged ? join(root, 'backend') : join(root, 'packages/smithy');
const nodePath = app.isPackaged ? join(root, 'runtime/node') : require.resolve('node/bin/node');
if (process.env.STONEFORGE_DESKTOP_TEST_DATA) app.setPath('userData', process.env.STONEFORGE_DESKTOP_TEST_DATA);
let manager: ProjectManager;
let attentionMonitor: AttentionMonitor;
const attentionNotifications = new Set<Notification>();
let window: BrowserWindow;
let active: string | undefined;
let quitting = false;
let adding = false;
let progress: string | undefined;
let preferences: Preferences = { projectOrder: [] };
const views = new Map<string, { view: WebContentsView; instance: Instance }>();
const shellURL = pathToFileURL(join(here, 'shell.html')).href;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  void app.whenReady().then(boot).catch(async (error) => {
    dialog.showErrorBox('Stoneforge could not start', String(error)); app.exit(1);
  });
}

/** Projects in tab order (saved user order first, then registry order). */
function orderedProjects() { return orderProjects(manager.list(), preferences.projectOrder); }
function snapshot() {
  return { projects: orderedProjects().map((project) => ({ ...project, status: projectStatus(project) })), active, progress, build,
    fullscreen: !!window && !window.isDestroyed() && window.isFullScreen() };
}
function update(): void {
  if (!window || window.isDestroyed()) return;
  const project = active ? manager.projects.get(active) : undefined;
  // The title bar shows tabs instead of a title; keep the window name for Mission Control and the Window menu.
  window.setTitle(project ? `${project.name} — Stoneforge Desktop` : 'Stoneforge Desktop');
  window.webContents.send('desktop:state', snapshot());
}
function layout(): void {
  const [width, height] = window.getContentSize();
  for (const [id, { view }] of views) {
    view.setVisible(id === active && manager.projects.get(id)?.state === 'ready');
    view.setBounds(projectBounds(width, height));
  }
}
/** Tab order change: shell-only, project views are never reloaded, started or stopped. */
function setOrder(order: string[]): void {
  if (order.join('\n') === orderedProjects().map((project) => project.id).join('\n')) return;
  preferences = { ...preferences, projectOrder: order };
  update();
  savePreferences(app.getPath('userData'), preferences).catch((error) => console.error('Could not save preferences:', error));
}
async function showActionError(error: unknown): Promise<void> {
  await dialog.showMessageBox(window, { type: 'error', message: 'Could not complete project action',
    detail: error instanceof Error ? error.message : String(error), buttons: ['OK'] });
}
/**
 * Select a tab from a shortcut or native menu. Switching only moves the dashboard. When the
 * shortcut came from a project view, keyboard focus follows to the newly shown project; the
 * shell holds it meanwhile so a hidden dashboard never keeps receiving keystrokes.
 */
function selectProject(id: string, focusProject = false): void {
  if (focusProject) window.webContents.focus();
  void openProject(id).then(() => {
    if (focusProject && active === id) views.get(id)?.view.webContents.focus();
  }).catch(showActionError);
}
/** ⌘1…⌘9 and ⌃Tab/⌃⇧Tab from the shell or any project dashboard (before the page sees them). */
function handleShortcut(event: Electron.Event, input: Electron.Input, fromProjectView: boolean): void {
  const shortcut = tabShortcut(input);
  if (!shortcut) return;
  event.preventDefault();
  const target = shortcutTarget(shortcut, orderedProjects().map((project) => project.id), active);
  if (target) selectProject(target, fromProjectView);
}
function cycleProjects(kind: 'next' | 'previous'): void {
  const target = shortcutTarget({ kind }, orderedProjects().map((project) => project.id), active);
  if (target) selectProject(target);
}
type Point = { x: number; y: number };
function popupPoint(options: unknown): Point | undefined {
  const { x, y } = (options ?? {}) as Partial<Point>;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
}
/** » menu: the projects whose tabs do not fit, with their status, in tab order. */
function overflowMenu(ids: readonly string[]): MenuItemConstructorOptions[] {
  return orderedProjects().filter((project) => ids.includes(project.id)).map((project) => {
    const status = projectStatus(project);
    return { label: `${status.symbol}  ${project.name} — ${status.kind === 'error' ? 'Error' : status.label}`,
      toolTip: `${project.root}\n${status.label}`, click: () => selectProject(project.id) };
  });
}
/**
 * Per-tab context menu (right/Control-click, or Shift+F10 on a focused tab). Currently tab
 * order only; project lifecycle commands remain in the toolbar and can be added here later.
 */
function tabMenu(id: string): MenuItemConstructorOptions[] {
  const order = orderedProjects().map((project) => project.id);
  const index = order.indexOf(id);
  return [
    { label: 'Move Tab Left', enabled: index > 0, click: () => setOrder(moveProject(order, id, -1)) },
    { label: 'Move Tab Right', enabled: index >= 0 && index < order.length - 1, click: () => setOrder(moveProject(order, id, 1)) },
  ];
}
function dispose(id: string): void {
  const entry = views.get(id);
  if (!entry) return;
  views.delete(id);
  window.contentView.removeChildView(entry.view);
  entry.view.webContents.close();
}
async function openProject(id: string): Promise<void> {
  if (!manager.projects.has(id)) throw new Error('Unknown project');
  const previous = active;
  active = id; layout(); update();
  try {
  const instance = await manager.start(id);
  let entry = views.get(id);
  if (entry && entry.instance !== instance) { dispose(id); entry = undefined; }
  if (!entry) {
    const partition = session.fromPartition(`persist:stoneforge-${id}`);
    partition.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    partition.setPermissionCheckHandler(() => false);
    partition.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      const allowed = ['http:', 'ws:'].includes(url.protocol) && url.host === new URL(instance.endpoint!).host;
      // Block stale connections before they can reach a newly reused port.
      if (!allowed || manager.projects.get(id)?.state !== 'ready') { callback({ cancel: true }); return; }
      void manager.isCurrent(id, instance).then((current) => callback({ cancel: !current }), () => callback({ cancel: true }));
    });
    partition.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };
      if (new URL(details.url).host === new URL(instance.endpoint!).host && manager.instances.get(id) === instance) {
        Object.assign(headers, manager.headers(instance));
      }
      callback({ requestHeaders: headers });
    });
    const view = new WebContentsView({ webPreferences: {
      session: partition, nodeIntegration: false, contextIsolation: true, sandbox: true,
      backgroundThrottling: false,
    } });
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('before-input-event', (event, input) => handleShortcut(event, input, true));
    view.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== instance.endpoint) event.preventDefault();
    });
    view.webContents.on('render-process-gone', () => { dispose(id); update(); });
    views.set(id, { view, instance });
    window.contentView.addChildView(view);
    layout();
    await view.webContents.loadURL(instance.endpoint!);
  }
  layout(); update();
  } catch (error) {
    if (active === id && previous && manager.projects.get(previous)?.state === 'ready') active = previous;
    layout(); update(); throw error;
  }
}

async function boot(): Promise<void> {
  manager = new ProjectManager({
    dataDir: app.getPath('userData'), node: nodePath,
    entry: join(backend, 'dist/server/managed.js'), webRoot: join(backend, 'web'),
    binDir: app.isPackaged ? join(root, 'runtime') : join(here, '../scripts/bin'),
  });
  await manager.load();
  preferences = await loadPreferences(app.getPath('userData'));
  window = new BrowserWindow({
    width: 1440, height: 940, minWidth: 960, minHeight: 640,
    title: 'Stoneforge Desktop', backgroundColor: '#0f172a',
    // The shell's tab strip is the title bar; traffic lights are centred in its 38px height.
    titleBarStyle: 'hidden', trafficLightPosition: { x: 13, y: 12 },
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('before-input-event', (event, input) => handleShortcut(event, input, false));
  window.on('resize', layout);
  window.on('enter-full-screen', update);
  window.on('leave-full-screen', update);
  window.on('close', (event) => { if (!quitting) { event.preventDefault(); window.hide(); } });
  app.on('activate', () => window.show());
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    void (async () => {
      if (adding) {
        await dialog.showMessageBox(window, { message: 'Project setup is in progress', detail: 'Wait for setup to finish before quitting.', buttons: ['OK'] });
        return;
      }
      if (manager.instances.size) {
        const answer = await dialog.showMessageBox(window, {
          type: 'question', message: 'Quit Stoneforge?',
          detail: 'Running agents and project servers will be stopped. Closing the window keeps them running.',
          buttons: ['Keep running', 'Stop and quit'], defaultId: 0, cancelId: 0,
        });
        if (answer.response !== 1) return;
      }
      quitting = true;
      attentionMonitor.stop();
      await manager.close();
      for (const id of views.keys()) dispose(id);
      app.quit();
    })().catch((error) => { quitting = false; attentionMonitor.start(); dialog.showErrorBox('Could not quit', String(error)); });
  });
  manager.on('changed', () => { update(); layout(); });
  manager.on('stopped', dispose);
  attentionMonitor = new AttentionMonitor(manager, notice => {
    const project = manager.projects.get(notice.projectId);
    if (!project || !Notification.isSupported()) return;
    const notification = new Notification({
      title: `Нужен ваш ответ — ${project.name}`,
      body: notice.kind === 'permission' ? 'Директор ожидает вашего подтверждения.' : 'Директор остановился и ждёт вашего ответа.',
      silent: false,
    });
    attentionNotifications.add(notification);
    notification.on('close', () => attentionNotifications.delete(notification));
    notification.on('failed', (_event, error) => { attentionNotifications.delete(notification); console.warn('[desktop] Notification failed:', error); });
    notification.on('click', () => {
      attentionNotifications.delete(notification);
      if (!manager.projects.has(notice.projectId)) return;
      window.show(); if (window.isMinimized()) window.restore(); window.focus();
      void openProject(notice.projectId).catch(error => console.warn('[desktop] Could not open notification project:', error));
    });
    notification.show();
  });
  attentionMonitor.start();
  ipcMain.handle('desktop:command', async (event, command: unknown, id?: unknown, options?: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame?.url !== shellURL) throw new Error('Untrusted sender');
    if (typeof command !== 'string') throw new Error('Invalid command');
    try {
    if (command === 'list') return snapshot();
    if (command === 'reorder') {
      const order = normalizeOrder((options as { order?: unknown } | undefined)?.order, orderedProjects().map((project) => project.id));
      if (!order) throw new Error('Invalid project order');
      setOrder(order); return snapshot();
    }
    if (command === 'overflow') {
      const point = popupPoint(options), ids = (options as { ids?: unknown } | undefined)?.ids;
      if (!point || !Array.isArray(ids) || !ids.every((item) => typeof item === 'string')) throw new Error('Invalid overflow menu request');
      const items = overflowMenu(ids);
      if (items.length) Menu.buildFromTemplate(items).popup({ window, ...point });
      return snapshot();
    }
    if (command === 'add') {
      if (adding) return snapshot();
      adding = true;
      try {
        const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'], title: 'Choose a project folder' });
        if (result.canceled || !result.filePaths[0]) return snapshot();
        const workspace = await manager.inspect(result.filePaths[0]);
        let preset: WorkflowPreset = 'review';
        if (!workspace.initialized) {
          const answer = await dialog.showMessageBox(window, {
            type: 'question', message: `Set up Stoneforge in ${basename(workspace.root)}?`,
            detail: `${workspace.root}\n\nThis folder has no Stoneforge database. Setup creates workspace data, default agents and agent instructions. Agents will stay stopped.\n\n` +
              (workspace.hasConfig ? 'Existing configuration and exported data will be reused.' :
                'Review: agents merge to a review branch; you merge to main.\nAuto: agents merge directly to main.\nApprove: restricted agent actions need approval; merges use pull requests.'),
            buttons: workspace.hasConfig ? ['Cancel', 'Initialize'] : ['Cancel', 'Review', 'Auto', 'Approve'],
            defaultId: 1, cancelId: 0,
          });
          if (answer.response === 0) return snapshot();
          preset = (['review', 'review', 'auto', 'approve'] as const)[answer.response] ?? 'review';
          progress = `Setting up ${basename(workspace.root)}…`; update();
        }
        const project = workspace.initialized ? await manager.add(workspace.root) : await manager.initialize(workspace.root, preset);
        progress = `Opening ${project.name}…`; update();
        await openProject(project.id);
      } finally {
        adding = false; progress = undefined; update();
      }
      return snapshot();
    }
    if (typeof id !== 'string' || !manager.projects.has(id)) throw new Error('Unknown project');
    if (command === 'open') await openProject(id);
    else if (command === 'tab-menu') {
      const point = popupPoint(options);
      if (!point) throw new Error('Invalid tab menu request');
      Menu.buildFromTemplate(tabMenu(id)).popup({ window, ...point });
    }
    else if (command === 'repositories') {
      const instance = await manager.start(id);
      const request = async (method: string, suffix = '', body?: unknown) => {
        if (!await manager.isCurrent(id, instance)) throw new Error('Project server changed; reopen the project');
        const response = await fetch(instance.endpoint + '/api/repositories' + suffix, { method,
          headers: { ...manager.headers(instance), 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000), redirect: 'error' });
        const result = await response.json();
        if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'Repository management requires the updated project server. Restart this project.');
        return result;
      };
      const { repositories } = await request('GET') as { repositories: Array<{ id: string; path: string; targetBranch?: string; error?: string }> };
      const answer = await dialog.showMessageBox(window, { message: 'Code repositories',
        detail: repositories.length ? repositories.map(r => `${r.id} — ${r.path}\n${r.error ?? `Merge target: ${r.targetBranch ?? 'repository default'}`}`).join('\n\n') : 'This project has no code repositories. Add an existing Git checkout with at least one commit. The project folder itself does not need Git.',
        buttons: ['Close', 'Add repository', ...repositories.map(r => `Manage ${r.id}`)], defaultId: 0, cancelId: 0 });
      if (answer.response === 1) {
        const folder = await dialog.showOpenDialog(window, { title: 'Choose a code repository', properties: ['openDirectory'] });
        if (!folder.canceled && folder.filePaths[0]) {
          const repoPath = folder.filePaths[0];
          const repoId = basename(repoPath).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z0-9]+/, '') || 'repository';
          const created = await request('POST', '', { id: repoId, path: repoPath });
          await dialog.showMessageBox(window, { message: `Repository ${created.repository.id} added`, detail: 'Use this repository when creating tasks. Its default branch is used for merges.', buttons: ['OK'] });
        }
      } else if (answer.response > 1) {
        const repo = repositories[answer.response - 2];
        const remove = await dialog.showMessageBox(window, { message: repo.id, detail: `${repo.path}\n\nRemoving registration preserves files. Repositories referenced by tasks or managed worktrees cannot be removed.`, buttons: ['Close', 'Remove registration'], cancelId: 0, defaultId: 0 });
        if (remove.response === 1) await request('DELETE', '/' + encodeURIComponent(repo.id));
      }
    }
    else if (command === 'stop' || command === 'restart' || command === 'remove') {
      const answer = await dialog.showMessageBox(window, { type: 'question',
        message: `${command === 'remove' ? 'Remove' : command === 'restart' ? 'Restart' : 'Stop'} ${manager.projects.get(id)!.name}?`,
        detail: 'Its running agents will be stopped. Project files and worktrees will be preserved.',
        buttons: ['Cancel', 'Continue'], defaultId: 0, cancelId: 0 });
      if (answer.response !== 1) return snapshot();
      await manager.stop(id);
      if (command === 'restart') await openProject(id);
      if (command === 'remove') { await manager.remove(id); if (active === id) active = undefined; }
    } else if (command === 'logs') {
      await showLogs(window, id, manager.projects.get(id)!.name, manager.logs.get(id));
    } else throw new Error('Unknown command');
    update(); return snapshot();
    } catch (error) {
      // A WebContentsView covers shell HTML, including its error banner. Native
      // dialogs remain visible even when another project's dashboard is open.
      await dialog.showMessageBox(window, { type: 'error', message: command === 'add' ? 'Could not add project' : 'Could not complete project action',
        detail: error instanceof Error ? error.message : String(error), buttons: ['OK'] });
      return snapshot();
    }
  });
  app.setAboutPanelOptions({ applicationName: 'Stoneforge Desktop', applicationVersion: build.version,
    version: `${build.commit.slice(0, 12)}${build.dirty ? ' (modified)' : ''}`,
    credits: `Branch: ${build.branch}\nBuilt: ${build.builtAt ?? 'unknown'}` });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Stoneforge', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
      { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
    { role: 'window', submenu: [
      { role: 'minimize' }, { role: 'zoom' }, { type: 'separator' },
      // Shown for discoverability; the keys are handled by before-input-event in every view
      // (including focused terminals), so the menu does not register them a second time.
      { id: 'next-project', label: 'Select Next Project', accelerator: 'Control+Tab', registerAccelerator: false, click: () => cycleProjects('next') },
      { id: 'previous-project', label: 'Select Previous Project', accelerator: 'Control+Shift+Tab', registerAccelerator: false, click: () => cycleProjects('previous') },
      { type: 'separator' }, { role: 'front' },
    ] },
  ]));
  await window.loadURL(shellURL);
  // Explicit paths are useful for local launches and the packaged integration fixture.
  const paths = process.argv.filter((arg) => arg.startsWith('--project=')).map((arg) => arg.slice(10));
  for (const path of paths) { const project = await manager.add(path); await openProject(project.id); }
}
