import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dropVisibilityListenersOnClose, VISIBILITY_EVENTS } from '../dist/window-guards.js';
import { fixtureEnv } from './fixture-env.mjs';

// A stand-in with Electron's internal listener: it calls isVisible(), which throws once destroyed.
function fakeWindow() {
  const window = new EventEmitter();
  let destroyed = false;
  window.isVisible = () => { if (destroyed) throw new TypeError('Object has been destroyed'); return true; };
  window.close = () => { destroyed = true; window.emit('closed'); };
  const visibilityChanged = () => window.isVisible();
  for (const event of VISIBILITY_EVENTS) window.on(event, visibilityChanged);
  return window;
}

test('a closed window no longer runs visibility listeners', () => {
  const unguarded = fakeWindow();
  unguarded.close();
  // Negative control: the late visibility event throws, as in the packaged crash.
  assert.throws(() => unguarded.emit('hide'), /Object has been destroyed/);
  const guarded = fakeWindow();
  dropVisibilityListenersOnClose(guarded);
  assert.equal(guarded.listenerCount('hide'), 1, 'An open window keeps its visibility listeners');
  guarded.close();
  for (const event of VISIBILITY_EVENTS) {
    assert.equal(guarded.listenerCount(event), 0, event);
    assert.doesNotThrow(() => guarded.emit(event));
  }
});

// The real Electron 44 listener: a visibility event on a destroyed BrowserWindow reproduces the
// exact packaged stack, and the guard (from the built main-process module) prevents it.
test('Electron: a visibility event after close no longer throws "Object has been destroyed"', { skip: process.platform !== 'darwin' }, async () => {
  const electron = createRequire(import.meta.url)('electron');
  const guard = new URL('../dist/window-guards.js', import.meta.url).href;
  const dir = await mkdtemp(join(tmpdir(), 'window-guards-'));
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'window-guards-probe', type: 'module', main: 'main.mjs' }));
    await writeFile(join(dir, 'main.mjs'), `
      import { app, BrowserWindow } from 'electron';
      import { writeFileSync } from 'node:fs';
      const { dropVisibilityListenersOnClose } = await import(${JSON.stringify(guard)});
      const result = { errors: [] };
      // Our own listener: Electron then shows no modal box for the expected baseline exception.
      process.on('uncaughtException', (error) => result.errors.push(String(error.stack)));
      app.on('window-all-closed', () => {});
      app.whenReady().then(async () => {
        if (process.env.GUARD === '1') app.on('browser-window-created', (_event, window) => dropVisibilityListenersOnClose(window));
        for (const how of ['close', 'destroy']) {
          const window = new BrowserWindow({ show: false, width: 200, height: 100 });
          const closed = new Promise((resolve) => window.once('closed', resolve));
          window[how]();
          await closed;
          // What the packaged crash shows: Electron emitting a visibility event on the closed window.
          for (const event of ['show', 'hide']) {
            try { window.emit(event); } catch (error) { result.errors.push(how + ' ' + event + ': ' + String(error.stack)); }
          }
        }
        writeFileSync(${JSON.stringify(join(dir, 'result.json'))}, JSON.stringify(result));
        app.exit(0);
      });
    `);
    const run = async (guarded) => {
      const child = spawnSync(electron, [dir], { env: fixtureEnv({ GUARD: guarded ? '1' : '0' }), encoding: 'utf8', timeout: 30_000 });
      assert.equal(child.status, 0, child.stderr || String(child.error));
      const result = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'));
      await rm(join(dir, 'result.json'));
      return result.errors;
    };
    const baseline = await run(false);
    assert.equal(baseline.length, 4, baseline.join('\n'));
    for (const error of baseline) assert.match(error, /TypeError: Object has been destroyed\n\s+at BrowserWindow\.visibilityChanged \(node:electron\/js2c\/browser_init/);
    assert.deepEqual(await run(true), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
