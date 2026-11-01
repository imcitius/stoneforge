/**
 * Getting Started (onboarding tour) must not reappear after the user skipped,
 * dismissed or finished it — even when the workspace backend restarts on a
 * different port. Desktop serves every project from 127.0.0.1:<dynamic port>,
 * so origin-scoped localStorage alone is lost on each backend/app restart.
 *
 * Uses one persistent browser profile (like a Desktop project partition) and
 * real temporary workspaces served by the built backend.
 * Run: pnpm exec playwright test -c playwright.onboarding-persistence.config.ts
 */

import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = join(root, 'packages/smithy/dist/bin/sf.js');
const ENDPOINT = '/api/settings/onboarding-tour';

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(STONEFORGE_|SF_|ELECTRON_)/.test(key) || ['PORT', 'HOST', 'ORCHESTRATOR_URL', 'ORCHESTRATOR_PORT'].includes(key)) delete env[key];
  }
  return { ...env, DAEMON_AUTO_START: 'false' };
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
  });
}

class Workspace {
  readonly dir: string;
  private server?: ChildProcess;
  port = 0;
  constructor(base: string, name: string) {
    this.dir = join(base, name);
    mkdirSync(this.dir);
    execFileSync(process.execPath, [cli, 'init', '--preset', 'auto', '--name', name], { cwd: this.dir, env: cleanEnv(), stdio: 'pipe' });
  }
  get origin() { return `http://127.0.0.1:${this.port}`; }
  /** Start (or restart) the backend on a port different from any earlier one. */
  async start(previous: number[] = []): Promise<void> {
    let port = await freePort();
    while (previous.includes(port)) port = await freePort();
    this.port = port;
    this.server = spawn(process.execPath, [cli, 'serve', '--no-open', '--host', '127.0.0.1', '--port', String(port)], { cwd: this.dir, env: cleanEnv(), stdio: 'ignore' });
    for (let i = 0; i < 200; i++) {
      try { if ((await fetch(this.origin + ENDPOINT)).ok) return; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Backend for ${this.dir} did not start on ${port}`);
  }
  async stop(): Promise<void> {
    const server = this.server;
    if (!server || server.exitCode !== null) return;
    const exited = new Promise((r) => server.once('exit', r));
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  async restart(): Promise<void> {
    const old = this.port;
    await this.stop();
    await this.start([old]);
    expect(this.port).not.toBe(old);
  }
  async state() { return (await fetch(this.origin + ENDPOINT)).json() as Promise<{ completed: boolean; status: string | null }>; }
}

/** Record any onboarding overlay, from before React mounts, for every document. */
async function watchOverlay(context: BrowserContext) {
  await context.addInitScript(() => {
    (window as unknown as { __tourSeen: boolean }).__tourSeen = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="onboarding-backdrop"],[data-testid="onboarding-tooltip"]')) {
        (window as unknown as { __tourSeen: boolean }).__tourSeen = true;
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

/** Open /activity and require the tour never appears (well past its 800ms auto-start delay). */
async function expectNoTour(page: Page, url: string) {
  await page.goto(url + '/activity');
  await expect(page.getByTestId('activity-page')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => (window as unknown as { __tourSeen: boolean }).__tourSeen)).toBe(false);
}

async function expectTour(page: Page, url: string) {
  await page.goto(url + '/activity');
  await expect(page.getByTestId('onboarding-tooltip')).toBeVisible({ timeout: 20_000 });
}

/** Finish the tour through its normal controls (section skips, Next, Finish). */
async function finishTour(page: Page) {
  const tooltip = page.getByTestId('onboarding-tooltip');
  for (let i = 0; i < 100 && await tooltip.isVisible(); i++) {
    const skipSection = page.getByTestId('onboarding-skip-section');
    const button = await skipSection.isVisible() ? skipSection : page.getByTestId('onboarding-next');
    await button.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(150);
  }
  await expect(tooltip).toBeHidden();
}

test.describe('Getting Started persists per workspace across backend restarts', () => {
  let base: string;
  let context: BrowserContext;
  let page: Page;
  const workspaces: Workspace[] = [];

  test.beforeAll(async () => {
    if (!existsSync(cli) || !existsSync(join(root, 'packages/smithy/web/index.html'))) {
      throw new Error('Build first: pnpm --filter @stoneforge/smithy... build && pnpm --filter @stoneforge/smithy-web build:web');
    }
    base = mkdtempSync(join(tmpdir(), 'onboarding-persistence-'));
    // One persistent profile across all restarts, like a Desktop project partition.
    context = await chromium.launchPersistentContext(join(base, 'profile'), { viewport: { width: 1440, height: 900 } });
    await watchOverlay(context);
    page = context.pages()[0] ?? await context.newPage();
  });

  test.afterAll(async () => {
    await context?.close();
    for (const workspace of workspaces) await workspace.stop();
    if (base) rmSync(base, { recursive: true, force: true });
  });

  test('skip, finish, restart, isolation, explicit Settings restart, delayed hydration and restart-vs-migration race', async () => {
    const atlas = new Workspace(base, 'atlas'); workspaces.push(atlas);
    const borealis = new Workspace(base, 'borealis'); workspaces.push(borealis);
    await atlas.start();

    // 1. First eligible visit shows the tour; Skip is remembered.
    await expectTour(page, atlas.origin);
    await page.getByTestId('onboarding-skip').click();
    await expect(page.getByTestId('onboarding-tooltip')).toBeHidden();
    await expect.poll(() => atlas.state()).toMatchObject({ completed: true, status: 'dismissed' });

    // 2. Same backend, reload/navigation: no tour.
    await expectNoTour(page, atlas.origin);

    // 3. Backend restart on a different port (new origin, empty localStorage).
    await atlas.restart();
    expect(await page.evaluate(() => localStorage.getItem('stoneforge:onboarding-complete'))).toBeNull();
    await expectNoTour(page, atlas.origin);
    expect(await page.evaluate(() => localStorage.getItem('stoneforge:onboarding-complete'))).toBeNull();

    // 4. A different workspace is isolated: it still gets its first tour; finish it.
    await borealis.start([atlas.port]);
    await expectTour(page, borealis.origin);
    await finishTour(page);
    await expect.poll(() => borealis.state()).toMatchObject({ completed: true, status: 'completed' });
    await borealis.restart();
    await expectNoTour(page, borealis.origin);

    // 5. Escape (close) dismisses and is remembered across restart.
    const cedar = new Workspace(base, 'cedar'); workspaces.push(cedar);
    await cedar.start([atlas.port, borealis.port]);
    await expectTour(page, cedar.origin);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('onboarding-tooltip')).toBeHidden();
    await expect.poll(() => cedar.state()).toMatchObject({ completed: true, status: 'dismissed' });
    await cedar.restart();
    await expectNoTour(page, cedar.origin);

    // 6. Delayed hydration: hold the workspace answer beyond the auto-start delay.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held = 0;
    await page.route('**' + ENDPOINT, async (route) => {
      if (route.request().method() === 'GET') { held++; await gate; }
      await route.continue();
    });
    await page.goto(atlas.origin + '/activity');
    await expect(page.getByTestId('activity-page')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(2000);
    expect(held).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as unknown as { __tourSeen: boolean }).__tourSeen)).toBe(false);
    release();
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => (window as unknown as { __tourSeen: boolean }).__tourSeen)).toBe(false);
    await page.unroute('**' + ENDPOINT);

    // 7. Explicit Settings restart still works and clears the workspace record.
    await page.goto(atlas.origin + '/settings');
    await page.getByTestId('settings-restart-onboarding').click();
    await expect(page.getByTestId('onboarding-tooltip')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => atlas.state()).toMatchObject({ completed: false, status: null });
    // ...and a user who dismisses it again is remembered after another restart.
    await page.getByTestId('onboarding-skip').click();
    await expect.poll(() => atlas.state()).toMatchObject({ completed: true, status: 'dismissed' });
    await atlas.restart();
    await expectNoTour(page, atlas.origin);

    // 8. Explicit restart while hydration is held, with an observable legacy
    //    completion flag in this origin: the stale hydration must not migrate
    //    the legacy flag over the restart (PUT completed after PUT null).
    const dune = new Workspace(base, 'dune'); workspaces.push(dune);
    await dune.start([atlas.port, borealis.port, cedar.port]);
    // Seed the legacy flag from a blank same-origin document (app not running),
    // as an older build would have left it.
    await page.route(dune.origin + '/__seed', (route) => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
    await page.goto(dune.origin + '/__seed');
    await page.evaluate(() => localStorage.setItem('stoneforge:onboarding-complete', 'true'));
    await page.unroute(dune.origin + '/__seed');
    expect(await dune.state()).toMatchObject({ completed: false, status: null });
    let releaseDune!: () => void;
    const duneGate = new Promise<void>((r) => { releaseDune = r; });
    let duneHeld = 0;
    const dunePuts: unknown[] = [];
    const isDuneGet = (request: { url(): string; method(): string }) =>
      request.url() === dune.origin + ENDPOINT && request.method() === 'GET';
    await page.route(dune.origin + ENDPOINT, async (route) => {
      const request = route.request();
      // Hold only the first page load's hydration answer (workspace: not completed).
      if (request.method() === 'GET' && duneHeld++ === 0) await duneGate;
      if (request.method() === 'PUT') dunePuts.push(JSON.parse(request.postData() ?? '{}').status);
      await route.continue().catch(() => {});
    });
    await page.goto(dune.origin + '/settings');
    await expect(page.getByTestId('settings-restart-onboarding')).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => localStorage.getItem('stoneforge:onboarding-complete'))).toBe('true');
    await expect.poll(() => duneHeld).toBe(1);
    await page.getByTestId('settings-restart-onboarding').click();
    await expect(page.getByTestId('onboarding-tooltip')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => dunePuts).toEqual([null]);
    // Release the stale answer and wait until the page has received it.
    const heldAnswer = page.waitForEvent('requestfinished', { predicate: isDuneGet, timeout: 20_000 });
    releaseDune();
    await heldAnswer;
    await page.waitForTimeout(1500);
    expect(dunePuts).toEqual([null]);
    expect(await dune.state()).toMatchObject({ completed: false, status: null });
    await expect(page.getByTestId('onboarding-tooltip')).toBeVisible();
    // The restart persisted: a fresh load offers the tour again; Skip then is the
    // only further write (no late "completed" from the stale migration).
    await page.goto(dune.origin + '/activity');
    await expect(page.getByTestId('onboarding-tooltip')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('onboarding-skip').click();
    await expect.poll(() => dunePuts).toEqual([null, 'dismissed']);
    await expect.poll(() => dune.state()).toMatchObject({ completed: true, status: 'dismissed' });
    await page.unroute(dune.origin + ENDPOINT);
    await dune.restart();
    await expectNoTour(page, dune.origin);

    // Other workspaces were not affected by Atlas's restart/dismissal.
    expect(await borealis.state()).toMatchObject({ status: 'completed' });
  });
});
