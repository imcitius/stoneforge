/** Runs inside the existing packaged smoke fixture; no production test IPC. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { recordPopups, chooseTabAction } from './tab-menu.mjs';

export async function checkLogs(electron, page, resources, temp) {
  const managerURL = pathToFileURL(join(resources, 'app/manager.js')).href;
  const original = await electron.evaluate(async ({ BrowserWindow, screen }, managerURL) => {
    const owner = BrowserWindow.getAllWindows()[0];
    const display = screen.getDisplayMatching(owner.getBounds());
    const area = { ...display.workArea, height: Math.min(600, display.workArea.height) };
    const saved = { bounds: owner.getBounds(), minimum: owner.getMinimumSize(), area };
    globalThis.__logsDisplay = screen.getDisplayMatching;
    screen.getDisplayMatching = () => ({ ...display, workArea: area });
    const { ProjectManager } = process.getBuiltinModule('module').createRequire(managerURL)(process.getBuiltinModule('url').fileURLToPath(managerURL));
    globalThis.__logsList = ProjectManager.prototype.list;
    // Supply deterministic log snapshots through the real manager/command path.
    ProjectManager.prototype.list = function () {
      if (globalThis.__logsFixture !== undefined) {
        for (const id of this.projects.keys()) this.logs.set(id, globalThis.__logsFixture);
      }
      return globalThis.__logsList.call(this);
    };
    owner.setMinimumSize(600, 300);
    owner.setBounds({ x: area.x, y: area.y, width: Math.min(1200, area.width), height: area.height });
    owner.show(); owner.focus();
    return saved;
  }, managerURL);
  const errors = [];
  const observations = [];
  const fixture = 'discarded prefix\n'.repeat(300) + Array.from({ length: 1000 }, (_, i) => `line ${i}\n`).join('') +
    'LONG:' + 'W'.repeat(1500) + '\n</pre><script>globalThis.LOG_EXECUTED=true</script><img src=x onerror="alert(1)">&\nEND';
  const setLogs = async (logs) => {
    await electron.evaluate((_electron, logs) => { globalThis.__logsFixture = logs; }, logs);
    await page.evaluate(() => window.desktop.command('list'));
  };
  // Native focus (NSWindow key status) exists only while this is the active macOS application.
  // Playwright clicks and keys are CDP input: unlike a user's click they never activate the app.
  // If another app became active meanwhile (a user, another GUI check), the owner's non-forcing
  // focus() after the viewer closes is refused and focus never settles (el-66l68k). So before each
  // user action the check activates the app, as that user's click would; the product must still
  // move focus to the viewer and back to the owner by itself. On failure, report who is active.
  const frontmost = () => {
    try {
      const info = execFileSync('/usr/bin/lsappinfo', ['info', '-only', 'name', '-only', 'pid',
        execFileSync('/usr/bin/lsappinfo', ['front']).toString().trim()]).toString();
      const root = execFileSync('/usr/sbin/ioreg', ['-n', 'Root', '-d1', '-a']).toString();
      return { name: info.match(/"([^"]*)"/)?.[1], pid: Number(info.match(/pid\s*=\s*(\d+)/)?.[1]),
        consoleLocked: root.match(/IOConsoleLocked<\/key>\s*<(true|false)\/>/)?.[1] ?? 'unknown' };
    } catch (error) { return { error: String(error) }; }
  };
  const focusReport = async (expected) => {
    const native = await electron.evaluate(({ BrowserWindow }) => ({ appPid: process.pid,
      windows: BrowserWindow.getAllWindows().map(w => ({ id: w.id, title: w.getTitle(), child: !!w.getParentWindow(),
        visible: w.isVisible(), focused: w.isFocused() })) }));
    const shell = await page.evaluate(() => ({ hasFocus: document.hasFocus(),
      activeElement: document.activeElement?.id || document.activeElement?.tagName })).catch(error => String(error));
    const front = frontmost();
    return `${expected}; frontmost app ${JSON.stringify(front)}, test app pid ${native.appPid}` +
      `${front.pid === native.appPid ? '' : ' (test app is NOT active)'}; windows ${JSON.stringify(native.windows)}; shell ${JSON.stringify(shell)}`;
  };
  const nativeFocus = async (child) => {
    const settled = await electron.evaluate(async ({ BrowserWindow }, child) => {
      const window = BrowserWindow.getAllWindows().find(window => !!window.getParentWindow() === child);
      if (window.isFocused()) return true;
      return new Promise((resolve) => {
        const focused = () => { clearTimeout(timeout); resolve(true); };
        const timeout = setTimeout(() => { window.off('focus', focused); resolve(false); }, 10_000);
        window.once('focus', focused);
      });
    }, child);
    if (!settled) throw new Error('Native focus did not settle: ' + await focusReport(`expected the ${child ? 'Logs viewer' : 'owner window'} to be focused`));
  };
  const activateApp = async () => {
    const active = await electron.evaluate(async ({ app, BrowserWindow }) => {
      if (BrowserWindow.getFocusedWindow()) return true;
      app.focus({ steal: true });
      if (BrowserWindow.getFocusedWindow()) return true;
      return new Promise((resolve) => {
        const focused = () => { clearTimeout(timeout); resolve(true); };
        const timeout = setTimeout(() => { app.off('browser-window-focus', focused); resolve(false); }, 10_000);
        app.once('browser-window-focus', focused);
      });
    });
    if (!active) throw new Error('Could not activate the packaged app before a user action: ' + await focusReport('expected the test app to be active'));
  };
  // Logs opens from the active tab's ⋯ project menu (the toolbar buttons were removed).
  const restorePopup = await recordPopups(electron);
  const open = async () => {
    // The user clicks ⋯ in the owner window: the app is active and the owner is key.
    await activateApp(); await nativeFocus(false);
    const waiting = electron.waitForEvent('window');
    await chooseTabAction(electron, page, 'Show Logs');
    const viewer = await waiting;
    viewer.on('pageerror', (error) => errors.push(error.message));
    await viewer.locator('#close').waitFor();
    await viewer.waitForFunction(() => document.hasFocus());
    await nativeFocus(true);
    return viewer;
  };
  const inspect = async (viewer, label) => {
    const metrics = await viewer.evaluate(() => {
      const pre = document.querySelector('pre'), close = document.getElementById('close');
      const box = close.getBoundingClientRect();
      return { text: pre.textContent, scrollHeight: pre.scrollHeight, clientHeight: pre.clientHeight,
        scrollWidth: pre.scrollWidth, clientWidth: pre.clientWidth, scrollTop: pre.scrollTop,
        close: { x: box.x, y: box.y, right: box.right, bottom: box.bottom },
        width: innerWidth, height: innerHeight, focused: document.hasFocus(),
        closeHit: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === close,
        node: typeof require, bridge: typeof window.desktop, executed: !!globalThis.LOG_EXECUTED,
        injectedElements: document.querySelectorAll('script,img').length };
    });
    const native = await electron.evaluate(({ BrowserWindow }) => {
      const viewer = BrowserWindow.getAllWindows().find(w => w.getParentWindow());
      const owner = viewer.getParentWindow();
      return { bounds: viewer.getBounds(), visible: viewer.isVisible(), focused: viewer.isFocused(),
        ownerId: owner.id, viewerId: viewer.id, closable: viewer.isClosable(),
        projectVisible: owner.contentView.children.some(view => view !== owner.webContentsView && view.getVisible()),
        preferences: viewer.webContents.getLastWebPreferences() };
    });
    const area = original.area, bounds = native.bounds;
    assert(bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width &&
      bounds.y + bounds.height <= area.y + area.height, 'Native outer bounds must fit the 600px work area');
    const nativeOk = native.visible && native.focused && native.closable && native.projectVisible;
    assert(nativeOk, nativeOk || JSON.stringify({ ...native, frontmost: frontmost() }));
    assert(metrics.close.bottom <= metrics.height && metrics.close.right <= metrics.width && metrics.closeHit);
    assert.equal(metrics.node, 'undefined'); assert.equal(metrics.bridge, 'undefined');
    assert(!metrics.executed && metrics.injectedElements === 0);
    assert(native.preferences.sandbox && native.preferences.contextIsolation && !native.preferences.nodeIntegration);
    observations.push({ label, ...metrics, text: undefined, native: { ...native, preferences: undefined } });
    return metrics;
  };
  const closingKey = async (viewer, key) => {
    // The keydown closes the native window before Playwright sends keyup.
    await viewer.keyboard.press(key).catch(error => { if (!viewer.isClosed()) throw error; });
  };
  const close = async (viewer, method) => {
    // The user acts in the viewer: the app is active and the viewer is key.
    await activateApp(); await nativeFocus(true);
    const closed = viewer.waitForEvent('close');
    if (method === 'button') await viewer.locator('#close').click();
    else if (method === 'escape') { await viewer.locator('pre').focus(); await closingKey(viewer, 'Escape'); }
    else {
      // BrowserWindow.close uses the native close lifecycle (unlike destroy).
      await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow().close());
    }
    await closed;
    await nativeFocus(false);
    await page.waitForFunction(() => document.hasFocus() && document.activeElement?.id === 'tab-actions');
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    observations.push({ closedBy: method, ownerFocusRestored: true });
  };
  try {
    await setLogs(fixture);
    const viewer = await open();
    const first = await inspect(viewer, 'multiline-top');
    assert.equal(first.text, fixture.slice(-10_000));
    assert(first.scrollHeight > first.clientHeight * 10);
    await viewer.screenshot({ path: join(temp, 'logs-multiline-top.png') });
    await activateApp(); await nativeFocus(true);
    await viewer.locator('pre').hover(); await viewer.mouse.wheel(0, 800);
    await viewer.waitForFunction(() => document.querySelector('pre').scrollTop > 0);
    await viewer.locator('pre').focus(); await viewer.keyboard.press('Control+End');
    // macOS uses Meta+ArrowDown for the end of a scrollable region.
    await viewer.keyboard.press('Meta+ArrowDown');
    await viewer.waitForFunction(() => {
      const pre = document.querySelector('pre'); return pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 2;
    });
    const end = await inspect(viewer, 'multiline-end');
    assert(end.scrollTop > 0); assert(end.scrollWidth <= end.clientWidth + 1, 'Long lines wrap');
    await viewer.screenshot({ path: join(temp, 'logs-multiline-end.png') });
    try {
      execFileSync('/usr/sbin/screencapture', ['-x', '-R', `${original.area.x},${original.area.y},${Math.min(1200, original.area.width)},${original.area.height}`, join(temp, 'logs-native-desktop.png')]);
      observations.push({ nativeScreenshot: 'logs-native-desktop.png' });
    } catch (error) { observations.push({ nativeScreenshotBlocked: String(error) }); }
    // Repeated commands focus the same viewer, rather than stacking windows.
    await page.evaluate(() => { void window.desktop.command('logs', document.querySelector('[role="tab"][aria-selected="true"]').dataset.project); });
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2);
    await close(viewer, 'button');

    await setLogs('L'.repeat(20_000));
    const long = await open();
    const longMetrics = await inspect(long, 'long-line');
    assert.equal(longMetrics.text.length, 10_000);
    assert(longMetrics.scrollHeight > longMetrics.clientHeight);
    assert(longMetrics.scrollWidth <= longMetrics.clientWidth + 1);
    await long.screenshot({ path: join(temp, 'logs-long-line.png') });
    await close(long, 'escape');

    await setLogs('');
    const empty = await open();
    assert.equal((await inspect(empty, 'empty')).text, 'No logs yet');
    await empty.screenshot({ path: join(temp, 'logs-empty.png') });
    await close(empty, 'native');

    await setLogs('\nFresh snapshot after reopening: 日本語 🪨');
    const reopened = await open();
    assert.equal((await inspect(reopened, 'reopened')).text, '\nFresh snapshot after reopening: 日本語 🪨');
    const commandClosed = reopened.waitForEvent('close');
    await closingKey(reopened, 'Meta+w'); await commandClosed;
    await page.waitForFunction(() => document.hasFocus());
    await setLogs('🪨' + 'x'.repeat(9999));
    const keyboard = await open();
    assert.equal((await keyboard.locator('pre').textContent()).length, 10_000);
    await keyboard.locator('#close').focus();
    const closed = keyboard.waitForEvent('close');
    await closingKey(keyboard, 'Enter'); await closed;
    await page.waitForFunction(() => document.hasFocus());
    const previous = await open();
    await activateApp();
    const replacement = electron.waitForEvent('window');
    const previousClosed = previous.waitForEvent('close');
    await page.evaluate(async () => {
      const atlas = [...document.querySelectorAll('[role="tab"]')].find(button => button.textContent.includes('Atlas'));
      await window.desktop.command('select', atlas.dataset.project);
      void window.desktop.command('logs', atlas.dataset.project);
    });
    await previousClosed;
    const atlasLogs = await replacement;
    await atlasLogs.locator('#close').waitFor();
    await nativeFocus(true);
    assert.equal(await atlasLogs.locator('h1').textContent(), 'Atlas — Logs');
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2);
    await close(atlasLogs, 'button');
    await page.locator('[role="tab"]').filter({ hasText: 'Cedar' }).click();
    observations.push({ projectSwitchReplacesViewer: true });
    assert.deepEqual(errors, []);
    console.log('Packaged Logs: 600px work area, text safety, scrolling, Close/Escape/native close, focus, reopening, child above project: passed');
  } finally {
    await restorePopup();
    await writeFile(join(temp, 'logs-observations.json'), JSON.stringify({ area: original.area, observations, errors }, null, 2));
    await electron.evaluate(async ({ BrowserWindow, screen }, { managerURL, original }) => {
      const { ProjectManager } = process.getBuiltinModule('module').createRequire(managerURL)(process.getBuiltinModule('url').fileURLToPath(managerURL));
      ProjectManager.prototype.list = globalThis.__logsList;
      screen.getDisplayMatching = globalThis.__logsDisplay;
      delete globalThis.__logsFixture;
      for (const window of BrowserWindow.getAllWindows()) if (window.getParentWindow()) window.close();
      const owner = BrowserWindow.getAllWindows()[0];
      owner.setMinimumSize(...original.minimum); owner.setBounds(original.bounds);
    }, { managerURL, original });
  }
}
