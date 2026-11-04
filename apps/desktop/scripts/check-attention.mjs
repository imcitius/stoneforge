/** Real bundled CLI -> backend -> hidden Desktop -> macOS Notification Center.
 * Uses a deterministic fake provider in disposable workspaces; no model calls.
 * The click callback is emitted by the test, not a physical OS banner click.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fixtureEnv } from '../tests/fixture-env.mjs';
import { mainProcessErrors } from './main-process-errors.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(join(root, 'apps/smithy-web/package.json'));
const { _electron } = require('playwright');
const bundle = resolve(process.env.DESKTOP_APP ?? join(root, 'apps/desktop/dist/mac/Stoneforge Desktop-darwin-arm64/Stoneforge Desktop.app'));
const resources = join(bundle, 'Contents/Resources');
const node = join(resources, 'runtime/node'), cli = join(resources, 'backend/dist/bin/sf.js');
const temp = await mkdtemp(join(tmpdir(), 'stoneforge-attention-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const env = fixtureEnv();
let electron;
// A main-process exception must fail this check, not hang it behind Electron's modal error box.
const mainErrors = mainProcessErrors(join(temp, 'main-process-errors.jsonl'));
const evidence = { bundle, temp, checks: [] };
// `observe` (optional) describes the actual state when the wait times out.
async function until(fn, label, timeout=30_000, observe) {
  const deadline=Date.now()+timeout;
  while (Date.now()<deadline) { if (await fn()) return; await pause(200); }
  const observed=observe ? await observe().catch(error=>'unavailable ('+error.message+')') : undefined;
  throw new Error('Timed out: '+label+(observed===undefined ? '' : '; observed '+observed));
}
try {
  execFileSync('/usr/bin/codesign', ['--verify','--deep','--strict',bundle]);
  const names=['Ожидает ответа','Другой проект'];
  for (const name of names) {
    const cwd=join(temp,name); await mkdir(cwd);
    execFileSync(node,[cli,'init','--preset','approve','--name',name],{cwd,env,stdio:'pipe'});
  }
  const fake=join(temp,'fake-provider');
  // Run the actual bundled sf through the provider's normal environment and
  // wait for the start route to finish publishing its session before signaling.
  await writeFile(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fixture"; exit 0; fi\nwhile [ ! -f "'+temp+'/release" ]; do sleep 0.1; done\nsf agent await-input > "'+temp+'/signal.log" 2>&1 || exit 42\nprintf "Какой вариант выбрать?\\n"\nIFS= read -r answer\nprintf "%s\\n" "$answer" > "'+temp+'/answer.log"\nwhile :; do sleep 1; done\n', {mode:0o755});
  electron=await _electron.launch({executablePath:join(bundle,'Contents/MacOS/Stoneforge Desktop'),args:names.map(name=>'--project='+join(temp,name)),env:{...env,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',STONEFORGE_DESKTOP_TEST_DATA:join(temp,'app-data')},timeout:30_000});
  await mainErrors.install(electron);
  const page=await electron.firstWindow();
  await until(async()=>JSON.stringify(await page.locator('[role="tab"]').evaluateAll(tabs=>tabs.map(tab=>tab.dataset.state)))===JSON.stringify(['ready','ready']),'two ready projects');
  const run=(id,script)=>electron.evaluate(async({webContents},{id,script})=>webContents.fromId(id).executeJavaScript(script),{id,script});
  let views;
  await until(async()=>{
    views=await electron.evaluate(({webContents})=>webContents.getAllWebContents().filter(wc=>wc.getURL().startsWith('http://127.0.0.1:')).map(wc=>({id:wc.id,url:wc.getURL()})));
    return views.length===2;
  },'project renderers');
  const identities=await Promise.all(views.map(v=>run(v.id,"fetch('/api/desktop/identity').then(r=>r.json())")));
  const index=identities.findIndex(i=>i.root===join(temp,names[0]) || i.workspaceRoot===join(temp,names[0]));
  // Match against the tab's stable project ID if the identity omits root.
  const projectId=await page.locator('[role="tab"]').filter({hasText:names[0]}).getAttribute('data-project');
  const view=views[index>=0?index:identities.findIndex(i=>i.projectId===projectId)];
  assert(view,'Waiting project renderer');
  await electron.evaluate(({Notification})=>{
    globalThis.__attentionNotices=[];
    const show=Notification.prototype.show;
    Notification.prototype.show=function(...args) { globalThis.__attentionNotices.push(this); return show.apply(this,args); };
  });
  await run(view.id,`(async()=>{
    await fetch('/api/daemon/stop',{method:'POST'});
    const {agents}=await (await fetch('/api/agents?role=director')).json();
    const agent=agents.find(a=>a.name==='director') || agents[0];
    if(!agent) throw new Error('Missing fixture director');
    const changed=await fetch('/api/agents/'+agent.id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'claude-code',executablePath:${JSON.stringify(fake)}})});
    if(!changed.ok) throw new Error(await changed.text());
    window.__attention={agentId:agent.id,subscribed:false,errors:[]};
    const ws=new WebSocket('ws://'+location.host+'/ws'); window.__attention.ws=ws;
    ws.onmessage=event=>{const message=JSON.parse(event.data);if(message.type==='subscribed')window.__attention.subscribed=true;if(message.type==='error')window.__attention.errors.push(message.error);};
    await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
    ws.send(JSON.stringify({type:'subscribe',agentId:agent.id}));
    while(!window.__attention.subscribed) await new Promise(resolve=>setTimeout(resolve,20));
    const started=await fetch('/api/agents/'+agent.id+'/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({interactive:true,initialPrompt:'Fixture question'})});
    if(!started.ok) throw new Error(await started.text());
  })()`);
  // The setup's explicit daemon stop is a user pause: Desktop shows this ready project as
  // 'paused' (el-5frvr5). Record that baseline; attention must override it and then return to it.
  const waitingTab=()=>page.locator('[role="tab"]').filter({hasText:names[0]});
  const tabStatus=async()=>'data-status='+await waitingTab().getAttribute('data-status');
  await until(async()=>await waitingTab().getAttribute('data-status')==='paused','tab shows paused task processing before attention',30_000,tabStatus);
  await page.locator('[role="tab"]').filter({hasText:names[1]}).click();
  await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].hide());
  await writeFile(join(temp,'release'),'go');
  await until(async()=>run(view.id,"fetch('/api/sessions?role=director&status=running').then(r=>r.json()).then(b=>b.sessions.some(s=>s.attention))"),'real CLI attention signal');
  evidence.signal=await readFile(join(temp,'signal.log'),'utf8');
  assert.match(evidence.signal,/Waiting for human input/);
  await until(async()=>await waitingTab().getAttribute('data-status')==='attention','tab attention badge',30_000,tabStatus);
  await until(async()=>electron.evaluate(()=>globalThis.__attentionNotices.length===1),'native notification emitted');
  await until(async()=>electron.evaluate(async({Notification})=>(await Notification.getHistory()).some(n=>n.title==='Нужен ваш ответ — Ожидает ответа')),'macOS delivered history');
  evidence.history=await electron.evaluate(async({Notification})=>(await Notification.getHistory()).filter(n=>n.title==='Нужен ваш ответ — Ожидает ответа').map(n=>({id:n.id,title:n.title,body:n.body})));
  evidence.checks.push('Bundled sf command, authenticated backend, inactive project, hidden window, tab attention badge, native macOS delivery');
  await pause(6500);
  assert.equal(await electron.evaluate(()=>globalThis.__attentionNotices.length),1,'Repeated polling must not duplicate');
  await electron.evaluate(()=>globalThis.__attentionNotices[0].emit('click'));
  await until(async()=>await page.locator('#name').textContent()===names[0],'notification click selects its project');
  assert.equal(await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),true);
  evidence.checks.push('Deduplication and simulated notification click callback restore/select correct project');
  await run(view.id,"window.__attention.ws.send(JSON.stringify({type:'input',input:'Первый вариант\\r'}))");
  await until(async()=>run(view.id,"fetch('/api/sessions?role=director&status=running').then(r=>r.json()).then(b=>b.sessions.length===1&&!b.sessions[0].attention)"),'human WS input clears attention');
  // Cleared attention restores the project's underlying status, which is still the paused baseline.
  await until(async()=>await waitingTab().getAttribute('data-status')==='paused','badge cleared to paused baseline',30_000,tabStatus);
  assert.match(await readFile(join(temp,'answer.log'),'utf8'),/Первый вариант/);
  assert.deepEqual(await run(view.id,'window.__attention.errors'),[]);
  evidence.checks.push('Real PTY human reply clears session attention and tab badge back to the paused baseline');
  await mainErrors.assertNone();
  console.log(JSON.stringify(evidence,null,2));
} catch (error) {
  // A trapped main-process exception exits the app; report it rather than the resulting closed target.
  await mainErrors.rethrow(error);
} finally {
  if(electron) {
    await electron.evaluate(async({Notification,app})=>{
      for(const notification of globalThis.__attentionNotices??[]) { if(notification.id) await Notification.remove(notification.id); }
      app.exit(0);
    }).catch(()=>{});
    await pause(2000);
  }
  await writeFile(join(temp,'attention-observations.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log('Fixture retained: '+temp);
}
