/** Native macOS clipboard regression: xterm mouse selection and terminal pbcopy. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ProjectManager } from '../dist/manager.js';
import { mainProcessErrors } from './main-process-errors.mjs';
import { saveClipboard, restoreClipboard } from './clipboard-snapshot.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(join(root, 'apps/smithy-web/package.json'));
const { _electron } = require('playwright');
const desktopRequire = createRequire(new URL('../package.json', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'stoneforge-clipboard-'));
const sample = 'Работа опять стояла — отчёт готов. Ёж 🦔';
let electron;
let saved;
// A main-process exception must fail this check, not hang it behind Electron's modal error box.
const mainErrors = mainProcessErrors(join(temp, 'main-process-errors.jsonl'));
try {
  await writeFile(join(temp, 'main.cjs'), `const {app,BrowserWindow,Menu}=require('electron'); app.whenReady().then(()=>{Menu.setApplicationMenu(Menu.buildFromTemplate([{role:'editMenu'}])); const w=new BrowserWindow({width:1200,height:400,webPreferences:{contextIsolation:true,nodeIntegration:false}}); w.loadFile(${JSON.stringify(join(temp, 'index.html'))});}); app.on('window-all-closed',()=>app.quit());`);
  const assets = resolve(root, 'apps/smithy-web/node_modules/@xterm/xterm');
  await writeFile(join(temp, 'index.html'), `<link rel="stylesheet" href="${pathToFileURL(join(assets, 'css/xterm.css'))}"><div id="term"></div><script src="${pathToFileURL(join(assets, 'lib/xterm.js'))}"></script><script>window.term=new Terminal({cols:100,rows:10,fontSize:16,allowProposedApi:true});term.open(document.getElementById('term'));window.inputs=[];term.onData(data=>window.inputs.push(data));term.write(${JSON.stringify(sample)});term.focus();</script>`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  electron = await _electron.launch({ executablePath: desktopRequire('electron'), args: [join(temp, 'main.cjs')], env });
  await mainErrors.install(electron);
  const page = await electron.firstWindow();
  // Items without MIME types (e.g. an empty pasteboard) are skipped; see clipboard-snapshot.mjs.
  await electron.evaluate(saveClipboard);
  saved = true;
  // Regression: an empty clipboard reads back as one item with no MIME types,
  // which the save step must tolerate and restore by clearing.
  await electron.evaluate(({clipboard}) => clipboard.clear());
  assert.ok((await electron.evaluate(async ({clipboard}) => (await clipboard.read()).map(item => item.types.length))).includes(0),
    'precondition: a cleared clipboard exposes an item with no MIME types');
  assert.deepEqual(await electron.evaluate(saveClipboard, '__emptyClipboard'), {saved:0, skipped:1});
  await electron.evaluate(({clipboard}, text) => clipboard.writeText(text), sample);
  assert.deepEqual(await electron.evaluate(restoreClipboard, '__emptyClipboard'), {restored:0});
  assert.equal(await electron.evaluate(({clipboard}) => clipboard.readText()), '', 'restoring an empty snapshot clears the clipboard');
  console.log('Empty clipboard (item without MIME types): saved without error, restored by clearing');
  await page.waitForFunction(() => window.term?.buffer.active.getLine(0)?.translateToString(true).includes('готов'));
  const bounds = await page.locator('.xterm-screen').boundingBox();
  const cell = await page.evaluate(() => window.term._core._renderService.dimensions.css.cell);
  await page.mouse.move(bounds.x + 1, bounds.y + cell.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + cell.width * 65, bounds.y + cell.height / 2, {steps: 20});
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.term.getSelection().trimEnd()), sample);
  await page.evaluate(() => { window.inputs=[]; });
  await page.keyboard.press('Meta+c');
  assert.deepEqual(await page.evaluate(() => window.inputs), [], 'Cmd+C must never send control keys or text to the running agent');
  assert.equal(await electron.evaluate(async ({clipboard}) => (await clipboard.readText()).trimEnd()), sample);
  console.log('xterm mouse selection + Cmd+C preserves Cyrillic, punctuation and emoji without sending agent input');

  // Claude can own selection through terminal mouse reporting, so native
  // xterm selection is not the only copy path worth checking.
  await page.evaluate(async () => {
    window.term.clearSelection();
    await new Promise(resolve => window.term.write('\x1b[?1000h\x1b[?1006h\x1b[?1004h', resolve));
    window.term.focus(); window.inputs=[];
  });
  await page.keyboard.press('Meta+c');
  assert.deepEqual(await page.evaluate(() => window.inputs), [], 'Cmd+C without native selection must not interrupt a mouse-reporting TUI');
  // Positive control proves the observer would catch an actual interrupt key.
  await page.keyboard.press('Control+c');
  assert.deepEqual(await page.evaluate(() => window.inputs), ['\x03']);
  console.log('TUI mouse/focus reporting: Cmd+C sends no input; explicit Ctrl+C sends ETX');

  const manager = new ProjectManager({dataDir:temp,node:process.execPath,entry:'unused',webRoot:temp,binDir:temp});
  const localeKeys = ['LANG','LC_ALL','LC_CTYPE'];
  const original = Object.fromEntries(localeKeys.map(k => [k,process.env[k]]));
  try {
    for (const fixture of [{}, {LC_ALL:'C'}]) {
      for (const key of localeKeys) { if (fixture[key]) process.env[key]=fixture[key]; else delete process.env[key]; }
      const bare = {...process.env};
      execFileSync('/usr/bin/pbcopy', [], {input:sample,env:bare});
      const broken = await electron.evaluate(({clipboard}) => clipboard.readText());
      assert.notEqual(broken, sample, 'Control must reproduce corruption without a UTF-8 locale');
      const corrected = manager.environment(temp);
      execFileSync('/usr/bin/pbcopy', [], {input:sample,env:corrected});
      assert.equal(await electron.evaluate(({clipboard}) => clipboard.readText()), sample);
    }
  } finally {
    for (const key of localeKeys) { if(original[key]===undefined) delete process.env[key]; else process.env[key]=original[key]; }
  }
  console.log('Native pbcopy: missing/C locale corrupts Unicode; Desktop environment preserves it');
  await mainErrors.assertNone();
} catch (error) {
  // A trapped main-process exception exits the app; report it rather than the resulting closed target.
  await mainErrors.rethrow(error);
} finally {
  try {
    if (electron && saved) await electron.evaluate(restoreClipboard);
  } finally { if (electron) await electron.close(); }
  await rm(temp, {recursive:true,force:true});
}
