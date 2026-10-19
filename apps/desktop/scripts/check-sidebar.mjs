/**
 * Packaged regression for the collapsible project sidebar. Uses temporary projects and
 * a temporary userData directory; it never touches the installed application or its data.
 *   node apps/desktop/scripts/check-sidebar.mjs   (DESKTOP_APP selects a relocated bundle)
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { _electron } = createRequire(join(root, 'apps/smithy-web/package.json'))('playwright');
const bundle = resolve(process.env.DESKTOP_APP ?? join(root, 'apps/desktop/dist/mac/Stoneforge Desktop-darwin-arm64/Stoneforge Desktop.app'));
const resources = join(bundle, 'Contents/Resources');
const node = join(resources, 'runtime/node');
const cli = join(resources, 'backend/dist/bin/sf.js');
const temp = await mkdtemp(join(tmpdir(), 'stoneforge-sidebar-'));
const appData = join(temp, 'app-data');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(STONEFORGE_|SF_)/.test(key) || ['ORCHESTRATOR_URL', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete env[key];
const observations = [];
const errors = [];
let electron, page;

async function launch() {
  electron = await _electron.launch({ executablePath: join(bundle, 'Contents/MacOS/Stoneforge Desktop'), args: [],
    env: { ...env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', STONEFORGE_DESKTOP_TEST_DATA: appData }, timeout: 30_000 });
  page = await electron.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => document.getElementById('build').textContent.startsWith('v'));
  await electron.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((w) => !w.getParentWindow());
    window.setContentSize(1024, 700); window.show(); window.focus();
  });
}
async function quit() {
  const exited = new Promise((r) => electron.process().once('exit', r));
  // Answer the real "Stop and quit" confirmation so project servers stop gracefully.
  await electron.evaluate(({ app, dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); app.quit(); });
  await Promise.race([exited, pause(30_000).then(() => { throw new Error('Desktop did not quit'); })]);
}
const native = () => electron.evaluate(({ BrowserWindow }) => {
  const window = BrowserWindow.getAllWindows().find((w) => !w.getParentWindow());
  const [width, height] = window.getContentSize();
  return { width, height, views: window.contentView.children.map((view) => ({ id: view.webContents.id, url: view.webContents.getURL(),
    bounds: view.getBounds(), visible: view.getVisible(), focused: view.webContents.isFocused() })) };
});
const shell = () => page.evaluate(() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
  const sidebar = document.getElementById('sidebar'), toggle = document.getElementById('sidebar-toggle');
  const tabbable = [...document.querySelectorAll('button,a[href],input,select,textarea,[tabindex]')]
    .filter((el) => !el.disabled && el.tabIndex >= 0 && el.checkVisibility());
  return { hidden: sidebar.hidden, display: getComputedStyle(sidebar).display, sidebar: rect(sidebar), main: rect(document.querySelector('main')),
    toggle: rect(toggle), expanded: toggle.getAttribute('aria-expanded'), label: toggle.getAttribute('aria-label'),
    controls: toggle.getAttribute('aria-controls'), sidebarTabbable: tabbable.filter((el) => sidebar.contains(el)).length,
    name: document.getElementById('name').textContent, status: document.getElementById('status').hidden ? '' : document.getElementById('status').textContent,
    active: document.activeElement?.id || document.activeElement?.tagName };
});
/** Shell DOM and native WebContentsView bounds must agree; waits for the IPC round trip. */
async function expectLayout(collapsed, label) {
  const started = Date.now();
  let s, n, failure;
  for (let attempt = 0; attempt < 100; attempt++) {
    [s, n] = [await shell(), await native()];
    try {
      const x = collapsed ? 0 : 240;
      assert.equal(s.hidden, collapsed); assert.equal(s.display === 'none', collapsed);
      assert.equal(s.expanded, String(!collapsed)); assert.equal(s.controls, 'sidebar');
      assert.equal(s.label, collapsed ? 'Show project sidebar' : 'Hide project sidebar');
      assert.equal(s.main.x, x, 'Shell main starts where the sidebar ends'); assert.equal(s.main.width, n.width - x);
      if (collapsed) assert.equal(s.sidebarTabbable, 0, 'Collapsed sidebar has no tabbable content');
      else assert.equal(s.sidebar.width, 240);
      // The toggle stays in the 64px toolbar strip, never under a native project view.
      assert(s.toggle.bottom <= 64 && s.toggle.x >= x && s.toggle.width > 0);
      for (const view of n.views) assert.deepEqual(view.bounds, { x, y: 64, width: n.width - x, height: n.height - 64 }, `${label}: view ${view.id}`);
      failure = undefined; break;
    } catch (error) { failure = error; await pause(20); }
  }
  if (failure) { console.error(label, JSON.stringify({ shell: s, native: n })); throw failure; }
  observations.push({ label, collapsed, settledMs: Date.now() - started, window: [n.width, n.height], views: n.views, toggle: s.toggle, focus: s.active });
  return { shell: s, native: n };
}
const projectNames = () => page.locator('nav button strong').allTextContents();
async function waitReady(count) {
  await page.waitForFunction((count) => {
    const states = [...document.querySelectorAll('nav span')].map((s) => s.textContent);
    return states.length === count && states.every((s) => s === 'ready');
  }, count, { timeout: 60_000 });
}
const visibleView = async () => (await native()).views.filter((v) => v.visible);
const run = (id, script) => electron.evaluate(({ webContents }, { id, script }) => webContents.fromId(id).executeJavaScript(script), { id, script });
const clickToggle = () => page.locator('#sidebar-toggle').click();
const menuToggle = () => electron.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('toggle-sidebar').click());
const menuChecked = () => electron.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('toggle-sidebar').checked);
const shot = (name) => page.screenshot({ path: join(temp, name) });

try {
  const projects = [];
  const first = join(temp, 'Atlas'); await mkdir(first);
  execFileSync(node, [cli, 'init', '--preset', 'auto', '--name', 'sidebar-fixture'], { cwd: first, env, stdio: 'pipe' });
  projects.push(first);
  for (const name of ['Borealis', 'Cedar проект']) { await cp(first, join(temp, name), { recursive: true }); projects.push(join(temp, name)); }

  // 1. Fresh userData: default visible; empty-state toggle with mouse and keyboard.
  await launch();
  await expectLayout(false, 'empty default');
  assert.equal(await menuChecked(), true);
  await assert.rejects(access(join(appData, 'preferences.json')), 'Default must not need a preference file');
  await page.locator('#add').focus();
  await clickToggle(); await expectLayout(true, 'empty collapsed by mouse');
  assert.equal(await menuChecked(), false);
  await shot('empty-collapsed.png');
  for (let i = 0; i < 8; i++) {
    // Real Tab traversal must never land on hidden sidebar controls.
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.getElementById('sidebar').contains(document.activeElement)), false);
  }
  await page.locator('#sidebar-toggle').focus(); await page.keyboard.press('Enter'); await expectLayout(false, 'empty expanded by Enter');
  await page.keyboard.press('Space'); await expectLayout(true, 'empty collapsed by Space');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'sidebar-toggle', 'Keyboard focus stays on the toggle');
  // Focus inside the sidebar moves to the toggle when the sidebar hides through the menu accelerator path.
  await page.keyboard.press('Space'); await expectLayout(false, 'empty expanded');
  await page.locator('#add').focus(); await menuToggle(); await expectLayout(true, 'collapsed from sidebar focus');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'sidebar-toggle');

  // 2. Add projects while collapsed (empty-state button), and while expanded. Loading/ready geometry.
  await electron.evaluate(({ dialog }) => {
    globalThis.__sidebarPaths = [];
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.__sidebarPaths.shift()] });
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await electron.evaluate((_e, path) => globalThis.__sidebarPaths.push(path), projects[0]);
  await page.locator('#add-empty').click();
  const loading = await expectLayout(true, 'adding while collapsed');
  observations.push({ label: 'loading state text', status: loading.shell.status });
  await waitReady(1); await expectLayout(true, 'first project ready while collapsed');
  assert.equal((await visibleView()).length, 1);
  await clickToggle(); await expectLayout(false, 'expanded with project');
  for (const path of projects.slice(1)) {
    await electron.evaluate((_e, path) => globalThis.__sidebarPaths.push(path), path);
    await page.locator('#add').click();
    await page.waitForFunction(() => !document.getElementById('add').disabled, null, { timeout: 60_000 });
  }
  await waitReady(3);
  assert.deepEqual(await projectNames(), ['Atlas', 'Borealis', 'Cedar проект']);
  const ids = await page.evaluate(() => [...document.querySelectorAll('nav button')].map((b) => b.dataset.project));
  const viewIds = (await native()).views.map((v) => v.id);
  assert.equal(viewIds.length, 3);
  // Session-state markers and backend identities that a reload/restart would lose or change.
  const identities = [];
  for (const id of viewIds) {
    identities.push(await run(id, `(async () => { window.__sidebarMarker = ${id}; return (await (await fetch('/api/desktop/identity')).json()); })()`));
  }

  // 3. Repeated toggles via mouse, keyboard and menu with resizes and project switches.
  const sizes = [[1024, 700], [1280, 820], [960, 640], [1024, 700]];
  let collapsed = false;
  for (let round = 0; round < 12; round++) {
    const method = ['mouse', 'keyboard', 'menu'][round % 3];
    if (method === 'mouse') await clickToggle();
    else if (method === 'keyboard') { await page.locator('#sidebar-toggle').focus(); await page.keyboard.press(round % 2 ? 'Space' : 'Enter'); }
    else await menuToggle();
    collapsed = !collapsed;
    await expectLayout(collapsed, `toggle ${round} (${method})`);
    const [width, height] = sizes[round % sizes.length];
    await electron.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows().find((w) => !w.getParentWindow()).setContentSize(width, height), [width, height]);
    await expectLayout(collapsed, `resize ${width}x${height} after toggle ${round}`);
    const target = ids[round % 3];
    // Collapsed: switch through the shell's real command bridge; expanded: click the sidebar.
    if (collapsed) await page.evaluate((id) => window.desktop.command('open', id), target);
    else await page.locator(`nav button[data-project="${target}"]`).click();
    await page.waitForFunction((expected) => document.getElementById('name').textContent === expected, (await projectNames())[round % 3]);
    const geometry = await expectLayout(collapsed, `switch to ${round % 3} after toggle ${round}`);
    assert.deepEqual(geometry.native.views.filter((v) => v.visible).map((v) => v.id), [viewIds[round % 3]]);
    if (round === 1) await shot('collapsed-project.png');
    if (round === 2) await shot('expanded-project.png');
  }
  // Toggle while the native project view itself has keyboard focus (menu accelerator path).
  await run(viewIds[0], 'document.body.focus()');
  await page.evaluate((id) => window.desktop.command('open', id), ids[0]);
  const focusView = async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      await electron.evaluate(({ BrowserWindow, webContents }, id) => {
        BrowserWindow.getAllWindows().find((w) => !w.getParentWindow()).focus(); webContents.fromId(id).focus();
      }, viewIds[0]);
      if ((await native()).views.find((v) => v.id === viewIds[0]).focused) return;
      await pause(100);
    }
    console.error('Focus diagnostics:', JSON.stringify(await electron.evaluate(({ BrowserWindow, webContents }) => ({
      windowFocused: BrowserWindow.getAllWindows().find((w) => !w.getParentWindow()).isFocused(),
      focused: webContents.getFocusedWebContents()?.id ?? null }))), JSON.stringify(await native()));
    throw new Error('Project view did not take native focus (is the macOS session unlocked and the app frontmost?)');
  };
  await focusView();
  await menuToggle(); collapsed = !collapsed; await expectLayout(collapsed, 'menu toggle with project focus');
  assert((await native()).views.find((v) => v.id === viewIds[0]).focused, 'Toggle must not steal project view focus');
  await menuToggle(); collapsed = !collapsed; await expectLayout(collapsed, 'menu toggle back with project focus');

  // 4. Projects, agents and sessions are unaffected: same views, no reloads, same backend instances.
  for (const [index, id] of viewIds.entries()) {
    assert.equal(await run(id, 'window.__sidebarMarker'), id, 'Project view was not reloaded');
    const identity = await run(id, `(async () => (await (await fetch('/api/desktop/identity')).json()))()`);
    assert.deepEqual(identity, identities[index], 'Toggle must not restart a backend');
  }
  assert.deepEqual(await page.locator('nav span').allTextContents(), ['ready', 'ready', 'ready']);

  // 5. Stopped/error-like status pane while collapsed: status text uses full width, no native view visible.
  if (!collapsed) { await clickToggle(); collapsed = true; await expectLayout(true, 'collapse before stop'); }
  await page.evaluate((id) => window.desktop.command('open', id), ids[2]);
  await page.locator('[data-command="stop"]').click();
  await page.waitForFunction(() => document.querySelectorAll('nav span')[2].textContent === 'stopped', null, { timeout: 30_000 });
  const stopped = await expectLayout(true, 'stopped project while collapsed');
  assert.equal((await visibleView()).length, 0); assert.match(stopped.shell.status, /Project stopped\. Show the project sidebar/);
  await shot('stopped-collapsed.png');
  await page.evaluate((id) => window.desktop.command('open', id), ids[2]);
  await waitReady(3);
  await expectLayout(true, 'reopened stopped project while collapsed');

  // 6. Preference persisted in userData only, then restored on relaunch.
  await page.evaluate((id) => window.desktop.command('open', id), ids[0]);
  await pause(200);
  assert.deepEqual(JSON.parse(await readFile(join(appData, 'preferences.json'), 'utf8')), { sidebarCollapsed: true });
  assert(!(await readFile(join(appData, 'projects.json'), 'utf8')).includes('sidebarCollapsed'));
  for (const path of projects) await assert.rejects(access(join(path, '.stoneforge/preferences.json')));
  await quit();
  await launch();
  await expectLayout(true, 'relaunch restored collapsed');
  assert.equal(await menuChecked(), false);
  assert.equal((await native()).views.length, 0, 'Relaunch does not start projects');
  await page.evaluate((id) => window.desktop.command('open', id), ids[1]);
  await page.waitForFunction(() => document.querySelectorAll('nav span')[1].textContent === 'ready', null, { timeout: 60_000 });
  await expectLayout(true, 'relaunch project opened collapsed');
  await clickToggle(); await expectLayout(false, 'relaunch expanded');
  await pause(200);
  assert.deepEqual(JSON.parse(await readFile(join(appData, 'preferences.json'), 'utf8')), { sidebarCollapsed: false });
  await shot('relaunch-expanded.png');
  await quit();
  await launch();
  await expectLayout(false, 'second relaunch restored expanded');
  await quit(); electron = undefined;
  assert.deepEqual(errors, [], 'Shell page errors');
  console.log('Packaged sidebar: default, mouse/keyboard/menu toggles, focus, tab order, resize, switching, stopped state, persistence: passed');
} finally {
  await writeFile(join(temp, 'sidebar-observations.json'), JSON.stringify(observations, null, 2));
  if (electron) await electron.evaluate(({ app }) => app.exit(0)).catch(() => {});
  console.log(`Fixture retained: ${temp}`);
}
