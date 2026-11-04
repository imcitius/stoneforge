/**
 * Packaged regression: Getting Started (onboarding tour) is remembered per project
 * across Desktop project restart (new backend port) and full application relaunch.
 * Uses temporary projects and a temporary userData directory; it never touches the
 * installed application, its data or live projects.
 *   node apps/desktop/scripts/check-getting-started.mjs   (DESKTOP_APP selects a relocated bundle)
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fixtureEnv } from '../tests/fixture-env.mjs';
import { defaultApp, requireLaunchAllowed, appExecutable } from './app-identity.mjs';
import { mainProcessErrors } from './main-process-errors.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { _electron } = createRequire(join(root, 'apps/smithy-web/package.json'))('playwright');
const bundle = defaultApp(join(root, 'apps/desktop'));
// Refuses production-identity apps unless STONEFORGE_DESKTOP_ALLOW_PRODUCTION_IDENTITY=1 (release only, el-3qg5my).
requireLaunchAllowed(bundle);
const resources = join(bundle, 'Contents/Resources');
const node = join(resources, 'runtime/node');
const cli = join(resources, 'backend/dist/bin/sf.js');
// realpath: backends report canonical roots (/private/var on macOS).
const temp = await realpath(await mkdtemp(join(tmpdir(), 'stoneforge-getting-started-')));
const appData = join(temp, 'app-data');
// A main-process exception must fail this check, not hang it behind Electron's modal error box.
const mainErrors = mainProcessErrors(join(temp, 'main-process-errors.jsonl'));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const env = fixtureEnv();
const observations = [];
const errors = [];
let electron, shell;

async function launch(args = []) {
  electron = await _electron.launch({ executablePath: appExecutable(bundle), args,
    env: { ...env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', STONEFORGE_DESKTOP_TEST_DATA: appData }, timeout: 30_000 });
  await mainErrors.install(electron);
  // Answer the real Restart/"Stop and quit" confirmations in every launched process
  // (a stub does not survive an app relaunch; an unanswered dialog hangs the check).
  await electron.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  shell = await electron.firstWindow();
  shell.on('pageerror', (error) => errors.push(error.message));
  await shell.waitForFunction(() => document.getElementById('build').textContent.startsWith('v'));
}
async function quit() {
  const exited = new Promise((r) => electron.process().once('exit', r));
  // The "Stop and quit" confirmation is answered by the stub from launch(), so
  // project servers stop gracefully.
  await electron.evaluate(({ app }) => { app.quit(); });
  await Promise.race([exited, pause(30_000).then(() => { throw new Error('Desktop did not quit'); })]);
  electron = undefined;
}
const projectsList = () => shell.evaluate(() => window.desktop.command('list').then((s) => s.projects));
async function projectId(name) {
  for (let i = 0; i < 200; i++) {
    const project = (await projectsList()).find((p) => p.name === name);
    if (project) return project.id;
    await pause(100);
  }
  throw new Error(`Project ${name} not registered`);
}
async function waitReady(name) {
  await shell.waitForFunction((name) => [...document.querySelectorAll('[role="tab"]')]
    .some((el) => el.textContent.includes(name) && el.dataset.state === 'ready'), name, { timeout: 60_000 });
}
/** The project dashboard page whose backend serves `root`, excluding stale origins. */
async function projectPage(root, exclude = []) {
  for (let attempt = 0; attempt < 200; attempt++) {
    for (const page of electron.context().pages()) {
      const url = page.url();
      if (!url.startsWith('http://127.0.0.1:')) continue;
      const origin = new URL(url).origin;
      if (exclude.includes(origin)) continue;
      const identity = await page.evaluate(async () => (await fetch('/api/desktop/identity')).json()).catch(() => undefined);
      if (identity?.projectRoot === root) {
        page.on('pageerror', (error) => errors.push(`${root}: ${error.message}`));
        // Record any overlay from before React mounts, for every later document.
        await page.addInitScript(() => {
          window.__tourSeen = false;
          new MutationObserver(() => {
            if (document.querySelector('[data-testid="onboarding-backdrop"],[data-testid="onboarding-tooltip"]')) window.__tourSeen = true;
          }).observe(document, { childList: true, subtree: true });
        });
        return { page, origin };
      }
    }
    await pause(100);
  }
  throw new Error(`No dashboard for ${root}`);
}
const tourState = (page) => page.evaluate(async () => (await fetch('/api/settings/onboarding-tour')).json());
async function observe(stage, page, origin) {
  const entry = { stage, origin, state: await tourState(page),
    local: await page.evaluate(() => ({ completed: localStorage.getItem('stoneforge:onboarding-complete'), step: localStorage.getItem('stoneforge:onboarding-step') })) };
  observations.push(entry);
  return entry;
}
/** Select the project in the shell so its (otherwise hidden) view is visible. */
async function activate(page) {
  const id = (await page.evaluate(async () => (await fetch('/api/desktop/identity')).json())).projectId;
  const project = (await projectsList()).find((p) => p.id === id);
  assert(project, `Unknown project ${id}`);
  await shell.evaluate((id) => window.desktop.command('select', id), id);
  await shell.waitForFunction((name) => document.getElementById('name').textContent === name, project.name);
}
async function expectTour({ page, origin }, stage) {
  await activate(page);
  await page.goto(origin + '/activity');
  await page.getByTestId('onboarding-tooltip').waitFor({ timeout: 30_000 });
  await page.screenshot({ path: join(temp, `${stage}.png`) });
  await observe(stage, page, origin);
}
/** No tour on /activity well past the 800ms auto-start delay, not even transiently. */
async function expectNoTour({ page, origin }, stage) {
  await activate(page);
  await page.goto(origin + '/activity');
  await page.getByTestId('activity-page').waitFor({ timeout: 30_000 });
  await pause(3000);
  assert.equal(await page.evaluate(() => window.__tourSeen), false, `${stage}: Getting Started must not reappear`);
  await page.screenshot({ path: join(temp, `${stage}.png`) });
  return observe(stage, page, origin);
}

try {
  const atlas = join(temp, 'Atlas'); await mkdir(atlas);
  execFileSync(node, [cli, 'init', '--preset', 'auto', '--name', 'getting-started-fixture'], { cwd: atlas, env, stdio: 'pipe' });
  const borealis = join(temp, 'Borealis проект');
  await cp(atlas, borealis, { recursive: true });

  // 1. Fresh userData + fresh projects: each project gets its first tour (isolation).
  await launch([`--project=${atlas}`, `--project=${borealis}`]);
  await waitReady('Atlas'); await waitReady('Borealis проект');
  const ids = { atlas: await projectId('Atlas'), borealis: await projectId('Borealis проект') };
  let a = await projectPage(atlas);
  let b = await projectPage(borealis);
  await expectTour(a, 'atlas-first-visit');
  assert.equal((await tourState(a.page)).completed, false);
  await a.page.getByTestId('onboarding-skip').click();
  await a.page.getByTestId('onboarding-tooltip').waitFor({ state: 'detached' });
  assert.deepEqual((await tourState(a.page)).status, 'dismissed');
  await expectTour(b, 'borealis-first-visit-isolated');
  assert.equal((await tourState(b.page)).completed, false, 'Atlas dismissal must not apply to Borealis');
  await expectNoTour(a, 'atlas-navigation-after-skip');

  // 2. Desktop Restart of the same project: new backend, new port/origin.
  const before = a.origin;
  await shell.evaluate((id) => window.desktop.command('restart', id), ids.atlas);
  await waitReady('Atlas');
  a = await projectPage(atlas, [before]);
  assert.notEqual(a.origin, before, 'Restart must serve the project from a different origin');
  const restarted = await expectNoTour(a, 'atlas-after-project-restart');
  assert.equal(restarted.local.completed, null, 'New origin has no localStorage completion; workspace state must decide');
  assert.equal(restarted.state.status, 'dismissed');

  // 3. Close Borealis's tour with Escape (dismiss), then relaunch the whole app.
  await activate(b.page);
  await b.page.getByTestId('onboarding-tooltip').waitFor();
  await b.page.keyboard.press('Escape');
  await b.page.getByTestId('onboarding-tooltip').waitFor({ state: 'detached' });
  assert.equal((await tourState(b.page)).status, 'dismissed');
  const origins = [a.origin, b.origin];
  await quit();
  await launch();
  assert.deepEqual((await projectsList()).map((p) => p.state), ['stopped', 'stopped'], 'Relaunch does not start projects');
  // Selecting a stopped project only shows it; Start is the explicit action.
  await shell.evaluate((id) => window.desktop.command('select', id), ids.atlas);
  await pause(1500);
  assert.deepEqual((await projectsList()).map((p) => p.state), ['stopped', 'stopped'], 'Selecting does not start a project');
  await shell.evaluate((id) => window.desktop.command('start', id), ids.atlas);
  await waitReady('Atlas');
  a = await projectPage(atlas, origins);
  await expectNoTour(a, 'atlas-after-app-relaunch');
  await shell.evaluate((id) => window.desktop.command('start', id), ids.borealis);
  await waitReady('Borealis проект');
  b = await projectPage(borealis, origins);
  await expectNoTour(b, 'borealis-after-app-relaunch');

  // 4. Explicit Settings restart still works, and a new dismissal is remembered.
  await activate(a.page);
  await a.page.goto(a.origin + '/settings');
  await a.page.getByTestId('settings-restart-onboarding').click();
  await a.page.getByTestId('onboarding-tooltip').waitFor({ timeout: 30_000 });
  assert.equal((await tourState(a.page)).completed, false);
  await observe('atlas-explicit-restart', a.page, a.origin);
  await a.page.getByTestId('onboarding-skip').click();
  await a.page.getByTestId('onboarding-tooltip').waitFor({ state: 'detached' });
  const final = a.origin;
  await shell.evaluate((id) => window.desktop.command('restart', id), ids.atlas);
  await waitReady('Atlas');
  a = await projectPage(atlas, [...origins, final]);
  await expectNoTour(a, 'atlas-after-explicit-restart-and-skip');
  assert.equal((await tourState(b.page)).status, 'dismissed');
  await quit();
  assert.deepEqual(errors, [], 'Page errors');
  await mainErrors.assertNone();
  console.log('Packaged Getting Started: first visit, Skip/Escape persisted across project restart (new port) and app relaunch, per-project isolation, explicit Settings restart: passed');
} catch (error) {
  // A trapped main-process exception exits the app; report it rather than the resulting closed target.
  await mainErrors.rethrow(error);
} finally {
  await writeFile(join(temp, 'getting-started-observations.json'), JSON.stringify(observations, null, 2));
  if (electron) await electron.evaluate(({ app }) => app.exit(0)).catch(() => {});
  console.log(`Fixture retained: ${temp}`);
}
