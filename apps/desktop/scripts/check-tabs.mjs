/**
 * Packaged regression for the title-bar project tabs and per-tab project controls. Uses ten
 * temporary projects and a temporary userData directory; it never touches the installed
 * application or its data. Selecting a tab must never start a project; only Start does.
 *   node apps/desktop/scripts/check-tabs.mjs   (DESKTOP_APP selects a relocated bundle)
 * Needs an unlocked macOS session (native focus checks).
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fixtureEnv } from '../tests/fixture-env.mjs';
import { defaultApp, appExecutable } from './app-identity.mjs';
import { mainProcessErrors } from './main-process-errors.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { _electron } = createRequire(join(root, 'apps/smithy-web/package.json'))('playwright');
const bundle = defaultApp(join(root, 'apps/desktop'));
const resources = join(bundle, 'Contents/Resources');
const node = join(resources, 'runtime/node');
const cli = join(resources, 'backend/dist/bin/sf.js');
// Window titles use the product name: "Stoneforge Desktop" or "Stoneforge Desktop Dev" (el-4fxwb9).
const productName = JSON.parse(await readFile(join(resources, 'app/build-info.json'), 'utf8')).productName ?? 'Stoneforge Desktop';
// Registered roots are canonical (the backend reports its realpath, e.g. /private/var/...).
const temp = await realpath(await mkdtemp(join(tmpdir(), 'stoneforge-tabs-')));
const appData = join(temp, 'app-data');
// A main-process exception must fail this check, not hang it behind Electron's modal error box.
const mainErrors = mainProcessErrors(join(temp, 'main-process-errors.jsonl'));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const env = fixtureEnv();
const observations = [];
const errors = [];
let electron, page;

const TOP = 76;
const names = ['Atlas', 'Borealis', 'Cedar проект', 'Delta', 'Ember', 'Fjord', 'Granite',
  'Harbor with a very long project name that must be truncated', 'Iris', 'Juniper'];

async function launch() {
  electron = await _electron.launch({ executablePath: appExecutable(bundle), args: [],
    env: { ...env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', STONEFORGE_DESKTOP_TEST_DATA: appData }, timeout: 30_000 });
  await mainErrors.install(electron);
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
  // Count real backend starts per project (ProjectManager.connectOrStart runs once per start).
  await electron.evaluate((_electron, managerURL) => {
    const { ProjectManager } = process.getBuiltinModule('module').createRequire(managerURL)(process.getBuiltinModule('url').fileURLToPath(managerURL));
    globalThis.__starts = {};
    if (ProjectManager.prototype.__countedStarts) return;
    const original = ProjectManager.prototype.connectOrStart;
    ProjectManager.prototype.connectOrStart = function (id) { globalThis.__starts[id] = (globalThis.__starts[id] ?? 0) + 1; return original.call(this, id); };
    ProjectManager.prototype.__countedStarts = true;
  }, pathToFileURL(join(resources, 'app/manager.js')).href);
}
/** Backend starts per project index since launch. */
const starts = async () => { const counts = await electron.evaluate(() => ({ ...globalThis.__starts })); return ids.map((id) => counts[id] ?? 0); };
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
    state: document.getElementById('state').hidden ? null : { text: document.getElementById('state').textContent, title: document.getElementById('state').title },
    start: document.getElementById('status').hidden || document.getElementById('start').hidden ? null : { label: document.getElementById('start').getAttribute('aria-label'), text: document.getElementById('start').textContent, disabled: document.getElementById('start').disabled },
    toolbarButtons: [...document.querySelectorAll('#toolbar button')].map((b) => b.textContent),
    actions: (() => { const b = document.getElementById('tab-actions'); return b.hidden ? null : { label: b.getAttribute('aria-label'), title: b.title, haspopup: b.getAttribute('aria-haspopup'), region: region(b), rect: rect(b), tabIndex: b.tabIndex }; })(),
    focus: document.activeElement?.dataset?.project ?? document.activeElement?.id ?? document.activeElement?.tagName,
  };
});
const ids = [];
const tabOf = (index) => page.locator(`[role="tab"][data-project="${ids[index]}"]`);
const activeId = () => page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.project);
async function waitActive(index, state = 'ready') {
  await page.waitForFunction(([id, state]) => {
    const tab = document.querySelector('[role="tab"][aria-selected="true"]');
    // Settled: no start/stop/restart still pending (e.g. a started view still loading).
    return tab?.dataset.project === id && tab.dataset.state === state && !tab.dataset.pending;
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
      assert.deepEqual(s.toolbarButtons, [], `${label}: no project buttons in the toolbar`);
      const selected = s.tabs.find((t) => t.selected === 'true');
      if (selected) {
        assert(s.actions, `${label}: ⋯ on the active tab`);
        assert(s.actions.rect.x >= selected.rect.x && s.actions.rect.x + s.actions.rect.width <= selected.rect.x + selected.rect.width, `${label}: ⋯ inside the active tab`);
        assert(s.actions.rect.width <= 24 && s.actions.rect.height <= 24, `${label}: compact ⋯`);
        assert.equal(s.actions.region, 'no-drag'); assert.equal(s.actions.haspopup, 'menu');
        assert.equal(s.actions.label, `Actions for ${selected.name}`);
      } else assert.equal(s.actions, null);
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
/** Activates a recorded popup item through its real click handler (`times` clicks in one turn). */
const clickPopup = (label, times = 1) => electron.evaluate((_e, { label, times }) => {
  const { menu } = globalThis.__popups.at(-1);
  const item = menu.items.find((i) => i.label === label) ?? menu.items.find((i) => i.label.includes(label));
  if (!item) throw new Error(`No popup item ${label}`);
  if (!item.enabled) throw new Error(`Popup item ${label} is disabled`);
  for (let index = 0; index < times; index++) item.click();
}, { label, times });
async function nextPopup() {
  const count = (await popups()).length;
  return async () => {
    for (let attempt = 0; attempt < 100; attempt++) { const all = await popups(); if (all.length > count) return all.at(-1); await pause(50); }
    throw new Error('No native popup');
  };
}
const menuLabels = (menu) => menu.items.map((i) => i.label ? `${i.label}${i.enabled ? '' : ' (disabled)'}` : '—');
const stateOf = (index) => page.evaluate((id) => document.querySelector(`[role="tab"][data-project="${id}"]`)?.dataset.state
  ?? window.desktop.command('list').then((s) => s.projects.find((p) => p.id === id)?.state), ids[index]);
async function waitState(index, state) {
  for (let attempt = 0; attempt < 600; attempt++) { if (await stateOf(index) === state) return; await pause(100); }
  throw new Error(`Project ${index} did not reach ${state} (is ${await stateOf(index)})`);
}
/** Stays in `state` for `ms` (no delayed or invisible start). */
async function staysState(index, state, ms = 1500) {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) { assert.equal(await stateOf(index), state, `Project ${index} must stay ${state}`); await pause(100); }
}
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

  // Selecting a stopped project by mouse only shows its state page; nothing starts.
  await tabOf(0).click(); await waitActive(0, 'stopped');
  await staysState(0, 'stopped');
  layout = await expectLayout('Atlas selected, stopped', 0);
  assert.equal(layout.native.title, `Atlas — ${productName}`);
  assert.equal(layout.native.views.length, 0, 'Selection creates no project view');
  assert.deepEqual(await starts(), ids.map(() => 0), 'Selecting does not start a backend');
  assert.match(layout.shell.status, /Atlas is stopped/);
  assert.deepEqual(layout.shell.start, { label: 'Start Atlas', text: 'Start project', disabled: false });
  assert.deepEqual(layout.shell.state, { text: 'Stopped', title: 'Stopped' });
  assert.match(layout.shell.actions.title, /^Atlas: Start, Restart, Logs, Repositories, Remove…$/);
  await shot('tabs-stopped-selected.png'); await nativeShot('tabs-stopped-selected-native.png');
  // Keyboard selection (⌘2, tablist Enter) of stopped projects does not start them either.
  await sendKey(await shellId(), '2', ['meta']); await waitActive(1, 'stopped');
  await tabOf(2).focus(); await page.keyboard.press('Enter'); await waitActive(2, 'stopped');
  await page.keyboard.press('Space'); await waitActive(2, 'stopped');
  await tabOf(0).focus(); await page.keyboard.press('Enter'); await waitActive(0, 'stopped');
  await staysState(1, 'stopped', 500); await staysState(2, 'stopped', 500);
  // The ⋯ button opens the same project menu; it does not select or start anything.
  let pendingMenu = await nextPopup();
  await page.locator('#tab-actions').click();
  let menu = await pendingMenu();
  assert.deepEqual(menuLabels(menu), ['Start Project', '—', 'Show Logs', 'Repositories… (disabled)', '—',
    'Move Tab Left (disabled)', 'Move Tab Right', '—', 'Remove Project…']);
  assert.equal(menu.items[3].toolTip, 'Start the project to manage its repositories');
  assert.equal(await activeId(), ids[0]);
  assert.deepEqual(await starts(), ids.map(() => 0), 'Selection, keyboard and ⋯ started nothing');
  observations.push({ label: 'stopped selection', checked: ['mouse', '⌘2', 'Enter', 'Space', '⋯ menu'], menu: menuLabels(menu) });

  // Start (explicit) — repeated clicks and duplicate requests start exactly once.
  await page.evaluate(() => { const start = document.getElementById('start'); start.click(); start.click(); });
  await page.evaluate((id) => { void window.desktop.command('start', id); void window.desktop.command('start', id); }, ids[0]);
  await page.waitForFunction(() => document.getElementById('start').disabled || document.getElementById('status').hidden);
  const starting = await shell();
  if (starting.start) { assert.equal(starting.start.disabled, true); assert.equal(starting.start.text, 'Starting…'); await shot('tabs-starting.png'); }
  await waitActive(0);
  layout = await expectLayout('Atlas started', 0);
  assert.deepEqual(layout.shell.state, { text: 'Running', title: 'Running' });
  assert.match(layout.shell.actions.title, /^Atlas: Stop, Restart/);
  await pause(500);
  assert.deepEqual(await starts(), [1, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'Start ran exactly once');
  const atlas = await viewOf(0);
  // Start from another (inactive) tab's right-click menu: that project only, no selection change.
  pendingMenu = await nextPopup();
  await tabOf(1).click({ button: 'right' });
  menu = await pendingMenu();
  assert.equal(menuLabels(menu)[0], 'Start Project');
  await clickPopup('Start Project', 2);
  await waitState(1, 'ready');
  assert.equal(await activeId(), ids[0], 'Menu Start keeps the selection');
  // An overflowed project can be started explicitly too.
  await page.evaluate((id) => window.desktop.command('start', id), ids[9]);
  await waitState(9, 'ready');
  assert.deepEqual(await starts(), [1, 1, 0, 0, 0, 0, 0, 0, 0, 1], 'One start per explicit Start');
  await run(atlas.id, `window.__tabsMarker = ${atlas.id}`);
  const atlasIdentity = await run(atlas.id, `fetch('/api/desktop/identity').then((r) => r.json())`);
  await shot('tabs-active.png'); await nativeShot('tabs-native-window.png');
  pendingMenu = await nextPopup();
  await page.locator('#tab-actions').focus(); await page.keyboard.press('Enter');
  menu = await pendingMenu();
  assert.deepEqual(menuLabels(menu), ['Stop Project…', 'Restart Project…', '—', 'Show Logs', 'Repositories…', '—',
    'Move Tab Left (disabled)', 'Move Tab Right', '—', 'Remove Project…'], 'Running project menu (keyboard-opened ⋯)');
  observations.push({ label: 'running menu', menu: menuLabels(menu) });

  // ⌃Tab from a focused project dashboard selects the next tab exactly once; focus follows.
  await focusView(atlas.id);
  await sendKey(atlas.id, 'Tab', ['control']);
  await waitActive(1); await expectLayout('⌃Tab from project view', 1);
  const borealis = await viewOf(1);
  for (let attempt = 0; attempt < 50 && !(await native()).views.find((v) => v.id === borealis.id).focused; attempt++) await pause(100);
  assert.equal((await native()).views.find((v) => v.id === borealis.id).focused, true, 'Focus follows to the selected project');
  assert.equal((await native()).views.find((v) => v.id === atlas.id).focused, false, 'Hidden project keeps no keyboard focus');
  await run(borealis.id, `window.__tabsMarker = ${borealis.id}`);
  // ⌃Tab from a focused dashboard to a stopped project: shown, not started; focus moves to the shell.
  await sendKey(borealis.id, 'Tab', ['control']);
  await waitActive(2, 'stopped'); await staysState(2, 'stopped', 800);
  for (let attempt = 0; attempt < 50 && (await native()).focused !== await shellId(); attempt++) await pause(100);
  assert.equal((await native()).focused, await shellId(), 'Hidden dashboards keep no focus when a stopped project is shown');
  await sendKey(await shellId(), 'Tab', ['control', 'shift']); await waitActive(1);
  await sendKey(await shellId(), 'Tab', ['control', 'shift']);
  await waitActive(0); await expectLayout('⌃⇧Tab back', 0);
  // ⌘9 selects the last project even though it is in the » menu; it takes the last visible slot.
  await focusView(atlas.id);
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
  await sendKey(await shellId(), '7', ['meta']); await waitActive(6, 'stopped');
  await sendKey(await shellId(), '1', ['meta']); await waitActive(0);
  await sendKey(await shellId(), 'Tab', ['control', 'shift']); await waitActive(9);
  await sendKey(await shellId(), 'Tab', ['control']); await waitActive(0);
  // ⌘0 is not a tab shortcut and must not change the selection.
  await sendKey(await shellId(), '0', ['meta']); await pause(300); assert.equal(await activeId(), ids[0]);
  observations.push({ label: 'shortcuts', checked: ['⌃Tab view', '⌃Tab view → stopped project (not started)', '⌘9 view', '⌘1 view', '⌘2 shell', '⌘7 shell', '⌘1 shell', '⌃⇧Tab wrap', '⌃Tab wrap', '⌘0 ignored'] });
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
  // Tab order: tablist (one stop) → ⋯ of the active tab → » → ＋.
  await page.keyboard.press('Tab'); assert.equal((await shell()).focus, 'tab-actions');
  await page.keyboard.press('Tab'); assert.equal((await shell()).focus, 'overflow');
  await page.keyboard.press('Tab'); assert.equal((await shell()).focus, 'add');
  for (let step = 0; step < 3; step++) await page.keyboard.press('Shift+Tab');
  assert.equal((await shell()).focus, ids[0]);
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
  assert.deepEqual(menuLabels(menus.at(-1)), ['Stop Project…', 'Restart Project…', '—', 'Show Logs', 'Repositories…', '—',
    'Move Tab Left', 'Move Tab Right', '—', 'Remove Project…']);
  await clickPopup('Move Tab Right');
  await page.waitForFunction((expected) => document.querySelectorAll('[role="tab"]')[2]?.dataset.project === expected, ids[1]);
  assert.deepEqual((await order()).slice(0, 3), [ids[0], ids[2], ids[1]]);
  await tabOf(0).focus(); await page.keyboard.press('Shift+F10');
  for (let attempt = 0; attempt < 50 && (await popups()).length < 2; attempt++) await pause(50);
  assert.deepEqual((await popups()).at(-1).items.filter((i) => i.label.startsWith('Move')).map((i) => [i.label, i.enabled]), [['Move Tab Left', false], ['Move Tab Right', true]]);
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

  // Stop through the active tab's ⋯ menu (twice in one turn): only Borealis stops, once.
  const before = await starts();
  pendingMenu = await nextPopup();
  await page.locator('#tab-actions').click();
  await pendingMenu(); await clickPopup('Stop Project…', 2);
  await waitState(1, 'stopped');
  layout = await expectLayout('Borealis stopped', 1);
  assert.match(layout.shell.status, /Borealis is stopped/);
  assert.equal(layout.native.views.filter((v) => v.visible).length, 0);
  assert.equal(layout.native.views.length, 2, 'Only the stopped project lost its view');
  for (const index of [0, 9]) assert.equal(await stateOf(index), 'ready', `Project ${index} keeps running`);
  await shot('tabs-stopped.png');
  // Reselecting a stopped project (mouse and keyboard) leaves it stopped.
  await tabOf(0).click(); await waitActive(0);
  await tabOf(1).click(); await waitActive(1, 'stopped');
  // Tab order is now Cedar, Borealis, Delta, Atlas, …: ⌘4 = Atlas, ⌘2 = Borealis.
  await sendKey(await shellId(), '4', ['meta']); await waitActive(0);
  await sendKey(await shellId(), '2', ['meta']); await waitActive(1, 'stopped');
  await staysState(1, 'stopped');
  assert.deepEqual(await starts(), before, 'Reselecting a stopped project starts nothing');
  // Start again from the stopped page with the keyboard.
  await page.locator('#start').focus(); await page.keyboard.press('Enter');
  await waitActive(1);
  // Restart from the menu (two clicks in one turn): one stop + one start, new backend.
  const borealisBefore = await run((await viewOf(1)).id, `fetch('/api/desktop/identity').then((r) => r.json())`);
  pendingMenu = await nextPopup();
  await tabOf(1).click({ button: 'right' });
  await pendingMenu(); await clickPopup('Restart Project…', 2);
  await page.waitForFunction((id) => document.querySelector(`[role="tab"][data-project="${id}"]`)?.dataset.state !== 'ready', ids[1]);
  await waitActive(1);
  const borealisAfter = await run((await viewOf(1)).id, `fetch('/api/desktop/identity').then((r) => r.json())`);
  assert.notEqual(borealisAfter.instanceId, borealisBefore.instanceId, 'Restart creates a new backend instance');
  await pause(500);
  const afterRestart = await starts();
  assert.deepEqual(afterRestart, before.map((count, index) => index === 1 ? count + 2 : count), 'Start + Restart: exactly two more starts, Borealis only');
  observations.push({ label: 'lifecycle', starts: afterRestart, restartedInstance: borealisAfter.instanceId !== borealisBefore.instanceId });

  // Switching only moved views: no reloads and the same backends.
  for (const [view, index] of [[atlas, 0], [juniper, 9]]) assert.equal(await run(view.id, 'window.__tabsMarker'), view.id, `Project ${index} view was not reloaded`);
  // Remove (confirmed) from the menu of a stopped project: registration only; files stay.
  pendingMenu = await nextPopup();
  await tabOf(2).click({ button: 'right' });
  await pendingMenu(); await clickPopup('Remove Project…');
  await page.waitForFunction((id) => !document.querySelector(`[role="tab"][data-project="${id}"]`), ids[2]);
  await access(join(temp, names[2], '.stoneforge/stoneforge.db'));
  assert.equal(await activeId(), ids[1], 'Removing another project keeps the selection');
  assert.deepEqual(await run(atlas.id, `fetch('/api/desktop/identity').then((r) => r.json())`), atlasIdentity, 'Switching must not restart a backend');

  // Status presentation gallery (synthetic shell state; screenshot evidence only).
  await page.evaluate(() => {
    const kinds = [['running', 'ready', 'Running'], ['stopped', 'stopped', 'Stopped'], ['busy', 'starting', 'Starting…'], ['busy', 'stopping', 'Stopping…'], ['error', 'error', 'Error: Backend exited'], ['attention', 'ready', 'Needs your input']];
    const snapshot = window.__galleryBase = structuredClone(state);
    render({ ...snapshot, projects: snapshot.projects.map((p, i) => i < kinds.length ? { ...p, state: kinds[i][1], status: { kind: kinds[i][0], label: kinds[i][2] } } : i === snapshot.projects.length - 1 ? { ...p, status: { kind: 'attention', label: 'Needs your input' } } : p) });
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
  const remaining = reordered.filter((id) => id !== ids[2]);
  assert.deepEqual(layout.shell.tabs.map((t) => t.id), remaining.slice(0, 8));
  assert.equal(layout.native.views.length, 0, 'Relaunch does not start projects');
  assert.equal(await activeId(), undefined, 'No selection is restored, so nothing can start invisibly');
  await tabOf(0).click(); await waitActive(0, 'stopped');
  await sendKey(await shellId(), 'Tab', ['control']); await page.waitForFunction((id) => document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.project !== id, ids[0]);
  await pause(1500);
  assert.equal((await native()).views.length, 0, 'Selecting after relaunch starts nothing');
  assert.deepEqual((await starts()).filter(Boolean), [], 'No backend start after relaunch');
  await quit();
  assert.deepEqual(errors, [], 'Shell page errors');
  await mainErrors.assertNone();
  console.log('Packaged tabs: layout/title bar regions, status, truncation, overflow menu, ⌘1–⌘9/⌃Tab from shell and views, tablist keyboard, selection never starts (mouse/keyboard/⋯/relaunch), Start once, Stop only selected, Restart once, Remove, per-tab ⋯/right-click/Shift+F10 menu, drag reorder persistence, resize, no reloads: passed');
} catch (error) {
  // A trapped main-process exception exits the app; report it rather than the resulting closed target.
  await mainErrors.rethrow(error);
} finally {
  await writeFile(join(temp, 'tabs-observations.json'), JSON.stringify(observations, null, 2));
  if (electron) await electron.evaluate(({ app }) => app.exit(0)).catch(() => {});
  console.log(`Fixture retained: ${temp}`);
}
