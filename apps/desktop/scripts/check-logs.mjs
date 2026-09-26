/** Runs inside the existing packaged smoke fixture; no production test IPC. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export async function checkLogs(electron, page, resources, temp) {
  const managerURL = pathToFileURL(join(resources, 'app/manager.js')).href;
  const original = await electron.evaluate(async ({ BrowserWindow, screen }, managerURL) => {
    const owner = BrowserWindow.getAllWindows()[0];
    const display = screen.getDisplayMatching(owner.getBounds());
    const area = { ...display.workArea, height: Math.min(600, display.workArea.height) };
    const saved = { bounds: owner.getBounds(), minimum: owner.getMinimumSize(), area };
    globalThis.__logsDisplay = screen.getDisplayMatching;
    screen.getDisplayMatching = () => ({ ...display, workArea: area });
    const { ProjectManager } = await import(managerURL);
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
  const open = async () => {
    const waiting = electron.waitForEvent('window');
    await page.locator('[data-command="logs"]').click();
    const viewer = await waiting;
    viewer.on('pageerror', (error) => errors.push(error.message));
    await viewer.locator('#close').waitFor();
    await viewer.waitForFunction(() => document.hasFocus());
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
    assert(native.visible && native.focused && native.closable && native.projectVisible);
    assert(metrics.close.bottom <= metrics.height && metrics.close.right <= metrics.width && metrics.closeHit);
    assert.equal(metrics.node, 'undefined'); assert.equal(metrics.bridge, 'undefined');
    assert(!metrics.executed && metrics.injectedElements === 0);
    assert(native.preferences.sandbox && native.preferences.contextIsolation && !native.preferences.nodeIntegration);
    observations.push({ label, ...metrics, text: undefined, native: { ...native, preferences: undefined } });
    return metrics;
  };
  const close = async (viewer, method) => {
    const closed = viewer.waitForEvent('close');
    if (method === 'button') await viewer.locator('#close').click();
    else if (method === 'escape') { await viewer.locator('pre').focus(); await viewer.keyboard.press('Escape'); }
    else {
      // BrowserWindow.close uses the native close lifecycle (unlike destroy).
      await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow().close());
    }
    await closed;
    await page.waitForFunction(() => document.hasFocus() && document.activeElement?.dataset.command === 'logs');
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
      execFileSync('/usr/sbin/screencapture', ['-x', '-R', `${original.area.x},${original.area.y},${original.area.width},${original.area.height}`, join(temp, 'logs-native-desktop.png')]);
      observations.push({ nativeScreenshot: 'logs-native-desktop.png' });
    } catch (error) { observations.push({ nativeScreenshotBlocked: String(error) }); }
    // Repeated commands focus the same viewer, rather than stacking windows.
    await page.evaluate(() => { void window.desktop.command('logs', document.querySelector('nav [aria-current="page"]').dataset.project); });
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

    await setLogs('Fresh snapshot after reopening');
    const reopened = await open();
    assert.equal((await inspect(reopened, 'reopened')).text, 'Fresh snapshot after reopening');
    await reopened.locator('#close').focus();
    const closed = reopened.waitForEvent('close');
    await reopened.keyboard.press('Enter'); await closed;
    await page.waitForFunction(() => document.hasFocus());
    assert.deepEqual(errors, []);
    console.log('Packaged Logs: 600px work area, text safety, scrolling, Close/Escape/native close, focus, reopening, child above project: passed');
  } finally {
    await writeFile(join(temp, 'logs-observations.json'), JSON.stringify({ area: original.area, observations, errors }, null, 2));
    await electron.evaluate(async ({ BrowserWindow, screen }, { managerURL, original }) => {
      const { ProjectManager } = await import(managerURL);
      ProjectManager.prototype.list = globalThis.__logsList;
      screen.getDisplayMatching = globalThis.__logsDisplay;
      delete globalThis.__logsFixture;
      for (const window of BrowserWindow.getAllWindows()) if (window.getParentWindow()) window.close();
      const owner = BrowserWindow.getAllWindows()[0];
      owner.setMinimumSize(...original.minimum); owner.setBounds(original.bounds);
    }, { managerURL, original });
  }
}
