import './socket-workaround.js';
import { app, BrowserWindow, WebContentsView, session, ipcMain, dialog, Menu, Notification, type MenuItemConstructorOptions } from 'electron';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ProjectManager, type Instance, type WorkflowPreset } from './manager.js';
import { showLogs } from './logs-window.js';
import { loadPreferences, savePreferences, projectBounds, type Preferences } from './preferences.js';
import { orderProjects, normalizeOrder, moveProject, projectStatus, tabShortcut, shortcutTarget, tabMenuModel, type LifecycleAction } from './tabs.js';
import { ProjectLifecycle } from './lifecycle.js';
import { AttentionMonitor } from './attention.js';
import { dropVisibilityListenersOnClose } from './window-guards.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
type BuildInfo = { version: string; commit: string; branch: string; dirty: boolean; builtAt?: string;
  /** Packaged app identity (scripts/app-identity.mjs); absent in builds before el-4fxwb9 and in source runs. */
  identity?: 'production' | 'dev'; bundleId?: string; productName?: string };
const build: BuildInfo = (() => {
  try { return JSON.parse(readFileSync(join(here, 'build-info.json'), 'utf8')); }
  catch { return { version: app.getVersion(), commit: 'unknown', branch: 'unknown', dirty: false }; }
})();
const root = app.isPackaged ? process.resourcesPath : resolve(here, '../../..');
const backend = app.isPackaged ? join(root, 'backend') : join(root, 'packages/smithy');
const nodePath = app.isPackaged ? join(root, 'runtime/node') : require.resolve('node/bin/node');
/** "Stoneforge Desktop" (release/installed identity) or "Stoneforge Desktop Dev" (dev/test packages). */
const productName = build.productName ?? 'Stoneforge Desktop';
if (process.env.STONEFORGE_DESKTOP_TEST_DATA) app.setPath('userData', process.env.STONEFORGE_DESKTOP_TEST_DATA);
let manager: ProjectManager;
let attentionMonitor: AttentionMonitor;
const attentionNotifications = new Set<Notification>();
let window: BrowserWindow;
let lifecycle: ProjectLifecycle<Instance>;
let quitting = false;
let adding = false;
let progress: string | undefined;
let preferences: Preferences = { projectOrder: [] };
const views = new Map<string, { view: WebContentsView; instance: Instance }>();
const shellURL = pathToFileURL(join(here, 'shell.html')).href;

// Every window, including Logs viewers: no visibility listener may run on a closed window.
app.on('browser-window-created', (_event, created) => dropVisibilityListenersOnClose(created));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { const shown = liveWindow(); shown?.show(); shown?.focus(); });
  void app.whenReady().then(boot).catch(async (error) => {
    dialog.showErrorBox('Stoneforge could not start', String(error)); app.exit(1);
  });
}

/**
 * The main window, unless it does not exist yet (boot) or was destroyed (quit closes it while
 * backend, notification and dock events can still arrive). A call on a destroyed BrowserWindow
 * throws "Object has been destroyed" in the main process, which Electron shows as a modal box.
 */
function liveWindow(): BrowserWindow | undefined {
  return window && !window.isDestroyed() ? window : undefined;
}
/** Projects in tab order (saved user order first, then registry order). */
function orderedProjects() { return orderProjects(manager.list(), preferences.projectOrder); }
function snapshot() {
  return { projects: orderedProjects().map((project) => ({ ...project, status: projectStatus(project),
    running: manager.instances.has(project.id), pending: lifecycle?.pendingAction(project.id), actions: lifecycle?.actions(project.id) })),
    active: lifecycle?.active, progress, build,
    fullscreen: !!liveWindow()?.isFullScreen() };
}
function update(): void {
  if (!liveWindow()) return;
  const active = lifecycle.active;
  const project = active ? manager.projects.get(active) : undefined;
  // The title bar shows tabs instead of a title; keep the window name for Mission Control and the Window menu.
  window.setTitle(project ? `${project.name} — ${productName}` : productName);
  window.webContents.send('desktop:state', snapshot());
}
function layout(): void {
  if (!liveWindow()) return;
  const [width, height] = window.getContentSize();
  for (const [id, { view }] of views) {
    view.setVisible(id === lifecycle.active && manager.projects.get(id)?.state === 'ready');
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
  void lifecycle.select(id).then(() => {
    if (focusProject && lifecycle.active === id) views.get(id)?.view.webContents.focus();
  }).catch(showActionError);
}
/** Explicit lifecycle command from the shell, a tab menu or the stopped-project page. */
function runLifecycle(action: LifecycleAction, id: string): Promise<boolean> {
  return lifecycle.run(action, id);
}
async function confirmLifecycle(action: Exclude<LifecycleAction, 'start'>, project: { name: string }): Promise<boolean> {
  const text = {
    stop: { message: `Stop ${project.name}?`, button: 'Stop', detail: 'Its server and running agents will be stopped. Other projects keep running. Project files and worktrees are preserved.' },
    restart: { message: `Restart ${project.name}?`, button: 'Restart', detail: 'Its server and running agents will be stopped, then the server starts again. Task processing resumes unless you paused it. Other projects keep running.' },
    remove: { message: `Remove ${project.name} from Desktop?`, button: 'Remove', detail: 'Its server and running agents will be stopped and the project leaves the tab bar. Project files, data and worktrees stay in place; Add project registers it again.' },
  }[action];
  const answer = await dialog.showMessageBox(window, { type: 'question', message: text.message, detail: text.detail,
    buttons: ['Cancel', text.button], defaultId: 0, cancelId: 0 });
  return answer.response === 1;
}
/** ⌘1…⌘9 and ⌃Tab/⌃⇧Tab from the shell or any project dashboard (before the page sees them). */
function handleShortcut(event: Electron.Event, input: Electron.Input, fromProjectView: boolean): void {
  const shortcut = tabShortcut(input);
  if (!shortcut) return;
  event.preventDefault();
  const target = shortcutTarget(shortcut, orderedProjects().map((project) => project.id), lifecycle.active);
  if (target) selectProject(target, fromProjectView);
}
function cycleProjects(kind: 'next' | 'previous'): void {
  const target = shortcutTarget({ kind }, orderedProjects().map((project) => project.id), lifecycle.active);
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
 * Per-tab menu (right/Control-click, Shift+F10 on a focused tab, or the ⋯ button on the active
 * tab): Start/Stop by state, Restart, Logs, Repositories, tab order and Remove. Items act on
 * that tab's project only and never change the selection.
 */
function tabMenu(id: string): MenuItemConstructorOptions[] {
  const project = manager.projects.get(id)!;
  const order = orderedProjects().map((item) => item.id);
  const index = order.indexOf(id);
  const act = (command: string) => () => { void projectCommand(command, id).catch(showActionError); };
  const clicks: Record<string, () => void> = {
    start: act('start'), stop: act('stop'), restart: act('restart'), logs: act('logs'),
    repositories: act('repositories'), remove: act('remove'), 'resume-processing': act('resume-processing'),
    'move-left': () => setOrder(moveProject(order, id, -1)), 'move-right': () => setOrder(moveProject(order, id, 1)),
  };
  return tabMenuModel({ state: project.state, running: manager.instances.has(id), taskProcessingPaused: project.taskProcessingPaused }, lifecycle.pendingAction(id), index, order.length)
    .map((entry) => 'id' in entry ? { id: `project-${entry.id}`, label: entry.label, enabled: entry.enabled, toolTip: entry.toolTip, click: clicks[entry.id] } : { type: 'separator' as const });
}
function dispose(id: string): void {
  const entry = views.get(id);
  if (!entry) return;
  views.delete(id);
  liveWindow()?.contentView.removeChildView(entry.view);
  if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
}
/** Creates (or reuses) the dashboard view of a running instance. Never starts a backend. */
async function attachView(id: string, instance: Instance): Promise<void> {
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
}
/** Selects a project and starts it: Add project and explicit --project= launch arguments only. */
async function openAndStart(id: string): Promise<void> {
  await lifecycle.select(id);
  await runLifecycle('start', id);
}

/**
 * Project commands from the shell, the per-tab menu and the stopped-project page. `select` only
 * shows the project; `start` is the only command that starts a stopped one.
 */
async function projectCommand(command: string, id: string): Promise<void> {
  if (!manager.projects.has(id)) throw new Error('Unknown project');
  if (command === 'select') { await lifecycle.select(id); return; }
  if (command === 'start' || command === 'stop' || command === 'restart' || command === 'remove') { await runLifecycle(command, id); return; }
  if (command === 'resume-processing') {
    if (!lifecycle.pendingAction(id)) await manager.resumeTaskProcessing(id);
    return;
  }
  if (command === 'logs') { await showLogs(window, id, manager.projects.get(id)!.name, manager.logs.get(id)); return; }
  if (command === 'repositories') {
    // Never starts a stopped project: repository management needs its running server.
    const instance = manager.instances.get(id);
    if (!instance || manager.projects.get(id)?.state !== 'ready') throw new Error('Start the project to manage its repositories.');
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
    return;
  }
  throw new Error('Unknown command');
}

async function boot(): Promise<void> {
  manager = new ProjectManager({
    dataDir: app.getPath('userData'), node: nodePath,
    entry: join(backend, 'dist/server/managed.js'), webRoot: join(backend, 'web'),
    binDir: app.isPackaged ? join(root, 'runtime') : join(here, '../scripts/bin'),
  });
  await manager.load();
  lifecycle = new ProjectLifecycle(manager, { confirm: confirmLifecycle, attach: attachView, changed: () => { update(); layout(); } });
  preferences = await loadPreferences(app.getPath('userData'));
  window = new BrowserWindow({
    width: 1440, height: 940, minWidth: 960, minHeight: 640,
    title: productName, backgroundColor: '#0f172a',
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
  app.on('activate', () => liveWindow()?.show());
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
      if (!manager.projects.has(notice.projectId) || !liveWindow()) return;
      window.show(); if (window.isMinimized()) window.restore(); window.focus();
      // Only shows the project (it is running: it has a waiting director); never starts one.
      void lifecycle.select(notice.projectId).catch(error => console.warn('[desktop] Could not open notification project:', error));
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
            detail: `${workspace.root}\n\nThis folder has no Stoneforge database. Setup creates workspace data, default agents and agent instructions. Task processing starts when the project opens.\n\n` +
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
        // Adding a project is an explicit request to open it, so it starts (once) here.
        await openAndStart(project.id);
      } finally {
        adding = false; progress = undefined; update();
      }
      return snapshot();
    }
    if (typeof id !== 'string' || !manager.projects.has(id)) throw new Error('Unknown project');
    if (command === 'tab-menu') {
      const point = popupPoint(options);
      if (!point) throw new Error('Invalid tab menu request');
      Menu.buildFromTemplate(tabMenu(id)).popup({ window, ...point });
    } else await projectCommand(command, id);
    update(); return snapshot();
    } catch (error) {
      // A WebContentsView covers shell HTML, including its error banner. Native
      // dialogs remain visible even when another project's dashboard is open.
      await dialog.showMessageBox(window, { type: 'error', message: command === 'add' ? 'Could not add project' : 'Could not complete project action',
        detail: error instanceof Error ? error.message : String(error), buttons: ['OK'] });
      return snapshot();
    }
  });
  app.setAboutPanelOptions({ applicationName: productName, applicationVersion: build.version,
    version: `${build.commit.slice(0, 12)}${build.dirty ? ' (modified)' : ''}`,
    credits: `Branch: ${build.branch}\nBuilt: ${build.builtAt ?? 'unknown'}${build.bundleId ? `\nBundle ID: ${build.bundleId} (${build.identity})` : ''}` });
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
  // They are explicit requests to open those projects, so they start (as Add project does).
  for (const path of paths) { const project = await manager.add(path); await openAndStart(project.id); }
}
