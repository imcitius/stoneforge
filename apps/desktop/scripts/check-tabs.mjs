/**
 * Packaged regression for the title-bar project tabs. Uses ten temporary projects and a
 * temporary userData directory; it never touches the installed application or its data.
 *   node apps/desktop/scripts/check-tabs.mjs   (DESKTOP_APP selects a relocated bundle)
 * Needs an unlocked macOS session (native focus checks).
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { _electron } = createRequire(join(root, 'apps/smithy-web/package.json'))('playwright');
const bundle = resolve(process.env.DESKTOP_APP ?? join(root, 'apps/desktop/dist/mac/Stoneforge Desktop-darwin-arm64/Stoneforge Desktop.app'));
const resources = join(bundle, 'Contents/Resources');
const node = join(resources, 'runtime/node');
const cli = join(resources, 'backend/dist/bin/sf.js');
// Registered roots are canonical (the backend reports its realpath, e.g. /private/var/...).
const temp = await realpath(await mkdtemp(join(tmpdir(), 'stoneforge-tabs-')));
const appData = join(temp, 'app-data');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(STONEFORGE_|SF_)/.test(key) || ['ORCHESTRATOR_URL', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete env[key];
const observations = [];
const errors = [];
let electron, page;

const TOP = 76;
const names = ['Atlas', 'Borealis', 'Cedar проект', 'Delta', 'Ember', 'Fjord', 'Granite',
  'Harbor with a very long project name that must be truncated', 'Iris', 'Juniper'];

async function launch() {
  electron = await _electron.launch({ executablePath: join(bundle, 'Contents/MacOS/Stoneforge Desktop'), args: [],
    env: { ...env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', STONEFORGE_DESKTOP_TEST_DATA: appData }, timeout: 30_000 });
  page = await electron.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => document.getElementById('build').textContent.startsWith('v'));
  await electron.evaluate(({ BrowserWindow, dialog, Menu }) => {
    const window = BrowserWindow.getAllWindows().find((w) => !w.getParentWindow());
    window.setContentSize(1024, 700); window.show(); window.focus();
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    // Record native popups (» and per-tab menus) instead of entering macOS menu tracking.
    globalThis.__popups = [];
    Menu.prototype.popup = function (options) { globalThis.__popups.push({ menu: this, x: options?.x, y: options?.y }); };
  });
}
async function quit() {
  const exited = new Promise((r) => electron.process().once('exit', r));
  await electron.evaluate(({ app }) => app.quit());
  await Promise.race([exited, pause(30_000).then(() => { throw new Error('Desktop did not quit'); })]);
  electron = undefined;
}
const native = () => electron.evaluate(({ BrowserWindow, webContents }) => {
  const window = BrowserWindow.getAllWindows().find((w) => !w.getParentWindow());
  const [width, height] = window.getContentSize();
  return { width, height, title: window.getTitle(), buttons: window.getWindowButtonPosition?.() ?? null,
    focused: webContents.getFocusedWebContents()?.id ?? null,
    views: window.contentView.children.map((view) => ({ id: view.webContents.id, url: view.webContents.getURL(),
      bounds: view.getBounds(), visible: view.getVisible(), focused: view.webContents.isFocused() })) };
});
const shell = () => page.evaluate(() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom }; };
  const region = (el) => getComputedStyle(el).getPropertyValue('-webkit-app-region') || getComputedStyle(el).webkitAppRegion;
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const overflow = document.getElementById('overflow');
  return {
    tablist: document.querySelector('[role="tablist"]')?.getAttribute('aria-label'),
    tabs: tabs.map((tab) => ({ id: tab.dataset.project, name: tab.querySelector('.tab-name').textContent, state: tab.dataset.state,
      status: tab.dataset.status, selected: tab.getAttribute('aria-selected'), label: tab.getAttribute('aria-label'), title: tab.title,
      tabIndex: tab.tabIndex, region: region(tab), rect: rect(tab), truncated: tab.querySelector('.tab-name').scrollWidth > tab.querySelector('.tab-name').clientWidth })),
    overflow: overflow.hidden ? null : { label: overflow.getAttribute('aria-label'), title: overflow.title, region: region(overflow), attention: overflow.classList.contains('attention') },
    add: { region: region(document.getElementById('add')), label: document.getElementById('add').getAttribute('aria-label'), rect: rect(document.getElementById('add')) },
    titlebar: { rect: rect(document.getElementById('titlebar')), region: region(document.getElementById('titlebar')) },
    toolbar: rect(document.getElementById('toolbar')), main: rect(document.querySelector('main')),
    sidebar: !!document.getElementById('sidebar'), name: document.getElementById('name').textContent,
    status: document.getElementById('status').hidden ? '' : document.getElementById('status').textContent,
    focus: document.activeElement?.dataset?.project ?? document.activeElement?.id ?? document.activeElement?.tagName,
  };
});
const ids = [];
const tabOf = (index) => page.locator(`[role="tab"][data-project="${ids[index]}"]`);
const activeId = () => page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.project);
async function waitActive(index, state = 'ready') {
  await page.waitForFunction(([id, state]) => {
    const tab = document.querySelector('[role="tab"][aria-selected="true"]');
    return tab?.dataset.project === id && tab.dataset.state === state;
  }, [ids[index], state], { timeout: 60_000 });
}
/** Every native project view fills the window width below the shell, and only the active one shows. */
async function expectLayout(label, activeIndex) {
  let s, n, failure;
  for (let attempt = 0; attempt < 100; attempt++) {
    [s, n] = [await shell(), await native()];
    try {
      assert.equal(s.sidebar, false, 'No project sidebar');
      assert.equal(s.titlebar.rect.y, 0); assert.equal(s.titlebar.rect.height, 38);
      assert.equal(s.toolbar.y, 38); assert.equal(s.toolbar.height, 38);
      assert.equal(s.main.x, 0); assert.equal(s.main.y, TOP); assert.equal(s.main.width, n.width);
      for (const view of n.views) assert.deepEqual(view.bounds, { x: 0, y: TOP, width: n.width, height: n.height - TOP }, `${label}: view ${view.id}`);
      if (activeIndex !== undefined) {
        assert.deepEqual(s.tabs.filter((t) => t.selected === 'true').map((t) => t.id), [ids[activeIndex]]);
        assert(n.views.filter((v) => v.visible).length <= 1);
      }
      for (const tab of s.tabs) assert(tab.rect.x >= 78 && tab.rect.bottom <= 39, `${label}: tab inside title bar right of traffic lights`);
      failure = undefined; break;
    } catch (error) { failure = error; await pause(20); }
  }
  if (failure) { console.error(label, JSON.stringify({ shell: s, native: n })); throw failure; }
  observations.push({ label, window: [n.width, n.height], title: n.title, tabs: s.tabs.map(({ name, state, status, selected, rect }) => ({ name, state, status, selected, width: rect.width })), overflow: s.overflow, views: n.views });
  return { shell: s, native: n };
}
const run = (id, script) => electron.evaluate(({ webContents }, { id, script }) => webContents.fromId(id).executeJavaScript(script), { id, script });
const viewOf = async (index) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const view = (await native()).views.find((v) => v.visible);
    const active = await activeId();
    if (view && active === ids[index]) return view;
    await pause(50);
  }
  throw new Error(`No visible view for project ${index}`);
};
/** Native key event into a WebContents (goes through before-input-event like a real key). */
const sendKey = (id, keyCode, modifiers) => electron.evaluate(({ webContents }, { id, keyCode, modifiers }) => {
  const contents = webContents.fromId(id);
  contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}, { id, keyCode, modifiers });
const shellId = () => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.getParentWindow()).webContents.id);
async function focusView(id) {
  for (let attempt = 0; attempt < 50; attempt++) {
    await electron.evaluate(({ BrowserWindow, webContents }, id) => {
      BrowserWindow.getAllWindows().find((w) => !w.getParentWindow()).focus(); webContents.fromId(id).focus();
    }, id);
    if ((await native()).views.find((v) => v.id === id)?.focused) return;
    await pause(100);
  }
  throw new Error('Project view did not take native focus (is the macOS session unlocked and the app frontmost?)');
}
const popups = () => electron.evaluate(() => globalThis.__popups.map(({ menu, x, y }) => ({ x, y, items: menu.items.map((i) => ({ label: i.label, enabled: i.enabled, toolTip: i.toolTip })) })));
const clickPopup = (label) => electron.evaluate((_e, label) => {
  const { menu } = globalThis.__popups.at(-1);
  const item = menu.items.find((i) => i.label === label || i.label.includes(label));
  if (!item) throw new Error(`No popup item ${label}`);
  item.click();
}, label);
const shot = (name) => page.screenshot({ path: join(temp, name) });
/** Whole window including traffic lights and the project view (needs Screen Recording permission). */
async function nativeShot(name) {
  try {
    const source = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.getParentWindow()).getMediaSourceId());
    const windowId = source.split(':')[1];
    execFileSync('/usr/sbin/screencapture', ['-x', '-o', `-l${windowId}`, join(temp, name)], { stdio: 'pipe' });
    observations.push({ nativeScreenshot: name });
  } catch (error) { observations.push({ nativeScreenshot: name, unavailable: String(error.message).slice(0, 200) }); }
}
const order = () => page.evaluate(() => window.desktop.command('list').then((s) => s.projects.map((p) => p.id)));

try {
  // Ten registered fixture projects; only those selected during the check get a backend.
  const first = join(temp, names[0]); await mkdir(first);
  execFileSync(node, [cli, 'init', '--preset', 'auto', '--name', 'tabs-fixture'], { cwd: first, env, stdio: 'pipe' });
  const registry = [];
  for (const name of names) {
    const path = join(temp, name);
    if (name !== names[0]) await cp(first, path, { recursive: true });
    const id = randomUUID(); ids.push(id); registry.push({ id, name, root: path });
  }
  await mkdir(appData, { recursive: true });
  await writeFile(join(appData, 'projects.json'), JSON.stringify(registry, null, 2));
  // A preference left by the removed sidebar must not affect the new layout.
  await writeFile(join(appData, 'preferences.json'), '{"sidebarCollapsed":true}\n');

  await launch();
  let layout = await expectLayout('initial 1024x700, no project open');
  const s0 = layout.shell;
  assert.equal(s0.tablist, 'Projects');
  assert.equal(s0.titlebar.region, 'drag', 'Empty title bar areas drag the window');
  assert.equal(s0.tabs.length, 8, 'Eight tabs fit at 1024px'); assert.match(s0.overflow.label, /^2 more projects$/);
  assert.equal(s0.overflow.region, 'no-drag'); assert.equal(s0.add.region, 'no-drag'); assert.equal(s0.add.label, 'Add project');
  assert(s0.add.rect.x > s0.tabs.at(-1).rect.x, '+ follows the tabs');
  for (const [index, tab] of s0.tabs.entries()) {
    assert.equal(tab.name, names[index]); assert.equal(tab.region, 'no-drag', 'Tabs do not drag the window');
    assert.equal(tab.state, 'stopped'); assert.equal(tab.status, 'stopped'); assert.equal(tab.selected, 'false');
    assert.equal(tab.label, `${names[index]}, Stopped`); assert.equal(tab.title, `${names[index]}\n${registry[index].root}\nStopped`);
    assert(tab.rect.width >= 96 && tab.rect.width <= 200);
  }
  assert.equal(s0.tabs.filter((t) => t.tabIndex === 0).length, 1, 'One tab stop in the tablist');
  assert.equal(s0.tabs[7].truncated, true, 'Long name is truncated with an ellipsis'); assert.equal(s0.tabs[0].truncated, false);
  assert.match(s0.overflow.title, /Iris — Stopped\nJuniper — Stopped/);
  const buttons = layout.native.buttons;
  observations.push({ trafficLights: buttons });
  if (buttons) assert.deepEqual(buttons, { x: 13, y: 12 });
  assert.equal(await electron.evaluate(({ Menu }) => !!Menu.getApplicationMenu().getMenuItemById('toggle-sidebar')), false, 'Sidebar menu item removed');
  assert.equal(await electron.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('next-project')?.accelerator), 'Control+Tab');
  await shot('tabs-initial.png');

  // Select by mouse; the project view gets the full width.
  await tabOf(0).click(); await waitActive(0);
  layout = await expectLayout('Atlas open', 0);
  assert.equal(layout.native.title, 'Atlas — Stoneforge Desktop');
  const atlas = await viewOf(0);
  await run(atlas.id, `window.__tabsMarker = ${atlas.id}`);
  const atlasIdentity = await run(atlas.id, `fetch('/api/desktop/identity').then((r) => r.json())`);
  await shot('tabs-active.png'); await nativeShot('tabs-native-window.png');

  // ⌃Tab from a focused project dashboard selects the next tab exactly once; focus follows.
  await focusView(atlas.id);
  await sendKey(atlas.id, 'Tab', ['control']);
  await waitActive(1); await expectLayout('⌃Tab from project view', 1);
  const borealis = await viewOf(1);
  for (let attempt = 0; attempt < 50 && !(await native()).views.find((v) => v.id === borealis.id).focused; attempt++) await pause(100);
  assert.equal((await native()).views.find((v) => v.id === borealis.id).focused, true, 'Focus follows to the selected project');
  assert.equal((await native()).views.find((v) => v.id === atlas.id).focused, false, 'Hidden project keeps no keyboard focus');
  await run(borealis.id, `window.__tabsMarker = ${borealis.id}`);
  await sendKey(borealis.id, 'Tab', ['control', 'shift']);
  await waitActive(0); await expectLayout('⌃⇧Tab back', 0);
  // ⌘9 selects the last project even though it is in the » menu; it takes the last visible slot.
  await sendKey(atlas.id, '9', ['meta']);
  await waitActive(9); layout = await expectLayout('⌘9 last (overflowed) project', 9);
  assert.deepEqual(layout.shell.tabs.map((t) => t.name), [...names.slice(0, 7), names[9]]);
  assert.match(layout.shell.overflow.title, /Harbor with a very long project name that must be truncated — Stopped\nIris — Stopped/);
  const juniper = await viewOf(9);
  await sendKey(juniper.id, '1', ['meta']); await waitActive(0);
  // Shortcuts also work while the shell itself has focus. (Native input events: Playwright's
  // CDP key synthesis bypasses Electron's before-input-event, unlike real key presses.)
  await page.locator('#add').focus();
  await sendKey(await shellId(), '2', ['meta']); await waitActive(1);
  await sendKey(await shellId(), '7', ['meta']); await waitActive(6);
  await sendKey(await shellId(), '1', ['meta']); await waitActive(0);
  await sendKey(await shellId(), 'Tab', ['control', 'shift']); await waitActive(9);
  await sendKey(await shellId(), 'Tab', ['control']); await waitActive(0);
  // ⌘0 is not a tab shortcut and must not change the selection.
  await sendKey(await shellId(), '0', ['meta']); await pause(300); assert.equal(await activeId(), ids[0]);
  observations.push({ label: 'shortcuts', checked: ['⌃Tab view', '⌃⇧Tab view', '⌘9 view', '⌘1 view', '⌘2 shell', '⌘7 shell', '⌘1 shell', '⌃⇧Tab wrap', '⌃Tab wrap', '⌘0 ignored'] });
  // The Window menu item cycles too.
  await electron.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('next-project').click()); await waitActive(1);

  // Tablist keyboard: arrows move focus only, Enter selects, one tab stop, Tab leaves the list.
  await tabOf(1).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal((await shell()).focus, ids[2]); assert.equal(await activeId(), ids[1], 'Arrow keys do not select');
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
  assert.equal((await shell()).focus, ids[0]);
  await page.keyboard.press('End'); assert.equal((await shell()).focus, ids[7]);
  await page.keyboard.press('ArrowRight'); assert.equal((await shell()).focus, ids[0], 'Arrow navigation wraps');
  assert.deepEqual((await shell()).tabs.filter((t) => t.tabIndex === 0).map((t) => t.id), [ids[0]], 'Roving tab stop follows focus');
  await page.keyboard.press('Enter'); await waitActive(0);
  await page.keyboard.press('Tab'); assert.equal((await shell()).focus, 'overflow');
  await page.keyboard.press('Tab'); assert.equal((await shell()).focus, 'add');
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Shift+Tab'); assert.equal((await shell()).focus, ids[0]);
  await page.keyboard.press('Home'); assert.equal((await shell()).focus, ids[0]);

  // » menu: remaining projects with status, in order; choosing one selects it.
  await electron.evaluate(() => { globalThis.__popups = []; });
  await page.locator('#overflow').focus(); await page.keyboard.press('Enter');
  for (let attempt = 0; attempt < 50 && !(await popups()).length; attempt++) await pause(50);
  let menus = await popups();
  assert.deepEqual(menus.at(-1).items.map((i) => i.label), [`○  ${names[8]} — Stopped`, `●  ${names[9]} — Running`]);
  assert.equal(menus.at(-1).items[1].toolTip, `${registry[9].root}\nRunning`);
  await clickPopup(names[9]); await waitActive(9);
  assert.equal(await run(juniper.id, 'typeof window.__tabsMarker'), 'undefined');
  await run(juniper.id, `window.__tabsMarker = ${juniper.id}`);

  // Per-tab menu hook: right-click and Shift+F10, Move Tab Left/Right, persisted order.
  await electron.evaluate(() => { globalThis.__popups = []; });
  await tabOf(1).click({ button: 'right' });
  for (let attempt = 0; attempt < 50 && !(await popups()).length; attempt++) await pause(50);
  menus = await popups();
  assert.deepEqual(menus.at(-1).items.map((i) => [i.label, i.enabled]), [['Move Tab Left', true], ['Move Tab Right', true]]);
  await clickPopup('Move Tab Right');
  await page.waitForFunction((expected) => document.querySelectorAll('[role="tab"]')[2]?.dataset.project === expected, ids[1]);
  assert.deepEqual((await order()).slice(0, 3), [ids[0], ids[2], ids[1]]);
  await tabOf(0).focus(); await page.keyboard.press('Shift+F10');
  for (let attempt = 0; attempt < 50 && (await popups()).length < 2; attempt++) await pause(50);
  assert.deepEqual((await popups()).at(-1).items.map((i) => [i.label, i.enabled]), [['Move Tab Left', false], ['Move Tab Right', true]]);
  // Drag-to-reorder: drop Atlas after Delta.
  await tabOf(0).dragTo(tabOf(3), { targetPosition: { x: 90, y: 15 } });
  await page.waitForFunction((expected) => document.querySelectorAll('[role="tab"]')[3]?.dataset.project === expected, ids[0]);
  const reordered = [ids[2], ids[1], ids[3], ids[0], ...ids.slice(4)];
  assert.deepEqual(await order(), reordered);
  await pause(200);
  assert.deepEqual(JSON.parse(await readFile(join(appData, 'preferences.json'), 'utf8')), { projectOrder: reordered }, 'Order in userData; old sidebar key dropped');
  // ⌘N follows the displayed order.
  await sendKey(await shellId(), '4', ['meta']); await waitActive(0);
  await sendKey(await shellId(), '2', ['meta']); await waitActive(1);
  await shot('tabs-reordered.png');

  // Resizing re-fits tabs; views keep full width; the active tab never overflows.
  for (const [width, height, visible] of [[1440, 900, 10], [960, 640, 7], [1280, 820, 10], [1024, 700, 8]]) {
    await electron.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows().find((w) => !w.getParentWindow()).setContentSize(width, height), [width, height]);
    await page.waitForFunction((count) => document.querySelectorAll('[role="tab"]').length === count, visible);
    layout = await expectLayout(`resize ${width}x${height}`, 1);
    assert.equal(layout.shell.overflow === null, visible === 10);
    if (width === 960) await shot('tabs-overflow-960.png');
    if (width === 1440) await shot('tabs-1440.png');
  }

  // Stop through the existing toolbar control; the tab shows it and reselecting reopens.
  await page.locator('[data-command="stop"]').click();
  await page.waitForFunction((id) => document.querySelector(`[role="tab"][data-project="${id}"]`)?.dataset.state === 'stopped', ids[1], { timeout: 30_000 });
  layout = await expectLayout('Borealis stopped', 1);
  assert.match(layout.shell.status, /Project stopped\. Select its tab to open it again\./);
  assert.equal(layout.native.views.filter((v) => v.visible).length, 0);
  await shot('tabs-stopped.png');
  await tabOf(1).click(); await waitActive(1);

  // Switching only moved views: no reloads and the same backends.
  for (const [view, index] of [[atlas, 0], [juniper, 9]]) assert.equal(await run(view.id, 'window.__tabsMarker'), view.id, `Project ${index} view was not reloaded`);
  assert.deepEqual(await run(atlas.id, `fetch('/api/desktop/identity').then((r) => r.json())`), atlasIdentity, 'Switching must not restart a backend');

  // Status presentation gallery (synthetic shell state; screenshot evidence only).
  await page.evaluate(() => {
    const kinds = [['running', 'ready', 'Running'], ['stopped', 'stopped', 'Stopped'], ['busy', 'starting', 'Starting…'], ['busy', 'stopping', 'Stopping…'], ['error', 'error', 'Error: Backend exited'], ['attention', 'ready', 'Needs your input']];
    const snapshot = window.__galleryBase = structuredClone(state);
    render({ ...snapshot, projects: snapshot.projects.map((p, i) => i < kinds.length ? { ...p, state: kinds[i][1], status: { kind: kinds[i][0], label: kinds[i][2] } } : i === 9 ? { ...p, status: { kind: 'attention', label: 'Needs your input' } } : p) });
  });
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.getParentWindow()).setContentSize(960, 640));
  await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 7);
  assert.equal((await shell()).overflow.attention, true, '» shows attention for an overflowed project');
  await shot('tabs-status-gallery-synthetic.png');
  await page.evaluate(() => window.desktop.command('list').then(render));
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.getParentWindow()).setContentSize(1024, 700));

  // Relaunch keeps the order, starts nothing; projects never store shell preferences.
  assert(!(await readFile(join(appData, 'projects.json'), 'utf8')).includes('projectOrder'));
  for (const name of names) await assert.rejects(access(join(temp, name, '.stoneforge/preferences.json')));
  await quit();
  await launch();
  layout = await expectLayout('relaunch');
  assert.deepEqual(layout.shell.tabs.map((t) => t.id), reordered.slice(0, 8));
  assert.equal(layout.native.views.length, 0, 'Relaunch does not start projects');
  await quit();
  assert.deepEqual(errors, [], 'Shell page errors');
  console.log('Packaged tabs: layout/title bar regions, status, truncation, overflow menu, ⌘1–⌘9/⌃Tab from shell and views, tablist keyboard, per-tab menu, drag reorder persistence, resize, stopped state, no reloads, relaunch: passed');
} finally {
  await writeFile(join(temp, 'tabs-observations.json'), JSON.stringify(observations, null, 2));
  if (electron) await electron.evaluate(({ app }) => app.exit(0)).catch(() => {});
  console.log(`Fixture retained: ${temp}`);
}
