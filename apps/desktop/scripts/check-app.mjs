/** Packaged Electron smoke test. Uses temporary workspaces and real provider calls with --live. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { findExternalServer } from '../../../packages/quarry/dist/cli/server-discovery.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(join(root, 'apps/smithy-web/package.json'));
const { _electron } = require('playwright');
const desktopRequire = createRequire(new URL('../package.json', import.meta.url));
const { Terminal } = desktopRequire('@xterm/headless');
const bundle = resolve(process.env.DESKTOP_APP ?? join(root, 'apps/desktop/dist/mac/Stoneforge Desktop-darwin-arm64/Stoneforge Desktop.app'));
const resources = join(bundle, 'Contents/Resources');
const node = join(resources, 'runtime/node');
const cli = join(resources, 'backend/dist/bin/sf.js');
const temp = await mkdtemp(join(tmpdir(), 'stoneforge-electron-'));
const live = process.argv.includes('--live') || process.argv.includes('--claude-only');
const providerNames = process.argv.includes('--claude-only') ? ['director'] : ['director', 'codex-director'];
let electron;
let externalFixture;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const a = join(temp, 'Atlas'); await mkdir(a);
  const env = { ...process.env }; delete env.STONEFORGE_ROOT; delete env.ELECTRON_RUN_AS_NODE;
  const sf = (...args) => execFileSync(node, [cli, ...args], { cwd: a, env, stdio: 'pipe' });
  sf('init', '--preset', 'auto', '--name', 'desktop-fixture');
  sf('agent', 'register', 'codex-director', '--role', 'director', '--provider', 'codex');
  await mkdir(join(a, '.stoneforge/prompts'), { recursive: true });
  await writeFile(join(a, '.stoneforge/prompts/director.md'), 'Temporary test workspace. Do not use tools or modify files. Answer the requested conversation only.');
  for (const name of ['Borealis', 'Cedar']) await cp(a, join(temp, name), { recursive: true });
  electron = await _electron.launch({ executablePath: join(bundle, 'Contents/MacOS/Stoneforge Desktop'),
    args: ['Atlas', 'Borealis', 'Cedar'].map((name) => '--project=' + join(temp, name)),
    env: { ...env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', STONEFORGE_DESKTOP_TEST_DATA: join(temp, 'app-data') },
    timeout: 30_000,
  });
  const page = await electron.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('nav button').filter({ hasText: 'Cedar' }).waitFor({ timeout: 30_000 });
  for (let i = 0; i < 80; i++) {
    const states = await page.locator('nav span').allTextContents();
    if (states.length === 3 && states.every((s) => s === 'ready')) break;
    await pause(250);
  }
  assert.deepEqual(await page.locator('nav span').allTextContents(), ['ready', 'ready', 'ready']);
  const getViews = () => electron.evaluate(({ webContents }) => webContents.getAllWebContents()
    .filter((wc) => wc.getURL().startsWith('http://127.0.0.1:')).map((wc) => ({ id: wc.id, url: wc.getURL() })));
  let views = [];
  for (let attempt = 0; attempt < 80; attempt++) { views = await getViews(); if (views.length === 3) break; await pause(250); }
  assert.equal(views.length, 3);
  const run = (id, script) => electron.evaluate(async ({ webContents }, { id, script }) => webContents.fromId(id).executeJavaScript(script), { id, script });
  const identities = [];
  for (const view of views) {
    const result = await run(view.id, `(async () => {
      const identity = await (await fetch('/api/desktop/identity')).json();
      const socket = await new Promise((resolve) => { const ws = new WebSocket('ws://' + location.host + '/ws/events'); ws.onopen = () => { ws.close(); resolve(true); }; ws.onerror = () => resolve(false); });
      const sse = await new Promise((resolve) => { const source = new EventSource('/api/events/stream'); const timeout = setTimeout(() => { source.close(); resolve(false); }, 5000); source.onopen = () => { clearTimeout(timeout); source.close(); resolve(true); }; source.onerror = () => { clearTimeout(timeout); source.close(); resolve(false); }; });
      return { identity, socket, sse, node: typeof require, text: document.body.innerText.slice(0, 200) };
    })()`);
    assert(result.socket, 'WebSocket header injection'); assert(result.sse, 'EventSource header injection');
    assert.equal(result.node, 'undefined'); assert(result.text.length > 40, 'Project UI rendered'); identities.push(result.identity);
    await run(view.id, `localStorage.setItem('desktop-test-marker', ${JSON.stringify(result.identity.projectId)})`);
  }
  assert.equal(new Set(identities.map((i) => i.projectId)).size, 3);
  for (const name of ['Atlas', 'Borealis', 'Cedar', 'Atlas', 'Cedar']) {
    await page.locator('nav button').filter({ hasText: name }).click();
    await pause(150);
    assert.equal(await page.locator('#name').textContent(), name);
  }
  for (let i = 0; i < views.length; i++) {
    assert.equal(await run(views[i].id, `localStorage.getItem('desktop-test-marker')`), identities[i].projectId);
  }
  console.log('Packaged UI: three projects, isolated storage, HTTP + WS + SSE, switching: passed');
  await page.screenshot({ path: join(temp, 'desktop.png') });
  const projectImage = await electron.evaluate(async ({ webContents }, id) => (await webContents.fromId(id).capturePage()).toPNG().toString('base64'), views[0].id);
  await writeFile(join(temp, 'project.png'), Buffer.from(projectImage, 'base64'));
  // Exercise the actual Add command while another WebContentsView is visible.
  // Native dialog answers are deterministic; UI state and real initialization run normally.
  const fresh = join(temp, 'Fresh проект'); await mkdir(fresh);
  await electron.evaluate(({ dialog }, fresh) => {
    globalThis.__addDialogs = [];
    globalThis.__addResponse = 0;
    globalThis.__addPath = fresh;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.__addPath] });
    dialog.showMessageBox = async (_window, options) => {
      globalThis.__addDialogs.push(options);
      return { response: globalThis.__addResponse, checkboxChecked: false };
    };
  }, fresh);
  await page.locator('#add').click();
  await page.waitForFunction(() => !document.getElementById('add').disabled);
  await assert.rejects(access(join(fresh, '.stoneforge')), 'Cancel must not initialize');
  assert.equal(await page.locator('nav button').count(), 3);
  await electron.evaluate(() => { globalThis.__addResponse = 1; });
  await page.locator('#add').focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('nav button')].some((el) => el.textContent.includes('Fresh проект') && el.textContent.includes('ready')), { timeout: 30_000 });
  assert.equal(await page.locator('nav button').count(), 4);
  await access(join(fresh, '.stoneforge/stoneforge.db'));
  await page.waitForFunction(() => !document.getElementById('add').disabled);
  await page.locator('#add').click();
  await page.waitForFunction(() => !document.getElementById('add').disabled);
  assert.equal(await page.locator('nav button').count(), 4, 'Re-add must deduplicate');
  await electron.evaluate(() => { globalThis.__addPath += '/missing'; });
  await page.locator('#add').click();
  await page.waitForFunction(() => !document.getElementById('add').disabled);
  const dialogs = await electron.evaluate(() => globalThis.__addDialogs);
  assert.equal(dialogs.filter((d) => d.message.startsWith('Set up Stoneforge')).length, 2);
  assert.equal(dialogs.at(-1).message, 'Could not add project', 'Errors use a native dialog above the project view');
  assert.match(dialogs.at(-1).detail, /ENOENT/);
  console.log('Packaged Add project: cancel, initialize, keyboard activation, deduplicate, visible error: passed');

  // Register repositories through the real Desktop command, then select one in task UI.
  const freshView = (await getViews()).find(v => !views.some(existing => existing.id === v.id));
  assert(freshView);
  for (const name of ['repo-a', 'repo-b']) {
    const repo = join(fresh, name); await mkdir(repo);
    const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.com');
    await writeFile(join(repo, 'README'), name); git('add', '.'); git('commit', '-qm', 'initial');
    await electron.evaluate((_electron, repo) => { globalThis.__addPath = repo; globalThis.__addResponse = 1; }, repo);
    await page.locator('[data-command="repositories"]').focus(); await page.keyboard.press('Enter');
    for (let attempt = 0; attempt < 100; attempt++) {
      const data = await run(freshView.id, `(async () => (await fetch('/api/repositories')).json())()`);
      if (data.repositories.some(r => r.id === name)) break;
      await pause(100);
    }
  }
  const registered = await run(freshView.id, `(async () => (await fetch('/api/repositories')).json())()`);
  assert.equal(registered.repositories.length, 2);
  await run(freshView.id, `(async () => {
    await fetch('/api/daemon/stop', { method: 'POST' });
    const agents = await (await fetch('/api/agents')).json();
    const response = await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Repository UI fixture', createdBy: agents.agents[0].id, repositoryId: 'repo-a' }) });
    if (!response.ok) throw new Error(await response.text());
  })()`);
  const taskPage = electron.context().pages().find(p => p.url().startsWith(new URL(freshView.url).origin));
  assert(taskPage, 'Project web contents accessible to UI test');
  taskPage.on('pageerror', error => console.error('Project UI error:', error.message));
  await taskPage.goto(new URL('/tasks', freshView.url).href);
  await taskPage.getByText('Repository UI fixture', { exact: true }).first().click();
  try { await taskPage.getByLabel('Repository', { exact: true }).selectOption('repo-b', { timeout: 5000 }); }
  catch (error) { console.error('Task UI state:', await taskPage.locator('body').innerText()); await taskPage.screenshot({ path: join(temp, 'repository-error.png') }); throw error; }
  await taskPage.waitForFunction(async () => {
    const data = await (await fetch('/api/tasks')).json();
    return data.tasks.find(t => t.title === 'Repository UI fixture')?.repositoryId === 'repo-b';
  });
  await taskPage.waitForFunction(() => { const select = document.querySelector('select'); return select?.value === 'repo-b' && !select.disabled; });
  await taskPage.screenshot({ path: join(temp, 'repositories.png') });
  console.log('Packaged repository registration and task selection: passed');

  const outside = join(temp, 'External'); await mkdir(outside);
  execFileSync(node, [cli, 'init', '--preset', 'approve'], { cwd: outside, env, stdio: 'pipe' });
  externalFixture = spawn(node, [cli, 'serve', '--no-open', '--host', '127.0.0.1', '--port', '0'], { cwd: outside, env: { ...env, DAEMON_AUTO_START: 'false' }, stdio: 'ignore' });
  let detected;
  for (let i = 0; i < 80; i++) { detected = await findExternalServer(outside); if (detected) break; await pause(100); }
  assert.equal(detected?.pid, externalFixture.pid);
  await electron.evaluate((_electron, path) => { globalThis.__addPath = path; }, outside);
  await page.locator('#add').click();
  await page.waitForFunction(() => [...document.querySelectorAll('nav button')].some((el) => el.textContent.includes('External') && el.textContent.includes('ready')));
  for (const name of ['Atlas', 'External', 'Cedar', 'External']) {
    await page.locator('nav button').filter({ hasText: name }).click();
    await page.waitForFunction((expected) => document.getElementById('name').textContent === expected, name);
  }
  assert.equal((await findExternalServer(outside)).pid, externalFixture.pid, 'Switching must reuse the same external process');
  // Simulate the external terminal closing. Desktop must invalidate its view.
  externalFixture.kill('SIGTERM');
  await page.waitForFunction(() => [...document.querySelectorAll('nav button')].some((el) => el.textContent.includes('External') && el.textContent.includes('error')), { timeout: 15_000 });
  await page.locator('nav button').filter({ hasText: 'Atlas' }).click();
  assert.equal(await page.locator('#name').textContent(), 'Atlas');
  console.log('Packaged adoption: external PID reused, project switching, external exit invalidation: passed');

  if (live) {
    // Start real TUI sessions in separate renderers; all traffic goes through session header injection.
    for (const [index, name] of providerNames.entries()) {
      const id = views[index].id;
      await run(id, `(async () => {
        const { agents } = await (await fetch('/api/agents')).json();
        const agent = agents.find(a => a.name === ${JSON.stringify(name)});
        window.__live = { output: '', errors: [], id: agent.id, subscribed: false };
        const ws = new WebSocket('ws://' + location.host + '/ws'); window.__live.ws = ws;
        ws.onmessage = event => { const message = JSON.parse(event.data); if (message.type === 'subscribed') window.__live.subscribed = true; if (message.type === 'pty-data') window.__live.output += message.data; if (message.type === 'error') window.__live.errors.push(message.error); };
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
        ws.send(JSON.stringify({ type: 'subscribe', agentId: agent.id }));
        while (!window.__live.subscribed) await new Promise(resolve => setTimeout(resolve, 20));
        const started = await fetch('/api/agents/' + agent.id + '/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ interactive: true, cols: 120, rows: 35, initialPrompt: 'Do not use tools. Reply only with the concatenation of DESKTOP and READY, without spaces.' }) });
        if (!started.ok) throw new Error(await started.text());
      })()`);
    }
    const done = new Set(), trusted = new Set();
    const terminals = providerNames.map(() => new Terminal({ cols: 120, rows: 35, allowProposedApi: true }));
    terminals.forEach((terminal, index) => terminal.onData((data) => { void run(views[index].id, `window.__live.ws.send(JSON.stringify({ type: 'input', input: ${JSON.stringify(data)} }))`); }));
    const offsets = providerNames.map(() => 0);
    const deadline = Date.now() + 90_000;
    for (let attempt = 0; Date.now() < deadline && done.size < providerNames.length; attempt++) {
      await pause(500);
      for (let index = 0; index < providerNames.length; index++) {
        const view = views[index];
        const state = await run(view.id, '({ output: window.__live.output, errors: window.__live.errors })');
        const terminal = terminals[index];
        await new Promise((resolve) => terminal.write(state.output.slice(offsets[index]), resolve));
        offsets[index] = state.output.length;
        const plain = Array.from({ length: terminal.buffer.active.length }, (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '').join('\n');
        await writeFile(join(temp, `provider-${index}.log`), plain);
        assert.deepEqual(state.errors, []);
        if (/401 Unauthorized|Incorrect API key|hit your session limit|Usage limit reached/i.test(plain)) {
          throw new Error(`${providerNames[index]}: provider authentication or usage limit blocked the live check; see ${temp}`);
        }
        if (!trusted.has(index) && /Yes,\s*I\s*trust\s*this\s*(folder|directory)|Trust\s*and\s*continue/.test(plain)) {
          if (index === 0) {
            await run(view.id, `window.__live.ws.send(JSON.stringify({ type: 'input', input: ${JSON.stringify('\x1b[B')} }))`);
            await pause(500);
          }
          await run(view.id, `window.__live.ws.send(JSON.stringify({ type: 'input', input: ${JSON.stringify('\r')} }))`);
          trusted.add(index);
        }
        if (/DESKTOP\s*READY/.test(plain)) done.add(index);
      }
      if (attempt % 10 === 0) await page.locator('nav button').nth(attempt % 3).click();
    }
    assert.equal(done.size, providerNames.length, 'Every selected interactive provider must answer');
    for (let index = 0; index < providerNames.length; index++) {
      terminals[index].dispose();
      await run(views[index].id, `window.__live.ws.send(JSON.stringify({ type: 'resize', cols: 110, rows: 32 }))`);
      await run(views[index].id, `(async () => { const response = await fetch('/api/agents/' + window.__live.id + '/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ graceful: true }) }); window.__live.ws.close(); if (!response.ok) throw new Error(await response.text()); })()`);
    }
    console.log(`Packaged ${providerNames.join(' + ')} interactive sessions, resize and switching: passed`);
  }
  assert.deepEqual(errors, []);
  console.log(`Diagnostics and screenshot: ${temp}`);
} finally {
  if (externalFixture && externalFixture.exitCode === null) externalFixture.kill('SIGTERM');
  if (electron) {
    // Simulate parent crash; children must observe IPC loss and close themselves.
    await electron.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await pause(2000);
  }
  console.log(`Fixture retained: ${temp}`);
}
