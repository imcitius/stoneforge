/** Packaged Electron smoke test. Uses temporary workspaces and real provider calls with --live. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
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
  if (electron) {
    // Simulate parent crash; children must observe IPC loss and close themselves.
    await electron.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await pause(2000);
  }
  console.log(`Fixture retained: ${temp}`);
}
